import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { convertTexturedPlyToGlb } from "../src/core/building-generation/textured-ply-to-glb.mjs";
import { runColmapReconstruction } from "../src/core/building-generation/colmap-worker.mjs";
import { generateBuildingAsset } from "../src/core/building-generation/generation-pipeline.mjs";
import { ingestMediaFile, toBuildingSpecSource } from "../src/core/building-generation/media-intake.mjs";

async function workspace(t){const root=await mkdtemp(path.join(os.tmpdir(),"building-recon-"));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40,9)]);
const fixture=JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json",import.meta.url),"utf8"));
function asciiPly(withUv=true){
 const props="property float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\n";
 return Buffer.from("ply\nformat ascii 1.0\nelement vertex 3\n"+props+"element face 1\nproperty list uchar int vertex_indices\n"+(withUv?"property list uchar float texcoord\n":"")+"end_header\n0 0 0 0 0 1\n1 0 0 0 0 1\n0 1 0 0 0 1\n"+(withUv?"3 0 1 2 6 0 0 1 0 0 1\n":"3 0 1 2\n"));
}
function binaryPly(){
 const header=Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nproperty list uchar float texcoord\nend_header\n"),body=[];
 for(const v of [[0,0,0],[1,0,0],[0,1,0]]){const b=Buffer.alloc(12);v.forEach((x,i)=>b.writeFloatLE(x,i*4));body.push(b);}
 const face=Buffer.alloc(1+12+1+24);face.writeUInt8(3,0);[0,1,2].forEach((x,i)=>face.writeInt32LE(x,1+i*4));face.writeUInt8(6,13);[0,0,1,0,0,1].forEach((x,i)=>face.writeFloatLE(x,14+i*4));body.push(face);
 return Buffer.concat([header,...body]);
}
function glbJson(buffer){
 assert.equal(buffer.readUInt32LE(0),0x46546c67);assert.equal(buffer.readUInt32LE(4),2);assert.equal(buffer.readUInt32LE(8),buffer.length);
 const jsonLen=buffer.readUInt32LE(12);assert.equal(buffer.readUInt32LE(16),0x4e4f534a);return JSON.parse(buffer.subarray(20,20+jsonLen).toString("utf8").trim());
}
function mockedColmapSpawn(_executable,args){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 queueMicrotask(async()=>{
  try{
   if(args[0]==="automatic_reconstructor"){
    const workspacePath=args[args.indexOf("--workspace_path")+1],out=path.join(workspacePath,"dense","0");
    await mkdir(out,{recursive:true});await writeFile(path.join(out,"meshed-poisson.ply"),asciiPly(false));
   }else if(args[0]==="mesh_texturer"){
    const outputPath=args[args.indexOf("--output_path")+1];await mkdir(outputPath,{recursive:true});
    await writeFile(path.join(outputPath,"mesh.ply"),asciiPly(true));await writeFile(path.join(outputPath,"texture.png"),png);
   }else throw new Error("unexpected mock COLMAP command "+args[0]);
   child.emit("close",0,null);
  }catch(error){child.stderr.write(error.message);child.emit("close",1,null);}
 });
 return child;
}
async function setupApprovedViews(t,root,buildingId="demo-build"){
 const dir=path.join(root,"uploads");await mkdir(dir,{recursive:true});const sources=[];
 for(let i=0;i<3;i++){
  const file="view-"+(i+1)+".png",bytes=Buffer.concat([png,Buffer.from([i+1])]);await writeFile(path.join(dir,file),bytes);
  const ingested=await ingestMediaFile({workspaceRoot:root,sourcePath:"uploads/"+file,buildingId,sourceId:"view-"+(i+1),kind:"image",licence:"CC BY 4.0",usageStatus:"approved",title:file,captureLocation:{longitude:90.406+i*0.00001,latitude:23.709}});
  sources.push(toBuildingSpecSource(ingested.record));
 }
 const buildingSpec={...fixture,id:buildingId,sources,evidence:[{field:"floorCount",value:5,confidence:"estimated",sourceIds:["view-1"]}]};
 return {sources,buildingSpec};
}

