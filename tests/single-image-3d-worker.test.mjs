import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
import { normalizeBuildingSpec } from "../src/core/building-generation/building-spec.mjs";
import { runSingleImage3D } from "../src/core/building-generation/single-image-3d-worker.mjs";
import { generateBuildingAsset } from "../src/core/building-generation/generation-pipeline.mjs";
import { ingestMediaFile, toBuildingSpecSource } from "../src/core/building-generation/media-intake.mjs";

async function workspace(t){const root=await mkdtemp(path.join(os.tmpdir(),"single-image-3d-"));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40,3)]);
const fixture=JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json",import.meta.url),"utf8"));
function glbOkay(buffer){assert.equal(buffer.readUInt32LE(0),0x46546c67);assert.equal(buffer.readUInt32LE(4),2);assert.equal(buffer.readUInt32LE(8),buffer.length);}
function mockedSpawn(_executable,args){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 queueMicrotask(async()=>{
  try{
   const outputDir=args[args.indexOf("--output-dir")+1],meshDir=path.join(outputDir,"0");await mkdir(meshDir,{recursive:true});
   await writeFile(path.join(meshDir,"mesh.glb"),generateProceduralGlb(fixture).glb);
   child.stdout.write("mock TripoSR complete\n");child.emit("close",0,null);
  }catch(error){child.stderr.write(error.message);child.emit("close",1,null);}
 });
 return child;
}
async function setupPhoto(t,root,{usageStatus="approved",licence="CC BY 4.0"}={}){
 await mkdir(path.join(root,"uploads"),{recursive:true});await writeFile(path.join(root,"uploads","facade.png"),png);
 const buildingId="single-photo-demo";
 const ingested=await ingestMediaFile({workspaceRoot:root,sourcePath:"uploads/facade.png",buildingId,sourceId:"facade-image",kind:"image",usageStatus,licence,title:"Facade photograph"});
 const source=toBuildingSpecSource(ingested.record),buildingSpec={...fixture,id:buildingId,sources:[source],evidence:[{field:"floorCount",value:null,confidence:"unknown",sourceIds:["facade-image"]}]};
 return {buildingId,buildingSpec,source};
}
test("requires explicit single-view opt-in and reviewed source licence",async t=>{
 const root=await workspace(t),{buildingId,buildingSpec}=await setupPhoto(t,root);
 const runner=path.join(root,"run.py");await writeFile(runner,"# locally installed TripoSR runner placeholder\n");
 const base={workspaceRoot:root,buildingId,buildingSpec,jobId:"ai-job",sourceId:"facade-image",runnerScript:runner,spawnImpl:mockedSpawn};
 await assert.rejects(runSingleImage3D({...base,allowSingleViewInference:false}),/allowSingleViewInference/);
 const unreviewed={...buildingSpec,sources:buildingSpec.sources.map(s=>({...s,usageStatus:"unreviewed"}))};
 await assert.rejects(runSingleImage3D({...base,buildingSpec:unreviewed,allowSingleViewInference:true}),/match the approved source licence/);
 const unknown={...buildingSpec,sources:buildingSpec.sources.map(s=>({...s,licence:"unknown"}))};
 await assert.rejects(runSingleImage3D({...base,buildingSpec:unknown,allowSingleViewInference:true}),/match the approved source licence/);
});
test("runs a mocked TripoSR command and emits an AI-proposed non-map-ready GLB report",async t=>{
 const root=await workspace(t),{buildingId,buildingSpec}=await setupPhoto(t,root);
 const runner=path.join(root,"run.py");await writeFile(runner,"# locally installed TripoSR runner placeholder\n");
 const result=await runSingleImage3D({
  workspaceRoot:root,buildingId,buildingSpec,jobId:"ai-preview",sourceId:"facade-image",
  runnerScript:runner,allowSingleViewInference:true,device:"cpu",mcResolution:128,spawnImpl:mockedSpawn,
 });
 glbOkay(await readFile(result.modelPath));
 assert.equal(result.report.status,"adapter-output-unverified");assert.equal(result.report.confidence,"unverified-adapter-output");
 assert.equal(result.report.mapReady,false);assert.equal(result.report.publicationEligible,false);
 assert.equal(result.report.executionEvidence.processAdapter,"injected-adapter-unverified");
 assert.equal(result.report.executionEvidence.workerStarted,true);assert.equal(result.report.executionEvidence.workerExitCode,0);
 assert.equal(result.report.executionEvidence.actualInferenceVerified,false);assert.match(result.report.executionEvidence.runnerScriptSha256,/^[a-f0-9]{64}$/);
 assert.equal(result.report.source.sha256,buildingSpec.sources[0].assetId);assert.ok(result.report.outputs.glb.bytes>100);
 const persisted=JSON.parse(await readFile(result.reportPath,"utf8"));assert.equal(persisted.georeference.status,"not-solved");
});
test("generation strategy router can explicitly select the single-image AI preview",async t=>{
 const root=await workspace(t),{buildingId,buildingSpec}=await setupPhoto(t,root);
 const runner=path.join(root,"run.py");await writeFile(runner,"# locally installed TripoSR runner placeholder\\n");
 const result=await generateBuildingAsset(buildingSpec,{strategy:"single-image-ai",singleImage:{
  workspaceRoot:root,jobId:"router-ai",sourceId:"facade-image",runnerScript:runner,allowSingleViewInference:true,device:"cpu",spawnImpl:mockedSpawn
 }});
 assert.equal(result.mode,"single-image-ai");assert.equal(result.report.confidence,"unverified-adapter-output");
 assert.equal(result.report.strategyExecution.actualStrategy,"single-image-ai");assert.equal(result.report.strategyExecution.workerStatus,"adapter-output-unverified");
 assert.equal(result.report.mapReady,false);assert.equal(result.report.publicationEligible,false);
});
test("rejects a GLB without a mesh and records runner failure",async t=>{
 const root=await workspace(t),{buildingId,buildingSpec}=await setupPhoto(t,root);
 const runner=path.join(root,"run.py");await writeFile(runner,"# runner placeholder\n");
 const badSpawn=(_exe,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};queueMicrotask(async()=>{const dir=path.join(args[args.indexOf("--output-dir")+1],"0");await mkdir(dir,{recursive:true});await writeFile(path.join(dir,"mesh.glb"),Buffer.alloc(24));child.emit("close",0,null);});return child;};
 await assert.rejects(runSingleImage3D({workspaceRoot:root,buildingId,buildingSpec,jobId:"bad-glb",sourceId:"facade-image",runnerScript:runner,allowSingleViewInference:true,spawnImpl:badSpawn}),/valid GLB/);
 const report=JSON.parse(await readFile(path.join(root,".building-engine","jobs",buildingId,"bad-glb-single-view","report.json"),"utf8"));
 assert.equal(report.status,"failed");
});
test("rejects unsupported device, out-of-range resolution and mismatched source hash",async t=>{
 const root=await workspace(t),{buildingId,buildingSpec}=await setupPhoto(t,root);
 const runner=path.join(root,"run.py");await writeFile(runner,"# runner placeholder\n");
 const base={workspaceRoot:root,buildingId,buildingSpec,jobId:"invalid",sourceId:"facade-image",runnerScript:runner,allowSingleViewInference:true,spawnImpl:mockedSpawn};
 await assert.rejects(runSingleImage3D({...base,device:"ssh:host"}),/device/);
 await assert.rejects(runSingleImage3D({...base,mcResolution:2048}),/mcResolution/);
 const media=path.join(root,".building-engine","media",buildingId,"assets",buildingSpec.sources[0].assetId+".png");
 await writeFile(media,"tampered");
 await assert.rejects(runSingleImage3D(base),/does not match/);
});