import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeBuildingSpec } from "./building-spec.mjs";
import { ingestMediaFile } from "./media-intake.mjs";
import { extractVideoFrames } from "./video-frame-extractor.mjs";
import { reviewBuildingSource, prepareBuildingSpecSources, loadVerifiedSource } from "./source-workflow.mjs";
import { generateBuildingAsset } from "./generation-pipeline.mjs";
import { registerModelToWgs84 } from "./ground-control-registration.mjs";
import {
 createOrResumeReconstructionJob,
 fingerprintStageInput,
 startReconstructionStage,
 completeReconstructionStage,
 failReconstructionStage,
 MEDIA_TO_MODEL_STAGE_IDS,
} from "./reconstruction-job-state.mjs";

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
 try{await rename(temp,filePath);}
 catch(error){
  if(!["EEXIST","EPERM","ENOTEMPTY"].includes(error?.code)){await rm(temp,{force:true}).catch(()=>{});throw error;}
  try{
   const existing=await lstat(filePath);
   if(existing.isSymbolicLink()||!existing.isFile())throw new TypeError("refusing to replace a non-regular output file: "+filePath);
   await rm(filePath);
   await rename(temp,filePath);
  }catch(replaceError){await rm(temp,{force:true}).catch(()=>{});throw replaceError;}
 }
}
async function atomicBytes(filePath,bytes){
 const temp=filePath+"."+randomUUID()+".tmp";
 await writeFile(temp,bytes,{flag:"wx",mode:0o600});
 try{await rename(temp,filePath);}
 catch(error){
  if(!["EEXIST","EPERM","ENOTEMPTY"].includes(error?.code)){await rm(temp,{force:true}).catch(()=>{});throw error;}
  try{
   const existing=await lstat(filePath);
   if(existing.isSymbolicLink()||!existing.isFile())throw new TypeError("refusing to replace a non-regular model output: "+filePath);
   await rm(filePath);
   await rename(temp,filePath);
  }catch(replaceError){await rm(temp,{force:true}).catch(()=>{});throw replaceError;}
 }
}
async function hashFile(filePath){
 const digest=createHash("sha256");
 for await(const chunk of createReadStream(filePath))digest.update(chunk);
 return digest.digest("hex");
}
function jsonSafe(value){
 if(value===undefined)return null;
 const serialized=JSON.stringify(value);
 if(serialized===undefined)throw new TypeError("workflow artifact payload is not JSON serializable");
 return JSON.parse(serialized);
}
function withoutUndefined(value){
 return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined));
}
async function prepareWorkflowDirectory(root,buildingId,jobId){
 const jobsRoot=await ensureDirectory(root,[".building-engine","jobs",buildingId]);
 const workflowDir=path.join(jobsRoot,jobId+"-workflow");
 try{
  const entry=await lstat(workflowDir);
  if(entry.isSymbolicLink()||!entry.isDirectory())throw new TypeError("workflow result path must be a real directory");
 }catch(error){
  if(error?.code!=="ENOENT")throw error;
  await mkdir(workflowDir,{recursive:false,mode:0o700});
 }
 const realWorkflowDir=await realpath(workflowDir);
 if(!inside(jobsRoot,realWorkflowDir))throw new TypeError("workflow result directory resolves outside building jobs");
 return realWorkflowDir;
}
async function runStateStage({
 root,buildingId,jobId,stageId,inputFingerprint,execute,validateReused,
}){
 const stateArgs={workspaceRoot:root,buildingId,jobId,stageId,inputFingerprint};
 let started=await startReconstructionStage(stateArgs);
 if(started.reused&&validateReused){
  try{await validateReused(started.artifact);}
  catch{
   started=await startReconstructionStage({...stateArgs,force:true});
  }
 }
 if(started.reused)return {artifact:started.artifact,reused:true,value:null};
 try{
  const result=await execute(started.job);
  const completed=await completeReconstructionStage({
   workspaceRoot:root,buildingId,jobId,stageId,
   payload:jsonSafe(result.payload??{}),outputs:jsonSafe(result.outputs??{}),
  });
  return {artifact:completed.artifact,reused:false,value:result.value??null};
 }catch(error){
  await failReconstructionStage({workspaceRoot:root,buildingId,jobId,stageId,error}).catch(()=>{});
  throw error;
 }
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

 const explicitlySelected=options.viewSourceIds===undefined?[]:options.viewSourceIds.map(id=>safeId(id,"view source ID"));
 const baseSpecSha256=hashBytes(Buffer.from(JSON.stringify(base)));
 const sourceFileManifest=[];
 for(const input of sourceInputs){
  const supplied=path.resolve(root,input.relativePath);
  if(!inside(root,supplied))throw new TypeError("source path escapes workspaceRoot: "+input.relativePath);
  const info=await lstat(supplied);
  if(info.isSymbolicLink()||!info.isFile())throw new TypeError("media source must be a regular non-symlink file: "+input.relativePath);
  if(info.size<=0||info.size>500*1024*1024)throw new RangeError("media source is empty or exceeds the 500 MB workflow intake limit: "+input.relativePath);
  const actual=await realpath(supplied);
  if(!inside(root,actual))throw new TypeError("media source resolves outside workspaceRoot: "+input.relativePath);
  sourceFileManifest.push({
   ...withoutUndefined(input),
   relativePath:path.relative(root,supplied).split(path.sep).join("/"),
   sha256:await hashFile(actual),
  });
 }
 const sourceManifest={
  baseSpecSha256,
  sourceFiles:sourceFileManifest,
  selectedViewSourceIds:explicitlySelected,
 };
 const config={
  profile:"media-to-model-v1",
  strategy,
  baseSpecSha256,
  viewSourceIds:options.viewSourceIds===undefined?null:explicitlySelected,
  confirmRights:options.confirmRights===true,
  confirmSingleViewInference:options.confirmSingleViewInference===true,
  confirmSameBuilding:options.confirmSameBuilding===true,
  confirmOverlapReviewed:options.confirmOverlapReviewed===true,
  confirmUpAxisReviewed:options.confirmUpAxisReviewed===true,
  fps:options.fps??0.5,
  maxFrames:options.maxFrames??60,
  maxWidth:options.maxWidth??1600,
  frameTimeoutMs:options.frameTimeoutMs??600000,
  ffmpegPath:options.ffmpegPath??"ffmpeg",
  upAxis:options.upAxis??null,
  quality:options.quality??"MEDIUM",
  colmapPath:options.colmapPath??null,
  colmapUseGpu:options.colmapUseGpu===true,
  reconstructionTimeoutMs:options.reconstructionTimeoutMs??3600000,
  headingDegrees:options.headingDegrees??0,
  modelDistanceUnits:options.modelDistanceUnits??null,
  realDistanceM:options.realDistanceM??null,
  runnerScript:options.runnerScript??null,
  pythonPath:options.pythonPath??null,
  device:options.device??"cuda:0",
  mcResolution:options.mcResolution??256,
  pretrainedModelNameOrPath:options.pretrainedModelNameOrPath??"stabilityai/TripoSR",
  singleImageTimeoutMs:options.singleImageTimeoutMs??1800000,
  controlPoints:options.controlPoints===undefined?null:jsonSafe(options.controlPoints),
  maxGcpRmsErrorM:options.maxGcpRmsErrorM??0.5,
  maxGcpResidualM:options.maxGcpResidualM??1,
 };
 const state=await createOrResumeReconstructionJob({
  workspaceRoot:root,buildingId,jobId,sourceManifest,config,stageIds:MEDIA_TO_MODEL_STAGE_IDS,
 });
 const realWorkflowDir=await prepareWorkflowDirectory(root,buildingId,jobId);
 const specPath=path.join(realWorkflowDir,"building-spec.json");
 const finalModelPath=path.join(realWorkflowDir,"model.glb");
 const runReportPath=path.join(realWorkflowDir,"workflow-report.json");
 const runReport={
  schemaVersion:"1.0.0",engine:"media-to-model-workflow-v1",buildingId,jobId,strategy,
  status:"running",startedAt:state.job.createdAt,
  inputs:{baseSpecSha256,sourceCount:sourceInputs.length,mediaRecords:[],selectedViewIds:[]},
  output:{
   buildingSpecPath:path.relative(root,specPath).split(path.sep).join("/"),
   reconstructionJobStatePath:path.relative(root,path.join(state.jobDirectory,"job-state.json")).split(path.sep).join("/"),
  },
  mapReady:false,publicationEligible:false,warnings:[],
 };
 await atomicJson(runReportPath,runReport);

 try{
  // Stage 1: local intake and explicit rights attestation. Reuse an exact, verified
  // source record after a crash rather than trying to create the same source ID twice.
  const ingestionFingerprint=fingerprintStageInput({
   stageId:"media-ingestion",
   inputs:{sourceManifestSha256:state.job.sourceManifestSha256},
   parameters:{
    fps:config.fps,maxFrames:config.maxFrames,maxWidth:config.maxWidth,
    frameTimeoutMs:config.frameTimeoutMs,ffmpegPath:config.ffmpegPath,
   },
  });
  const ingestion=await runStateStage({
   root,buildingId,jobId,stageId:"media-ingestion",inputFingerprint:ingestionFingerprint,
   validateReused:async artifact=>{
    if(!Array.isArray(artifact.payload?.mediaRecords)||!Array.isArray(artifact.payload?.visualIds)){
     throw new TypeError("cached media-ingestion artifact is incomplete");
    }
    for(const saved of artifact.payload.mediaRecords){
     const loaded=await loadVerifiedSource(root,buildingId,saved.id);
     if(loaded.sha256!==saved.sha256||loaded.record.kind!==saved.kind||
        loaded.record.mimeType!==saved.mimeType||loaded.record.licence!==saved.licence||
        loaded.record.usageStatus!==saved.usageStatus||loaded.record.relativePath!==saved.relativePath||
        (saved.parentSourceId!==undefined&&loaded.record.parentSourceId!==saved.parentSourceId)){
      throw new TypeError("cached media source no longer matches its ingestion artifact: "+saved.id);
     }
    }
   },
   execute:async()=>{
    const mediaRecords=[],visualIds=[];
    for(const manifestInput of sourceFileManifest){
     const input=sourceInputs.find(item=>item.sourceId===manifestInput.sourceId);
     const relative=manifestInput.relativePath;
     let existing=null;
     try{existing=await loadVerifiedSource(root,buildingId,input.sourceId);}
     catch(error){if(error?.code!=="ENOENT")throw error;}
     if(existing){
      if(existing.sha256!==manifestInput.sha256)throw new TypeError("source ID '"+input.sourceId+"' already exists with different content; use a new source ID");
     }else{
      await ingestMediaFile({
       workspaceRoot:root,sourcePath:relative,buildingId,sourceId:input.sourceId,kind:input.kind,
       title:path.basename(relative),licence:"unknown",usageStatus:"unreviewed",author:input.author,
       attribution:input.attribution,sourceUrl:input.sourceUrl,capturedAt:input.capturedAt,
       description:input.description,captureLocation:input.captureLocation,
      });
     }
     const reviewed=await reviewBuildingSource({
      workspaceRoot:root,buildingId,sourceId:input.sourceId,licence:input.licence,confirmRights:true,
      author:input.author,attribution:input.attribution,sourceUrl:input.sourceUrl,capturedAt:input.capturedAt,
      description:input.description,captureLocation:input.captureLocation,
     });
     mediaRecords.push({
      id:reviewed.record.id,kind:reviewed.record.kind,mimeType:reviewed.record.mimeType,
      sha256:reviewed.assetSha256,licence:reviewed.record.licence,usageStatus:reviewed.record.usageStatus,
      relativePath:reviewed.record.relativePath,
     });
     if(reviewed.record.kind==="image")visualIds.push(reviewed.record.id);
     if(reviewed.record.kind==="video"){
      const extracted=await extractVideoFrames({
       workspaceRoot:root,videoRelativePath:reviewed.record.relativePath,buildingId,sourceId:reviewed.record.id,
       fps:config.fps,maxFrames:config.maxFrames,maxWidth:config.maxWidth,
       timeoutMs:config.frameTimeoutMs,ffmpegPath:options.ffmpegPath,videoRecord:reviewed.record,
      });
      for(const frame of extracted.frames){
       visualIds.push(frame.id);
       mediaRecords.push({
        id:frame.id,kind:frame.kind,mimeType:frame.mimeType,sha256:frame.sha256,
        licence:frame.licence,usageStatus:frame.usageStatus,relativePath:frame.relativePath,
        parentSourceId:frame.parentSourceId,frameNumber:frame.frameNumber,nominalTimeSeconds:frame.nominalTimeSeconds,
       });
      }
     }
    }
    return {
     payload:{mediaRecords,visualIds},
     outputs:{sourceCount:sourceInputs.length,mediaRecordCount:mediaRecords.length,visualViewCount:visualIds.length},
    };
   },
  });
  const mediaRecords=ingestion.artifact.payload.mediaRecords;
  const visualIds=ingestion.artifact.payload.visualIds;
  if(!Array.isArray(mediaRecords)||!Array.isArray(visualIds))throw new TypeError("stored media-ingestion artifact is incomplete");

  // Stage 2: verify selected views, sync their source provenance into BuildingSpec,
  // and persist the normalized spec in the immutable artifact.
  const specSourceIds=[...new Set([...mediaRecords.map(item=>item.id),...explicitlySelected])];
  const selectedSourceManifest=[];
  for(const sourceId of explicitlySelected){
   const ingestedRecord=mediaRecords.find(item=>item.id===sourceId);
   if(ingestedRecord){
    selectedSourceManifest.push({
     id:sourceId,sha256:ingestedRecord.sha256,kind:ingestedRecord.kind,
     licence:ingestedRecord.licence,usageStatus:ingestedRecord.usageStatus,
    });
    continue;
   }
   const selected=await loadVerifiedSource(root,buildingId,sourceId);
   selectedSourceManifest.push({
    id:sourceId,sha256:selected.sha256,kind:selected.record.kind,
    licence:selected.record.licence,usageStatus:selected.record.usageStatus,
    parentSourceId:selected.record.parentSourceId??null,
   });
  }
  const specSyncFingerprint=fingerprintStageInput({
   stageId:"building-spec-sync",
   inputs:{ingestionArtifactSha256:ingestion.artifact.contentSha256,baseSpecSha256},
   parameters:{selectedSourceIds:specSourceIds,selectedSourceManifest},
  });
  const specSync=await runStateStage({
   root,buildingId,jobId,stageId:"building-spec-sync",inputFingerprint:specSyncFingerprint,
   execute:async()=>{
    let buildingSpec=base;
    if(specSourceIds.length){
     const prepared=await prepareBuildingSpecSources({workspaceRoot:root,buildingSpec:base,sourceIds:specSourceIds});
     buildingSpec=prepared.buildingSpec;
    }
    const availableViews=[...new Set(visualIds)];
    for(const sourceId of explicitlySelected){
     if(availableViews.includes(sourceId))continue;
     const selected=await loadVerifiedSource(root,buildingId,sourceId);
     if(!["image","video-frame"].includes(selected.record.kind))throw new TypeError("selected view "+sourceId+" must be an image or extracted video-frame");
     availableViews.push(sourceId);
    }
    const viewIds=sourceIdsFromViewOption(options.viewSourceIds,availableViews);
    if(strategy==="single-image-ai"&&viewIds.length!==1)throw new TypeError("single-image-ai requires exactly one selected image/video-frame via viewSourceIds");
    if(strategy==="photogrammetry"&&viewIds.length<3)throw new TypeError("photogrammetry requires at least three selected image/video-frame sources");
    return {
     payload:{buildingSpec:jsonSafe(buildingSpec),selectedSourceIds:specSourceIds,viewIds,selectedSourceManifest},
     outputs:{buildingSpecRelativePath:path.relative(root,specPath).split(path.sep).join("/"),selectedSourceCount:specSourceIds.length,selectedViewCount:viewIds.length},
    };
   },
  });
  const syncedSpec=specSync.artifact.payload.buildingSpec;
  const viewIds=specSync.artifact.payload.viewIds;
  if(!syncedSpec||!Array.isArray(viewIds))throw new TypeError("stored building-spec-sync artifact is incomplete");
  await atomicJson(specPath,syncedSpec);
  runReport.inputs.mediaRecords=mediaRecords;
  runReport.inputs.selectedViewIds=viewIds;
  runReport.selectedSourceManifest=specSync.artifact.payload.selectedSourceManifest;

  // Stage 3: build the selected model candidate and record the actual worker report.
  const modelFingerprint=fingerprintStageInput({
   stageId:"model-generation",
   inputs:{specSyncArtifactSha256:specSync.artifact.contentSha256},
   parameters:{
    strategy,viewIds,quality:config.quality,colmapPath:config.colmapPath,colmapUseGpu:config.colmapUseGpu,
    reconstructionTimeoutMs:config.reconstructionTimeoutMs,upAxis:config.upAxis,
    confirmSameBuilding:config.confirmSameBuilding,confirmOverlapReviewed:config.confirmOverlapReviewed,
    confirmUpAxisReviewed:config.confirmUpAxisReviewed,headingDegrees:config.headingDegrees,
    modelDistanceUnits:config.modelDistanceUnits,realDistanceM:config.realDistanceM,
    runnerScript:config.runnerScript,pythonPath:config.pythonPath,device:config.device,
    mcResolution:config.mcResolution,pretrainedModelNameOrPath:config.pretrainedModelNameOrPath,
    singleImageTimeoutMs:config.singleImageTimeoutMs,
   },
  });
  const modelStage=await runStateStage({
   root,buildingId,jobId,stageId:"model-generation",inputFingerprint:modelFingerprint,
   validateReused:async artifact=>{
    const relative=artifact.payload?.modelPath;
    if(relative!==path.relative(root,finalModelPath).split(path.sep).join("/"))throw new TypeError("cached model path changed");
    const entry=await lstat(finalModelPath);
    if(entry.isSymbolicLink()||!entry.isFile())throw new TypeError("cached model output is not a regular file");
    const actual=await realpath(finalModelPath);
    if(!inside(realWorkflowDir,actual))throw new TypeError("cached model output resolves outside the workflow directory");
    const bytes=await readFile(actual);
    if(hashBytes(bytes)!==artifact.payload.modelSha256)throw new TypeError("cached model output checksum mismatch");
   },
   execute:async currentJob=>{
    const planSuffix=strategy==="photogrammetry"?"colmap":strategy==="single-image-ai"?"single-image":"procedural";
    const attempt=currentJob.stages.find(stage=>stage.id==="model-generation")?.attempts??1;
    const workerJobId=safeId(jobId.slice(0,35)+"-"+hashBytes(Buffer.from(jobId)).slice(0,8)+"-"+planSuffix+"-"+attempt,"workerJobId");
    const result=await generateBuildingAsset(syncedSpec,{
     strategy,
     reconstruction:{
      workspaceRoot:root,jobId:workerJobId,sourceIds:viewIds,upAxis:options.upAxis,upAxisReviewed:options.confirmUpAxisReviewed===true,
      matchConfirmed:options.confirmSameBuilding===true,overlapReviewed:options.confirmOverlapReviewed===true,
      quality:config.quality,colmapPath:options.colmapPath,useGpu:config.colmapUseGpu,timeoutMs:config.reconstructionTimeoutMs,
      headingDegrees:config.headingDegrees,
      scaleCalibration:{...(options.modelDistanceUnits!==undefined?{modelDistanceUnits:options.modelDistanceUnits}:{}),...(options.realDistanceM!==undefined?{realDistanceM:options.realDistanceM}:{})},
      ffmpegPath:options.ffmpegPath,
     },
     singleImage:{
      workspaceRoot:root,jobId:workerJobId,sourceId:viewIds[0],runnerScript:options.runnerScript,pythonPath:options.pythonPath,
      device:config.device,mcResolution:config.mcResolution,pretrainedModelNameOrPath:config.pretrainedModelNameOrPath,
      timeoutMs:config.singleImageTimeoutMs,allowSingleViewInference:options.confirmSingleViewInference===true,
     },
    });
    let modelBytes;
    if(Buffer.isBuffer(result.glb))modelBytes=result.glb;
    else if(typeof result.modelPath==="string")modelBytes=await readFile(result.modelPath);
    else throw new TypeError("selected strategy completed without a GLB output");
    const parsedGlbHeader=modelBytes.length>=12&&modelBytes.readUInt32LE(0)===0x46546c67&&modelBytes.readUInt32LE(4)===2&&modelBytes.readUInt32LE(8)===modelBytes.length;
    if(!parsedGlbHeader)throw new TypeError("selected generation strategy did not produce a valid GLB 2.0 binary");
    await atomicBytes(finalModelPath,modelBytes);
    return {
     payload:{
      mode:result.mode,plan:jsonSafe(result.plan),report:jsonSafe(result.report),
      warning:result.warning??null,
      modelPath:path.relative(root,finalModelPath).split(path.sep).join("/"),
      modelBytes:modelBytes.length,modelSha256:hashBytes(modelBytes),
      workerReportPath:typeof result.reportPath==="string"?path.relative(root,result.reportPath).split(path.sep).join("/"):null,
     },
     outputs:{
      modelPath:path.relative(root,finalModelPath).split(path.sep).join("/"),
      modelBytes:modelBytes.length,modelSha256:hashBytes(modelBytes),
      workerReportPath:typeof result.reportPath==="string"?path.relative(root,result.reportPath).split(path.sep).join("/"):null,
     },
    };
   },
  });
  const modelOutput=modelStage.artifact.payload;
  if(!modelOutput||typeof modelOutput.modelSha256!=="string")throw new TypeError("stored model-generation artifact is incomplete");
  runReport.mode=modelOutput.mode;
  runReport.output={
   ...runReport.output,
   modelPath:modelOutput.modelPath,
   modelBytes:modelOutput.modelBytes,
   modelSha256:modelOutput.modelSha256,
   reportPath:modelOutput.workerReportPath,
  };
  runReport.strategyPlan=modelOutput.plan;
  runReport.modelReport=modelOutput.report;

  // Stage 4: finalize the human-review report. This never grants publication or map readiness.
  const finalFingerprint=fingerprintStageInput({
   stageId:"report-finalization",
   inputs:{modelArtifactSha256:modelStage.artifact.contentSha256},
   parameters:{
    controlPoints:config.controlPoints,
    maxGcpRmsErrorM:config.maxGcpRmsErrorM,
    maxGcpResidualM:config.maxGcpResidualM,
   },
  });
  const finalized=await runStateStage({
   root,buildingId,jobId,stageId:"report-finalization",inputFingerprint:finalFingerprint,
   execute:async()=>{
    runReport.status="completed-requires-review";
    runReport.completedAt=new Date().toISOString();
    if(options.controlPoints!==undefined){
     runReport.georeference=registerModelToWgs84({controlPoints:options.controlPoints,maxRmsErrorM:options.maxGcpRmsErrorM,maxResidualM:options.maxGcpResidualM});
     runReport.warnings.push("Ground-control registration was calculated; verify that each model X/Z coordinate identifies the corresponding physical feature in this exact GLB.");
     runReport.warnings.push("Vertical height datum remains unresolved; horizontal registration alone does not make the model publishable.");
    }
    runReport.mapReady=false;
    runReport.publicationEligible=false;
    runReport.warnings=[...new Set([
     ...(runReport.warnings??[]),...(modelOutput.report?.warnings??[]),
     ...(modelOutput.warning?[modelOutput.warning]:[]),
     "The workflow produces a review candidate only; it does not publish assets to /map.",
    ])];
    await atomicJson(runReportPath,runReport);
    return {
     payload:{report:jsonSafe(runReport)},
     outputs:{
      workflowReportPath:path.relative(root,runReportPath).split(path.sep).join("/"),
      modelSha256:modelOutput.modelSha256,status:runReport.status,
      mapReady:false,publicationEligible:false,
     },
    };
   },
  });
  const finalReport=finalized.artifact.payload.report;
  if(!finalReport||finalReport.mapReady!==false||finalReport.publicationEligible!==false)throw new TypeError("stored report violates the fail-closed publication contract");
  await atomicJson(runReportPath,finalReport);
  return {workflowDir:realWorkflowDir,modelPath:finalModelPath,specPath,reportPath:runReportPath,report:finalReport};
 }catch(error){
  runReport.status="failed";runReport.failedAt=new Date().toISOString();runReport.failureMessage=error instanceof Error?error.message:String(error);
  runReport.mapReady=false;runReport.publicationEligible=false;
  await atomicJson(runReportPath,runReport).catch(()=>{});
  error.reportPath=runReportPath;
  throw error;
 }
}
