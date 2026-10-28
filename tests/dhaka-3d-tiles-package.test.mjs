import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, cp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { buildDhaka3DTilesPackage } from "../scripts/build-dhaka-3d-tiles-package.mjs";
import { verifyTilesetPackage } from "../src/core/geospatial/tileset-package-integrity.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDirectory, "..");
let temporaryDirectory;
let sourcePath;
let packageA;
let packageB;
let sourceBytes;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function polygon(id, coordinates, properties = {}) {
  return {
    type: "Feature",
    id,
    properties,
    geometry: { type: "Polygon", coordinates: [coordinates] },
  };
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

function sampleSource() {
  const concave = [
    [90.411, 23.78],
    [90.4112, 23.78],
    [90.4112, 23.7802],
    [90.4111, 23.7801],
    [90.411, 23.7802],
    [90.411, 23.78],
  ];
  return {
    type: "FeatureCollection",
    features: [
      polygon("building-a", square(90.410, 23.780), { class: "building" }),
      polygon("building-b", concave, { class: "building" }),
      {
        type: "Feature",
        id: "building-c-multipolygon",
        properties: { class: "building" },
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [square(90.412, 23.780)],
            [square(90.4125, 23.7805)],
          ],
        },
      },
      polygon("outside", square(90.43, 23.78)),
      {
        type: "Feature",
        id: "has-hole",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            square(90.413, 23.78),
            square(90.41303, 23.78003, 90.41305, 23.78005),
          ],
        },
      },
      {
        type: "Feature",
        id: "line",
        properties: {},
        geometry: { type: "LineString", coordinates: [[90.414, 23.78], [90.4141, 23.7801]] },
      },
      polygon("building-a", square(90.415, 23.78), { duplicate: true }),
      polygon("too-wide", square(90.416, 23.78, 90.42, 23.7801)),
    ],
  };
}

async function preparePackage(outputPath) {
  return buildDhaka3DTilesPackage({
    sourcePath,
    outputPath,
    maxFeatures: 16,
    syntheticHeightMeters: 8,
  });
}

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "p3-6-tiles-package-"));
  sourcePath = path.join(temporaryDirectory, "source.geojson");
  packageA = path.join(temporaryDirectory, "package-a");
  packageB = path.join(temporaryDirectory, "package-b");
  sourceBytes = Buffer.from(`${JSON.stringify(sampleSource(), null, 2)}\n`, "utf8");
  await writeFile(sourcePath, sourceBytes);
  await preparePackage(packageA);
});

