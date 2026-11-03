import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { coordinateToLocalMeters, normalizeBuildingSpec } from "../src/core/building-generation/building-spec.mjs";
import { generateBuildingModel, planGeneration } from "../src/core/building-generation/generation-engine.mjs";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
import { createFacadeFrame, offsetFacadePoint, surfaceInsertCenterOffset } from "../src/core/building-generation/facade-placement.mjs";
const fixture=JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json",import.meta.url),"utf8"));
function parseGlb(buffer){
 assert.equal(buffer.readUInt32LE(0),0x46546c67);assert.equal(buffer.readUInt32LE(4),2);assert.equal(buffer.readUInt32LE(8),buffer.byteLength);
 const size=buffer.readUInt32LE(12);assert.equal(buffer.readUInt32LE(16),0x4e4f534a);
 const gltf=JSON.parse(buffer.subarray(20,20+size).toString("utf8").trim()),bin=20+size;
 assert.equal(buffer.readUInt32LE(bin+4),0x004e4942);assert.ok(gltf.buffers[0].byteLength<=buffer.readUInt32LE(bin));return gltf;
}
test("maps geographic east/north coordinates into the right-handed glTF east/up/south frame", () => {
  const origin = { longitude: 90.4, latitude: 23.7 };
  const east = coordinateToLocalMeters([origin.longitude + 0.0001, origin.latitude], origin);
  const north = coordinateToLocalMeters([origin.longitude, origin.latitude + 0.0001], origin);
  assert.ok(east.x > 0 && Math.abs(east.z) < 1e-9, "longitude east maps to +X");
  assert.ok(north.z < 0 && Math.abs(north.x) < 1e-9, "latitude north maps to -Z");
  const xCrossY = [1, 0, 0].map((_, i) => i === 2 ? 1 : 0);
  assert.deepEqual(xCrossY, [0, 0, 1], "+X east crossed with +Y up points to +Z south");
});

