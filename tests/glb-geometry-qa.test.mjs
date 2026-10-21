import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";

const fixture=JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json",import.meta.url),"utf8"));
function makeGlb(positions,indices){
 const p=Buffer.alloc(positions.length*4);positions.forEach((value,index)=>p.writeFloatLE(value,index*4));
 const index=Buffer.alloc(indices.length*2);indices.forEach((value,i)=>index.writeUInt16LE(value,i*2));
 const pad=(buffer)=>buffer.length%4?Buffer.concat([buffer,Buffer.alloc(4-buffer.length%4)]):buffer;
 const binary=pad(Buffer.concat([p,index]));
 const gltf={
  asset:{version:"2.0",generator:"GLB geometry QA test"},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
  meshes:[{primitives:[{attributes:{POSITION:0},indices:1,mode:4}]}],
  accessors:[
   {bufferView:0,componentType:5126,count:positions.length/3,type:"VEC3"},
   {bufferView:1,componentType:5123,count:indices.length,type:"SCALAR"}
  ],
  bufferViews:[
   {buffer:0,byteOffset:0,byteLength:p.length,target:34962},
   {buffer:0,byteOffset:p.length,byteLength:index.length,target:34963}
  ],buffers:[{byteLength:p.length+index.length}],
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

test("detects degenerate triangles for operator review",()=>{
 const glb=makeGlb([0,0,0,1,0,0,2,0,0],[0,1,2]),report=analyzeGlbQuality(glb);
 assert.equal(report.counts.degenerateTriangleCount,1);assert.ok(report.warnings.includes("degenerate-triangles-present"));
 assert.ok(report.warnings.includes("degenerate-triangle-ratio-exceeds-threshold"));
});
test("rejects malformed GLB data, invalid indices and non-finite coordinates",()=>{
 assert.throws(()=>analyzeGlbQuality(Buffer.from("not a glb")),/GLB 2.0/);
 assert.throws(()=>analyzeGlbQuality(makeGlb([0,0,0,1,0,0,0,1,0],[0,1,9])),/outside its POSITION accessor/);
 assert.throws(()=>analyzeGlbQuality(makeGlb([0,0,0,1,0,0,Number.NaN,1,0],[0,1,2])),/non-finite/);
});
test("bounds vertex scanning to guard a malformed or unexpectedly huge asset",()=>{
 const glb=makeGlb([0,0,0,1,0,0,0,1,0],[0,1,2]);
 assert.throws(()=>analyzeGlbQuality(glb,{maxVertices:2}),/maxVertices/);
});
