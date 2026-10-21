import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeImageQuality, compareImageQuality, hammingDistanceHex, readImageDimensions, scoreGrayImage } from "../src/core/building-generation/image-quality-preflight.mjs";

function pngHeader(width,height){const buffer=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(buffer,0);buffer.writeUInt32BE(width,16);buffer.writeUInt32BE(height,20);return buffer;}
function mockFfmpegSpawn(_executable,args){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 queueMicrotask(()=>{const pixels=Buffer.alloc(4096);for(let y=0;y<64;y++)for(let x=0;x<64;x++)pixels[y*64+x]=(x*4+y*3)%256;child.stdout.write(pixels);setImmediate(()=>{child.stdout.end();child.emit("close",0,null);});});
 child.args=args;return child;
}
function summary(sourceId,hash,warnings=[]){return {sourceId,perceptualHash:hash,warnings,status:warnings.length?"review-recommended":"basic-quality-check-passed"};}
test("reads PNG and JPEG dimensions without trusting filename extensions",()=>{
 assert.deepEqual(readImageDimensions(pngHeader(1920,1080)),{width:1920,height:1080});
 const jpeg=Buffer.alloc(21);Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x02,0xd0,0x07,0x80,0x03,0x01,0x11,0x00]).copy(jpeg);
 assert.deepEqual(readImageDimensions(jpeg),{width:1920,height:720});
 assert.equal(readImageDimensions(Buffer.from("not an image")),null);
});
test("scores dark/low-contrast or soft thumbnails and detects a detailed image",()=>{
 const dims={width:1280,height:720};
 const dark=scoreGrayImage(Buffer.alloc(4096,4),dims);
 assert.ok(dark.warnings.includes("very-dark"));assert.ok(dark.warnings.includes("low-contrast"));assert.ok(dark.warnings.includes("possibly-blurry-or-out-of-focus"));
 const detailed=Buffer.alloc(4096);for(let y=0;y<64;y++)for(let x=0;x<64;x++)detailed[y*64+x]=((x*17+y*29+x*y)%256);
 const result=scoreGrayImage(detailed,dims);
 assert.ok(result.laplacianVariance>12);assert.ok(result.contrastStdDev>18);assert.equal(result.status,"basic-quality-check-passed");
 assert.match(result.perceptualHash,/^[a-f0-9]{16}$/);
});
test("detects near-duplicate perceptual hashes without removing images automatically",()=>{
 assert.equal(hammingDistanceHex("0000000000000000","0000000000000003"),2);
 assert.throws(()=>hammingDistanceHex("abc","0000000000000000"),/16 hexadecimal/);
 const input=[summary("front-a","1234567890abcdef"),summary("front-b","1234567890abcdee"),summary("side","f0f0f0f0f0f0f0f0")];
 const result=compareImageQuality(input,{nearDuplicateHamming:2});
 assert.ok(result[0].nearDuplicateIds.includes("front-b"));assert.ok(result[1].nearDuplicateIds.includes("front-a"));
 assert.ok(result[0].warnings.includes("near-duplicate-view"));assert.equal(result.length,3);assert.equal(input[0].warnings.length,0);
});
test("decodes only a bounded grayscale sample through FFmpeg",async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"image-quality-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const imagePath=path.join(root,"any-extension.bin");await writeFile(imagePath,pngHeader(1280,720));
 let args;
 const spawnImpl=(exe,argv,options)=>{args=argv;return mockFfmpegSpawn(exe,argv,options);};
 const result=await analyzeImageQuality({imagePath,spawnImpl});
 assert.equal(result.width,1280);assert.equal(result.height,720);assert.equal(result.sampleWidth,64);
 assert.match(result.perceptualHash,/^[a-f0-9]{16}$/);assert.ok(args.includes("pipe:1"));
 assert.ok(args.includes("-nostdin"));assert.equal(args[args.indexOf("-frames:v")+1],"1");
});
test("fails clearly when an image cannot be decoded",async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"image-quality-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const imagePath=path.join(root,"fake.png");await writeFile(imagePath,pngHeader(640,480));
 await assert.rejects(analyzeImageQuality({imagePath,spawnImpl:()=>{throw new Error("ffmpeg missing");}}),/Could not start FFmpeg/);
});
