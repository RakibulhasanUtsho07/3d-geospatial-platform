import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ingestMediaFile } from "./media-intake.mjs";

function validateOptions(options) {
  if (!options || typeof options !== "object") throw new TypeError("options are required");
  if (typeof options.fps !== "number" || !Number.isFinite(options.fps) || options.fps < 0.05 || options.fps > 2) throw new RangeError("fps must be between 0.05 and 2 frames per second");
  if (!Number.isInteger(options.maxFrames) || options.maxFrames < 1 || options.maxFrames > 500) throw new RangeError("maxFrames must be an integer from 1 to 500");
  if (!Number.isInteger(options.maxWidth) || options.maxWidth < 320 || options.maxWidth > 4096) throw new RangeError("maxWidth must be an integer from 320 to 4096");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 5000 || options.timeoutMs > 1200000) throw new RangeError("timeoutMs must be from 5000 to 1200000");
}
export function buildFfmpegArgs(inputPath, outputPattern, options) {
  validateOptions(options);
  return ["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-i", inputPath, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "fps=" + options.fps + ",scale=w='min(" + options.maxWidth + ",iw)':h=-2", "-frames:v", String(options.maxFrames), "-q:v", "2", "-start_number", "1", "-f", "image2", outputPattern];
}
function inside(root,candidate){const relative=path.relative(root,candidate);return relative===""||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative));}
function safeId(value,label){if(typeof value!=="string"||!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value))throw new TypeError(label+" is invalid");return value;}
function runFfmpeg(executable,args,timeoutMs,spawnImpl=nodeSpawn){
  return new Promise((resolve,reject)=>{
    let child;
    try{child=spawnImpl(executable,args,{stdio:["ignore","ignore","pipe"],windowsHide:true});}catch(error){reject(error);return;}
    let stderr="",settled=false;
    const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
    child.stderr?.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-16000);});
    const timer=setTimeout(()=>{child.kill("SIGKILL");done(reject,new Error("FFmpeg timed out after "+timeoutMs+" ms"));},timeoutMs);
    child.once("error",error=>done(reject,new Error("Could not start FFmpeg '"+executable+"': "+error.message)));
    child.once("close",(code,signal)=>code===0?done(resolve,{code,stderr}):done(reject,new Error("FFmpeg failed (exit "+code+(signal?", signal "+signal:"")+"): "+(stderr.trim().slice(-4000)||"no diagnostic output"))));
  });
}
/** Extract bounded candidate frames from an ingested video using FFmpeg; never runs through a shell. */
export async function extractVideoFrames(options) {
  validateOptions(options);
  const root=await realpath(path.resolve(options.workspaceRoot));
  const videoPath=await realpath(path.resolve(root,options.videoRelativePath));
  if(!inside(root,videoPath))throw new TypeError("video must be inside workspaceRoot");
  const videoStat=await stat(videoPath);if(!videoStat.isFile()||videoStat.size<=0)throw new TypeError("video input must be a non-empty regular file");
  const buildingId=safeId(options.buildingId,"buildingId"),sourceId=safeId(options.sourceId,"sourceId");
  const workRoot=path.join(root,".building-engine","tmp"),workDir=path.join(workRoot,buildingId+"-"+sourceId+"-"+randomUUID());
  if(!inside(root,workDir))throw new TypeError("temporary frame path escapes workspaceRoot");
  await mkdir(workDir,{recursive:true});
  const outputPattern=path.join(workDir,"frame-%06d.jpg"),args=buildFfmpegArgs(videoPath,outputPattern,options);
  try{
    await runFfmpeg(options.ffmpegPath||"ffmpeg",args,options.timeoutMs,options.spawnImpl);
    const names=(await readdir(workDir)).filter(n=>/^frame-\d{6}\.jpg$/.test(n)).sort();
    if(!names.length)throw new Error("FFmpeg succeeded but produced no video frames");
    if(names.length>options.maxFrames)throw new Error("FFmpeg output exceeded maxFrames");
    const videoRecord=options.videoRecord,frames=[];
    for(const name of names){
      const index=Number(name.match(/-(\d+)\.jpg$/)[1]),frameSourceId=(sourceId+"-frame-"+String(index).padStart(6,"0")).slice(0,80);
      const relative=path.relative(root,path.join(workDir,name)).split(path.sep).join("/");
      const ingested=await ingestMediaFile({workspaceRoot:root,sourcePath:relative,buildingId,sourceId:frameSourceId,kind:"video-frame",title:(videoRecord?.title||sourceId)+" frame "+index,licence:videoRecord?.licence||"unknown",author:videoRecord?.author,attribution:videoRecord?.attribution,usageStatus:videoRecord?.usageStatus||"unreviewed",parentSourceId:sourceId,description:"FFmpeg sample: frame "+index+"; nominal sample time "+((index-1)/options.fps)+" seconds at "+options.fps+" fps. This timestamp is approximate and is not camera calibration."});
      frames.push({...ingested.record,frameNumber:index,nominalTimeSeconds:Number(((index-1)/options.fps).toFixed(3))});
    }
    return {buildingId,sourceId,fps:options.fps,requestedMaxFrames:options.maxFrames,extractedFrames:frames.length,frames,warning:"Sampled frames are references only; sampling does not identify the building, calibrate a camera, prove overlapping views or reconstruct 3D geometry."};
  }finally{await rm(workDir,{recursive:true,force:true}).catch(()=>{});}
}