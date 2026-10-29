import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { buildDhaka3DTilesPackage } from "../scripts/build-dhaka-3d-tiles-package.mjs";
import { reviewDhaka3DTilesPackageAlignment } from "../scripts/review-dhaka-3d-tiles-package-alignment.mjs";

let root, sourcePath, packagePath;
const sourceData = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "alignment-square",
      properties: { class: "building" },
      geometry: { type: "Polygon", coordinates: [[
        [90.4100, 23.7800], [90.4101, 23.7800], [90.4101, 23.7801],
        [90.4100, 23.7801], [90.4100, 23.7800]
      ]] }
    },
    {
      type: "Feature",
      id: "alignment-concave",
      properties: { class: "building" },
      geometry: { type: "Polygon", coordinates: [[
        [90.4110, 23.7800], [90.4113, 23.7800], [90.4113, 23.7803],
        [90.41115, 23.78012], [90.4110, 23.7803], [90.4110, 23.7800]
      ]] }
    },
    {
      type: "Feature",
      id: "alignment-multipolygon",
      properties: { class: "building" },
      geometry: { type: "MultiPolygon", coordinates: [
        [[[90.4120, 23.7800], [90.4121, 23.7800], [90.4121, 23.7801], [90.4120, 23.7801], [90.4120, 23.7800]]],
        [[[90.4125, 23.7805], [90.4126, 23.7805], [90.4126, 23.7806], [90.4125, 23.7806], [90.4125, 23.7805]]]
      ] }
    }
  ]
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "p3-6-package-alignment-"));
  sourcePath = path.join(root, "source.geojson");
  packagePath = path.join(root, "package");
  await writeFile(sourcePath, JSON.stringify(sourceData, null, 2) + "\n", "utf8");
  await buildDhaka3DTilesPackage({
    sourcePath,
    outputPath: packagePath,
    maxFeatures: 16,
    syntheticHeightMeters: 8
  });
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("checks every emitted GLB footprint after its child ECEF transform", async () => {
  const report = await reviewDhaka3DTilesPackageAlignment({ sourcePath, packageDirectory: packagePath });
  assert.equal(report.status, "pass", report.errors.join("; "));
  assert.equal(report.evidenceType, "dhaka-3d-tiles-per-tile-footprint-placement-residual");
  assert.equal(report.package.integrityStatus, "pass");
  assert.equal(report.summary.tileCount, 3);
  assert.equal(report.tiles.length, 3);
  assert.equal(report.summary.allTransformedVerticesInsideDeclaredRegions, true);
  assert.ok(report.summary.maximumHorizontalResidualMeters <= report.thresholds.maximumHorizontalResidualMeters);
  assert.ok(report.summary.maximumEllipsoidHeightResidualMeters <= report.thresholds.maximumEllipsoidHeightResidualMeters);
  assert.deepEqual(report.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false
  });
  for (const tile of report.tiles) {
    assert.equal(tile.status, "pass", tile.contentUri);
    assert.ok(tile.sourceVertexCount >= 4, tile.contentUri);
    assert.equal(tile.sourceVertexCount, tile.transformedGroundVertexCount, tile.contentUri);
    assert.equal(tile.allTransformedVerticesInsideDeclaredRegion, true, tile.contentUri);
  }
});

test("detects a shifted child transform even when package file hashes are recomputed", async () => {
  const damagedPath = path.join(root, "shifted-package");
  await cp(packagePath, damagedPath, { recursive: true });
  const tilesetPath = path.join(damagedPath, "tileset.json");
  const manifestPath = path.join(damagedPath, "build-manifest.json");
  const tileset = JSON.parse(await readFile(tilesetPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // Shift ECEF X by 5 metres, update the container's file hash to ensure the
  // alignment evaluator—not just the integrity checker—detects the defect.
  tileset.root.children[0].transform[12] += 5;
  const tilesetBytes = Buffer.from(JSON.stringify(tileset, null, 2) + "\n");
  manifest.files["tileset.json"] = { sha256: sha256(tilesetBytes), bytes: tilesetBytes.length };
  await writeFile(tilesetPath, tilesetBytes);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const report = await reviewDhaka3DTilesPackageAlignment({ sourcePath, packageDirectory: damagedPath });
  assert.equal(report.status, "fail");
  assert.ok(report.errors.some((error) => /footprint residual|escape child region/.test(error)));
  assert.equal(report.tiles[0].status, "fail");
});

test("rejects a wrong source dataset before producing an alignment pass", async () => {
  const wrongSourcePath = path.join(root, "different-source.geojson");
  await writeFile(wrongSourcePath, JSON.stringify({ type: "FeatureCollection", features: [] }), "utf8");
  await assert.rejects(
    reviewDhaka3DTilesPackageAlignment({ sourcePath: wrongSourcePath, packageDirectory: packagePath }),
    /Source dataset SHA-256 does not match/
  );
});
