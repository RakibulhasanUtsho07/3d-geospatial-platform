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
function unpackGlb(glb){
 const jsonLength=glb.readUInt32LE(12);
 const json=JSON.parse(glb.subarray(20,20+jsonLength).toString("utf8").trim());
 const binaryStart=20+jsonLength+8;
 const binary=Buffer.from(glb.subarray(binaryStart));
 const declaredLength=json.buffers?.[0]?.byteLength??binary.length;
 return {json,binary:binary.subarray(0,declaredLength)};
}
function packGlb(json,binary){
 json.buffers??=[{byteLength:binary.length}];
 json.buffers[0].byteLength=binary.length;
 const jsonRaw=Buffer.from(JSON.stringify(json)),jsonPad=(4-jsonRaw.length%4)%4;
 const jsonChunk=Buffer.concat([jsonRaw,Buffer.alloc(jsonPad,0x20)]);
 const binPad=(4-binary.length%4)%4,binChunk=binPad?Buffer.concat([binary,Buffer.alloc(binPad)]):binary;
 const total=12+8+jsonChunk.length+8+binChunk.length,header=Buffer.alloc(12);
 header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(total,8);
 const jh=Buffer.alloc(8);jh.writeUInt32LE(jsonChunk.length,0);jh.writeUInt32LE(0x4e4f534a,4);
 const bh=Buffer.alloc(8);bh.writeUInt32LE(binChunk.length,0);bh.writeUInt32LE(0x004e4942,4);
 return Buffer.concat([header,jh,jsonChunk,bh,binChunk]);
}
function addSparseView(state,bytes,alignment=4,viewExtra={}){
 const padding=(alignment-state.binary.length%alignment)%alignment;
 if(padding)state.binary=Buffer.concat([state.binary,Buffer.alloc(padding)]);
 const byteOffset=state.binary.length;
 state.binary=Buffer.concat([state.binary,bytes]);
 return state.json.bufferViews.push({buffer:0,byteOffset,byteLength:bytes.length,...viewExtra})-1;
}
function encodeUInt(values,componentType){
 const bytes=componentType===5121?1:componentType===5123?2:4;
 const buffer=Buffer.alloc(values.length*bytes);
 values.forEach((value,index)=>{
  if(bytes===1)buffer.writeUInt8(value,index);
  else if(bytes===2)buffer.writeUInt16LE(value,index*bytes);
  else buffer.writeUInt32LE(value,index*bytes);
 });
 return buffer;
}
function encodeFloat(values){
 const buffer=Buffer.alloc(values.length*4);
 values.forEach((value,index)=>buffer.writeFloatLE(value,index*4));
 return buffer;
}
function mutateGlb(glb,mutator){
 const state=unpackGlb(glb);
 state.json.bufferViews??=[];
 mutator(state);
 return packGlb(state.json,state.binary);
}
test("applies sparse POSITION replacements over a dense base accessor",()=>{
 const glb=mutateGlb(makeGlb([0,0,0,0,0,0,0,0,0],[0,1,2]),state=>{
  const indexView=addSparseView(state,Buffer.from([1,2]),1);
  const valueView=addSparseView(state,encodeFloat([1,0,0,0,1,0]),4);
  state.json.accessors[0].sparse={count:2,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const report=analyzeGlbQuality(glb);
 assert.deepEqual(report.bounds.min,[0,0,0]);assert.deepEqual(report.bounds.max,[1,1,0]);
 assert.equal(report.counts.referencedVertexCount,3);assert.equal(report.counts.degenerateTriangleCount,0);
});

test("validates dense POSITION values after sparse replacements are applied",()=>{
 const makeOverlay=(nonFiniteVertex)=>mutateGlb(makeGlb([
  0,0,0,0,0,0,0,1,0
 ],[0,1,2]),state=>{
  if(nonFiniteVertex!==null)state.binary.writeFloatLE(Number.NaN,nonFiniteVertex*12);
  const indexView=addSparseView(state,Buffer.from([1]),1);
  const valueView=addSparseView(state,encodeFloat([1,0,0]),4);
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const overridden=analyzeGlbQuality(makeOverlay(1));
 assert.deepEqual(overridden.bounds.min,[0,0,0]);
 assert.deepEqual(overridden.bounds.max,[1,1,0]);
 assert.equal(overridden.counts.degenerateTriangleCount,0);
 assert.throws(()=>analyzeGlbQuality(makeOverlay(0)),/non-finite vertex coordinate at vertex 0/);
});

test("supports zero-initialized POSITION accessors without a base bufferView",()=>{
 const glb=mutateGlb(makeGlb([0,0,0,0,0,0,0,0,0],[0,1,2]),state=>{
  delete state.json.accessors[0].bufferView;
  const indexView=addSparseView(state,Buffer.from([1,2]),1);
  const valueView=addSparseView(state,encodeFloat([1,0,0,0,1,0]),4);
  state.json.accessors[0].sparse={count:2,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const report=analyzeGlbQuality(glb);
 assert.deepEqual(report.bounds.max,[1,1,0]);assert.equal(report.meshDetails[0].topology.modelDiagonal,Number(Math.SQRT2.toFixed(6)));
});

test("applies sparse primitive index replacements before triangle validation",()=>{
 const glb=mutateGlb(makeGlb([0,0,0,1,0,0,0,1,0],[0,0,0]),state=>{
  const indexView=addSparseView(state,Buffer.from([1,2]),1);
  const valueView=addSparseView(state,encodeUInt([1,2],5123),4);
  state.json.accessors[1].sparse={count:2,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const report=analyzeGlbQuality(glb);
 assert.equal(report.counts.triangleCount,1);assert.equal(report.counts.degenerateTriangleCount,0);
 assert.equal(report.meshDetails[0].topology.connectedComponentCount,1);
});

test("supports sparse index values with an omitted zero-initialized base bufferView",()=>{
 const glb=mutateGlb(makeGlb([0,0,0,1,0,0,0,1,0],[0,0,0]),state=>{
  delete state.json.accessors[1].bufferView;
  const indexView=addSparseView(state,encodeUInt([0,1,2],5121),1);
  const valueView=addSparseView(state,encodeUInt([0,1,2],5123),4);
  state.json.accessors[1].sparse={count:3,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const report=analyzeGlbQuality(glb);
 assert.equal(report.counts.degenerateTriangleCount,0);assert.deepEqual(report.bounds.dimensions,[1,1,0]);
});

test("supports each glTF unsigned sparse-index component width",()=>{
 for(const componentType of [5121,5123,5125]){
  const align=componentType===5121?1:componentType===5123?2:4;
  const glb=mutateGlb(makeGlb([0,0,0,1,0,0,0,1,0],[0,0,0]),state=>{
   const indexView=addSparseView(state,encodeUInt([1,2],componentType),align);
   const valueView=addSparseView(state,encodeUInt([1,2],5123),4);
   state.json.accessors[1].sparse={count:2,indices:{bufferView:indexView,componentType},values:{bufferView:valueView}};
  });
  assert.equal(analyzeGlbQuality(glb).counts.degenerateTriangleCount,0);
 }
});

test("rejects sparse accessor counts outside valid bounds and above configured caps",()=>{
 const base=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]);
 const tooMany=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1,2,3,4]),1),valueView=addSparseView(state,encodeFloat([1,0,0,0,1,0,2,0,0,3,0,0]),4);
  state.json.accessors[0].sparse={count:4,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const overCap=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1,2]),1),valueView=addSparseView(state,encodeFloat([1,0,0,0,1,0]),4);
  state.json.accessors[0].sparse={count:2,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 assert.throws(()=>analyzeGlbQuality(tooMany),/sparse count exceeds accessor count/);
 assert.throws(()=>analyzeGlbQuality(overCap,{maxSparseEntries:1}),/maximum sparse entry count 1/);
});

test("rejects duplicate, decreasing and out-of-range sparse indices",()=>{
 const make=(indices)=>mutateGlb(makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]),state=>{
  const indexView=addSparseView(state,Buffer.from(indices),1),valueView=addSparseView(state,encodeFloat(Array(indices.length*3).fill(0)),4);
  state.json.accessors[0].sparse={count:indices.length,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 assert.throws(()=>analyzeGlbQuality(make([1,1])),/strictly increasing/);
 assert.throws(()=>analyzeGlbQuality(make([2,1])),/strictly increasing/);
 assert.throws(()=>analyzeGlbQuality(make([3])),/outside its accessor count/);
});

test("rejects unsupported sparse index components and non-finite replacement coordinates",()=>{
 const unsupported=mutateGlb(makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]),state=>{
  const indexView=addSparseView(state,Buffer.from([1]),1),valueView=addSparseView(state,encodeFloat([Number.NaN,0,0]),4);
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5126},values:{bufferView:valueView}};
 });
 const nonFinite=mutateGlb(makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]),state=>{
  const indexView=addSparseView(state,Buffer.from([1]),1),valueView=addSparseView(state,encodeFloat([Number.NaN,0,0]),4);
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 assert.throws(()=>analyzeGlbQuality(unsupported),/sparse indices componentType/);
 assert.throws(()=>analyzeGlbQuality(nonFinite),/non-finite coordinate/);
});

test("rejects sparse bufferView target or stride metadata and out-of-range payloads",()=>{
 const base=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]);
 const withTarget=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1]),1,{target:34962}),valueView=addSparseView(state,encodeFloat([1,0,0]),4);
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const withStride=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1]),1),valueView=addSparseView(state,encodeFloat([1,0,0]),4,{byteStride:12});
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const shortValues=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1]),1),valueView=addSparseView(state,encodeFloat([1,0]),4);
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 assert.throws(()=>analyzeGlbQuality(withTarget),/must not define target or byteStride/);
 assert.throws(()=>analyzeGlbQuality(withStride),/must not define target or byteStride/);
 assert.throws(()=>analyzeGlbQuality(shortValues),/sparse values exceed their bufferView/);
});