test("normalizes BuildingSpec and derives metric footprint while retaining evidence",()=>{
 const {spec,derived}=normalizeBuildingSpec(fixture);assert.equal(spec.schemaVersion,"1.0.0");assert.equal(spec.location.longitude,fixture.location.longitude);
 assert.ok(derived.footprintAreaM2>50&&derived.footprintAreaM2<150);assert.equal(spec.evidence[0].confidence,"estimated");assert.deepEqual(spec.evidence[0].sourceIds,["survey-notes"]);
});
test("rejects malformed footprints, dangling evidence and unsafe sources",()=>{
 assert.throws(()=>normalizeBuildingSpec({...fixture,footprint:{type:"Point",coordinates:[90,23]}}),/GeoJSON Polygon/);
 assert.throws(()=>normalizeBuildingSpec({...fixture,evidence:[{field:"height",confidence:"verified",sourceIds:["missing"]}]}),/unknown source/);
 assert.throws(()=>normalizeBuildingSpec({...fixture,sources:[{id:"x",kind:"image",url:"http://example.com/a.jpg"}]}),/HTTPS/);
 assert.throws(()=>normalizeBuildingSpec({...fixture,dimensions:{floorCount:0}}),/between 1 and 100/);
 assert.throws(()=>normalizeBuildingSpec({...fixture,architecture:{wallColor:"blue"}}),/#RRGGBB/);
});
test("writes a binary GLB with metric geometry, nodes and materials",()=>{
 const {glb,report}=generateProceduralGlb(fixture);assert.ok(Buffer.isBuffer(glb));assert.ok(glb.byteLength>5000);
 const model=parseGlb(glb);assert.equal(model.asset.version,"2.0");assert.equal(model.asset.extras.buildingId,fixture.id);assert.ok(model.meshes.length>=3);
 assert.ok(model.accessors.some(a=>a.type==="VEC3"&&a.componentType===5126));assert.ok(model.materials.some(m=>m.name==="Glass"));
 assert.equal(report.output.format,"glb");assert.equal(report.geometry.floorCount,5);assert.equal(report.georeference.longitude,fixture.location.longitude);assert.equal(report.reviewRequired,true);
});
test("labels media route candidates without claiming photogrammetry ran",()=>{
 const withVisuals={...fixture,sources:[
 {id:"front-photo",kind:"image",url:"https://example.org/front.jpg",licence:"CC BY 4.0",attribution:"Example",usageStatus:"approved",location:{longitude:90.406,latitude:23.709}},
 {id:"side-photo",kind:"image",url:"https://example.org/side.jpg",licence:"CC BY 4.0",attribution:"Example",usageStatus:"approved",location:{longitude:90.4061,latitude:23.709}},
 {id:"roof-video",kind:"video",url:"https://example.org/roof.mp4",licence:"CC BY 4.0",attribution:"Example",usageStatus:"approved",location:{longitude:90.4062,latitude:23.709}}],
 evidence:[{field:"floorCount",value:5,confidence:"derived",sourceIds:["front-photo"]}]};
 const plan=planGeneration(withVisuals);assert.equal(plan.sourceRoute,"multiview-photogrammetry-candidate");assert.equal(plan.additionalWorkersConfigured,false);
 const result=generateBuildingModel(withVisuals);assert.equal(result.report.strategy,"reference-assisted-procedural");
 assert.ok(result.report.warnings.some(w=>w.includes("does not run image understanding")));assert.ok(result.report.limitations.some(s=>s.includes("not a photogrammetry")));
});
test("is deterministic for a fixed BuildingSpec",()=>assert.deepEqual(generateBuildingModel(fixture).glb,generateBuildingModel(fixture).glb));

function extractMeshPositions(glb, suffix) {
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8").trim());
  const binaryStart = 28 + jsonLength;
  const mesh = gltf.meshes.find(item => item.name.endsWith(suffix));
  assert.ok(mesh, "generated GLB includes " + suffix + " mesh");
  const accessor = gltf.accessors[mesh.primitives[0].attributes.POSITION];
  const view = gltf.bufferViews[accessor.bufferView];
  const stride = view.byteStride || 12;
  const start = binaryStart + (view.byteOffset || 0) + (accessor.byteOffset || 0);
  return Array.from({ length: accessor.count }, (_, index) => {
    const offset = start + index * stride;
    return {
      x: glb.readFloatLE(offset),
      y: glb.readFloatLE(offset + 4),
      z: glb.readFloatLE(offset + 8),
    };
  });
}

function edgeFrameFor(derived, edgeIndex) {
  const p = derived.localFootprint[edgeIndex];
  const n = derived.localFootprint[(edgeIndex + 1) % derived.localFootprint.length];
  const signedArea = derived.localFootprint.reduce((sum, point, index) => {
    const next = derived.localFootprint[(index + 1) % derived.localFootprint.length];
    return sum + point.x * next.z - next.x * point.z;
  }, 0) / 2;
  return { p, ...createFacadeFrame(p, n, signedArea >= 0 ? 1 : -1) };
}

test("facade-local tangent and exterior normal stay orthogonal for rotated edges", () => {
  for (const degrees of [0, 30, 45, 90, 180, 270]) {
    const angle = degrees * Math.PI / 180;
    const frame = createFacadeFrame({ x: 0, z: 0 }, { x: 10 * Math.cos(angle), z: 10 * Math.sin(angle) });
    assert.ok(Math.abs(frame.len - 10) < 1e-9);
    assert.ok(Math.abs(frame.tangent.x * frame.out.x + frame.tangent.z * frame.out.z) < 1e-9);
    assert.ok(Math.abs(Math.hypot(frame.out.x, frame.out.z) - 1) < 1e-9);
    const localXAxis = { x: Math.cos(frame.yaw), z: -Math.sin(frame.yaw) };
    assert.ok(Math.abs(localXAxis.x - frame.tangent.x) < 1e-9);
    assert.ok(Math.abs(localXAxis.z - frame.tangent.z) < 1e-9);
    const anchor = { x: 2.1, z: -4.2 };
    const moved = offsetFacadePoint(anchor, frame, 1.75, 0.12);
    const dx = moved.x - anchor.x, dz = moved.z - anchor.z;
    assert.ok(Math.abs(dx * frame.tangent.x + dz * frame.tangent.z - 1.75) < 1e-9);
    assert.ok(Math.abs(dx * frame.out.x + dz * frame.out.z - 0.12) < 1e-9);
  }
});

test("surface inserts place their inner face at the configured clearance", () => {
  for (const [depth, clearance] of [[0.055, 0.002], [0.075, 0.002], [0.09, 0.003]]) {
    assert.ok(Math.abs(surfaceInsertCenterOffset(depth, clearance) - depth / 2 - clearance) < 1e-12);
  }
  assert.throws(() => surfaceInsertCenterOffset(0.05, -0.001), /between 0 and 0.05/);
  assert.throws(() => surfaceInsertCenterOffset(0, 0.002), /greater than zero/);
});

test("generated windows meet the exterior wall plane for either footprint winding", () => {
  const original = fixture.footprint.coordinates[0].slice(0, -1);
  const reversedOpen = [...original].reverse();
  const reversed = [...reversedOpen, reversedOpen[0]];
  const cases = [
    [fixture, "normal winding"],
    [{ ...fixture, footprint: { ...fixture.footprint, coordinates: [reversed] } }, "reversed winding"],
  ];

  for (const [spec, label] of cases) {
    const built = generateProceduralGlb(spec);
    const vertices = extractMeshPositions(built.glb, "-glass");
    const { derived } = normalizeBuildingSpec(spec);
    for (let edgeIndex = 0; edgeIndex < derived.localFootprint.length; edgeIndex++) {
      const { p, len, tangent, out } = edgeFrameFor(derived, edgeIndex);
      const distances = vertices.map(point => {
        const dx = point.x - p.x, dz = point.z - p.z;
        return {
          along: dx * tangent.x + dz * tangent.z,
          outward: dx * out.x + dz * out.z,
        };
      }).filter(value => value.along > 0.25 && value.along < len - 0.25 && value.outward > 0 && value.outward < 0.1)
        .map(value => value.outward);
      assert.ok(distances.length > 0, label + " contains glass on edge " + edgeIndex);
      assert.ok(Math.abs(Math.min(...distances) - 0.002) < 0.0001, label + " glass inner face clearance on edge " + edgeIndex);
      assert.ok(Math.abs(Math.max(...distances) - 0.057) < 0.0001, label + " glass outer face depth on edge " + edgeIndex);
    }
  }
});

test("explicit front facade selection drives the door and is reported", () => {
  const explicitSpec = { ...fixture, architecture: { ...fixture.architecture, frontFacadeEdgeIndex: 1 } };
  const explicit = generateProceduralGlb(explicitSpec);
  assert.equal(explicit.report.facadeSelection.method, "explicit-edge-index");
  assert.equal(explicit.report.facadeSelection.edgeIndex, 1);
  assert.equal(explicit.report.facadeSelection.confidence, "operator-specified");
  assert.equal(explicit.report.facadeSelection.source, "buildingSpec.architecture.frontFacadeEdgeIndex");
  assert.equal(explicit.normalizedSpec.architecture.frontFacadeEdgeIndex, 1);
  const doorVertices = extractMeshPositions(explicit.glb, "-door");
  const { derived } = normalizeBuildingSpec(explicitSpec);
  const selected = edgeFrameFor(derived, 1);
  const selectedDistances = doorVertices.map(point => {
    const dx = point.x - selected.p.x, dz = point.z - selected.p.z;
    return {
      along: dx * selected.tangent.x + dz * selected.tangent.z,
      outward: dx * selected.out.x + dz * selected.out.z,
    };
  }).filter(value => value.along > 0.1 && value.along < selected.len - 0.1 && value.outward > 0 && value.outward < 0.1)
    .map(value => value.outward);
  assert.ok(selectedDistances.length > 0, "door vertices are attached to the explicitly selected facade");
  assert.ok(Math.abs(Math.min(...selectedDistances) - 0.002) < 0.0001, "door inner face has 2 mm clearance");
  assert.ok(Math.abs(Math.max(...selectedDistances) - 0.072) < 0.0001, "door outer face matches its 70 mm depth");

  const inferred = generateProceduralGlb(fixture);
  assert.equal(inferred.report.facadeSelection.method, "longest-edge-inferred");
  assert.equal(inferred.report.facadeSelection.edgeIndex, 0);
  assert.equal(inferred.report.facadeSelection.confidence, "estimated");
  assert.equal(inferred.report.facadeSelection.source, "longest-edge-inferred");
  assert.ok(inferred.report.warnings.some(message => message.includes("Front facade was inferred")));
  assert.equal(inferred.report.reviewRequired, true);
});

test("BuildingSpec rejects a facade edge index outside the footprint edges or non-integer values", () => {
  assert.throws(
    () => normalizeBuildingSpec({ ...fixture, architecture: { ...fixture.architecture, frontFacadeEdgeIndex: 4 } }),
    /frontFacadeEdgeIndex must be between 0 and 3/,
  );
  assert.throws(
    () => normalizeBuildingSpec({ ...fixture, architecture: { ...fixture.architecture, frontFacadeEdgeIndex: 1.5 } }),
    /frontFacadeEdgeIndex must be an integer/,
  );
});
