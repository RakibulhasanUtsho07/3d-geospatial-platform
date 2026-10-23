import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeBuildingSpec } from "../src/core/building-generation/building-spec.mjs";
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

test("facade-local tangent and exterior normal remain orthogonal for rotated edges",()=>{
 for(const degrees of [0,30,45,90,180,270]){
  const angle=degrees*Math.PI/180;
  const frame=createFacadeFrame({x:0,z:0},{x:10*Math.cos(angle),z:10*Math.sin(angle)});
  assert.ok(Math.abs(frame.len-10)<1e-9,"edge length at "+degrees+" degrees");
  assert.ok(Math.abs(frame.tangent.x*frame.out.x+frame.tangent.z*frame.out.z)<1e-9,"tangent/normal orthogonal at "+degrees+" degrees");
  assert.ok(Math.abs(Math.hypot(frame.out.x,frame.out.z)-1)<1e-9,"unit exterior normal at "+degrees+" degrees");
  const localXAxis={x:Math.cos(frame.yaw),z:-Math.sin(frame.yaw)};
  assert.ok(Math.abs(localXAxis.x-frame.tangent.x)<1e-9,"box local X aligns with facade tangent at "+degrees+" degrees");
  assert.ok(Math.abs(localXAxis.z-frame.tangent.z)<1e-9,"box local X aligns with facade tangent at "+degrees+" degrees");
  const anchor={x:2.1,z:-4.2};
  const moved=offsetFacadePoint(anchor,frame,1.75,0.12);
  const dx=moved.x-anchor.x,dz=moved.z-anchor.z;
  assert.ok(Math.abs(dx*frame.tangent.x+dz*frame.tangent.z-1.75)<1e-9,"tangent offset at "+degrees+" degrees");
  assert.ok(Math.abs(dx*frame.out.x+dz*frame.out.z-0.12)<1e-9,"outward offset at "+degrees+" degrees");
 }
});

test("surface inserts place the inner face at the configured wall-plane clearance",()=>{
 for(const [depth,clearance] of [[0.055,0.002],[0.075,0.002],[0.09,0.003]]){
  const center=surfaceInsertCenterOffset(depth,clearance);
  assert.ok(Math.abs((center-depth/2)-clearance)<1e-12);
 }
 assert.throws(()=>surfaceInsertCenterOffset(0.05,-0.001),/between 0 and 0.05/);
 assert.throws(()=>surfaceInsertCenterOffset(0,0.002),/greater than zero/);
});

test("generated window glass meets the exterior wall plane without the previous half-wall-thickness gap",()=>{
 const built=generateProceduralGlb(fixture);
 const glb=built.glb;
 const jsonLength=glb.readUInt32LE(12);
 const gltf=JSON.parse(glb.subarray(20,20+jsonLength).toString("utf8").trim());
 const binaryStart=28+jsonLength;
 const glassMesh=gltf.meshes.find(mesh=>mesh.name.endsWith("-glass"));
 assert.ok(glassMesh,"generated GLB includes a glass material mesh");
 const positionAccessor=gltf.accessors[glassMesh.primitives[0].attributes.POSITION];
 const view=gltf.bufferViews[positionAccessor.bufferView];
 const start=binaryStart+(view.byteOffset||0)+(positionAccessor.byteOffset||0);
 const positions=[];
 for(let i=0;i<positionAccessor.count;i++){
  const offset=start+i*12;
  positions.push({x:glb.readFloatLE(offset),y:glb.readFloatLE(offset+4),z:glb.readFloatLE(offset+8)});
 }
 const {derived}=normalizeBuildingSpec(fixture);
 for(let edgeIndex=0;edgeIndex<derived.localFootprint.length;edgeIndex++){
  const p=derived.localFootprint[edgeIndex];
  const n=derived.localFootprint[(edgeIndex+1)%derived.localFootprint.length];
  const frame=createFacadeFrame(p,n);
  const distances=positions.map(point=>{
   const dx=point.x-p.x,dz=point.z-p.z;
   return {along:dx*frame.tangent.x+dz*frame.tangent.z,outward:dx*frame.out.x+dz*frame.out.z};
  }).filter(value=>value.along>0.25&&value.along<frame.len-0.25&&value.outward>0&&value.outward<0.1)
    .map(value=>value.outward);
  assert.ok(distances.length>0,"glass samples exist on facade edge "+edgeIndex);
  const nearestFace=Math.min(...distances);
  assert.ok(Math.abs(nearestFace-0.002)<0.0001,"glass inner face is 2 mm outside wall plane, edge "+edgeIndex+" measured "+nearestFace);
  assert.ok(Math.max(...distances)>0.055&&Math.max(...distances)<0.059,"glass thickness extends outward from wall plane, edge "+edgeIndex);
 }
});
