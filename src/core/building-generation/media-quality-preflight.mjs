import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadVerifiedSource } from "./source-workflow.mjs";

const MAX_SOURCE_COUNT = 120;
const SAMPLE_SIDE = 64;
const SAMPLE_BYTES = SAMPLE_SIDE * SAMPLE_SIDE;

function readDimensions(buffer, mimeType) {
  if (mimeType === "image/png") {
    if (buffer.length < 24 || buffer.subarray(0, 8).compare(Buffer.from([137,80,78,71,13,10,26,10])) !== 0 || buffer.toString("ascii", 12, 16) !== "IHDR") {
      throw new TypeError("PNG dimensions are missing or malformed");
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType !== "image/jpeg") throw new TypeError("quality preflight only supports JPEG and PNG images");
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new TypeError("JPEG header is malformed");
  const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  let offset = 2;
  while (offset + 4 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset++;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (sof.has(marker)) {
      if (segmentLength < 7) throw new TypeError("JPEG SOF segment is malformed");
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  throw new TypeError("JPEG dimensions could not be read from its SOF marker");
}
export function calculateImageQualityMetrics(gray, width = SAMPLE_SIDE, height = SAMPLE_SIDE) {
  if (!(gray instanceof Uint8Array) || gray.length !== width * height) throw new TypeError("grayscale sample must contain width × height bytes");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8) throw new RangeError("sample dimensions must be integer values of at least 8 × 8");
  let sum=0,sumSquares=0,min=255,max=0;
  const histogram=new Uint32Array(256);
  for(const pixel of gray){sum+=pixel;sumSquares+=pixel*pixel;min=Math.min(min,pixel);max=Math.max(max,pixel);histogram[pixel]++;}
  const count=gray.length,mean=sum/count,variance=Math.max(0,sumSquares/count-mean*mean),sorted=[];
  for(let i=0;i<256;i++)for(let n=0;n<histogram[i];n++)sorted.push(i);
  const percentile=p=>sorted[Math.min(count-1,Math.floor((count-1)*p))];
  let laplacianSum=0,laplacianSquares=0,lapCount=0;
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x,lap=gray[i-1]+gray[i+1]+gray[i-width]+gray[i+width]-4*gray[i];
    laplacianSum+=lap;laplacianSquares+=lap*lap;lapCount++;
  }
  const laplacianVariance=Math.max(0,laplacianSquares/lapCount-(laplacianSum/lapCount)**2);
  const blockSamples=[];
  for(let by=0;by<8;by++)for(let bx=0;bx<8;bx++){
    let blockSum=0,blockCount=0;
    for(let y=by*height/8|0;y<((by+1)*height/8|0);y++)for(let x=bx*width/8|0;x<((bx+1)*width/8|0);x++){blockSum+=gray[y*width+x];blockCount++;}
    blockSamples.push(blockSum/Math.max(1,blockCount));
  }
  const blockMean=blockSamples.reduce((acc,value)=>acc+value,0)/blockSamples.length;
  let averageHash=0n;
  for(let i=0;i<blockSamples.length;i++)if(blockSamples[i]>=blockMean)averageHash|=1n<<BigInt(i);
  const dynamicRange=percentile(0.95)-percentile(0.05);
  const warnings=[];
  if(laplacianVariance<18)warnings.push("low-sharpness: possible blur or insufficient fine detail (heuristic)");
  if(mean<28)warnings.push("possibly-underexposed: average luminance is low (heuristic)");
  if(mean>235)warnings.push("possibly-overexposed: average luminance is high (heuristic)");
  if(dynamicRange<28)warnings.push("low-contrast: luminance range is narrow (heuristic)");
  return {
    sampleWidth:width,sampleHeight:height,
    meanLuminance:Number(mean.toFixed(2)),luminanceVariance:Number(variance.toFixed(2)),
    percentile5Luminance:percentile(0.05),percentile95Luminance:percentile(0.95),
    dynamicRange,laplacianVariance:Number(laplacianVariance.toFixed(3)),
    averageHash:averageHash.toString(16).padStart(16,"0"),
    warnings,
  };
}
function hammingHex(a,b) {
  let v=BigInt("0x"+a)^BigInt("0x"+b),distance=0;
  while(v){distance+=Number(v&1n);v>>=1n;}
  return distance;
}
export function compareImageHashes(items, threshold = 5) {
  if(!Array.isArray(items))throw new TypeError("items must be an array");
  if(!Number.isInteger(threshold)||threshold<0||threshold>64)throw new RangeError("threshold must be between 0 and 64");
  const pairs=[];
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
    const a=items[i],b=items[j];
    if(typeof a.averageHash!=="string"||typeof b.averageHash!=="string")continue;
    const distance=hammingHex(a.averageHash,b.averageHash);
    if(distance<=threshold)pairs.push({sourceIds:[a.sourceId,b.sourceId],hammingDistance:distance,kind:distance===0?"same-perceptual-hash":"possible-near-duplicate"});
  }
  return pairs;
}
async function runFfmpeg(executable,args,timeoutMs,spawnImpl=nodeSpawn) {
  return await new Promise((resolve,reject)=>{
    let child;
    try{child=spawnImpl(executable,args,{stdio:["ignore","pipe","pipe"],windowsHide:true});}
    catch(error){reject(error);return;}
    const stdout=[],stdoutLimit=SAMPLE_BYTES+4096;let stdoutBytes=0,stderr="",settled=false;
    const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
    child.stdout?.on("data",chunk=>{
      stdoutBytes+=chunk.length;
      if(stdoutBytes>stdoutLimit){child.kill("SIGKILL");done(reject,new Error("FFmpeg grayscale output exceeded its expected limit"));return;}
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-12000);});
    const timer=setTimeout(()=>{child.kill("SIGTERM");const killer=setTimeout(()=>child.kill("SIGKILL"),1500);killer.unref?.();done(reject,new Error("FFmpeg image preflight timed out after "+timeoutMs+" ms"));},timeoutMs);
    child.once("error",error=>done(reject,new Error("Could not start FFmpeg '"+executable+"': "+error.message)));
    child.once("close",(code,signal)=>{
      if(code!==0)return done(reject,new Error("FFmpeg image decode failed (exit "+code+(signal?", signal "+signal:"")+"): "+(stderr.trim().slice(-3000)||"no diagnostic output")));
      const output=Buffer.concat(stdout);
      if(output.length!==SAMPLE_BYTES)return done(reject,new Error("FFmpeg returned "+output.length+" grayscale bytes; expected "+SAMPLE_BYTES));
      done(resolve,output);
    });
  });
}
async function sampleImage(source,options){
  const {bytes:sourceBytes}=source;
  if(!["image/jpeg","image/png"].includes(source.record.mimeType))throw new TypeError("unsupported image MIME "+source.record.mimeType+"; expected JPEG or PNG");
  if(sourceBytes>20*1024*1024)throw new RangeError("image exceeds 20 MB preflight limit");
  const signaturePath=source.assetPath;
  const header=await readFile(signaturePath);
  const dimensions=readDimensions(header,source.record.mimeType);
  if(!Number.isInteger(dimensions.width)||!Number.isInteger(dimensions.height)||dimensions.width<1||dimensions.height<1)throw new TypeError("invalid image dimensions");
  if(dimensions.width>30000||dimensions.height>30000||dimensions.width*dimensions.height>60_000_000)throw new RangeError("image dimensions exceed the 60-megapixel safety limit");
  const ffmpeg=options.ffmpegPath||process.env.FFMPEG_BIN||"ffmpeg";
  const filter="scale=64:64:force_original_aspect_ratio=decrease,pad=64:64:(ow-iw)/2:(oh-ih)/2:color=black,format=gray";
  const args=["-nostdin","-hide_banner","-loglevel","error","-i",signaturePath,"-frames:v","1","-vf",filter,"-f","rawvideo","-pix_fmt","gray","pipe:1"];
  const pixels=await runFfmpeg(ffmpeg,args,options.timeoutMs,options.spawnImpl);
  const metrics=calculateImageQualityMetrics(pixels);
  const warnings=[...metrics.warnings];
  if(dimensions.width<640||dimensions.height<480)warnings.push("low-resolution: original image is smaller than 640 × 480 pixels");
  if(source.record.usageStatus!=="approved"||!source.record.licence||source.record.licence.toLowerCase()==="unknown")warnings.push("rights-not-reviewed: this source must not be used for reconstruction until reuse permission/licence is reviewed");
  const result={sourceId:source.sourceId,kind:source.record.kind,mimeType:source.record.mimeType,sha256:source.sha256,byteSize:sourceBytes,width:dimensions.width,height:dimensions.height,usageStatus:source.record.usageStatus,licence:source.record.licence||"unknown",quality:{...metrics,warnings}};
  return result;
}

