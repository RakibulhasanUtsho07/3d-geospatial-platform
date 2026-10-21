#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { buildArchitecturalSketchFilter, createSketchRecord, normalizeSketchOptions } from "../src/core/building-generation/architectural-sketch-preparation.mjs";

const EXTENSIONS=new Set([".jpg",".jpeg",".png"]);
function parseArgs(argv){
 const positional=[],options={lowThreshold:0.08,highThreshold:0.25,maxEdge:4096,ffmpeg:process.env.FFMPEG_BIN||"ffmpeg"};
 for(const arg of argv){
  const match=arg.match(/^--(low-threshold|high-threshold|max-edge|ffmpeg)=(.+)$/);
  if(!match){positional.push(arg);continue;}
  const key={"low-threshold":"lowThreshold","high-threshold":"highThreshold","max-edge":"maxEdge",ffmpeg:"ffmpeg"}[match[1]];
  options[key]=key==="ffmpeg"?match[2]:Number(match[2]);
 }
 return {positional,options};
}
async function readHeader(filePath,maxBytes=1024*1024){
 const chunks=[];let size=0;
 for await(const chunk of createReadStream(filePath,{start:0,end:maxBytes-1})){chunks.push(chunk);size+=chunk.length;}
 return Buffer.concat(chunks,size);
}
async function sha256File(filePath){
 const hash=createHash("sha256");
 for await(const chunk of createReadStream(filePath))hash.update(chunk);
 return hash.digest("hex");
}
function runFfmpeg(executable,args){
 return new Promise((resolve,reject)=>{
  let child;try{child=nodeSpawn(executable,args,{stdio:["ignore","ignore","pipe"],windowsHide:true});}
  catch(error){reject(new Error("Could not start FFmpeg: "+error.message));return;}
  let stderr="",settled=false;
  const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
  child.stderr?.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
  const timer=setTimeout(()=>{child.kill("SIGTERM");done(reject,new Error("Sketch generation timed out after 180000 ms"));},180000);
  child.once("error",error=>done(reject,new Error("Could not start FFmpeg: "+error.message)));
  child.once("close",(code,signal)=>code===0?done(resolve):done(reject,new Error("FFmpeg sketch generation failed (exit "+code+(signal?", signal "+signal:"")+"): "+(stderr.trim()||"no diagnostic output"))));
 });
}
async function main(){
 const {positional,options:rawOptions}=parseArgs(process.argv.slice(2));
 if(positional.length!==2||process.argv.includes("--help")){
  console.log("Usage: node scripts/prepare-architectural-sketches.mjs <input-image-dir> <output-dir> [--low-threshold=0.08] [--high-threshold=0.25] [--max-edge=4096] [--ffmpeg=ffmpeg]\nCreates one grayscale edge-drawing preview per JPEG/PNG image and a manifest. This is not semantic building segmentation or a 3D architectural sketch.");
  process.exit(process.argv.includes("--help")?0:2);
 }
 const options=normalizeSketchOptions(rawOptions);
 const inputDir=await realpath(path.resolve(positional[0])),outputDir=path.resolve(positional[1]);
 if(inputDir===outputDir)throw new Error("output directory must differ from input directory");
 await mkdir(outputDir,{recursive:true});
 const realOutputDir=await realpath(outputDir);
 if(inputDir===realOutputDir)throw new Error("output directory resolves to the input directory");
 const manifestPath=path.join(realOutputDir,"architectural-sketch-manifest.json");
 try{await access(manifestPath);throw new Error("manifest already exists; choose a new output directory");}catch(error){if(error.code!=="ENOENT")throw error;}
 const entries=(await readdir(inputDir,{withFileTypes:true})).filter(entry=>entry.isFile()&&EXTENSIONS.has(path.extname(entry.name).toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name));
 if(!entries.length)throw new Error("No JPEG or PNG images found directly inside "+inputDir);
 const manifest={schemaVersion:"1.0.0",engine:"per-view-edge-sketch-preview-v1",createdAt:new Date().toISOString(),inputDirectory:inputDir,outputDirectory:realOutputDir,options,sourceImageCount:0,sketchCount:0,sketches:[],warnings:["These are edge-drawing previews, not semantic building masks or validated architectural sketches.","Background edges remain until a building segmentation/masking stage is integrated.","No cross-view alignment, 3D wireframe construction, automatic repair or accuracy certification is performed."]};
 for(const entry of entries){
  const sourcePath=path.join(inputDir,entry.name),bytes=await readHeader(sourcePath),dimensions=readImageDimensions(bytes);
  if(!dimensions){manifest.warnings.push("Skipped image with unreadable JPEG/PNG dimensions: "+entry.name);continue;}
  const sourceSha256=await sha256File(sourcePath);
  const safeName=entry.name.replace(/[^a-z0-9._-]/gi,"_").slice(0,120)||"image";
  const outputName=safeName+".edges.png",outputPath=path.join(realOutputDir,outputName);
  await runFfmpeg(rawOptions.ffmpeg,["-nostdin","-hide_banner","-loglevel","error","-n","-i",sourcePath,"-frames:v","1","-vf",buildArchitecturalSketchFilter(options),outputPath]);
  const record=createSketchRecord({sourceFile:entry.name,outputFile:outputName,width:dimensions.width,height:dimensions.height,options,sourceSha256});
  manifest.sketches.push(record);manifest.sourceImageCount++;manifest.sketchCount++;
 }
 if(!manifest.sketchCount)throw new Error("No valid images were processed");
 await writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});
 console.log(JSON.stringify({status:"preview-generated",sourceImageCount:manifest.sourceImageCount,sketchCount:manifest.sketchCount,manifestPath,warning:"Review generated previews: edge maps include trees, sky boundaries, road markings and texture. This is not a building-only sketch."},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
