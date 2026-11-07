import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";

const fixture=JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json",import.meta.url),"utf8"));
function makeGlb(positions,indices=null,sceneGraph={}){
 const p=Buffer.alloc(positions.length*4);positions.forEach((value,index)=>p.writeFloatLE(value,index*4));
 const hasIndices=Array.isArray(indices);
 const index=hasIndices?Buffer.alloc(indices.length*2):Buffer.alloc(0);
 if(hasIndices)indices.forEach((value,i)=>index.writeUInt16LE(value,i*2));
 const pad=(buffer)=>buffer.length%4?Buffer.concat([buffer,Buffer.alloc(4-buffer.length%4)]):buffer;
 const binary=pad(hasIndices?Buffer.concat([p,index]):p);
 const primitive={attributes:{POSITION:0},mode:4};
 if(hasIndices)primitive.indices=1;
 const accessors=[{bufferView:0,componentType:5126,count:positions.length/3,type:"VEC3"}];
 const bufferViews=[{buffer:0,byteOffset:0,byteLength:p.length,target:34962}];
 if(hasIndices){
  accessors.push({bufferView:1,componentType:5123,count:indices.length,type:"SCALAR"});
  bufferViews.push({buffer:0,byteOffset:p.length,byteLength:index.length,target:34963});
 }
 const gltf={
  asset:{version:"2.0",generator:"GLB geometry QA test"},
  ...(Object.hasOwn(sceneGraph,"scene")?{scene:sceneGraph.scene}:{scene:0}),
  ...(Object.hasOwn(sceneGraph,"scenes")?{scenes:sceneGraph.scenes}:{scenes:[{nodes:[0]}]}),
  ...(Object.hasOwn(sceneGraph,"nodes")?{nodes:sceneGraph.nodes}:{nodes:[{mesh:0}]}),
  meshes:[{primitives:[primitive]}],
  accessors,
  bufferViews,buffers:[{byteLength:p.length+index.length}],
  materials:[{name:"test"}]
 };
 const jsonRaw=Buffer.from(JSON.stringify(gltf)),jsonPad=(4-jsonRaw.length%4)%4,json=Buffer.concat([jsonRaw,Buffer.alloc(jsonPad,0x20)]);
 const total=12+8+json.length+8+binary.length,header=Buffer.alloc(12);
 header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(total,8);
 const jh=Buffer.alloc(8);jh.writeUInt32LE(json.length,0);jh.writeUInt32LE(0x4e4f534a,4);
 const bh=Buffer.alloc(8);bh.writeUInt32LE(binary.length,0);bh.writeUInt32LE(0x004e4942,4);
 return Buffer.concat([header,jh,json,bh,binary]);
}
test("reports mesh counts, finite bounds and numeric QA for a generated procedural GLB",()=>{
 const {glb}=generateProceduralGlb(fixture),report=analyzeGlbQuality(glb);
 assert.equal(report.valid,true);assert.equal(report.format,"glb");
 assert.ok(report.counts.meshCount>=3);assert.ok(report.counts.vertexCount>100);assert.ok(report.counts.triangleCount>100);
 assert.ok(report.bounds.dimensions.every(value=>Number.isFinite(value)&&value>0));
 assert.ok(["basic-geometry-check-passed","review-recommended"].includes(report.status));
 assert.ok(report.limitations.some(text=>text.includes("architectural fidelity")));
});
test("reports a small valid triangle as a review recommendation instead of claiming accuracy",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]),report=analyzeGlbQuality(glb);
 assert.equal(report.valid,true);assert.equal(report.counts.vertexCount,3);assert.equal(report.counts.triangleCount,1);
 assert.equal(report.counts.degenerateTriangleCount,0);assert.ok(report.warnings.includes("very-small-triangle-count"));
 assert.ok(report.bounds.dimensions[0]===1&&report.bounds.dimensions[1]===1);
});
test("includes topology review hints in the final GLB quality report",()=>{
 const glb=makeGlb([
  0,0,0,1,0,0,0,1,0,
  20,0,0,21,0,0,20,1,0
 ],[0,1,2,3,4,5]);
 const report=analyzeGlbQuality(glb);
 const topology=report.meshDetails[0].topology;
 assert.equal(topology.connectedComponentCount,2);
 assert.equal(topology.smallDetachedComponentCount,1);
 assert.ok(report.warnings.includes("disconnected-mesh-components-present"));
 assert.ok(report.warnings.includes("small-detached-components-present"));
 assert.ok(report.warnings.includes("open-boundary-edges-present"));
});

