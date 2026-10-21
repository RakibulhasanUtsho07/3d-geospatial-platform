import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runMediaToModelWorkflow } from "../src/core/building-generation/media-to-model-workflow.mjs";
import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import { reviewBuildingSource } from "../src/core/building-generation/source-workflow.mjs";

const fixture=JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json",import.meta.url),"utf8"));
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(128,31)]);
const EARTH_RADIUS_M=6378137;
function makeControlPoints(){
 const scale=2.5,theta=30*Math.PI/180,c=Math.cos(theta),s=Math.sin(theta),lon0=90.4,lat0=23.7,tx=100,ty=200;
 return [[-10,-8],[10,-8],[10,8],[-10,8]].map(([modelX,modelZ],index)=>{
  const east=scale*(c*modelX-s*modelZ)+tx,north=scale*(s*modelX+c*modelZ)+ty;
  return {id:"workflow-gcp-"+(index+1),modelX,modelZ,
   longitude:lon0+east/(EARTH_RADIUS_M*Math.cos(lat0*Math.PI/180))*180/Math.PI,
   latitude:lat0+north/EARTH_RADIUS_M*180/Math.PI,
   evidenceSourceId:"survey-control"};
 });
}
async function workspace(t){
 const root=await mkdtemp(path.join(os.tmpdir(),"media-to-model-workflow-"));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return root;
}
async function addExistingApprovedPhoto(root,sourceId="existing-front"){
 await mkdir(path.join(root,"uploads"),{recursive:true});
 await writeFile(path.join(root,"uploads",sourceId+".png"),Buffer.concat([png,Buffer.from(sourceId)]));
 const ingested=await ingestMediaFile({workspaceRoot:root,sourcePath:"uploads/"+sourceId+".png",buildingId:fixture.id,sourceId,kind:"image",title:"Existing photo"});
 await reviewBuildingSource({workspaceRoot:root,buildingId:fixture.id,sourceId,licence:"CC BY 4.0",confirmRights:true,attribution:"Test rights attestation"});
 return ingested;
}
test("runs a complete local image intake → rights record → BuildingSpec sync → procedural GLB → QA report",async t=>{
 const root=await workspace(t);
 await mkdir(path.join(root,"uploads"));
 await writeFile(path.join(root,"uploads","front.png"),Buffer.concat([png,Buffer.from("front-photo")]));
 const result=await runMediaToModelWorkflow({
  workspaceRoot:root,buildingSpec:fixture,jobId:"end-to-end-image",strategy:"procedural",confirmRights:true,
  sources:[{sourceId:"front-photo",relativePath:"uploads/front.png",licence:"CC BY 4.0",author:"Test photographer",attribution:"Test source credit"}],
 });
 const bytes=await readFile(result.modelPath),spec=JSON.parse(await readFile(result.specPath,"utf8"));
 const manifest=JSON.parse(await readFile(result.reportPath,"utf8"));
 assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);
 assert.equal(manifest.status,"completed-requires-review");assert.equal(manifest.mode,"procedural");
 assert.equal(manifest.mapReady,false);assert.equal(manifest.publicationEligible,false);
 assert.equal(spec.sources.find(source=>source.id==="front-photo").licence,"CC BY 4.0");
 assert.equal(spec.sources.find(source=>source.id==="front-photo").usageStatus,"approved");
 assert.ok(manifest.modelReport.geometryQuality.counts.triangleCount>0);
 assert.equal(manifest.inputs.mediaRecords[0].sha256,spec.sources.find(source=>source.id==="front-photo").assetId);
 assert.ok((await stat(result.modelPath)).size>100);
});
test("runs information-only procedural generation without requiring a media view",async t=>{
 const root=await workspace(t);
 const result=await runMediaToModelWorkflow({workspaceRoot:root,buildingSpec:fixture,jobId:"spec-only",strategy:"procedural",sources:[]});
 assert.equal(result.report.mode,"procedural");assert.equal(result.report.status,"completed-requires-review");
 assert.ok((await readFile(result.modelPath)).subarray(0,4).equals(Buffer.from([0x67,0x6c,0x54,0x46])));
 assert.deepEqual(result.report.inputs.selectedViewIds,[]);
});
test("attaches ground-control registration to the workflow report but still blocks auto-publication",async t=>{
 const root=await workspace(t);
 const result=await runMediaToModelWorkflow({
  workspaceRoot:root,buildingSpec:fixture,jobId:"gcp-registered",strategy:"procedural",sources:[],
  controlPoints:makeControlPoints(),maxGcpRmsErrorM:0.5,maxGcpResidualM:1,
 });
 const report=JSON.parse(await readFile(result.reportPath,"utf8"));
 assert.equal(report.georeference.status,"calibrated-needs-human-review");
 assert.ok(Math.abs(report.georeference.transform.metresPerModelUnit-2.5)<1e-4);
 assert.ok(report.georeference.controls.rmsErrorM<0.002);
 assert.equal(report.georeference.vertical.status,"not-solved");
 assert.equal(report.mapReady,false);assert.equal(report.publicationEligible,false);
});
test("requires explicit rights attestation and a known licence before media ingestion",async t=>{
 const root=await workspace(t);await mkdir(path.join(root,"uploads"));await writeFile(path.join(root,"uploads","front.png"),png);
 await assert.rejects(runMediaToModelWorkflow({
  workspaceRoot:root,buildingSpec:fixture,jobId:"rights-missing",strategy:"procedural",
  sources:[{sourceId:"front-photo",relativePath:"uploads/front.png",licence:"CC BY 4.0"}],confirmRights:false,
 }),/confirmRights/);
 await assert.rejects(runMediaToModelWorkflow({
  workspaceRoot:root,buildingSpec:fixture,jobId:"licence-unknown",strategy:"procedural",
  sources:[{sourceId:"front-photo",relativePath:"uploads/front.png",licence:"unknown"}],confirmRights:true,
 }),/known licence/);
 await assert.rejects(stat(path.join(root,".building-engine")),/ENOENT/);
});
test("can use an already-ingested, reviewed image selected by source ID without importing it twice",async t=>{
 const root=await workspace(t);await addExistingApprovedPhoto(root,"saved-photo");
 const result=await runMediaToModelWorkflow({
  workspaceRoot:root,buildingSpec:fixture,jobId:"existing-photo",strategy:"procedural",sources:[],viewSourceIds:["saved-photo"],
 });
 const spec=JSON.parse(await readFile(result.specPath,"utf8"));
 assert.ok(spec.sources.some(source=>source.id==="saved-photo"&&source.usageStatus==="approved"));
 assert.deepEqual(result.report.inputs.selectedViewIds,["saved-photo"]);
});
test("rejects absolute media paths, path traversal, and incomplete reconstruction confirmations",async t=>{
 const root=await workspace(t);await mkdir(path.join(root,"uploads"));await writeFile(path.join(root,"uploads","front.png"),png);
 await assert.rejects(runMediaToModelWorkflow({
  workspaceRoot:root,buildingSpec:fixture,jobId:"absolute-path",sources:[{sourceId:"a",relativePath:path.resolve(root,"uploads/front.png"),licence:"CC BY 4.0"}],confirmRights:true,
 }),/must be relative/);
 await assert.rejects(runMediaToModelWorkflow({
  workspaceRoot:root,buildingSpec:fixture,jobId:"traversal",sources:[{sourceId:"a",relativePath:"../outside.png",licence:"CC BY 4.0"}],confirmRights:true,
 }),/escapes workspaceRoot/);
 await assert.rejects(runMediaToModelWorkflow({
  workspaceRoot:root,buildingSpec:fixture,jobId:"missing-overlap",strategy:"photogrammetry",sources:[],viewSourceIds:["one","two","three"],upAxis:"Z",confirmSameBuilding:true,confirmOverlapReviewed:false,confirmUpAxisReviewed:true,
 }),/photogrammetry requires/);
});