test("rejects sparse buffer references and misaligned sparse offsets",()=>{
 const base=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]);
 const external=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1]),1),valueView=addSparseView(state,encodeFloat([1,0,0]),4);
  state.json.bufferViews[indexView].buffer=1;
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const misaligned=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([0,1]),1),valueView=addSparseView(state,encodeFloat([1,0,0]),4);
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,byteOffset:1,componentType:5123},values:{bufferView:valueView}};
 });
 assert.throws(()=>analyzeGlbQuality(external),/must reference the embedded GLB buffer/);
 assert.throws(()=>analyzeGlbQuality(misaligned),/sparse indices byteOffset is not aligned/);
});

test("rejects misaligned sparse bufferView offsets and sparse values offsets",()=>{
 const base=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]);
 const badIndexViewOffset=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1]),1),valueView=addSparseView(state,encodeFloat([1,0,0]),4);
  state.json.bufferViews[indexView].byteOffset+=1;
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5123},values:{bufferView:valueView}};
 });
 const badValuesOffset=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1]),1),valueView=addSparseView(state,encodeFloat([1,0,0]),4);
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView,byteOffset:1}};
 });
 assert.throws(()=>analyzeGlbQuality(badIndexViewOffset),/bufferView byteOffset is not aligned/);
 assert.throws(()=>analyzeGlbQuality(badValuesOffset),/sparse values byteOffset is not aligned/);
});