test("ignores unreferenced positions for model bounds and topology scale while reporting them",()=>{
 const glb=makeGlb([
  0,0,0,1,0,0,0,1,0,
  1000000,-1000000,2000000
 ],[0,1,2]);
 const report=analyzeGlbQuality(glb),topology=report.meshDetails[0].topology;
 assert.equal(report.counts.vertexCount,4);
 assert.equal(report.counts.referencedVertexCount,3);
 assert.equal(report.counts.unreferencedVertexCount,1);
 assert.equal(report.meshDetails[0].referencedVertexCount,3);
 assert.equal(report.meshDetails[0].unreferencedVertexCount,1);
 assert.deepEqual(report.bounds.min,[0,0,0]);
 assert.deepEqual(report.bounds.max,[1,1,0]);
 assert.deepEqual(report.bounds.dimensions,[1,1,0]);
 assert.equal(topology.modelDiagonal,Number(Math.SQRT2.toFixed(6)));
 assert.equal(topology.referencedVertexCount,3);
 assert.equal(topology.unreferencedVertexCount,1);
 assert.equal(topology.topologyAnalyzed,true);
 assert.ok(report.warnings.includes("unreferenced-vertices-present"));
 assert.ok(!report.warnings.includes("long-triangle-edges-present"));
});

test("treats every POSITION entry as referenced for a non-indexed TRIANGLES primitive",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0]);
 const report=analyzeGlbQuality(glb),topology=report.meshDetails[0].topology;
 assert.equal(report.counts.vertexCount,3);
 assert.equal(report.counts.referencedVertexCount,3);
 assert.equal(report.counts.unreferencedVertexCount,0);
 assert.equal(report.meshDetails[0].referencedVertexCount,3);
 assert.equal(report.meshDetails[0].unreferencedVertexCount,0);
 assert.equal(topology.referencedVertexCount,3);
 assert.equal(topology.unreferencedVertexCount,0);
 assert.deepEqual(report.bounds.min,[0,0,0]);
 assert.deepEqual(report.bounds.max,[1,1,0]);
 assert.ok(!report.warnings.includes("unreferenced-vertices-present"));
});

