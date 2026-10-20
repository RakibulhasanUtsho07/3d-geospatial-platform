import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeBuildingSpec } from "./building-spec.mjs";
import { convertTexturedPlyToGlb } from "./textured-ply-to-glb.mjs";

const ID=/^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MAX_IMAGE_COUNT=120,MAX_TOTAL_INPUT_BYTES=500*1024*1024;
function safeId(value,label){if(typeof value!=="string"||!ID.test(value))throw new TypeError(label+" is invalid");return value;}
function inside(root,candidate){const relative=path.relative(root,candidate);return relative===""||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative));}
function requireBool(value,label){if(value!==true)throw new TypeError(label+" must be explicitly confirmed before a reconstruction job can run");}
async function ensureSafeDirectoryTree(root,segments){
 let current=root;
 for(const segment of segments){
  const next=path.join(current,segment);
  try{
   const entry=await lstat(next);
   if(entry.isSymbolicLink())throw new TypeError("workspace directory must not be a symlink: "+next);
   if(!entry.isDirectory())throw new TypeError("workspace path component is not a directory: "+next);
  }catch(error){
   if(error?.code!=="ENOENT")throw error;
   try{await mkdir(next);}catch(createError){if(createError?.code!=="EEXIST")throw createError;}
   const entry=await lstat(next);
   if(entry.isSymbolicLink()||!entry.isDirectory())throw new TypeError("unsafe workspace path component: "+next);
  }
  current=await realpath(next);
  if(!inside(root,current))throw new TypeError("workspace directory resolves outside workspaceRoot");
 }
 return current;
}
function validateCalibration(options){
 const hasModel=options.modelDistanceUnits!==undefined,hasReal=options.realDistanceM!==undefined;
 if(hasModel!==hasReal)throw new TypeError("provide both modelDistanceUnits and realDistanceM to calibrate scale");
 if(!hasModel)return {metresPerModelUnit:1,scaleCalibrated:false,method:"unknown-scale-preview-only"};
 if(!Number.isFinite(options.modelDistanceUnits)||options.modelDistanceUnits<=0||!Number.isFinite(options.realDistanceM)||options.realDistanceM<=0)throw new RangeError("scale calibration distances must be positive finite numbers");
 const scale=options.realDistanceM/options.modelDistanceUnits;if(scale<0.0001||scale>1000)throw new RangeError("derived scale factor must be between 0.0001 and 1000 metres per model unit");
 return {metresPerModelUnit:scale,scaleCalibrated:true,method:"operator-supplied-known-distance",modelDistanceUnits:options.modelDistanceUnits,realDistanceM:options.realDistanceM};
}
async function runProcess(executable,args,timeoutMs,spawnImpl=nodeSpawn){
 return await new Promise((resolve,reject)=>{
  let child;try{child=spawnImpl(executable,args,{stdio:["ignore","pipe","pipe"],windowsHide:true});}catch(error){reject(error);return;}
  let stdout="",stderr="",settled=false;
  const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
  child.stdout?.on("data",chunk=>{stdout=(stdout+chunk.toString()).slice(-8000);});child.stderr?.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-16000);});
  const timer=setTimeout(()=>{child.kill("SIGTERM");setTimeout(()=>child.kill("SIGKILL"),2500).unref?.();done(reject,new Error(executable+" command timed out after "+timeoutMs+" ms"));},timeoutMs);
  child.once("error",error=>done(reject,new Error("Could not start "+executable+": "+error.message)));
  child.once("close",(code,signal)=>code===0?done(resolve,{stdout,stderr}):done(reject,new Error(executable+" "+args[0]+" failed (exit "+code+(signal?", signal "+signal:"")+"): "+(stderr.trim().slice(-4000)||stdout.trim().slice(-2000)||"no diagnostic output"))));
 });
}
async function fileExists(file){try{const s=await stat(file);return s.isFile()&&s.size>0;}catch(error){if(error?.code==="ENOENT")return false;throw error;}}
async function locateMesh(workspace){
 const directories=[path.join(workspace,"dense","0"),path.join(workspace,"dense")];
 for(const dir of directories)for(const name of ["meshed-poisson.ply","meshed-delaunay.ply","meshed-advancing-front.ply"]){const candidate=path.join(dir,name);if(await fileExists(candidate))return candidate;}
 throw new Error("COLMAP finished but no meshed-*.ply was found under dense/0 or dense; check COLMAP output and logs");
}
async function readApprovedSources(root,buildingId,sourceIds,spec){
 if(!Array.isArray(sourceIds)||sourceIds.length<3||sourceIds.length>MAX_IMAGE_COUNT)throw new RangeError("sourceIds must contain between 3 and "+MAX_IMAGE_COUNT+" candidate views");
 if(new Set(sourceIds).size!==sourceIds.length)throw new TypeError("sourceIds contains duplicates");
 const specById=new Map(spec.sources.map(source=>[source.id,source]));
 const mediaRoot=await realpath(path.join(root,".building-engine","media",buildingId));
 if(!inside(root,mediaRoot))throw new TypeError("building media directory resolves outside workspaceRoot");
 const assetRoot=await realpath(path.join(mediaRoot,"assets")),sourceRoot=await realpath(path.join(mediaRoot,"sources"));
 if(!inside(root,assetRoot)||!inside(root,sourceRoot)||!inside(mediaRoot,assetRoot)||!inside(mediaRoot,sourceRoot))throw new TypeError("media asset or source directory escapes its building workspace");
 const result=[];let totalBytes=0;const contentHashes=new Set();
 for(let index=0;index<sourceIds.length;index++){
  const sourceId=safeId(sourceIds[index],"sourceId"),recordPath=path.join(sourceRoot,sourceId+".json");
  const recordInfo=await lstat(recordPath);if(recordInfo.isSymbolicLink()||!recordInfo.isFile())throw new TypeError("source metadata must be a regular non-symlink file: "+sourceId);
  const recordReal=await realpath(recordPath);if(!inside(sourceRoot,recordReal))throw new TypeError("source metadata resolves outside source store: "+sourceId);
  const record=JSON.parse(await readFile(recordReal,"utf8"));
  if(record.id!==sourceId||record.buildingId!==buildingId)throw new TypeError("media source metadata identity mismatch for "+sourceId);
  if(!["image","video-frame"].includes(record.kind)||!["image/jpeg","image/png"].includes(record.mimeType))throw new TypeError("COLMAP worker accepts ingested JPEG/PNG image or video-frame sources only: "+sourceId);
  if(record.usageStatus!=="approved"||typeof record.licence!=="string"||!record.licence.trim()||record.licence.toLowerCase()==="unknown")throw new TypeError("source "+sourceId+" needs a reviewed licence and usageStatus=approved");
  const declared=specById.get(sourceId);
  if(!declared||declared.assetId!==record.assetId||declared.usageStatus!=="approved"||declared.licence!==record.licence)throw new TypeError("BuildingSpec source "+sourceId+" must reference the same approved asset id, licence and usage status");
  if(typeof record.relativePath!=="string"||record.relativePath.includes("\\"))throw new TypeError("invalid asset relativePath for "+sourceId);
  const absolute=path.resolve(root,record.relativePath);if(!inside(root,absolute))throw new TypeError("asset path escapes workspaceRoot");
  const lstatResult=await lstat(absolute);if(lstatResult.isSymbolicLink()||!lstatResult.isFile())throw new TypeError("media asset must be a regular non-symlink file");
  const actual=await realpath(absolute);if(!inside(root,actual)||!inside(assetRoot,actual))throw new TypeError("media asset is outside its building-specific asset store");
  const bytes=await readFile(actual),sha256=createHash("sha256").update(bytes).digest("hex");
  if(sha256!==record.sha256||sha256!==record.assetId)throw new TypeError("media asset hash mismatch for "+sourceId);
  totalBytes+=bytes.length;if(totalBytes>MAX_TOTAL_INPUT_BYTES)throw new RangeError("candidate image set exceeds 500 MB total input limit");
  if(contentHashes.has(sha256))throw new TypeError("duplicate image content detected; remove duplicate frame/source "+sourceId);
  contentHashes.add(sha256);result.push({id:sourceId,record,absolute,bytes,index});
 }
 return result;
}