test("rejects missing sparse count and short sparse index payloads",()=>{
 const base=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]);
 const missingCount=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1]),1),valueView=addSparseView(state,encodeFloat([1,0,0]),4);
  state.json.accessors[0].sparse={indices:{bufferView:indexView,componentType:5121},values:{bufferView:valueView}};
 });
 const shortIndices=mutateGlb(base,state=>{
  const indexView=addSparseView(state,Buffer.from([1]),2),valueView=addSparseView(state,encodeFloat([1,0,0]),4);
  state.json.accessors[0].sparse={count:1,indices:{bufferView:indexView,componentType:5123},values:{bufferView:valueView}};
 });
 assert.throws(()=>analyzeGlbQuality(missingCount),/sparse count must be a valid/);
 assert.throws(()=>analyzeGlbQuality(shortIndices),/sparse indices exceed their bufferView/);
});

test("accepts an omitted base bufferView with no sparse overrides as a zero-initialized accessor",()=>{
 const glb=mutateGlb(makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]),state=>{
  delete state.json.accessors[0].bufferView;
 });
 const report=analyzeGlbQuality(glb);
 assert.deepEqual(report.bounds.dimensions,[0,0,0]);
 assert.equal(report.counts.degenerateTriangleCount,1);
});

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
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{nodes:undefined,scenes:undefined}),report=analyzeGlbQuality(glb);
 assert.deepEqual(report.bounds.min,[0,0,0]);assert.deepEqual(report.bounds.max,[1,1,0]);assert.equal(report.bounds.units,"mesh-local-unverified");
 assert.ok(report.warnings.includes("scene-graph-unavailable-mesh-local-bounds-fallback"));
 assert.equal(report.counts.meshInstanceCount,0);assert.equal(report.counts.boundsTransformCount,1);
 assert.equal(report.meshDetails[0].sceneInstanceCount,0);assert.equal(report.meshDetails[0].boundsTransformCount,1);
 assert.equal(report.scene.localFallback,true);
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