test("applies node translation and non-uniform scale to active-scene aggregate bounds",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{nodes:[{mesh:0,translation:[10,20,30],scale:[2,3,4]}],scenes:[{nodes:[0]}]});
 const report=analyzeGlbQuality(glb);
 assert.deepEqual(report.bounds.min,[10,20,30]);assert.deepEqual(report.bounds.max,[12,23,30]);assert.deepEqual(report.bounds.dimensions,[2,3,0]);
 assert.equal(report.bounds.units,"scene-space-unverified");assert.equal(report.counts.meshInstanceCount,1);
 assert.equal(report.meshDetails[0].sceneInstanceCount,1);assert.equal(report.meshDetails[0].topologyCoordinateSpace,"mesh-local");
 assert.equal(report.meshDetails[0].topology.modelDiagonal,Number(Math.SQRT2.toFixed(6)));assert.equal(report.scene.boundsSpace,"scene-space-unverified");
});
test("applies node quaternion rotation to aggregate axis-aligned bounds",()=>{
 const rotation=Math.SQRT1_2,glb=makeGlb([0,0,0,1,0,0,0,2,0],[0,1,2],{nodes:[{mesh:0,rotation:[0,0,rotation,rotation]}],scenes:[{nodes:[0]}]});
 const report=analyzeGlbQuality(glb);
 assert.ok(Math.abs(report.bounds.min[0]+2)<1e-6);assert.ok(Math.abs(report.bounds.min[1])<1e-6);
 assert.ok(Math.abs(report.bounds.max[0])<1e-6);assert.ok(Math.abs(report.bounds.max[1]-1)<1e-6);
});
test("composes parent and child node transforms in glTF hierarchy order",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{nodes:[{translation:[10,5,0],children:[1]},{mesh:0,scale:[2,3,1]}],scenes:[{nodes:[0]}]});
 const report=analyzeGlbQuality(glb);assert.deepEqual(report.bounds.min,[10,5,0]);assert.deepEqual(report.bounds.max,[12,8,0]);assert.equal(report.counts.sceneNodeCount,2);
});
test("includes every active-scene instance when one mesh is referenced by multiple nodes",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{nodes:[{mesh:0,translation:[10,0,0]},{mesh:0,translation:[0,20,0]}],scenes:[{nodes:[0,1]}]});
 const report=analyzeGlbQuality(glb);assert.deepEqual(report.bounds.min,[0,0,0]);assert.deepEqual(report.bounds.max,[11,21,0]);
 assert.equal(report.counts.meshInstanceCount,2);assert.equal(report.meshDetails[0].sceneInstanceCount,2);assert.equal(report.counts.boundsVertexEvaluations,6);
});
test("supports explicit column-major affine node matrices",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{nodes:[{mesh:0,matrix:[2,0,0,0,0,3,0,0,0,0,1,0,10,20,30,1]}],scenes:[{nodes:[0]}]});
 const report=analyzeGlbQuality(glb);assert.deepEqual(report.bounds.min,[10,20,30]);assert.deepEqual(report.bounds.max,[12,23,30]);
});
test("falls back to explicit mesh-local bounds when scene graph data is absent",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{nodes:null,scenes:null}),report=analyzeGlbQuality(glb);
 assert.deepEqual(report.bounds.min,[0,0,0]);assert.deepEqual(report.bounds.max,[1,1,0]);assert.equal(report.bounds.units,"mesh-local-unverified");
 assert.ok(report.warnings.includes("scene-graph-unavailable-mesh-local-bounds-fallback"));
});
test("uses only the declared default scene when a GLB contains multiple scenes",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{
  scene:1,
  nodes:[{mesh:0,translation:[100,0,0]},{mesh:0,translation:[-30,0,0]}],
  scenes:[{nodes:[0]},{nodes:[1]}]
 });
 const report=analyzeGlbQuality(glb);
 assert.deepEqual(report.bounds.min,[-30,0,0]);assert.deepEqual(report.bounds.max,[-29,1,0]);assert.equal(report.scene.index,1);
});

test("excludes mesh definitions not instanced in the active scene from aggregate bounds",()=>{
 const original=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]);
 const bytes=Buffer.from(original);
 const jsonLength=bytes.readUInt32LE(12);
 const json=JSON.parse(bytes.subarray(20,20+jsonLength).toString("utf8").trim());
 const primitive=json.meshes[0].primitives[0];
 json.meshes.push({primitives:[primitive]});
 json.nodes.push({mesh:1,translation:[1000,0,0]});
 json.scenes=[{nodes:[0]}];
 json.nodes=[{mesh:0},{mesh:1,translation:[1000,0,0]}];
 json.buffers[0].byteLength=bytes.length-28-jsonLength;
 const jsonRaw=Buffer.from(JSON.stringify(json)),jsonPad=(4-jsonRaw.length%4)%4,newJson=Buffer.concat([jsonRaw,Buffer.alloc(jsonPad,0x20)]);
 const binary=bytes.subarray(20+jsonLength+8);
 const newTotal=12+8+newJson.length+8+binary.length,header=Buffer.alloc(12);
 header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(newTotal,8);
 const jh=Buffer.alloc(8);jh.writeUInt32LE(newJson.length,0);jh.writeUInt32LE(0x4e4f534a,4);
 const bh=Buffer.alloc(8);bh.writeUInt32LE(binary.length,0);bh.writeUInt32LE(0x004e4942,4);
 const glb=Buffer.concat([header,jh,newJson,bh,binary]);
 const report=analyzeGlbQuality(glb);
 assert.deepEqual(report.bounds.min,[0,0,0]);assert.deepEqual(report.bounds.max,[1,1,0]);
 assert.ok(report.warnings.includes("uninstanced-mesh-definitions-excluded-from-scene-bounds"));
 assert.equal(report.counts.meshInstanceCount,1);
});

