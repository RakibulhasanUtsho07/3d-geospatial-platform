import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeBuildingSpec } from "./building-spec.mjs";
import { ingestMediaFile } from "./media-intake.mjs";
import { extractVideoFrames } from "./video-frame-extractor.mjs";
import { reviewBuildingSource, prepareBuildingSpecSources } from "./source-workflow.mjs";
import { generateBuildingAsset } from "./generation-pipeline.mjs";
import { registerModelToWgs84 } from "./ground-control-registration.mjs";

const ID=/^[a-z0-9][a-z0-9._-]{0,79}$/i;
const KNOWN_LICENCE=value=>typeof value==="string"&&value.trim().length>0&&!["unknown","n/a","none"].includes(value.trim().toLowerCase());
function safeId(value,label,max=80){
 if(typeof value!=="string"||value.length>max||!ID.test(value))throw new TypeError(label+" must be a valid identifier of at most "+max+" characters");
 return value;
}
function inside(root,candidate){const relative=path.relative(root,candidate);return relative===""||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative));}
async function ensureDirectory(root,segments){
 let current=root;
 for(const segment of segments){
  const next=path.join(current,segment);
  try{const entry=await lstat(next);if(entry.isSymbolicLink()||!entry.isDirectory())throw new TypeError("workflow directory path must not contain symlinks or files: "+next);}
  catch(error){if(error?.code!=="ENOENT")throw error;try{await mkdir(next);}catch(createError){if(createError?.code!=="EEXIST")throw createError;}const entry=await lstat(next);if(entry.isSymbolicLink()||!entry.isDirectory())throw new TypeError("unsafe workflow directory: "+next);}
  current=await realpath(next);if(!inside(root,current))throw new TypeError("workflow directory resolves outside workspaceRoot");
 }
 return current;
}
async function atomicJson(filePath,value){
 const temp=filePath+"."+randomUUID()+".tmp";
 await writeFile(temp,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600});
 try{await rename(temp,filePath);}catch(error){await rm(temp,{force:true}).catch(()=>{});throw error;}
}
function parseSource(source){
 if(!source||typeof source!=="object")throw new TypeError("each source must be an object");
 const sourceId=safeId(source.sourceId,"sourceId");
 if(typeof source.relativePath!=="string"||!source.relativePath.trim())throw new TypeError("source "+sourceId+" needs a workspace-relative file path");
 if(path.isAbsolute(source.relativePath)||path.win32.isAbsolute(source.relativePath))throw new TypeError("source paths must be relative to workspaceRoot");
 if(!KNOWN_LICENCE(source.licence))throw new TypeError("source "+sourceId+" needs a known licence/permission basis; unknown is not accepted for this media-to-3D workflow");
 return {sourceId,relativePath:source.relativePath,licence:source.licence.trim(),author:source.author,attribution:source.attribution,sourceUrl:source.sourceUrl,capturedAt:source.capturedAt,description:source.description,kind:source.kind??"auto",captureLocation:source.captureLocation};
}
function hashBytes(buffer){return createHash("sha256").update(buffer).digest("hex");}
function sourceIdsFromViewOption(value,available){
 const chosen=value===undefined?available:value;
 if(!Array.isArray(chosen))throw new TypeError("viewSourceIds must be an array");
 if(!chosen.length)return [];
 const ids=chosen.map(id=>safeId(id,"view source ID"));
 if(new Set(ids).size!==ids.length)throw new TypeError("selected view source IDs contain duplicates");
 const missing=ids.filter(id=>!available.includes(id));
 if(missing.length)throw new TypeError("selected views are not among the ingested image/video-frame sources: "+missing.join(", "));
 return ids;
}

/**
 * End-to-end local workflow:
 * structured BuildingSpec + licensed local media -> provenance sync -> chosen 3D strategy -> GLB + QA manifest.
 * This is a local operator workflow, not a public upload/admin API.
 */
