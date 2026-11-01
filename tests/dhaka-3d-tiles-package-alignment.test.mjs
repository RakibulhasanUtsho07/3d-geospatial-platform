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
      properties: {
        type: "building",
        has_parts: true,
        class: "building",
        height: 18,
        min_height: 2.5,
        facade_material: "brick",
        facade_color: "#a53",
        roof_shape: "gabled",
        roof_height: 2.5,
        roof_direction: 0,
        roof_orientation: "along",
      },
      geometry: { type: "Polygon", coordinates: [[
        [90.4100, 23.7800], [90.41005, 23.7800], [90.4101, 23.7800], [90.4101, 23.7801],
        [90.4100, 23.7801], [90.4100, 23.7800]
      ]] }
    },
    {
      type: "Feature",
      id: "alignment-min-floor",
      properties: { class: "building", height: 16, min_floor: 2 },
      geometry: { type: "Polygon", coordinates: [[
        [90.4140, 23.7800], [90.4142, 23.7800], [90.4142, 23.7802],
        [90.4140, 23.7802], [90.4140, 23.7800]
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

function rewriteGlbJson(bytes, gltf) {
  const oldJsonLength = bytes.readUInt32LE(12);
  const binaryHeaderOffset = 20 + oldJsonLength;
  const binaryLength = bytes.readUInt32LE(binaryHeaderOffset);
  const binaryChunkType = bytes.readUInt32LE(binaryHeaderOffset + 4);
  const binaryChunk = bytes.subarray(binaryHeaderOffset + 8, binaryHeaderOffset + 8 + binaryLength);
  const jsonBytes = Buffer.from(JSON.stringify(gltf), "utf8");
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 0x20)]);
  const paddedBinary = Buffer.concat([binaryChunk, Buffer.alloc((4 - binaryChunk.length % 4) % 4)]);
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBinary.length;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(paddedBinary.length, 0);
  binaryHeader.writeUInt32LE(binaryChunkType, 4);
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, paddedBinary]);
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
  assert.equal(report.summary.tileCount, 5);
  assert.equal(report.tiles.length, 5);
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

test("aligns the source footprint with a non-zero Overture min_height base and top", async () => {
  const sourceDerivedPackage = path.join(root, "source-derived-package");
  await buildDhaka3DTilesPackage({
    sourcePath,
    outputPath: sourceDerivedPackage,
    maxFeatures: 16,
  });
  const report = await reviewDhaka3DTilesPackageAlignment({
    sourcePath,
    packageDirectory: sourceDerivedPackage,
  });
  assert.equal(report.status, "pass", report.errors.join("; "));
  const tile = report.tiles.find((item) => item.featureId === "alignment-square");
  assert.ok(tile);
  assert.equal(tile.heightProvenance.heightMeters, 18);
  assert.equal(tile.architectureEvidence.sourceSchema, "overture-buildings-2.0.0");
  assert.equal(tile.architectureEvidence.compositionStatus, "parent-declares-associated-parts");
  assert.deepEqual(tile.architectureEvidence.facade.material, { status: "source", value: "brick" });
  assert.deepEqual(tile.architectureEvidence.roof.shape, { status: "source", value: "gabled" });
  assert.equal(tile.architectureEvidence.roof.geometryStatus, "source-roof-shape-and-height-present-geometry-not-yet-generated");
  assert.equal(tile.heightProvenance.baseHeightMeters, 2.5);
  assert.equal(tile.heightProvenance.topHeightMeters, 20.5);
  assert.ok(tile.transformedEllipsoidHeightRangeMeters.base.minimum >= 2.49);
  assert.ok(tile.transformedEllipsoidHeightRangeMeters.top.maximum <= 20.51);
  assert.equal(tile.allTransformedVerticesInsideDeclaredRegion, true);
});

test("resolves min_floor as a labelled base-height estimate and verifies it in world space", async () => {
  const sourceDerivedPackage = path.join(root, "min-floor-source-derived-package");
  await buildDhaka3DTilesPackage({ sourcePath, outputPath: sourceDerivedPackage, maxFeatures: 16 });
  const report = await reviewDhaka3DTilesPackageAlignment({
    sourcePath,
    packageDirectory: sourceDerivedPackage,
  });
  assert.equal(report.status, "pass", report.errors.join("; "));
  const tile = report.tiles.find((item) => item.featureId === "alignment-min-floor");
  assert.ok(tile);
  assert.equal(tile.heightProvenance.heightMeters, 16);
  assert.equal(tile.heightProvenance.baseHeightMeters, 6);
  assert.equal(tile.heightProvenance.topHeightMeters, 22);
  assert.equal(tile.heightProvenance.baseHeightSource, "min-floor-estimate");
  assert.equal(tile.heightProvenance.baseHeightEstimated, true);
  assert.equal(tile.heightProvenance.reportedMinFloor, 2);
  assert.equal(tile.heightProvenance.reportedMinHeightMeters, null);
  assert.equal(tile.heightProvenance.minHeightApplication, "min-floor-proxy-applied-as-relative-above-ground-offset");
  assert.ok(tile.transformedEllipsoidHeightRangeMeters.base.minimum >= 5.99);
  assert.ok(tile.transformedEllipsoidHeightRangeMeters.top.maximum <= 22.01);
});