/** Run non-destructive, local image-set screening before launching photogrammetry. */
export async function assessBuildingMediaSources(options){
  if(!options||typeof options!=="object")throw new TypeError("options are required");
  if(!Array.isArray(options.sourceIds)||options.sourceIds.length<1||options.sourceIds.length>MAX_SOURCE_COUNT)throw new RangeError("sourceIds must contain between 1 and "+MAX_SOURCE_COUNT+" IDs");
  const sourceIds=options.sourceIds;
  if(new Set(sourceIds).size!==sourceIds.length)throw new TypeError("sourceIds contains duplicates");
  const results=[];
  for(const sourceId of sourceIds){
    const verified=await loadVerifiedSource(options.workspaceRoot,options.buildingId,sourceId);
    try{results.push(await sampleImage(verified,{...options,sourceId}));}
    catch(error){results.push({sourceId,sha256:verified.sha256,kind:verified.record.kind,usageStatus:verified.record.usageStatus,licence:verified.record.licence||"unknown",error:error instanceof Error?error.message:String(error),quality:{warnings:["quality-analysis-failed"]}});}
  }
  const nearDuplicatePairs=compareImageHashes(results.filter(item=>item.quality?.averageHash),options.nearDuplicateThreshold??5);
  const uniqueHashes=new Set(results.map(item=>item.sha256).filter(Boolean));
  const failures=results.filter(item=>item.error);
  const rightsApproved=results.length>=3&&results.every(item=>item.usageStatus==="approved"&&item.licence&&item.licence.toLowerCase()!=="unknown");
  const countReady=results.length>=3&&uniqueHashes.size>=3;
  const report={
    schemaVersion:"1.0.0",engine:"local-media-quality-preflight-v1",buildingId:options.buildingId,
    assessedAt:new Date().toISOString(),sourceCount:results.length,uniqueContentCount:uniqueHashes.size,
    qualityAnalysisComplete:failures.length===0,rightsApproved,
    reconstructionCandidate:countReady&&failures.length===0,
    safeToSubmitToColmap:countReady&&failures.length===0&&rightsApproved,
    warnings:[],
    nearDuplicatePairs,
    sources:results,
    limitations:[
      "Sharpness, luminance and average-hash checks are heuristics, not proof that images overlap or show the same building.",
      "This preflight does not infer camera intrinsics/poses, register geographic coordinates or reconstruct geometry.",
      "A reconstruction still requires explicit same-building and view-overlap confirmation plus manual QA.",
    ],
  };
  if(results.length<3)report.warnings.push("At least three distinct views are needed before COLMAP can be considered.");
  if(uniqueHashes.size<results.length)report.warnings.push("Exact duplicate image content is present; remove duplicate sources before reconstruction.");
  if(nearDuplicatePairs.length)report.warnings.push("Near-duplicate visual views were detected by a low-resolution average hash; inspect these pairs manually.");
  if(!rightsApproved)report.warnings.push("At least one source lacks reviewed usageStatus=approved and a known licence.");
  if(failures.length)report.warnings.push("One or more images failed local decode/quality analysis; fix those files or the FFmpeg installation.");
  if(!results.some(item=>item.width&&item.height))report.warnings.push("No source image dimensions could be assessed.");
  return report;
}
export async function writeMediaQualityReport(options, report) {
  if(!options||typeof options!=="object"||!report||typeof report!=="object")throw new TypeError("options and report are required");
  if(!Array.isArray(report.sources)||report.sources.length===0)throw new TypeError("report must include at least one source");
  const verified=await loadVerifiedSource(options.workspaceRoot,options.buildingId,report.sources[0].sourceId);
  const reportName="quality-preflight-"+new Date().toISOString().replace(/[^0-9]/g,"").slice(0,17)+"-"+randomUUID().slice(0,8)+".json";
  const reportPath=path.join(path.dirname(verified.recordPath),reportName);
  await writeFile(reportPath,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
  return reportPath;
}
