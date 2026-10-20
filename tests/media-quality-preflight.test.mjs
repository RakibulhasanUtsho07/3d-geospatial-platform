import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import { assessBuildingMediaSources, calculateImageQualityMetrics, compareImageHashes, writeMediaQualityReport } from "../src/core/building-generation/media-quality-preflight.mjs";

const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
function png(width=1024,height=768,tail=0){
 const b=Buffer.alloc(40,tail);PNG_SIGNATURE.copy(b,0);b.writeUInt32BE(13,8);b.write("IHDR",12,"ascii");b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);b[24]=8;b[25]=2;b[26]=0;b[27]=0;b[28]=0;return b;
}
async function workspace(t){const root=await mkdtemp(path.join(os.tmpdir(),"media-quality-"));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function intake(root,sourceId,{licence="CC BY 4.0",usageStatus="approved"}={}){
 const inputDir=path.join(root,"uploads");await mkdir(inputDir,{recursive:true});
 const tail=Array.from(sourceId).reduce((sum,char)=>sum+char.charCodeAt(0),0)%200;await writeFile(path.join(inputDir,sourceId+".png"),png(1024,768,tail));
 return await ingestMediaFile({workspaceRoot:root,sourcePath:"uploads/"+sourceId+".png",buildingId:"quality-demo",sourceId,kind:"image",licence,usageStatus,title:sourceId});
}
function testPixels(pattern){
 const gray=Buffer.alloc(64*64);
 for(let y=0;y<64;y++)for(let x=0;x<64;x++){
  let light;
  if(pattern===0)light=x<32?24:232;
  else if(pattern===1)light=y<32?24:232;
  else light=((Math.floor(x/8)+Math.floor(y/8))%2)?24:232;
  gray[y*64+x]=light;
 }
 return gray;
}
function fakeFfmpegFor(paths){
 const seedMap=new Map(paths.map((file,i)=>[file,i%3]));
 return (_executable,args)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  queueMicrotask(()=>{
   const input=args[args.indexOf("-i")+1],seed=seedMap.get(input);
   if(seed===undefined){child.stderr.write("missing test fixture");child.emit("close",1,null);return;}
   child.stdout.end(testPixels(seed));child.emit("close",0,null);
  });
  return child;
 };
}

test("quality metrics flag flat/low-detail input and return a stable perceptual hash",()=>{
 const flat=calculateImageQualityMetrics(Buffer.alloc(64*64,80));
 assert.equal(flat.laplacianVariance,0);
 assert.ok(flat.warnings.some(w=>w.includes("low-sharpness")));
 assert.ok(flat.warnings.some(w=>w.includes("low-contrast")));
 const edge=calculateImageQualityMetrics(testPixels(0));
 assert.ok(edge.laplacianVariance>flat.laplacianVariance);
 assert.match(edge.averageHash,/^[a-f0-9]{16}$/);
});
test("perceptual hash comparison reports identical and near-duplicate candidates",()=>{
 const pairs=compareImageHashes([
  {sourceId:"a",averageHash:"0000000000000000"},
  {sourceId:"b",averageHash:"0000000000000001"},
  {sourceId:"c",averageHash:"ffffffffffffffff"},
 ],1);
 assert.equal(pairs.length,1);assert.deepEqual(pairs[0].sourceIds,["a","b"]);assert.equal(pairs[0].hammingDistance,1);
 assert.throws(()=>compareImageHashes([],65),/threshold/);
});
test("assesses an approved three-image set and writes a persistent JSON report",async t=>{
 const root=await workspace(t),records=[];
 for(const id of ["front-view","left-view","right-view"])records.push(await intake(root,id));
 const paths=records.map(r=>r.absoluteAssetPath);
 const options={workspaceRoot:root,buildingId:"quality-demo",sourceIds:records.map(r=>r.record.id),spawnImpl:fakeFfmpegFor(paths)};
 const report=await assessBuildingMediaSources(options);
 assert.equal(report.qualityAnalysisComplete,true);assert.equal(report.rightsApproved,true);
 assert.equal(report.sourceCount,3);assert.equal(report.uniqueContentCount,3);
 assert.equal(report.reconstructionCandidate,true);assert.equal(report.safeToSubmitToColmap,true);
 assert.ok(report.sources.every(s=>s.width===1024&&s.height===768&&s.quality.averageHash));
 const reportPath=await writeMediaQualityReport(options,report);
 const saved=JSON.parse(await readFile(reportPath,"utf8"));assert.equal(saved.engine,"local-media-quality-preflight-v1");
});
test("unreviewed rights block the ready flag even when pixels decode successfully",async t=>{
 const root=await workspace(t),records=[];
 for(const id of ["photo-a","photo-b","photo-c"])records.push(await intake(root,id,id==="photo-c"?{licence:"unknown",usageStatus:"unreviewed"}:{}));
 const paths=records.map(r=>r.absoluteAssetPath);
 const report=await assessBuildingMediaSources({workspaceRoot:root,buildingId:"quality-demo",sourceIds:records.map(r=>r.record.id),spawnImpl:fakeFfmpegFor(paths)});
 assert.equal(report.qualityAnalysisComplete,true);assert.equal(report.reconstructionCandidate,true);assert.equal(report.rightsApproved,false);assert.equal(report.safeToSubmitToColmap,false);
 assert.ok(report.warnings.some(w=>w.includes("known licence")));
});
test("decode failures are reported instead of being silently called reconstruction-ready",async t=>{
 const root=await workspace(t),records=[];
 for(const id of ["bad-a","bad-b","bad-c"])records.push(await intake(root,id));
 const spawnImpl=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};queueMicrotask(()=>{child.stderr.write("decoder failed");child.emit("close",1,null);});return child;};
 const report=await assessBuildingMediaSources({workspaceRoot:root,buildingId:"quality-demo",sourceIds:records.map(r=>r.record.id),spawnImpl});
 assert.equal(report.qualityAnalysisComplete,false);assert.equal(report.safeToSubmitToColmap,false);
 assert.ok(report.sources.every(s=>s.error.includes("FFmpeg image decode failed")));
});
test("rejects malformed image dimensions before expensive decode",async t=>{
 const root=await workspace(t);
 const inputDir=path.join(root,"uploads");await mkdir(inputDir,{recursive:true});
 await writeFile(path.join(inputDir,"small.png"),png(64000,64000));
 const record=await ingestMediaFile({workspaceRoot:root,sourcePath:"uploads/small.png",buildingId:"quality-demo",sourceId:"huge",kind:"image",licence:"CC BY 4.0",usageStatus:"approved"});
 const report=await assessBuildingMediaSources({workspaceRoot:root,buildingId:"quality-demo",sourceIds:["huge"],spawnImpl:fakeFfmpegFor([record.absoluteAssetPath])});
 assert.equal(report.qualityAnalysisComplete,false);assert.match(report.sources[0].error,/60-megapixel/);
});