test("fails closed on invalid node transforms, hierarchy cycles and duplicate parenting",()=>{
 const positions=[0,0,0,1,0,0,0,1,0],indices=[0,1,2];
 const malformedMatrix=makeGlb(positions,indices,{nodes:[{mesh:0,matrix:[1,0,0,0.2,0,1,0,0,0,0,1,0,0,0,0,1]}],scenes:[{nodes:[0]}]});
 const mixedTransforms=makeGlb(positions,indices,{nodes:[{mesh:0,matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],translation:[1,0,0]}],scenes:[{nodes:[0]}]});
 const invalidRotation=makeGlb(positions,indices,{nodes:[{mesh:0,rotation:[0,0,0,0]}],scenes:[{nodes:[0]}]});
 const cyclic=makeGlb(positions,indices,{nodes:[{children:[0],mesh:0}],scenes:[{nodes:[0]}]});
 const duplicateParent=makeGlb(positions,indices,{nodes:[{children:[2]},{children:[2]},{mesh:0}],scenes:[{nodes:[0,1]}]});
 const invalidMesh=makeGlb(positions,indices,{nodes:[{mesh:5}],scenes:[{nodes:[0]}]});
 assert.throws(()=>analyzeGlbQuality(malformedMatrix),/matrix must be affine/);
 assert.throws(()=>analyzeGlbQuality(mixedTransforms),/matrix and TRS/);
 assert.throws(()=>analyzeGlbQuality(invalidRotation),/normalized quaternion/);
 assert.throws(()=>analyzeGlbQuality(cyclic),/contains a cycle/);
 assert.throws(()=>analyzeGlbQuality(duplicateParent),/referenced more than once/);
 assert.throws(()=>analyzeGlbQuality(invalidMesh),/invalid mesh index/);
});
test("bounds evaluation has a strict per-report vertex budget",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]);
 assert.throws(()=>analyzeGlbQuality(glb,{maxSceneBoundsVertexEvaluations:2}),/maxSceneBoundsVertexEvaluations/);
});

test("detects degenerate triangles for operator review",()=>{
 const glb=makeGlb([0,0,0,1,0,0,2,0,0],[0,1,2]),report=analyzeGlbQuality(glb);
 assert.equal(report.counts.degenerateTriangleCount,1);assert.ok(report.warnings.includes("degenerate-triangles-present"));
 assert.ok(report.warnings.includes("degenerate-triangle-ratio-exceeds-threshold"));
});
test("rejects malformed GLB data, invalid indices and non-finite coordinates",()=>{
 assert.throws(()=>analyzeGlbQuality(Buffer.from("not a glb")),/GLB 2.0/);
 assert.throws(()=>analyzeGlbQuality(makeGlb([0,0,0,1,0,0,0,1,0],[0,1,9])),/outside its POSITION accessor/);
 assert.throws(()=>analyzeGlbQuality(makeGlb([0,0,0,1,0,0,Number.NaN,1,0],[0,1,2])),/non-finite/);
 assert.throws(()=>analyzeGlbQuality(makeGlb([0,0,0,1,0,0,0,1,0,Number.NaN,1,2],[0,1,2])),/non-finite/);
});
test("bounds vertex scanning to guard a malformed or unexpectedly huge asset",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]);
 assert.throws(()=>analyzeGlbQuality(glb,{maxVertices:2}),/maxVertices/);
 const unusedVertex=makeGlb([0,0,0,1,0,0,0,1,0,1000000,1000000,1000000],[0,1,2]);
 assert.throws(()=>analyzeGlbQuality(unusedVertex,{maxVertices:3}),/exceeds maximum geometry QA vertex count 3/);
});