after(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("builds a real multi-content OGC 3D Tiles 1.1 hierarchy from source footprints", async () => {
  const tileset = JSON.parse(await readFile(path.join(packageA, "tileset.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(packageA, "build-manifest.json"), "utf8"));
  assert.equal(tileset.asset.version, "1.1");
  assert.equal(tileset.root.children.length, 3);
  assert.equal(manifest.tiles.length, 3);
  assert.equal(manifest.configuration.emittedFeatures, 3);
  assert.equal(manifest.source.sha256, sha256(sourceBytes));
  assert.equal(manifest.validation.contentCount, 3);
  assert.equal(manifest.releaseFlags.acceptanceEligible, false);
  assert.equal(manifest.releaseFlags.publicationEligible, false);
  assert.equal(manifest.releaseFlags.mapReady, false);
  assert.equal(manifest.releaseFlags.automaticApproval, false);
  assert.equal(tileset.asset.extras.heightStatus, "synthetic-test-height");
  assert.ok(manifest.excludedCounts.outsideBounds >= 1);
  assert.ok(manifest.excludedCounts.interiorRingsUnsupported >= 1);
  assert.ok(manifest.excludedCounts.unsupportedGeometry >= 1);
  assert.ok(manifest.excludedCounts.duplicateIdentity >= 1);
  assert.ok(manifest.excludedCounts.footprintSizeOutOfRange >= 1);
  assert.ok(tileset.root.geometricError > 0);
  for (const child of tileset.root.children) {
    assert.equal(child.geometricError, 0);
    assert.equal(child.transform.length, 16);
    assert.ok(child.boundingVolume.region.every(Number.isFinite));
    assert.match(child.content.uri, /^tiles\/building-\d{4}-[a-f0-9]{10}\.glb$/);
    assert.ok((await readFile(path.join(packageA, child.content.uri))).length > 100);
  }
});

test("GLB payloads are valid binary glTF with non-empty triangle geometry", async () => {
  const tileset = JSON.parse(await readFile(path.join(packageA, "tileset.json"), "utf8"));
  for (const child of tileset.root.children) {
    const bytes = await readFile(path.join(packageA, child.content.uri));
    assert.equal(bytes.toString("ascii", 0, 4), "glTF");
    assert.equal(bytes.readUInt32LE(4), 2);
    assert.equal(bytes.readUInt32LE(8), bytes.length);
    const jsonLength = bytes.readUInt32LE(12);
    assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
    const gltf = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
    assert.equal(gltf.asset.version, "2.0");
    assert.equal(gltf.meshes.length, 1);
    assert.ok(gltf.accessors[0].count >= 18);
    assert.ok(gltf.accessors[2].count >= 18);
    assert.equal(gltf.accessors[2].componentType, 5125);
    assert.equal(gltf.extras.heightStatus, "synthetic-test-height");
  }
});

test("source, manifest and every GLB hash/byte length are bound and verified", async () => {
  const report = await verifyTilesetPackage({
    directory: packageA,
    expectedSourceSha256: sha256(sourceBytes),
  });
  assert.equal(report.valid, true, report.errors.join("; "));
  assert.equal(report.tileCount, 4);
  assert.equal(report.contentCount, 3);
  assert.equal(report.sourceSha256, sha256(sourceBytes));
  assert.ok(report.bytesVerified > 0);
});

test("rejects a different expected source hash and unsafe parent-traversal content URI", async () => {
  const mismatch = await verifyTilesetPackage({ directory: packageA, expectedSourceSha256: "0".repeat(64) });
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.errors.some((error) => error.includes("does not match the expected source")));

  const attackPackage = path.join(temporaryDirectory, "package-unsafe-uri");
  await cp(packageA, attackPackage, { recursive: true });
  const tilesetPath = path.join(attackPackage, "tileset.json");
  const tileset = JSON.parse(await readFile(tilesetPath, "utf8"));
  tileset.root.children[0].content.uri = "../escape.glb";
  await writeFile(tilesetPath, `${JSON.stringify(tileset, null, 2)}\n`);
  const report = await verifyTilesetPackage({ directory: attackPackage });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) =>
    error.includes("unsafe content URI") || error.includes("must not traverse parent directories")
  ));
});

test("rejects missing or tampered GLB content instead of accepting a manifest-only pass", async () => {
  const damagedPackage = path.join(temporaryDirectory, "package-damaged");
  await cp(packageA, damagedPackage, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(damagedPackage, "build-manifest.json"), "utf8"));
  const target = manifest.tiles[0].contentUri;
  await writeFile(path.join(damagedPackage, target), Buffer.from("not a glb"));
  const report = await verifyTilesetPackage({ directory: damagedPackage });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes("Byte-length mismatch") || error.includes("SHA-256 mismatch")));
});

test("rejects symbolic links in package assets", async () => {
  const linkedPackage = path.join(temporaryDirectory, "package-symlink");
  await cp(packageA, linkedPackage, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(linkedPackage, "build-manifest.json"), "utf8"));
  const target = path.join(linkedPackage, manifest.tiles[0].contentUri);
  const external = path.join(temporaryDirectory, "external.glb");
  await writeFile(external, Buffer.from("outside package"));
  await rm(target);
  await symlink(external, target);
  const report = await verifyTilesetPackage({ directory: linkedPackage });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes("Symbolic links are not allowed")));
});