test("rejects architecture metadata drift between the source feature, GLB and build manifest", async () => {
  const damagedPath = path.join(root, "architecture-evidence-drift-package");
  await cp(packagePath, damagedPath, { recursive: true });
  const manifestPath = path.join(damagedPath, "build-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.tiles[0].architectureEvidence.roof.shape.value = "flat";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const report = await reviewDhaka3DTilesPackageAlignment({ sourcePath, packageDirectory: damagedPath });
  assert.equal(report.status, "fail");
  assert.ok(report.errors.some((error) => /architecture evidence does not match/i.test(error)));
});

test("rejects architecture metadata consistently rebound in GLB and manifest when source disagrees", async () => {
  const damagedPath = path.join(root, "architecture-source-tamper-package");
  await cp(packagePath, damagedPath, { recursive: true });
  const manifestPath = path.join(damagedPath, "build-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const tile = manifest.tiles.find((item) => item.featureId === "alignment-square");
  assert.ok(tile);
  const glbPath = path.join(damagedPath, tile.contentUri);
  const glb = await readFile(glbPath);
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.toString("utf8", 20, 20 + jsonLength));
  gltf.extras.architectureEvidence.roof.shape.value = "flat";
  tile.architectureEvidence.roof.shape.value = "flat";
  const forgedGlb = rewriteGlbJson(glb, gltf);
  await writeFile(glbPath, forgedGlb);
  const forgedHash = sha256(forgedGlb);
  tile.contentSha256 = forgedHash;
  tile.bytes = forgedGlb.length;
  manifest.files[tile.contentUri] = { sha256: forgedHash, bytes: forgedGlb.length };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const report = await reviewDhaka3DTilesPackageAlignment({ sourcePath, packageDirectory: damagedPath });
  assert.equal(report.status, "fail");
  assert.ok(report.errors.some((error) => /architecture evidence does not match/i.test(error)));
});

test("rejects manifest height provenance drift even if the GLB hash is unchanged", async () => {
  const damagedPath = path.join(root, "height-provenance-drift-package");
  await cp(packagePath, damagedPath, { recursive: true });
  const manifestPath = path.join(damagedPath, "build-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.tiles[0].heightEvidence.baseHeightMeters = 1;
  manifest.tiles[0].heightEvidence.topHeightMeters = 9;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const report = await reviewDhaka3DTilesPackageAlignment({ sourcePath, packageDirectory: damagedPath });
  assert.equal(report.status, "fail");
  assert.ok(report.errors.some((error) => /height provenance does not match/i.test(error)));
});

test("rejects source-height claims that are self-consistent in GLB and manifest but disagree with source properties", async () => {
  const sourceDerivedPackage = path.join(root, "source-height-tamper-package");
  await buildDhaka3DTilesPackage({
    sourcePath,
    outputPath: sourceDerivedPackage,
    maxFeatures: 16,
  });

  const manifestPath = path.join(sourceDerivedPackage, "build-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const tile = manifest.tiles.find((item) => item.featureId === "alignment-square");
  assert.ok(tile);
  const glbPath = path.join(sourceDerivedPackage, tile.contentUri);
  const glb = await readFile(glbPath);
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.toString("utf8", 20, 20 + jsonLength));

  // The source fixture says height=18m and min_height=2.5m. Rebind a forged
  // 19m/21.5m interval consistently in both GLB and manifest, then rehash it.
  // The reviewer must still reject it by recomputing from the source feature.
  gltf.extras.heightMeters = 19;
  gltf.extras.unclampedHeightMeters = 19;
  gltf.extras.topHeightMeters = 21.5;
  tile.heightEvidence.heightMeters = 19;
  tile.heightEvidence.unclampedHeightMeters = 19;
  tile.heightEvidence.topHeightMeters = 21.5;

  const forgedGlb = rewriteGlbJson(glb, gltf);
  await writeFile(glbPath, forgedGlb);
  const forgedHash = sha256(forgedGlb);
  tile.contentSha256 = forgedHash;
  tile.bytes = forgedGlb.length;
  manifest.files[tile.contentUri] = { sha256: forgedHash, bytes: forgedGlb.length };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const report = await reviewDhaka3DTilesPackageAlignment({
    sourcePath,
    packageDirectory: sourceDerivedPackage,
  });
  assert.equal(report.status, "fail");
  assert.ok(report.errors.some((error) =>
    /height provenance does not match/i.test(error),
  ));
});
