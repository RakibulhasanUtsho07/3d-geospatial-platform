import assert from "node:assert/strict";
import test from "node:test";
import {extractGlbGeometry,validateAffineMatrix4x4} from "../src/core/building-generation/glb-geometry-extraction.mjs";
import {BOX_TRIANGLES,MODEL_TO_EVALUATION,TARGET_CHECK_POINTS,TARGET_FOOTPRINT,TARGET_VERTICES,createBuildingGlb} from "./fixtures/glb-geometry-fixture.mjs";
const options={coordinateFrameId:"test-building-frame-y-up-v1",units:"m",modelToEvaluationFrameMatrix4x4:MODEL_TO_EVALUATION};

test("extracts actual GLB accessors and applies scene-node plus registration transforms",()=>{
  const result=extractGlbGeometry(createBuildingGlb(),options);
  assert.deepEqual(result.dimensionsM,{widthM:2,heightM:3,depthM:4});
  assert.deepEqual(result.footprint,TARGET_FOOTPRINT);
  assert.equal(result.surfaceMesh.triangles.length,BOX_TRIANGLES.length);
  assert.deepEqual(result.surfaceMesh.vertices,BOX_TRIANGLES.flatMap(face=>face.map(index=>TARGET_VERTICES[index])));
  assert.equal(result.extractionSummary.sourceVertexCount,8);
  assert.equal(result.extractionSummary.sourceTriangleCount,12);
  assert.equal(result.extractionSummary.surfaceSampling.sampledTriangleCount,12);
  assert.match(result.extractionSummary.footprintMethod,/not a surveyed wall footprint/);
});
test("repeated extraction of identical bytes and transform is deterministic",()=>{
  const bytes=createBuildingGlb();
  assert.deepEqual(extractGlbGeometry(bytes,options),extractGlbGeometry(bytes,options));
});
test("fails closed on invalid header length and external buffers",()=>{
  const bad=Buffer.from(createBuildingGlb());bad.writeUInt32LE(bad.length+4,8);
  assert.throws(()=>extractGlbGeometry(bad,options),/declared length/);
  assert.throws(()=>extractGlbGeometry(createBuildingGlb(j=>{j.buffers[0].uri="mesh.bin";}),options),/External\/data-URI buffers/);
});
test("rejects sparse, compressed and animated inputs without fabricating vertices",()=>{
  assert.throws(()=>extractGlbGeometry(createBuildingGlb(j=>{j.accessors[0].sparse={count:1,indices:{},values:{}};}),options),/sparse accessors/);
  assert.throws(()=>extractGlbGeometry(createBuildingGlb(j=>{j.meshes[0].primitives[0].extensions={KHR_draco_mesh_compression:{}};}),options),/Draco compression/);
  assert.throws(()=>extractGlbGeometry(createBuildingGlb(j=>{j.animations=[{}];}),options),/Animated GLBs/);
});
test("validates transform shape, finiteness, affine row and invertibility",()=>{
  assert.throws(()=>validateAffineMatrix4x4([1,0,0]),/16 column-major/);
  assert.throws(()=>validateAffineMatrix4x4([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]),/invertible/);
  assert.throws(()=>validateAffineMatrix4x4([1,0,0,1,0,1,0,0,0,0,1,0,0,0,0,1]),/must be affine/);
  assert.throws(()=>extractGlbGeometry(createBuildingGlb(),{...options,units:"ft"}),/metres/);
});

test("extracts held-out candidate checkpoints from exact GLB POSITION vertices",()=>{
  const result=extractGlbGeometry(createBuildingGlb(),{
    ...options,
    checkPointBindings:[
      {id:"survey-check-01",nodeIndex:1,primitiveIndex:0,vertexIndex:0},
      {id:"survey-check-02",nodeIndex:1,primitiveIndex:0,vertexIndex:1},
      {id:"survey-check-03",nodeIndex:1,primitiveIndex:0,vertexIndex:6},
    ],
  });
  assert.deepEqual(result.checkPoints,TARGET_CHECK_POINTS);
  assert.equal(result.extractionSummary.checkPointCount,3);
  assert.match(result.extractionSummary.checkPointMethod,/actual GLB/);
});
test("rejects candidate checkpoint bindings that do not identify rendered vertices",()=>{
  assert.throws(()=>extractGlbGeometry(createBuildingGlb(),{
    ...options,checkPointBindings:[{id:"missing-point",nodeIndex:1,primitiveIndex:0,vertexIndex:999}],
  }),/outside the primitive POSITION accessor/);
  assert.throws(()=>extractGlbGeometry(createBuildingGlb(),{
    ...options,checkPointBindings:[{id:"x",nodeIndex:1,primitiveIndex:0,vertexIndex:0},{id:"x",nodeIndex:1,primitiveIndex:0,vertexIndex:1}],
  }),/duplicate ID/);
});
test("rejects line-only or degenerate mesh geometry",()=>{
  assert.throws(()=>extractGlbGeometry(createBuildingGlb(j=>{j.meshes[0].primitives[0].mode=1;}),options),/no supported triangle geometry/);
  assert.throws(()=>extractGlbGeometry(createBuildingGlb(j=>{j.accessors[1].count=2;}),options),/multiple of three/);
});