test("cross-binds source hashes, per-tile content hashes and disabled release flags", async () => {
  const sourceTamper = path.join(temporaryDirectory, "package-source-hash-mismatch");
  await cp(packageA, sourceTamper, { recursive: true });
  const tilesetPath = path.join(sourceTamper, "tileset.json");
  const buildPath = path.join(sourceTamper, "build-manifest.json");
  const tileset = JSON.parse(await readFile(tilesetPath, "utf8"));
  const build = JSON.parse(await readFile(buildPath, "utf8"));
  tileset.asset.extras.sourceSha256 = "0".repeat(64);
  const modifiedTilesetBytes = Buffer.from(`${JSON.stringify(tileset, null, 2)}\n`);
  await writeFile(tilesetPath, modifiedTilesetBytes);
  build.files["tileset.json"] = {
    sha256: sha256(modifiedTilesetBytes),
    bytes: modifiedTilesetBytes.length,
  };
  await writeFile(buildPath, `${JSON.stringify(build, null, 2)}\n`);
  const sourceMismatch = await verifyTilesetPackage({ directory: sourceTamper });
  assert.equal(sourceMismatch.valid, false);
  assert.ok(sourceMismatch.errors.some((error) => error.includes("source SHA-256 does not match")));

  const tileHashTamper = path.join(temporaryDirectory, "package-tile-hash-mismatch");
  await cp(packageA, tileHashTamper, { recursive: true });
  const tileHashManifestPath = path.join(tileHashTamper, "build-manifest.json");
  const tileHashManifest = JSON.parse(await readFile(tileHashManifestPath, "utf8"));
  tileHashManifest.tiles[0].contentSha256 = "0".repeat(64);
  await writeFile(tileHashManifestPath, `${JSON.stringify(tileHashManifest, null, 2)}\n`);
  const tileHashMismatch = await verifyTilesetPackage({ directory: tileHashTamper });
  assert.equal(tileHashMismatch.valid, false);
  assert.ok(tileHashMismatch.errors.some((error) => error.includes("Tile content SHA-256 does not match")));

  const releaseTamper = path.join(temporaryDirectory, "package-release-flag-enabled");
  await cp(packageA, releaseTamper, { recursive: true });
  const releaseManifestPath = path.join(releaseTamper, "build-manifest.json");
  const releaseManifest = JSON.parse(await readFile(releaseManifestPath, "utf8"));
  releaseManifest.releaseFlags.mapReady = true;
  await writeFile(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`);
  const releaseMismatch = await verifyTilesetPackage({ directory: releaseTamper });
  assert.equal(releaseMismatch.valid, false);
  assert.ok(releaseMismatch.errors.some((error) => error.includes("release flags must remain explicitly false")));
});

test("rebuilds identical tileset, GLBs and build manifest from unchanged source/config", async () => {
  await preparePackage(packageB);
  const first = JSON.parse(await readFile(path.join(packageA, "build-manifest.json"), "utf8"));
  const second = JSON.parse(await readFile(path.join(packageB, "build-manifest.json"), "utf8"));
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(first.tiles, second.tiles);
  assert.equal(sha256(await readFile(path.join(packageA, "build-manifest.json"))),
    sha256(await readFile(path.join(packageB, "build-manifest.json"))));
});

test("refuses unsafe feature counts, invalid heights and a source with no accepted footprint", async () => {
  await assert.rejects(
    buildDhaka3DTilesPackage({ sourcePath, outputPath: path.join(temporaryDirectory, "invalid"), maxFeatures: 0 }),
    /maxFeatures must be an integer/,
  );
  await assert.rejects(
    buildDhaka3DTilesPackage({ sourcePath, outputPath: path.join(temporaryDirectory, "invalid"), syntheticHeightMeters: 0 }),
    /syntheticHeightMeters must be finite/,
  );
  const emptyPath = path.join(temporaryDirectory, "empty.geojson");
  await writeFile(emptyPath, JSON.stringify({ type: "FeatureCollection", features: [] }));
  await assert.rejects(
    buildDhaka3DTilesPackage({ sourcePath: emptyPath, outputPath: path.join(temporaryDirectory, "empty-package") }),
    /No valid Dhaka footprint/,
  );
});
