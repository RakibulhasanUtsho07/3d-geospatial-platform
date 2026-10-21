#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { planImageTiles } from "../src/core/building-generation/image-tile-analysis.mjs";

const IMAGE_EXTENSIONS=new Set([".jpg",".jpeg",".png"]);
function parseCli(argv){
 const positional=[],options={tileSize:1024,overlap:128,minTileSize:256,ffmpeg:process.env.FFMPEG_BIN||"ffmpeg"};
 for(const arg of argv){
  const match=arg.match(/^--(tile-size|overlap|min-tile-size|ffmpeg)=(.+)$/);
  if(!match){positional.push(arg);continue;}
  const key={"tile-size":"tileSize",overlap:"overlap","min-tile-size":"minTileSize",ffmpeg:"ffmpeg"}[match[1]];
  options[key]=key==="ffmpeg"?match[2]:Number(match[2]);
 }
 return {positional,options};
}
async function readHeader(filePath,maxBytes=1024*1024){
 const chunks=[];let size=0;
 for await(const chunk of createReadStream(filePath,{start:0,end:maxBytes-1})){chunks.push(chunk);size+=chunk.length;}
 return Buffer.concat(chunks,size);
}
function runFfmpeg(executable,args){
 return new Promise((resolve,reject)=>{
  let child;try{child=nodeSpawn(executable,args,{stdio:["ignore","ignore","pipe"],windowsHide:true});}
  catch(error){reject(new Error("Could not start FFmpeg: "+error.message));return;}
  let stderr="",settled=false;
  const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
  child.stderr?.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
  const timer=setTimeout(()=>{child.kill("SIGTERM");done(reject,new Error("FFmpeg tile crop timed out after 120000 ms"));},120000);
  child.once("error",error=>done(reject,new Error("Could not start FFmpeg: "+error.message)));
  child.once("close",(code,signal)=>code===0?done(resolve):done(reject,new Error("FFmpeg crop failed (exit "+code+(signal?", signal "+signal:"")+"): "+(stderr.trim()||"no diagnostic output"))));
 });
}
async function main(){
 const {positional,options}=parseCli(process.argv.slice(2));
 if(positional.length!==2||process.argv.includes("--help")){
  console.log("Usage: node scripts/tile-building-images.mjs <input-image-dir> <output-dir> [--tile-size=1024] [--overlap=128] [--min-tile-size=256] [--ffmpeg=ffmpeg]\nReads JPEG/PNG files in the input directory (non-recursive), writes overlapping JPEG tiles and tile-manifest.json. This creates crops only; it does not detect building pixels or create architectural sketches.");
  process.exit(process.argv.includes("--help")?0:2);
 }
 if(!Number.isSafeInteger(options.tileSize)||options.tileSize<256)throw new RangeError("--tile-size must be an integer >=256");
 if(!Number.isSafeInteger(options.overlap)||options.overlap<0||options.overlap>=options.tileSize)throw new RangeError("--overlap must be an integer from 0 to tile-size-1");
 if(!Number.isSafeInteger(options.minTileSize)||options.minTileSize<1||options.minTileSize>options.tileSize)throw new RangeError("--min-tile-size must be between 1 and tile-size");
 const inputDir=await realpath(path.resolve(positional[0])),outputDir=path.resolve(positional[1]);
 if(inputDir===outputDir)throw new TypeError("output directory must differ from input directory");
 await mkdir(outputDir,{recursive:true});const realOutputDir=await realpath(outputDir);
 const entries=(await readdir(inputDir,{withFileTypes:true})).filter(entry=>entry.isFile()&&IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name));
 if(!entries.length)throw new Error("No JPEG or PNG files found directly inside "+inputDir);
 const manifest={schemaVersion:"1.0.0",engine:"image-tiling-preparation-v1",createdAt:new Date().toISOString(),inputDirectory:inputDir,outputDirectory:realOutputDir,config:{tileSize:options.tileSize,overlap:options.overlap,minTileSize:options.minTileSize},imageCount:0,tileCount:0,images:[],warnings:["Tiles are image crops only. No segmentation, architectural sketching, 3D alignment or geometry repair is performed by this command."]};
 for(const entry of entries){
  const sourcePath=path.join(inputDir,entry.name),dimensions=readImageDimensions(await readHeader(sourcePath));
  if(!dimensions){manifest.warnings.push("Skipped image with unreadable JPEG/PNG dimensions: "+entry.name);continue;}
  const plan=planImageTiles(dimensions.width,dimensions.height,options),stem=path.basename(entry.name,path.extname(entry.name)).replace(/[^a-z0-9._-]/gi,"_").slice(0,80)||"image";
  const imageOutputDir=path.join(realOutputDir,stem);await mkdir(imageOutputDir,{recursive:true});
  const tiles=[];
  for(const tile of plan.tiles){
   const filename=stem+"-"+tile.id+".jpg",outputPath=path.join(imageOutputDir,filename);
   await runFfmpeg(options.ffmpeg,["-nostdin","-hide_banner","-loglevel","error","-y","-i",sourcePath,"-frames:v","1","-vf","crop="+tile.width+":"+tile.height+":"+tile.x+":"+tile.y,"-q:v","2",outputPath]);
   tiles.push({...tile,relativePath:path.relative(realOutputDir,outputPath).split(path.sep).join("/")});
  }
  manifest.images.push({sourceFile:entry.name,sourceWidth:dimensions.width,sourceHeight:dimensions.height,tileCount:tiles.length,tiles});
  manifest.imageCount++;
  manifest.tileCount+=tiles.length;
 }
 if(!manifest.imageCount)throw new Error("No readable JPEG/PNG images were tiled; check input files and FFmpeg");
 const manifestPath=path.join(realOutputDir,"tile-manifest.json");
 await writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});
 console.log(JSON.stringify({status:"completed",imageCount:manifest.imageCount,tileCount:manifest.tileCount,manifestPath},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
