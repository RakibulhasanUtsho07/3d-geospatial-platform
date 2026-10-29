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
        [90.4100, 23.7800], [90.41005, 23.7800], [90.4101, 23.7800], [90.4101, 23.7801],
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
    },
    {
      type:"Feature",id:"alignment-hole",properties:{class:"building"},
      geometry:{type:"Polygon",coordinates:[
        [[90.4130,23.7800],[90.4131,23.7800],[90.4131,23.7801],[90.4130,23.7801],[90.4130,23.7800]],
        [[90.41303,23.78003],[90.41303,23.78007],[90.41307,23.78007],[90.41307,23.78003],[90.41303,23.78003]]
      ]}
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
  assert.equal(report.summary.tileCount, 4);
  assert.equal(report.tiles.length, 4);
  assert.equal(report.summary.allTransformedVerticesInsideDeclaredRegions, true);
  assert.ok(report.summary.maximumHorizontalResidualMeters <= report.thresholds.maximumHorizontalResidualMeters);
  assert.ok(report.summary.maximumFootprintPerimeterDifferenceMeters <= report.thresholds.maximumHorizontalResidualMeters);
  assert.equal(report.summary.degenerateTriangleCountMaximumAcrossTiles, 0);
  assert.ok(report.tiles.every((tile) => tile.transformQuality.valid && tile.degenerateTriangleCount === 0));
  assert.ok(report.tiles.every((tile) => tile.maximumLocalFootprintBoundaryResidualMeters <= report.thresholds.maximumHorizontalResidualMeters));
  assert.ok(report.tiles.every((tile) => tile.maximumTransformedFootprintBoundaryResidualMeters <= report.thresholds.maximumHorizontalResidualMeters));
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
    assert.ok(tile.transformedGroundVertexCount <= tile.sourceVertexCount, tile.contentUri);
    assert.equal(tile.allTransformedVerticesInsideDeclaredRegion, true, tile.contentUri);
  }
});

test("compares all courtyard boundaries with the emitted GLB", async () => {
  const report=await reviewDhaka3DTilesPackageAlignment({sourcePath,packageDirectory:packagePath});
  const tile=report.tiles.find(item=>item.featureId==="alignment-hole"||item.sourceFeatureId==="alignment-hole");
  assert.ok(tile,"Hole-bearing feature must be evaluated.");
  assert.equal(tile.status,"pass",tile.errors?.join("; "));
  assert.ok(tile.sourceBoundarySegmentCount>=8,"Source segments must include exterior and interior loops.");
  assert.ok(tile.meshBoundarySegmentCount>=8,"GLB boundary segments must include courtyard walls.");
  assert.ok(tile.maximumLocalFootprintBoundaryResidualMeters<=report.thresholds.maximumHorizontalResidualMeters);
  assert.ok(tile.maximumTransformedFootprintBoundaryResidualMeters<=report.thresholds.maximumHorizontalResidualMeters);
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
  assert.ok(report.errors.some((error) => /transform|footprint boundary residual|escape child region/.test(error)));
  assert.equal(report.tiles[0].status, "fail");
});

test("detects a shifted GLB perimeter even when all content hashes are consistently rebound", async () => {
  const damagedPath = path.join(root, "shifted-glb-package");
  await cp(packagePath, damagedPath, { recursive: true });
  const manifestPath = path.join(damagedPath, "build-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const uri = manifest.tiles[0].contentUri;
  const glbPath = path.join(damagedPath, uri);
  const bytes = await readFile(glbPath);
  const jsonLength = bytes.readUInt32LE(12);
  const binaryOffset = 20 + jsonLength + 8;
  const gltf = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
  const accessor = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  const view = gltf.bufferViews[accessor.bufferView];
  const start = binaryOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? 12;
  for (let index = 0; index < accessor.count; index += 1) {
    const offset = start + index * stride;
    bytes.writeFloatLE(bytes.readFloatLE(offset) + 1, offset);
  }
  await writeFile(glbPath, bytes);
  const newHash = sha256(bytes);
  manifest.files[uri] = { sha256: newHash, bytes: bytes.length };
  const tile = manifest.tiles.find((item) => item.contentUri === uri);
  tile.contentSha256 = newHash;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const report = await reviewDhaka3DTilesPackageAlignment({ sourcePath, packageDirectory: damagedPath });
  assert.equal(report.status, "fail");
  assert.ok(report.errors.some((error) => /footprint boundary residual|perimeter difference/.test(error)));
  assert.ok(report.tiles.some((item) => item.contentUri === uri && item.status === "fail"));
});

test("rejects a degenerate indexed triangle even when GLB and package hashes are rebound", async () => {
  const damagedPath = path.join(root, "degenerate-triangle-package");
  await cp(packagePath, damagedPath, { recursive: true });
  const manifestPath = path.join(damagedPath, "build-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const uri = manifest.tiles[0].contentUri;
  const glbPath = path.join(damagedPath, uri);
  const bytes = await readFile(glbPath);
  const jsonLength = bytes.readUInt32LE(12);
  const binaryChunkHeader = 20 + jsonLength;
  const binaryOffset = binaryChunkHeader + 8;
  const gltf = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
  const primitive = gltf.meshes[0].primitives[0];
  const indexAccessor = gltf.accessors[primitive.indices];
  assert.equal(indexAccessor.componentType, 5125, "Fixture should expose uint32 triangle indices.");
  const indexView = gltf.bufferViews[indexAccessor.bufferView];
  const indexOffset = binaryOffset + (indexView.byteOffset ?? 0) + (indexAccessor.byteOffset ?? 0);
  const firstIndex = bytes.readUInt32LE(indexOffset);
  // Collapse the first triangle to one point without changing GLB byte lengths.
  bytes.writeUInt32LE(firstIndex, indexOffset + 4);
  bytes.writeUInt32LE(firstIndex, indexOffset + 8);
  await writeFile(glbPath, bytes);

  const nextHash = sha256(bytes);
  manifest.files[uri] = { sha256: nextHash, bytes: bytes.length };
  const tile = manifest.tiles.find((item) => item.contentUri === uri);
  tile.contentSha256 = nextHash;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const report = await reviewDhaka3DTilesPackageAlignment({ sourcePath, packageDirectory: damagedPath });
  assert.equal(report.status, "fail");
  assert.ok(report.errors.some((error) => /degenerate triangles/.test(error)));
  assert.ok(report.tiles.some((item) => item.contentUri === uri &&
    item.degenerateTriangleCount > 0 && item.status === "fail"));
});

test("rejects a wrong source dataset before producing an alignment pass", async () => {
  const wrongSourcePath = path.join(root, "different-source.geojson");
  await writeFile(wrongSourcePath, JSON.stringify({ type: "FeatureCollection", features: [] }), "utf8");
  await assert.rejects(
    reviewDhaka3DTilesPackageAlignment({ sourcePath: wrongSourcePath, packageDirectory: packagePath }),
    /Source dataset SHA-256 does not match/
  );
});