/** Run COLMAP only on same-building, overlapping, usage-approved image sets. */
export async function runColmapReconstruction(options){
 if(!options||typeof options!=="object")throw new TypeError("options are required");
 const buildingId=safeId(options.buildingId,"buildingId"),jobId=safeId(options.jobId,"jobId");
 requireBool(options.matchConfirmed,"matchConfirmed");requireBool(options.overlapReviewed,"overlapReviewed");
 const quality=(options.quality??"MEDIUM").toUpperCase();if(!["LOW","MEDIUM","HIGH","EXTREME"].includes(quality))throw new TypeError("quality must be LOW, MEDIUM, HIGH or EXTREME");
 const timeoutMs=options.timeoutMs??3600000;if(!Number.isInteger(timeoutMs)||timeoutMs<5000||timeoutMs>14400000)throw new RangeError("timeoutMs must be between 5000 and 14400000");
 const upAxis=options.upAxis;if(!["X","Y","Z"].includes(upAxis))throw new TypeError("choose an explicit source upAxis: X, Y or Z");
 if(typeof options.upAxisReviewed!=="boolean")throw new TypeError("upAxisReviewed must be a boolean");
 const headingDegrees=options.headingDegrees??0;if(!Number.isFinite(headingDegrees)||headingDegrees<0||headingDegrees>360)throw new RangeError("headingDegrees must be between 0 and 360");
 const calibration=validateCalibration(options.scaleCalibration??{});
 const root=await realpath(path.resolve(options.workspaceRoot)),specResult=normalizeBuildingSpec(options.buildingSpec).spec;
 if(specResult.id!==buildingId)throw new TypeError("BuildingSpec id must equal buildingId");
 const sources=await readApprovedSources(root,buildingId,options.sourceIds,specResult);
 const realJobsRoot=await ensureSafeDirectoryTree(root,[".building-engine","jobs",buildingId]);
 const jobDir=path.join(realJobsRoot,jobId);if(!inside(root,jobDir))throw new TypeError("job directory escaped workspaceRoot");
 await mkdir(jobDir,{recursive:false});const outputJobDir=await realpath(jobDir);if(!inside(root,outputJobDir))throw new TypeError("job directory resolved outside workspaceRoot");
 const imagesDir=path.join(outputJobDir,"images");await mkdir(imagesDir);const realImagesDir=await realpath(imagesDir);if(!inside(root,realImagesDir))throw new TypeError("staging directory resolved outside workspaceRoot");
 const startedAt=new Date().toISOString(),staged=[];
 let report={schemaVersion:"1.0.0",engine:"colmap-multiview-worker-v1",buildingId,jobId,status:"running",startedAt,quality,sourceCount:sources.length,sourceIds:sources.map(s=>s.id),sourceSha256:sources.map(s=>({id:s.id,sha256:s.record.sha256,licence:s.record.licence,usageStatus:s.record.usageStatus})),confirmations:{sameBuilding:options.matchConfirmed,overlapReviewed:options.overlapReviewed,upAxisReviewed:options.upAxisReviewed},scaleCalibration:calibration,georeference:{status:"not-solved",longitude:specResult.location.longitude,latitude:specResult.location.latitude,heightM:specResult.location.heightM,headingDegrees},warnings:[],mapReady:false,outputs:{}};
 const reportPath=path.join(outputJobDir,"report.json");
 try{
  for(const source of sources){const ext=source.record.mimeType==="image/png"?".png":".jpg",filename="view-"+String(source.index+1).padStart(4,"0")+ext,dest=path.join(realImagesDir,filename);await copyFile(source.absolute,dest);staged.push({sourceId:source.id,filename,sha256:source.record.sha256});}
  report.stagedImages=staged;report.progress="reconstruction";await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  const colmapPath=options.colmapPath||process.env.COLMAP_BIN||"colmap",spawnImpl=options.spawnImpl;
  const reconstructionArgs=["automatic_reconstructor","--workspace_path",outputJobDir,"--image_path",realImagesDir,"--quality",quality];
  const reconstructStart=Date.now();await runProcess(colmapPath,reconstructionArgs,timeoutMs,spawnImpl);report.timingsMs={...report.timingsMs,reconstruction:Date.now()-reconstructStart};
  const inputMesh=await locateMesh(outputJobDir),denseWorkspace=path.dirname(inputMesh),texturedDir=path.join(outputJobDir,"textured");await mkdir(texturedDir,{recursive:true});
  const textureStart=Date.now();await runProcess(colmapPath,["mesh_texturer","--workspace_path",denseWorkspace,"--input_path",inputMesh,"--output_path",texturedDir],timeoutMs,spawnImpl);report.timingsMs={...report.timingsMs,texturing:Date.now()-textureStart};
  const texturedMesh=path.join(texturedDir,"mesh.ply"),texturePath=path.join(texturedDir,"texture.png");
  if(!(await fileExists(texturedMesh))||!(await fileExists(texturePath)))throw new Error("COLMAP mesh_texturer did not produce textured/mesh.ply and textured/texture.png");
  const modelPath=path.join(outputJobDir,"model.glb"),converted=await convertTexturedPlyToGlb({plyPath:texturedMesh,texturePath,metresPerModelUnit:calibration.metresPerModelUnit,upAxis,scaleCalibrated:calibration.scaleCalibrated});
  await writeFile(modelPath,converted.glb,{flag:"wx",mode:0o600});
  const glbSha256=createHash("sha256").update(converted.glb).digest("hex");
  report.status="completed-requires-review";report.completedAt=new Date().toISOString();report.outputs={glb:{relativePath:path.relative(root,modelPath).split(path.sep).join("/"),bytes:converted.glb.length,sha256:glbSha256},texturedMesh:{relativePath:path.relative(root,texturedMesh).split(path.sep).join("/")},texture:{relativePath:path.relative(root,texturePath).split(path.sep).join("/")},geometry:converted.geometry,bounds:converted.bounds};
  report.warnings.push("Photogrammetry was run, but this worker does not compute ground-control-point registration to WGS84; the BuildingSpec location is a placement hint only.");
  report.warnings.push("Human review is required for scale, vertical axis, front-facing heading, mesh completeness, texture seams, occlusion and same-building identity.");
  if(!calibration.scaleCalibrated)report.warnings.push("No real-world scale was supplied; 1 model unit was provisionally treated as 1 metre for preview only.");
  if(!options.upAxisReviewed)report.warnings.push("Source up axis has not been reviewed; verify model orientation before map placement.");
  report.mapReady=false;report.publicationEligible=false;
  await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  return {jobDir:outputJobDir,modelPath,reportPath,report};
 }catch(error){report.status="failed";report.failedAt=new Date().toISOString();report.failureMessage=error instanceof Error?error.message:String(error);report.mapReady=false;await writeFile(reportPath,JSON.stringify(report,null,2)+"\n").catch(()=>{});error.reportPath=reportPath;throw error;}
}