test("converts ASCII textured PLY into a valid GLB with embedded PNG and UV coordinates",async t=>{
 const root=await workspace(t),plyPath=path.join(root,"mesh.ply"),texturePath=path.join(root,"texture.png");
 await writeFile(plyPath,asciiPly(true));await writeFile(texturePath,png);
 const result=await convertTexturedPlyToGlb({plyPath,texturePath,metresPerModelUnit:2,upAxis:"Z",scaleCalibrated:true});
 const gltf=glbJson(result.glb);assert.equal(gltf.asset.version,"2.0");assert.equal(gltf.images[0].mimeType,"image/png");
 assert.ok(gltf.accessors.some(a=>a.type==="VEC2"));assert.equal(result.geometry.triangles,1);assert.equal(result.bounds.metresPerModelUnit,2);
 assert.equal(gltf.asset.extras.scaleCalibrated,true);
});
test("converts binary little-endian PLY and rejects absent UVs or non-PNG textures",async t=>{
 const root=await workspace(t),plyPath=path.join(root,"mesh.ply"),texturePath=path.join(root,"texture.png");
 await writeFile(plyPath,binaryPly());await writeFile(texturePath,png);
 const result=await convertTexturedPlyToGlb({plyPath,texturePath,upAxis:"Y"});assert.equal(result.geometry.triangles,1);
 await writeFile(plyPath,asciiPly(false));await assert.rejects(convertTexturedPlyToGlb({plyPath,texturePath}),/missing per-face UV/);
 await writeFile(texturePath,Buffer.from("not a png"));await assert.rejects(convertTexturedPlyToGlb({plyPath,texturePath}),/must be a PNG/);
});
test("requires explicit operator review and approved asset provenance",async t=>{
 const root=await workspace(t),{buildingSpec}=await setupApprovedViews(t,root);
 await assert.rejects(runColmapReconstruction({workspaceRoot:root,buildingSpec,buildingId:buildingSpec.id,jobId:"job-1",sourceIds:["view-1","view-2","view-3"],upAxis:"Z",upAxisReviewed:true,matchConfirmed:false,overlapReviewed:true,spawnImpl:mockedColmapSpawn}),/must be explicitly confirmed/);
 const unapproved={...buildingSpec,sources:buildingSpec.sources.map((s,i)=>i===0?{...s,usageStatus:"unreviewed"}:s)};
 await assert.rejects(runColmapReconstruction({workspaceRoot:root,buildingSpec:unapproved,buildingId:buildingSpec.id,jobId:"job-2",sourceIds:["view-1","view-2","view-3"],upAxis:"Z",upAxisReviewed:true,matchConfirmed:true,overlapReviewed:true,spawnImpl:mockedColmapSpawn}),/approved/);
});
test("runs mocked COLMAP reconstruction, converts texture atlas and marks model review-only",async t=>{
 const root=await workspace(t),{buildingSpec}=await setupApprovedViews(t,root);
 const result=await runColmapReconstruction({
  workspaceRoot:root,buildingSpec,buildingId:buildingSpec.id,jobId:"successful-job",sourceIds:["view-1","view-2","view-3"],
  upAxis:"Z",upAxisReviewed:true,matchConfirmed:true,overlapReviewed:true,quality:"LOW",
  scaleCalibration:{modelDistanceUnits:1,realDistanceM:4},spawnImpl:mockedColmapSpawn,
 });
 assert.equal(result.report.status,"completed-requires-review");assert.equal(result.report.mapReady,false);assert.equal(result.report.publicationEligible,false);
 assert.equal(result.report.scaleCalibration.metresPerModelUnit,4);assert.ok(result.report.outputs.glb.bytes>100);
 assert.equal(glbJson(await readFile(result.modelPath)).asset.version,"2.0");
 assert.equal(JSON.parse(await readFile(result.reportPath,"utf8")).status,"completed-requires-review");
});
test("fails closed when COLMAP cannot start and preserves failure diagnostics",async t=>{
 const root=await workspace(t),{buildingSpec}=await setupApprovedViews(t,root);
 await assert.rejects(runColmapReconstruction({
  workspaceRoot:root,buildingSpec,buildingId:buildingSpec.id,jobId:"missing-colmap",sourceIds:["view-1","view-2","view-3"],
  upAxis:"Z",upAxisReviewed:false,matchConfirmed:true,overlapReviewed:true,colmapPath:"colmap-does-not-exist",timeoutMs:5000,
 }),/Could not start/);
 const report=JSON.parse(await readFile(path.join(root,".building-engine","jobs",buildingSpec.id,"missing-colmap","report.json"),"utf8"));
 assert.equal(report.status,"failed");assert.match(report.failureMessage,/Could not start/);
});
test("strategy router stays procedural by default, with an explicit photogrammetry gate",async t=>{
 const root=await workspace(t),{buildingSpec}=await setupApprovedViews(t,root);
 const route=await generateBuildingAsset(buildingSpec);
 assert.equal(route.mode,"procedural");assert.equal(route.report.photogrammetryCandidateNotRun,true);
 await assert.rejects(generateBuildingAsset(buildingSpec,{strategy:"photogrammetry",reconstruction:{
  workspaceRoot:root,jobId:"unused",sourceIds:["view-1","view-2","view-3"],upAxis:"Z",upAxisReviewed:true,matchConfirmed:true,overlapReviewed:true,spawnImpl:mockedColmapSpawn
 }}),/photogrammetry strategy/);
});