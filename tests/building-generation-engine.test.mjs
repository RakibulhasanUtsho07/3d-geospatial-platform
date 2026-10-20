import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeBuildingSpec } from "../src/core/building-generation/building-spec.mjs";
import { generateBuildingModel, planGeneration } from "../src/core/building-generation/generation-engine.mjs";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
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