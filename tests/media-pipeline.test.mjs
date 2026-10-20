import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ingestMediaFile, toBuildingSpecSource } from "../src/core/building-generation/media-intake.mjs";
import { buildFfmpegArgs, extractVideoFrames } from "../src/core/building-generation/video-frame-extractor.mjs";

async function workspace(t){const root=await mkdtemp(path.join(os.tmpdir(),"building-media-"));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40,7)]);
const mp4=Buffer.concat([Buffer.alloc(4),Buffer.from("ftypisom"),Buffer.alloc(40,2)]);
function fakeSpawn(_exe,args){const child=new EventEmitter();child.stderr=new PassThrough();child.kill=()=>{};queueMicrotask(async()=>{const pattern=args.at(-1),dir=path.dirname(pattern);await writeFile(path.join(dir,"frame-000001.jpg"),Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(20,4)]));await writeFile(path.join(dir,"frame-000002.jpg"),Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(20,5)]));child.emit("close",0,null);});return child;}

test("detects signatures, content-addresses assets and keeps unknown reuse rights explicit",async t=>{
 const root=await workspace(t);await writeFile(path.join(root,"front.png"),png);
 const result=await ingestMediaFile({workspaceRoot:root,sourcePath:"front.png",buildingId:"demo-building",sourceId:"front-photo",kind:"auto",title:"Front facade"});
 assert.equal(result.record.kind,"image");assert.equal(result.record.mimeType,"image/png");assert.match(result.record.sha256,/^[a-f0-9]{64}$/);
 assert.equal(result.record.usageStatus,"unreviewed");assert.equal(result.record.licence,"unknown");assert.equal((await readFile(result.absoluteAssetPath)).length,png.length);
 assert.equal(toBuildingSpecSource(result.record).assetId,result.record.sha256);
});
test("rejects kind mismatch, path traversal, duplicate IDs and too-large files",async t=>{
 const root=await workspace(t);await writeFile(path.join(root,"video.mp4"),mp4);
 await assert.rejects(ingestMediaFile({workspaceRoot:root,sourcePath:"video.mp4",buildingId:"b1",sourceId:"bad",kind:"image"}),/does not match/);
 await assert.rejects(ingestMediaFile({workspaceRoot:root,sourcePath:"../outside.png",buildingId:"b1",sourceId:"bad"}),/inside workspaceRoot/);
 await ingestMediaFile({workspaceRoot:root,sourcePath:"video.mp4",buildingId:"b1",sourceId:"video",kind:"auto"});
 await assert.rejects(ingestMediaFile({workspaceRoot:root,sourcePath:"video.mp4",buildingId:"b1",sourceId:"video",kind:"auto"}),/already exists/);
 const big=Buffer.concat([png,Buffer.alloc(20*1024*1024+1)]);await writeFile(path.join(root,"big.png"),big);
 await assert.rejects(ingestMediaFile({workspaceRoot:root,sourcePath:"big.png",buildingId:"b1",sourceId:"big",kind:"image"}),/exceeds/);
});
test("rejects source symlinks and output folder symlinks escaping the workspace",async t=>{
 const root=await workspace(t),outside=await mkdtemp(path.join(os.tmpdir(),"building-media-outside-"));t.after(()=>rm(outside,{recursive:true,force:true}));
 await writeFile(path.join(outside,"file.png"),png);await symlink(path.join(outside,"file.png"),path.join(root,"link.png"));
 await assert.rejects(ingestMediaFile({workspaceRoot:root,sourcePath:"link.png",buildingId:"b1",sourceId:"symlink"}),/symbolic link/);
 await mkdir(path.join(root,".building-engine"),{recursive:true});await symlink(outside,path.join(root,".building-engine","media"));
 await writeFile(path.join(root,"ok.png"),png);
 await assert.rejects(ingestMediaFile({workspaceRoot:root,sourcePath:"ok.png",buildingId:"b1",sourceId:"escape"}),/symlink outside/);
});
test("builds bounded FFmpeg argv without shell evaluation",()=>{
 const args=buildFfmpegArgs("/workspace/cam; echo unsafe.mp4","/workspace/frame-%06d.jpg",{fps:0.5,maxFrames:60,maxWidth:1600,timeoutMs:600000});
 assert.ok(args.includes("/workspace/cam; echo unsafe.mp4"));assert.ok(args.includes("-frames:v"));assert.equal(args[args.indexOf("-frames:v")+1],"60");
 assert.throws(()=>buildFfmpegArgs("a","b",{fps:20,maxFrames:60,maxWidth:1600,timeoutMs:600000}),/fps/);
 assert.throws(()=>buildFfmpegArgs("a","b",{fps:0.5,maxFrames:501,maxWidth:1600,timeoutMs:600000}),/maxFrames/);
});
test("extracts bounded frames as distinct source records and avoids reconstruction claims",async t=>{
 const root=await workspace(t);await mkdir(path.join(root,"input"));await writeFile(path.join(root,"input","site.mp4"),mp4);
 const video=await ingestMediaFile({workspaceRoot:root,sourcePath:"input/site.mp4",buildingId:"demo",sourceId:"site-video",kind:"auto",licence:"CC BY 4.0",usageStatus:"approved"});
 const result=await extractVideoFrames({workspaceRoot:root,videoRelativePath:video.record.relativePath,buildingId:"demo",sourceId:"site-video",fps:0.5,maxFrames:10,maxWidth:1600,timeoutMs:600000,videoRecord:video.record,spawnImpl:fakeSpawn});
 assert.equal(result.extractedFrames,2);assert.equal(result.frames[0].kind,"video-frame");assert.equal(result.frames[0].parentSourceId,"site-video");
 assert.equal(result.frames[1].nominalTimeSeconds,2);assert.match(result.warning,/does not identify the building/);
});
test("reports missing FFmpeg clearly",async t=>{
 const root=await workspace(t);await writeFile(path.join(root,"video.mp4"),mp4);
 const video=await ingestMediaFile({workspaceRoot:root,sourcePath:"video.mp4",buildingId:"demo",sourceId:"video",kind:"auto"});
 await assert.rejects(extractVideoFrames({workspaceRoot:root,videoRelativePath:video.record.relativePath,buildingId:"demo",sourceId:"video",fps:0.5,maxFrames:10,maxWidth:1600,timeoutMs:600000,ffmpegPath:"no-such-ffmpeg-binary"}),/Could not start FFmpeg/);
});