test("preserves scene node count when selected scene has nodes but no mesh instances",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{
  nodes:[{translation:[5,0,0]}],scenes:[{nodes:[0]}]
 });
 const report=analyzeGlbQuality(glb);
 assert.deepEqual(report.bounds.min,[0,0,0]);assert.deepEqual(report.bounds.max,[1,1,0]);
 assert.equal(report.counts.sceneNodeCount,1);assert.equal(report.counts.meshInstanceCount,0);
 assert.equal(report.counts.boundsTransformCount,1);assert.equal(report.scene.localFallback,true);
 assert.ok(report.warnings.includes("selected-scene-has-no-mesh-instances-local-bounds-fallback"));
});

test("bounds the node definition array before allocating traversal state",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{
  nodes:[{mesh:0},{translation:[1,0,0]}],scenes:[{nodes:[0]}]
 });
 assert.throws(()=>analyzeGlbQuality(glb,{maxSceneNodes:1}),/node definition array exceeds maxSceneNodes/);
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
test("rejects malformed scene metadata instead of silently falling back",()=>{
 const positions=[0,0,0,1,0,0,0,1,0],indices=[0,1,2];
 const badNodes=makeGlb(positions,indices,{nodes:null,scenes:[{nodes:[0]}]});
 const badScenes=makeGlb(positions,indices,{nodes:[{mesh:0}],scenes:null});
 const emptyScenes=makeGlb(positions,indices,{nodes:[{mesh:0}],scenes:[]});
 assert.throws(()=>analyzeGlbQuality(badNodes),/nodes must be an array/);
 assert.throws(()=>analyzeGlbQuality(badScenes),/scenes must be an array/);
 assert.throws(()=>analyzeGlbQuality(emptyScenes),/at least one scene/);
});

test("rejects an invalid default scene index and invalid root node index",()=>{
 const positions=[0,0,0,1,0,0,0,1,0],indices=[0,1,2];
 const badScene=makeGlb(positions,indices,{scene:1,nodes:[{mesh:0}],scenes:[{nodes:[0]}]});
 const badRoot=makeGlb(positions,indices,{nodes:[{mesh:0}],scenes:[{nodes:[3]}]});
 assert.throws(()=>analyzeGlbQuality(badScene),/default scene index is outside/);
 assert.throws(()=>analyzeGlbQuality(badRoot),/invalid node index/);
});

test("enforces the scene mesh-instance limit",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{
  nodes:[{mesh:0},{mesh:0,translation:[5,0,0]}],scenes:[{nodes:[0,1]}]
 });
 assert.throws(()=>analyzeGlbQuality(glb,{maxSceneMeshInstances:1}),/maxSceneMeshInstances 1/);
});

test("bounds evaluation budget is applied across repeated mesh instances",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2],{
  nodes:[{mesh:0},{mesh:0,translation:[5,0,0]}],scenes:[{nodes:[0,1]}]
 });
 assert.throws(()=>analyzeGlbQuality(glb,{maxSceneBoundsVertexEvaluations:5}),/maxSceneBoundsVertexEvaluations 5/);
});

test("fails closed on non-finite composed parent-child transforms and malformed child arrays",()=>{
 const positions=[0,0,0,1,0,0,0,1,0],indices=[0,1,2];
 const overflow=makeGlb(positions,indices,{nodes:[{scale:[1.7e308,1,1],children:[1]},{mesh:0,scale:[2,1,1]}],scenes:[{nodes:[0]}]});
 const badChildren=makeGlb(positions,indices,{nodes:[{children:3,mesh:0}],scenes:[{nodes:[0]}]});
 assert.throws(()=>analyzeGlbQuality(overflow),/non-finite composed node transform/);
 assert.throws(()=>analyzeGlbQuality(badChildren),/children must be an array/);
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
