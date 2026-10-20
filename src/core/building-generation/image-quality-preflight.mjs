import { spawn as nodeSpawn } from "node:child_process";
import { createReadStream } from "node:fs";

const SAMPLE_WIDTH=64,SAMPLE_HEIGHT=64,SAMPLE_BYTES=SAMPLE_WIDTH*SAMPLE_HEIGHT;
function readPngDimensions(buffer){
 if(buffer.length<24||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return null;
 const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);
 return width>0&&height>0?{width,height}:null;
}
function readJpegDimensions(buffer){
 if(buffer.length<4||buffer[0]!==0xff||buffer[1]!==0xd8)return null;
 const frameMarkers=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
 let offset=2;
 while(offset+4<buffer.length){
  if(buffer[offset]!==0xff){offset++;continue;}
  while(offset<buffer.length&&buffer[offset]===0xff)offset++;
  if(offset>=buffer.length)break;
  const marker=buffer[offset++];
  if(marker===0xd9||marker===0xda)break;
  if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
  if(offset+2>buffer.length)break;
  const length=buffer.readUInt16BE(offset);
  if(length<2||offset+length>buffer.length)break;
  if(frameMarkers.has(marker)&&length>=7){
   const height=buffer.readUInt16BE(offset+3),width=buffer.readUInt16BE(offset+5);
   return width>0&&height>0?{width,height}:null;
  }
  offset+=length;
 }
 return null;
}
export function readImageDimensions(buffer){
 if(!Buffer.isBuffer(buffer))throw new TypeError("image bytes must be a Buffer");
 return readPngDimensions(buffer)||readJpegDimensions(buffer);
}
function variance(values){
 if(!values.length)return 0;
 const mean=values.reduce((sum,value)=>sum+value,0)/values.length;
 return values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length;
}
function makeDHash(pixels,width=SAMPLE_WIDTH,height=SAMPLE_HEIGHT){
 let bits=0n;
 for(let y=0;y<8;y++){
  const py=Math.min(height-1,Math.floor((y+0.5)*height/8));
  for(let x=0;x<8;x++){
   const leftX=Math.min(width-1,Math.floor((x+0.5)*width/9));
   const rightX=Math.min(width-1,Math.floor((x+1.5)*width/9));
   bits=(bits<<1n)|(pixels[py*width+leftX]>pixels[py*width+rightX]?1n:0n);
  }
 }
 return bits.toString(16).padStart(16,"0");
}
export function hammingDistanceHex(a,b){
 if(typeof a!=="string"||typeof b!=="string"||!/^[0-9a-f]{16}$/i.test(a)||!/^[0-9a-f]{16}$/i.test(b))throw new TypeError("perceptual hashes must be 16 hexadecimal characters");
 let value=BigInt("0x"+a)^BigInt("0x"+b),count=0;
 while(value){count++;value&=value-1n;}
 return count;
}
/** Compute review hints from a small grayscale sample; these are heuristics, not a reconstruction guarantee. */
export function scoreGrayImage(pixels,dimensions,options={}){
 if(!Buffer.isBuffer(pixels)||pixels.length!==SAMPLE_BYTES)throw new TypeError("grayscale sample must be exactly 64x64 8-bit pixels");
 const {width,height}=dimensions||{};
 if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1)throw new TypeError("valid image width and height are required");
 const samples=Array.from(pixels),meanLuminance=samples.reduce((sum,value)=>sum+value,0)/samples.length;
 const contrastStdDev=Math.sqrt(variance(samples)),laplacian=[];
 for(let y=1;y<SAMPLE_HEIGHT-1;y++)for(let x=1;x<SAMPLE_WIDTH-1;x++){
  const i=y*SAMPLE_WIDTH+x,center=samples[i];
  laplacian.push(4*center-samples[i-1]-samples[i+1]-samples[i-SAMPLE_WIDTH]-samples[i+SAMPLE_WIDTH]);
 }
 const laplacianVariance=variance(laplacian),hash=makeDHash(pixels);
 const thresholds={minWidth:options.minWidth??640,minHeight:options.minHeight??480,minLaplacianVariance:options.minLaplacianVariance??12,minContrastStdDev:options.minContrastStdDev??18,minLuminance:options.minLuminance??25,maxLuminance:options.maxLuminance??230,nearDuplicateHamming:options.nearDuplicateHamming??4};
 const warnings=[];
 if(width<thresholds.minWidth||height<thresholds.minHeight)warnings.push("low-resolution");
 if(meanLuminance<thresholds.minLuminance)warnings.push("very-dark");
 if(meanLuminance>thresholds.maxLuminance)warnings.push("over-exposed-or-very-bright");
 if(contrastStdDev<thresholds.minContrastStdDev)warnings.push("low-contrast");
 if(laplacianVariance<thresholds.minLaplacianVariance)warnings.push("possibly-blurry-or-out-of-focus");
 return {
  width,height,sampleWidth:SAMPLE_WIDTH,sampleHeight:SAMPLE_HEIGHT,meanLuminance:Number(meanLuminance.toFixed(2)),
  contrastStdDev:Number(contrastStdDev.toFixed(2)),laplacianVariance:Number(laplacianVariance.toFixed(2)),
  perceptualHash:hash,warnings,thresholds,
  status:warnings.length?"review-recommended":"basic-quality-check-passed",
  caveat:"Heuristic thumbnail metrics only. They do not verify same-building identity, camera pose, geometric overlap or suitability for accurate reconstruction.",
 };
}
function runFfmpeg(executable,args,timeoutMs,spawnImpl=nodeSpawn){
 return new Promise((resolve,reject)=>{
  let child;
  try{child=spawnImpl(executable,args,{stdio:["ignore","pipe","pipe"],windowsHide:true});}
  catch(error){reject(error);return;}
  let stdout=Buffer.alloc(0),stderr="",settled=false;
  const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
  child.stdout?.on("data",chunk=>{
   if(stdout.length+chunk.length>SAMPLE_BYTES){child.kill("SIGTERM");done(reject,new Error("FFmpeg emitted too many thumbnail bytes"));return;}
   stdout=Buffer.concat([stdout,chunk]);
  });
  child.stderr?.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
  const timer=setTimeout(()=>{child.kill("SIGTERM");done(reject,new Error("FFmpeg image preflight timed out after "+timeoutMs+" ms"));},timeoutMs);
  child.once("error",error=>done(reject,new Error("Could not start FFmpeg image preflight: "+error.message)));
  child.once("close",(code,signal)=>code===0?done(resolve,{pixels:stdout,stderr}):done(reject,new Error("FFmpeg image preflight failed (exit "+code+(signal?", signal "+signal:"")+"): "+(stderr.trim().slice(-3000)||"no diagnostic output"))));
 });
}
/** Decode a bounded 64x64 grayscale thumbnail using FFmpeg, without reading the full image into memory. */
async function readImageHeader(filePath,maxBytes=1024*1024){
 const chunks=[];let total=0;
 for await(const chunk of createReadStream(filePath,{start:0,end:maxBytes-1})){chunks.push(chunk);total+=chunk.length;}
 return Buffer.concat(chunks,total);
}
export async function analyzeImageQuality(options){
 if(!options||typeof options!=="object"||typeof options.imagePath!=="string")throw new TypeError("imagePath is required");
 const bytes=await readImageHeader(options.imagePath),dimensions=readImageDimensions(bytes);
 if(!dimensions)throw new TypeError("image dimensions could not be identified from JPEG/PNG headers");
 const timeoutMs=options.timeoutMs??15000;
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new RangeError("timeoutMs must be from 1000 to 120000");
 const ffmpegPath=options.ffmpegPath||process.env.FFMPEG_BIN||"ffmpeg";
 const args=["-nostdin","-hide_banner","-loglevel","error","-i",options.imagePath,"-frames:v","1","-vf","scale=64:64:flags=area,format=gray","-f","rawvideo","-pix_fmt","gray","pipe:1"];
 const decoded=await runFfmpeg(ffmpegPath,args,timeoutMs,options.spawnImpl);
 if(decoded.pixels.length!==SAMPLE_BYTES)throw new TypeError("FFmpeg image preflight returned "+decoded.pixels.length+" thumbnail bytes; expected "+SAMPLE_BYTES);
 return scoreGrayImage(decoded.pixels,dimensions,options.thresholds);
}
/** Add cross-view near-duplicate warnings without removing source records automatically. */
export function compareImageQuality(results,options={}){
 if(!Array.isArray(results))throw new TypeError("image quality results must be an array");
 const maxDistance=options.nearDuplicateHamming??4;
 const output=results.map(result=>({...result,warnings:[...result.warnings],nearDuplicateIds:[]}));
 for(let i=0;i<output.length;i++)for(let j=i+1;j<output.length;j++){
  const distance=hammingDistanceHex(output[i].perceptualHash,output[j].perceptualHash);
  if(distance<=maxDistance){
   output[i].nearDuplicateIds.push(output[j].sourceId);output[j].nearDuplicateIds.push(output[i].sourceId);
  }
 }
 for(const result of output){
  if(result.nearDuplicateIds.length&&!result.warnings.includes("near-duplicate-view"))result.warnings.push("near-duplicate-view");
  result.status=result.warnings.length?"review-recommended":"basic-quality-check-passed";
 }
 return output;
}