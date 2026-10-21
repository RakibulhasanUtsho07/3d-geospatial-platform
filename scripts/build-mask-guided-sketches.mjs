#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { validateMaskDimensions, buildMaskedBuildingSketchFilter } from "../src/core/building-generation/mask-guided-building-sketches.mjs";
import { normalizeSketchOptions } from "../src/core/building-generation/architectural-sketch-preparation.mjs";

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
 const hash=createHash("sha256");for await(const chunk of createReadStream(filePath))hash.update(chunk);return hash.digest("hex");
}
function runFfmpeg(executable,args){
 return new Promise((resolve,reject)=>{
  let child;try{child=nodeSpawn(executable,args,{stdio:["ignore","ignore","pipe"],windowsHide:true});}
  catch(error){reject(new Error("Could not start FFmpeg: "+error.message));return;}
  let stderr="",settled=false;const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
  child.stderr?.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
  const timer=setTimeout(()=>{child.kill("SIGTERM");done(reject,new Error("Masked sketch generation timed out after 180000 ms"));},180000);
  child.once("error",error=>done(reject,new Error("Could not start FFmpeg: "+error.message)));
  child.once("close",(code,signal)=>code===0?done(resolve):done(reject,new Error("FFmpeg masked sketch failed (exit "+code+(signal?", signal "+signal:"")+"): "+(stderr.trim()||"no diagnostic output"))));
 });
}
async function main(){
 const {positional,options:rawOptions}=parseArgs(process.argv.slice(2));
 if(positional.length!==3||process.argv.includes("--help")){
  console.log("Usage: node scripts/build-mask-guided-sketches.mjs <input-image-dir> <reviewed-mask-dir> <output-dir> [--low-threshold=0.08] [--high-threshold=0.25] [--max-edge=4096] [--ffmpeg=ffmpeg]\nMasks must be named <source-filename>.mask.png (example: facade.jpg.mask.png), same pixel dimensions as source, white=building and black=background.");
  process.exit(process.argv.includes("--help")?0:2);
 }
 const options=normalizeSketchOptions(rawOptions);
 const inputDir=await realpath(path.resolve(positional[0])),maskDir=await realpath(path.resolve(positional[1])),outputDir=path.resolve(positional[2]);
 if(inputDir===outputDir||maskDir===outputDir)throw new Error("output directory must differ from input and mask directories");
 await mkdir(outputDir,{recursive:true});const realOutputDir=await realpath(outputDir);
 if(inputDir===realOutputDir||maskDir===realOutputDir)throw new Error("output directory resolves to an input directory");
 const manifestPath=path.join(realOutputDir,"masked-sketch-manifest.json");
 try{await access(manifestPath);throw new Error("manifest already exists; choose a new output directory");}catch(error){if(error.code!=="ENOENT")throw error;}
 const entries=(await readdir(inputDir,{withFileTypes:true})).filter(e=>e.isFile()&&EXTENSIONS.has(path.extname(e.name).toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name));
 if(!entries.length)throw new Error("No JPEG or PNG images found directly inside "+inputDir);
 const manifest={schemaVersion:"1.0.0",engine:"reviewed-mask-guided-edge-sketch-v1",createdAt:new Date().toISOString(),sourceDirectory:inputDir,maskDirectory:maskDir,outputDirectory:realOutputDir,options,maskConvention:"white=building foreground; black=background",sourceImageCount:0,sketchCount:0,skipped:[],sketches:[],warnings:["Mask quality is not automatically verified; visually review each mask before processing.","The output contains image edges inside the provided mask, not a vector CAD model or validated 3D geometry.","Incorrect masks can clip real building parts or include background; no hidden geometry is inferred."]};
 for(const entry of entries){
  const sourcePath=path.join(inputDir,entry.name),maskName=entry.name+".mask.png",maskPath=path.join(maskDir,maskName);
  let maskBytes;try{maskBytes=await readHeader(maskPath);}catch(error){if(error.code==="ENOENT"){manifest.skipped.push({sourceFile:entry.name,reason:"missing-reviewed-mask",expectedMask:maskName});continue;}throw error;}
  const sourceDimensions=readImageDimensions(await readHeader(sourcePath)),maskDimensions=readImageDimensions(maskBytes);
  if(!sourceDimensions||!maskDimensions){manifest.skipped.push({sourceFile:entry.name,reason:"source-or-mask-dimensions-unreadable"});continue;}
  validateMaskDimensions(sourceDimensions,maskDimensions);
  const sourceSha256=await sha256File(sourcePath),maskSha256=await sha256File(maskPath);
  const safeName=entry.name.replace(/[^a-z0-9._-]/gi,"_").slice(0,120)||"image",outputName=safeName+".building-edges.png",outputPath=path.join(realOutputDir,outputName);
  const filter=buildMaskedBuildingSketchFilter(options);
  await runFfmpeg(rawOptions.ffmpeg,["-nostdin","-hide_banner","-loglevel","error","-n","-i",sourcePath,"-i",maskPath,"-filter_complex",filter,"-frames:v","1",outputPath]);
  manifest.sketches.push({sourceFile:entry.name,maskFile:maskName,outputFile:outputName,sourceWidth:sourceDimensions.width,sourceHeight:sourceDimensions.height,sourceSha256,maskSha256,options,status:"mask-guided-edge-preview-needs-human-review",limitations:["Mask is user-provided and not semantically verified by this command.","Output is raster edges, not vector architecture or a 3D sketch.","Cross-view registration and geometric reconstruction are not performed."]});
  manifest.sourceImageCount++;manifest.sketchCount++;
 }
 if(!manifest.sketchCount)throw new Error("No images processed. Add reviewed masks named <source-filename>.mask.png with exact source dimensions; white=building, black=background.");
 await writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});
 console.log(JSON.stringify({status:"masked-edge-previews-generated",sourceImageCount:manifest.sourceImageCount,sketchCount:manifest.sketchCount,skipped:manifest.skipped.length,manifestPath,warning:"Inspect every mask and output; this is not an automatic segmentation model."},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
