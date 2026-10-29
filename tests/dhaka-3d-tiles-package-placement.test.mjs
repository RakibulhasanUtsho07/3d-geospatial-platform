import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { buildDhaka3DTilesPackage } from "../scripts/build-dhaka-3d-tiles-package.mjs";
import { reviewDhaka3DTilesPackagePlacement } from "../scripts/review-dhaka-3d-tiles-package-placement.mjs";

let temporaryDirectory;
let sourcePath;
let packageDirectory;
const defaultBounds = { west: 90.4, south: 23.77, east: 90.42, north: 23.79 };

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function square(west, south, east = west + 0.0001, north = south + 0.0001) {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

function feature(id, coordinates) {
  return {
    type: "Feature",
    id,
    properties: { class: "building" },
    geometry: { type: "Polygon", coordinates: [coordinates] },
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

async function rebindTilesetHash(packagePath, tilesetBytes, build) {
  build.files["tileset.json"] = { sha256: sha256(tilesetBytes), bytes: tilesetBytes.length };
  await writeJson(path.join(packagePath, "build-manifest.json"), build);
}

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "p3-6-placement-review-"));
  sourcePath = path.join(temporaryDirectory, "source.geojson");
  packageDirectory = path.join(temporaryDirectory, "package");
  const concave = [
    [90.411, 23.78],
    [90.4112, 23.78],
    [90.4112, 23.7802],
    [90.4111, 23.7801],
    [90.411, 23.7802],
    [90.411, 23.78],
  ];
  const source = {
    type: "FeatureCollection",
    features: [
      feature("placement-square-a", square(90.410, 23.780)),
      feature("placement-concave-b", concave),
      {
        type: "Feature",
        id: "placement-multipolygon-c",
        properties: { class: "building" },
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [square(90.412, 23.780)],
            [square(90.4125, 23.7805)],
          ],
        },
      },
    ],
  };
  await writeJson(sourcePath, source);
  await buildDhaka3DTilesPackage({
    sourcePath,
    outputPath: packageDirectory,
    maxFeatures: 8,
    syntheticHeightMeters: 8,
    bounds: defaultBounds,
  });
});

after(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("reports source-to-GLB footprint and ECEF placement residuals for all emitted tiles", async () => {
  const outputPath = path.join(temporaryDirectory, "reports", "placement-review.json");
  const report = await reviewDhaka3DTilesPackagePlacement({
    sourcePath,
    packageDirectory,
    outputPath,
    maxResidualMeters: 0.25,
  });
  assert.equal(report.status, "pass");
  assert.equal(report.input.emittedTileCount, 3);
  assert.equal(report.summary.allTileResidualsWithinThreshold, true);
  assert.equal(report.summary.allChildRegionsCoverSourceBounds, true);
  assert.ok(report.summary.maximumFootprintBoundaryResidualMeters <= 0.25);
  assert.ok(report.summary.maximumEcefPlacementResidualMeters <= 0.25);
  assert.ok(report.tiles.every((tile) => tile.status === "pass" && tile.triangleCount > 0));
  const onDisk = await readJson(outputPath);
  assert.equal(onDisk.input.sourceSha256, report.input.sourceSha256);
  assert.equal(onDisk.releaseFlags.publicationEligible, false);
});

test("rejects a GLB footprint shift even when package hashes/manifests are consistently rebound", async () => {
  const damagedPackage = path.join(temporaryDirectory, "shifted-footprint-package");
  await cp(packageDirectory, damagedPackage, { recursive: true });
  const build = await readJson(path.join(damagedPackage, "build-manifest.json"));
  const uri = build.tiles[0].contentUri;
  const glbPath = path.join(damagedPackage, uri);
  const bytes = await readFile(glbPath);
  const jsonLength = bytes.readUInt32LE(12);
  const binaryHeader = 20 + jsonLength;
  const binaryOffset = binaryHeader + 8;
  const gltf = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
  const positionAccessor = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  const positionView = gltf.bufferViews[positionAccessor.bufferView];
  const positionOffset = binaryOffset + (positionView.byteOffset ?? 0) + (positionAccessor.byteOffset ?? 0);
  const stride = positionView.byteStride ?? 12;
  for (let i = 0; i < positionAccessor.count; i += 1) {
    const offset = positionOffset + i * stride;
    bytes.writeFloatLE(bytes.readFloatLE(offset) + 1, offset);
  }
  await writeFile(glbPath, bytes);
  const nextHash = sha256(bytes);
  build.files[uri].sha256 = nextHash;
  build.tiles.find((tile) => tile.contentUri === uri).contentSha256 = nextHash;
  await writeJson(path.join(damagedPackage, "build-manifest.json"), build);

  const integrityPath = await import("../src/core/geospatial/tileset-package-integrity.mjs");
  const integrity = await integrityPath.verifyTilesetPackage({ directory: damagedPackage });
  assert.equal(integrity.valid, true, integrity.errors.join("; "));
  await assert.rejects(
    reviewDhaka3DTilesPackagePlacement({
      sourcePath,
      packageDirectory: damagedPackage,
      outputPath: path.join(temporaryDirectory, "shifted-report.json"),
      maxResidualMeters: 0.25,
    }),
    /footprint boundary residual|ECEF placement residual/i,
  );
});

test("rejects an ECEF translation error after hashes are rebound", async () => {
  const damagedPackage = path.join(temporaryDirectory, "shifted-transform-package");
  await cp(packageDirectory, damagedPackage, { recursive: true });
  const tilesetPath = path.join(damagedPackage, "tileset.json");
  const tileset = await readJson(tilesetPath);
  const build = await readJson(path.join(damagedPackage, "build-manifest.json"));
  tileset.root.children[0].transform[12] += 1;
  const bytes = Buffer.from(JSON.stringify(tileset, null, 2) + "\n");
  await writeFile(tilesetPath, bytes);
  await rebindTilesetHash(damagedPackage, bytes, build);

  const integrityPath = await import("../src/core/geospatial/tileset-package-integrity.mjs");
  const integrity = await integrityPath.verifyTilesetPackage({ directory: damagedPackage });
  assert.equal(integrity.valid, true, integrity.errors.join("; "));
  await assert.rejects(
    reviewDhaka3DTilesPackagePlacement({
      sourcePath,
      packageDirectory: damagedPackage,
      outputPath: path.join(temporaryDirectory, "shifted-transform-report.json"),
      maxResidualMeters: 0.25,
    }),
    /transform translation differs from source anchor/i,
  );
});

test("fails closed on a changed source, mismatched GLB or enabled release gate", async () => {
  const outputPath = path.join(temporaryDirectory, "source-mismatch.json");
  await assert.rejects(
    reviewDhaka3DTilesPackagePlacement({
      sourcePath: path.join(temporaryDirectory, "missing-source.geojson"),
      packageDirectory,
      outputPath,
    }),
  );

  const flaggedPackage = path.join(temporaryDirectory, "release-flag-package");
  await cp(packageDirectory, flaggedPackage, { recursive: true });
  const build = await readJson(path.join(flaggedPackage, "build-manifest.json"));
  build.releaseFlags.publicationEligible = true;
  await writeJson(path.join(flaggedPackage, "build-manifest.json"), build);
  await assert.rejects(
    reviewDhaka3DTilesPackagePlacement({
      sourcePath,
      packageDirectory: flaggedPackage,
      outputPath: path.join(temporaryDirectory, "flagged-report.json"),
    }),
    /Package integrity must pass/,
  );
});