export async function runMediaToModelWorkflow(options){
 if(!options||typeof options!=="object")throw new TypeError("workflow options are required");
 const root=await realpath(path.resolve(options.workspaceRoot));
 const jobId=safeId(options.jobId,"jobId",60);
 const strategy=options.strategy??"procedural";
 if(!["procedural","auto","single-image-ai","photogrammetry"].includes(strategy))throw new TypeError("strategy must be procedural, auto, single-image-ai or photogrammetry");
 const base=normalizeBuildingSpec(options.buildingSpec).spec;
 const buildingId=safeId(base.id,"buildingId");
 if(!Array.isArray(options.sources))throw new TypeError("sources must be an array");
 const sourceInputs=options.sources.map(parseSource);
 if(sourceInputs.length>100)throw new RangeError("at most 100 source files can be ingested in one workflow run");
 if(new Set(sourceInputs.map(s=>s.sourceId)).size!==sourceInputs.length)throw new TypeError("source IDs must be unique");
 if(sourceInputs.length&&options.confirmRights!==true)throw new TypeError("confirmRights must be true after checking rights for every provided media source");
 if(strategy==="single-image-ai"&&options.confirmSingleViewInference!==true)throw new TypeError("single-image-ai requires confirmSingleViewInference=true because unseen geometry is inferred");
 if(strategy==="photogrammetry"){
  if(options.confirmSameBuilding!==true||options.confirmOverlapReviewed!==true||options.confirmUpAxisReviewed!==true)throw new TypeError("photogrammetry requires same-building, overlap and source-axis confirmations");
  if(!["X","Y","Z"].includes(options.upAxis))throw new TypeError("photogrammetry requires upAxis X, Y or Z");
 }
 const mediaRecords=[],visualIds=[];
 for(const input of sourceInputs){
  const sourcePath=path.resolve(root,input.relativePath);
  if(!inside(root,sourcePath))throw new TypeError("source path escapes workspaceRoot: "+input.relativePath);
  const relative=path.relative(root,sourcePath).split(path.sep).join("/");
  const ingested=await ingestMediaFile({workspaceRoot:root,sourcePath:relative,buildingId,sourceId:input.sourceId,kind:input.kind,title:path.basename(relative),licence:"unknown",usageStatus:"unreviewed",author:input.author,attribution:input.attribution,sourceUrl:input.sourceUrl,capturedAt:input.capturedAt,description:input.description,captureLocation:input.captureLocation});
  const reviewed=await reviewBuildingSource({workspaceRoot:root,buildingId,sourceId:input.sourceId,licence:input.licence,confirmRights:true,author:input.author,attribution:input.attribution,sourceUrl:input.sourceUrl,capturedAt:input.capturedAt,description:input.description,captureLocation:input.captureLocation});
  mediaRecords.push({id:reviewed.record.id,kind:reviewed.record.kind,mimeType:reviewed.record.mimeType,sha256:reviewed.assetSha256,licence:reviewed.record.licence,usageStatus:reviewed.record.usageStatus,relativePath:reviewed.record.relativePath});
  if(reviewed.record.kind==="image")visualIds.push(reviewed.record.id);
  if(reviewed.record.kind==="video"){
   const extracted=await extractVideoFrames({
    workspaceRoot:root,videoRelativePath:reviewed.record.relativePath,buildingId,sourceId:reviewed.record.id,
    fps:options.fps??0.5,maxFrames:options.maxFrames??60,maxWidth:options.maxWidth??1600,
    timeoutMs:options.frameTimeoutMs??600000,ffmpegPath:options.ffmpegPath,videoRecord:reviewed.record,
   });
   for(const frame of extracted.frames){
    visualIds.push(frame.id);
    mediaRecords.push({id:frame.id,kind:frame.kind,mimeType:frame.mimeType,sha256:frame.sha256,licence:frame.licence,usageStatus:frame.usageStatus,relativePath:frame.relativePath,parentSourceId:frame.parentSourceId,frameNumber:frame.frameNumber,nominalTimeSeconds:frame.nominalTimeSeconds});
   }
  }
 }
 let buildingSpec=base;
 const importedIds=mediaRecords.map(item=>item.id);
 const explicitlySelected=options.viewSourceIds===undefined?[]:options.viewSourceIds.map(id=>safeId(id,"view source ID"));
 const specSourceIds=[...new Set([...importedIds,...explicitlySelected])];
 if(specSourceIds.length){
  const prepared=await prepareBuildingSpecSources({workspaceRoot:root,buildingSpec:base,sourceIds:specSourceIds});
  buildingSpec=prepared.buildingSpec;
 }
 const availableViews=[...new Set(visualIds)];
 for(const sourceId of explicitlySelected){
  if(availableViews.includes(sourceId))continue;
  const sourceRecordPath=path.join(root,".building-engine","media",buildingId,"sources",sourceId+".json");
  const sourceRecord=JSON.parse(await readFile(sourceRecordPath,"utf8"));
  if(sourceRecord.buildingId!==buildingId||sourceRecord.id!==sourceId)throw new TypeError("selected view source metadata identity mismatch: "+sourceId);
  if(!["image","video-frame"].includes(sourceRecord.kind))throw new TypeError("selected view "+sourceId+" must be an image or extracted video-frame");
  availableViews.push(sourceId);
 }
 const viewIds=sourceIdsFromViewOption(options.viewSourceIds,availableViews);
 if(strategy==="single-image-ai"&&viewIds.length!==1)throw new TypeError("single-image-ai requires exactly one selected image/video-frame via viewSourceIds");
 if(strategy==="photogrammetry"&&viewIds.length<3)throw new TypeError("photogrammetry requires at least three selected image/video-frame sources");
 const jobsRoot=await ensureDirectory(root,[".building-engine","jobs",buildingId]);
 const workflowDir=path.join(jobsRoot,jobId+"-workflow");
 await mkdir(workflowDir,{recursive:false,mode:0o700});
 const realWorkflowDir=await realpath(workflowDir);
 if(!inside(jobsRoot,realWorkflowDir))throw new TypeError("workflow result directory resolves outside building jobs");
 const specPath=path.join(realWorkflowDir,"building-spec.json");
 await atomicJson(specPath,buildingSpec);
 const runReportPath=path.join(realWorkflowDir,"workflow-report.json");
 const now=new Date().toISOString();
 const runReport={
  schemaVersion:"1.0.0",engine:"media-to-model-workflow-v1",buildingId,jobId,strategy,status:"running",startedAt:now,
  inputs:{baseSpecSha256:hashBytes(Buffer.from(JSON.stringify(base))),sourceCount:sourceInputs.length,mediaRecords,selectedViewIds:viewIds},
  output:{buildingSpecPath:path.relative(root,specPath).split(path.sep).join("/")},mapReady:false,publicationEligible:false,warnings:[],
 };
 await atomicJson(runReportPath,runReport);
 try{
  const workerJobId=jobId+"-"+(strategy==="photogrammetry"?"colmap":strategy==="single-image-ai"?"single-image":"procedural");
  const result=await generateBuildingAsset(buildingSpec,{
   strategy,
   reconstruction:{
    workspaceRoot:root,jobId:workerJobId,sourceIds:viewIds,upAxis:options.upAxis,upAxisReviewed:options.confirmUpAxisReviewed===true,
    matchConfirmed:options.confirmSameBuilding===true,overlapReviewed:options.confirmOverlapReviewed===true,
    quality:options.quality??"MEDIUM",colmapPath:options.colmapPath,timeoutMs:options.reconstructionTimeoutMs,
    headingDegrees:options.headingDegrees??0,
    scaleCalibration:{...(options.modelDistanceUnits!==undefined?{modelDistanceUnits:options.modelDistanceUnits}:{}),...(options.realDistanceM!==undefined?{realDistanceM:options.realDistanceM}:{})},
    ffmpegPath:options.ffmpegPath,
  },
   singleImage:{
    workspaceRoot:root,jobId:workerJobId,sourceId:viewIds[0],runnerScript:options.runnerScript,pythonPath:options.pythonPath,
    device:options.device??"cuda:0",mcResolution:options.mcResolution??256,pretrainedModelNameOrPath:options.pretrainedModelNameOrPath,
    timeoutMs:options.singleImageTimeoutMs,allowSingleViewInference:options.confirmSingleViewInference===true,
   },
  });
  let finalModelPath=path.join(realWorkflowDir,"model.glb");
  if(Buffer.isBuffer(result.glb))await writeFile(finalModelPath,result.glb,{flag:"wx",mode:0o600});
  else if(typeof result.modelPath==="string")await copyFile(result.modelPath,finalModelPath);
  else throw new TypeError("selected strategy completed without a GLB output");
  const modelBytes=await readFile(finalModelPath);
  runReport.status="completed-requires-review";
  runReport.completedAt=new Date().toISOString();
  runReport.mode=result.mode;
  runReport.output={
   ...runReport.output,
   modelPath:path.relative(root,finalModelPath).split(path.sep).join("/"),
   modelBytes:modelBytes.length,
   modelSha256:hashBytes(modelBytes),
   reportPath:result.reportPath?path.relative(root,result.reportPath).split(path.sep).join("/"):null,
  };
  runReport.strategyPlan=result.plan;
  runReport.modelReport=result.report;
  if(options.controlPoints!==undefined){
   runReport.georeference=registerModelToWgs84({controlPoints:options.controlPoints,maxRmsErrorM:options.maxGcpRmsErrorM,maxResidualM:options.maxGcpResidualM});
   runReport.warnings.push("Ground-control registration was calculated; verify that each model X/Z coordinate identifies the corresponding physical feature in this exact GLB.");
   runReport.warnings.push("Vertical height datum remains unresolved; horizontal registration alone does not make the model publishable.");
  }
  runReport.mapReady=false;
  runReport.publicationEligible=false;
  runReport.warnings=[...new Set([...(runReport.warnings??[]),...(result.report?.warnings??[]),...(result.warning?[result.warning]:[]),"The workflow produces a review candidate only; it does not publish assets to /map."])];
  await atomicJson(runReportPath,runReport);
  return {workflowDir:realWorkflowDir,modelPath:finalModelPath,specPath,reportPath:runReportPath,report:runReport};
 }catch(error){
  runReport.status="failed";runReport.failedAt=new Date().toISOString();runReport.failureMessage=error instanceof Error?error.message:String(error);
  await atomicJson(runReportPath,runReport).catch(()=>{});
  error.reportPath=runReportPath;
  throw error;
 }
}