import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeBuildingSpec } from "./building-spec.mjs";
import { analyzeGlbQuality } from "./glb-geometry-qa.mjs";

const ID=/^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MAX_MODEL_BYTES=500*1024*1024;
function safeId(value,label){if(typeof value!=="string"||!ID.test(value))throw new TypeError(label+" is invalid");return value;}
function inside(root,candidate){const relative=path.relative(root,candidate);return relative===""||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative));}
function requireConfirmed(value){if(value!==true)throw new TypeError("allowSingleViewInference must be explicitly true; single-view AI is approximate and can hallucinate unseen geometry");}
async function processRun(executable,args,cwd,timeoutMs,spawnImpl=nodeSpawn){
 return await new Promise((resolve,reject)=>{
  let child;
  try{child=spawnImpl(executable,args,{cwd,stdio:["ignore","pipe","pipe"],windowsHide:true});}
  catch(error){
   const wrapped=new Error("Could not start single-image runner '"+executable+"': "+error.message);
   wrapped.processStarted=false;wrapped.spawnErrorCode=error?.code??null;reject(wrapped);return;
  }
  let stdout="",stderr="",settled=false;
  const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
  child.stdout?.on("data",chunk=>{stdout=(stdout+chunk.toString()).slice(-12000);});
  child.stderr?.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-20000);});
  const timer=setTimeout(()=>{
   child.kill("SIGTERM");const killer=setTimeout(()=>child.kill("SIGKILL"),2500);killer.unref?.();
   const error=new Error("Single-image 3D runner timed out after "+timeoutMs+" ms");
   error.processStarted=true;error.timedOut=true;done(reject,error);
  },timeoutMs);
  child.once("error",error=>{
   const wrapped=new Error("Could not start single-image runner '"+executable+"': "+error.message);
   wrapped.processStarted=false;wrapped.spawnErrorCode=error?.code??null;done(reject,wrapped);
  });
  child.once("close",(code,signal)=>{
   if(code===0)done(resolve,{stdout,stderr,exitCode:code,signal,processStarted:true});
   else{
    const error=new Error("Single-image runner failed (exit "+code+(signal?", signal "+signal:"")+"): "+(stderr.trim().slice(-6000)||stdout.trim().slice(-2000)||"no diagnostic output"));
    error.processStarted=true;error.exitCode=code;error.signal=signal;
    done(reject,error);
   }
  });
 });
}

async function requiredRegularFile(filePath,label,{allowSymlink=false}={}){
 const entry=await lstat(filePath);
 if((entry.isSymbolicLink()&&!allowSymlink)||!entry.isFile())throw new TypeError(label+" must be a regular file"+(allowSymlink?"":" and not a symlink"));
 const resolved=await realpath(filePath),s=await stat(resolved);
 if(!s.isFile()||s.size<=0)throw new TypeError(label+" is empty or invalid");
 return {path:resolved,size:s.size};
}
function parseGlb(buffer){
 if(buffer.length<20||buffer.readUInt32LE(0)!==0x46546c67||buffer.readUInt32LE(4)!==2||buffer.readUInt32LE(8)!==buffer.length)throw new TypeError("single-image runner did not output a valid GLB 2.0 file");
 const jsonLength=buffer.readUInt32LE(12);
 if(jsonLength<2||20+jsonLength>buffer.length||buffer.readUInt32LE(16)!==0x4e4f534a)throw new TypeError("GLB JSON chunk is missing or invalid");
 const json=JSON.parse(buffer.subarray(20,20+jsonLength).toString("utf8").trim());
 if(json.asset?.version!=="2.0"||!Array.isArray(json.meshes)||json.meshes.length===0)throw new TypeError("GLB output contains no mesh");
 return {json,meshCount:json.meshes.length};
}

/** Use the externally-installed TripoSR run.py for a single-view AI-proposed mesh preview. */
export async function runSingleImage3D(options){
 if(!options||typeof options!=="object")throw new TypeError("options are required");
 requireConfirmed(options.allowSingleViewInference);
 const buildingId=safeId(options.buildingId,"buildingId"),jobId=safeId(options.jobId,"jobId"),sourceId=safeId(options.sourceId,"sourceId");
 const timeoutMs=options.timeoutMs??1800000;
 if(!Number.isInteger(timeoutMs)||timeoutMs<10000||timeoutMs>7200000)throw new RangeError("timeoutMs must be between 10000 and 7200000");
 const resolution=options.mcResolution??256;
 if(!Number.isInteger(resolution)||resolution<64||resolution>512)throw new RangeError("mcResolution must be an integer between 64 and 512");
 const device=options.device??"cuda:0";
 if(typeof device!=="string"||!(/^(cpu|mps|cuda:\d+)$/.test(device)))throw new TypeError("device must be cpu, mps or cuda:N");
 const modelId=options.pretrainedModelNameOrPath??"stabilityai/TripoSR";
 if(typeof modelId!=="string"||!modelId.trim()||modelId.length>500||modelId.includes("\0"))throw new TypeError("pretrainedModelNameOrPath is invalid");
 const root=await realpath(path.resolve(options.workspaceRoot)),spec=normalizeBuildingSpec(options.buildingSpec).spec;
 if(spec.id!==buildingId)throw new TypeError("BuildingSpec id must equal buildingId");
 const declared=spec.sources.find(source=>source.id===sourceId);
 if(!declared)throw new TypeError("BuildingSpec does not contain source '"+sourceId+"'");
 const mediaRoot=await realpath(path.join(root,".building-engine","media",buildingId));
 if(!inside(root,mediaRoot))throw new TypeError("building media directory resolves outside workspaceRoot");
 const sourceRoot=await realpath(path.join(mediaRoot,"sources")),assetRoot=await realpath(path.join(mediaRoot,"assets"));
 if(!inside(mediaRoot,sourceRoot)||!inside(mediaRoot,assetRoot))throw new TypeError("source/asset directory escapes the building media store");
 const recordPath=path.join(sourceRoot,sourceId+".json"),recordFile=await requiredRegularFile(recordPath,"source metadata");
 if(!inside(sourceRoot,recordFile.path))throw new TypeError("source metadata resolves outside source store");
 const record=JSON.parse(await readFile(recordFile.path,"utf8"));
 if(record.id!==sourceId||record.buildingId!==buildingId)throw new TypeError("source metadata identity mismatch");
 if(!["image","video-frame"].includes(record.kind)||!["image/jpeg","image/png"].includes(record.mimeType))throw new TypeError("single-image AI route only accepts approved JPEG/PNG images or extracted video frames");
 if(record.usageStatus!=="approved"||typeof record.licence!=="string"||!record.licence.trim()||record.licence.toLowerCase()==="unknown")throw new TypeError("source must have a reviewed licence and usageStatus=approved");
 if(declared.usageStatus!=="approved"||declared.licence!==record.licence||declared.assetId!==record.assetId)throw new TypeError("BuildingSpec source must match the approved source licence, usage status and assetId");
 if(typeof record.relativePath!=="string"||record.relativePath.includes("\\"))throw new TypeError("source asset relativePath is invalid");
 const assetPath=path.resolve(root,record.relativePath);
 if(!inside(root,assetPath))throw new TypeError("source asset path escapes workspaceRoot");
 const sourceFile=await requiredRegularFile(assetPath,"source image");
 if(!inside(assetRoot,sourceFile.path))throw new TypeError("source image is outside this building's asset store");
 const inputBytes=await readFile(sourceFile.path),inputHash=createHash("sha256").update(inputBytes).digest("hex");
 if(inputHash!==record.sha256||inputHash!==record.assetId)throw new TypeError("source image SHA-256 does not match its ingestion record");
 if(sourceFile.size>20*1024*1024)throw new RangeError("source image exceeds the 20 MB limit");
 const runnerRaw=path.resolve(options.runnerScript??"");
 const runner=await requiredRegularFile(runnerRaw,"TripoSR run.py");
 const runnerBytes=await readFile(runner.path),runnerScriptSha256=createHash("sha256").update(runnerBytes).digest("hex");
 const jobsRoot=path.join(root,".building-engine","jobs",buildingId);
 await mkdir(jobsRoot,{recursive:true});
 const realJobsRoot=await realpath(jobsRoot);
 if(!inside(root,realJobsRoot))throw new TypeError("job root resolves outside workspaceRoot");
 const jobDir=path.join(realJobsRoot,jobId+"-single-view");
 if(!inside(realJobsRoot,jobDir))throw new TypeError("job directory escapes job root");
 await mkdir(jobDir,{recursive:false});
 const realJobDir=await realpath(jobDir);
 if(!inside(realJobsRoot,realJobDir))throw new TypeError("job directory resolves outside job root");
 const outputDir=path.join(realJobDir,"tripo-output");
 await mkdir(outputDir);
 const reportPath=path.join(realJobDir,"report.json"),startedAt=new Date().toISOString();
 const report={
  schemaVersion:"1.0.0",engine:"single-image-ai-triposr-v1",modelImplementation:"VAST-AI-Research/TripoSR",
  modelLicense:"MIT (verify installed revision and notices)",buildingId,jobId,sourceId,status:"running",startedAt,
  source:{sha256:inputHash,licence:record.licence,usageStatus:record.usageStatus,mimeType:record.mimeType},
  modelParameters:{modelId,device,mcResolution:resolution,modelSaveFormat:"glb",backgroundRemoval:true},
  confidence:"ai-proposed",
  scaleCalibration:{status:"not-calibrated"},
  georeference:{status:"not-solved"},
  executionEvidence:{
   processAdapter:options.spawnImpl?"injected-adapter-unverified":"node-child-process.spawn",
   workerStarted:false,workerExitCode:null,workerVersion:"not-queried",
   runnerScriptSha256,
   actualInferenceVerified:false,
   outputVerification:"GLB-structure-and-geometry-only",
   caveat:"A successful process and parseable GLB do not independently prove that TripoSR inference or the requested model weights actually ran."
  },
  warnings:["Single-image AI inferred unseen surfaces; this is not measured or survey-accurate architecture.","Output scale, front-facing direction and georeference are not established by the input image.","Human review is mandatory before any use as a building model.","The worker does not independently attest model weights or the inference implementation; inspect executionEvidence and runner script hash."],
  mapReady:false,publicationEligible:false,
 };
 try{
  await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  const pythonPath=options.pythonPath||process.env.TRIPOSR_PYTHON||"python";
  const args=[runner.path,sourceFile.path,"--output-dir",outputDir,"--model-save-format","glb","--mc-resolution",String(resolution),"--device",device,"--pretrained-model-name-or-path",modelId];
  const begin=Date.now();
  const processResult=await processRun(pythonPath,args,path.dirname(runner.path),timeoutMs,options.spawnImpl);
  report.durationMs=Date.now()-begin;
  report.executionEvidence.workerStarted=processResult.processStarted===true;
  report.executionEvidence.workerExitCode=processResult.exitCode;
  report.executionEvidence.processStatus="exited-0";
  const outputPath=path.join(outputDir,"0","mesh.glb"),output=await requiredRegularFile(outputPath,"TripoSR GLB output");
  if(output.size>MAX_MODEL_BYTES)throw new RangeError("TripoSR GLB output exceeds 500 MB");
  const bytes=await readFile(output.path),parsed=parseGlb(bytes),modelQuality=analyzeGlbQuality(bytes),sha256=createHash("sha256").update(bytes).digest("hex");
  const modelPath=path.join(realJobDir,"model.glb");
  await writeFile(modelPath,bytes,{flag:"wx",mode:0o600});
  report.status=options.spawnImpl?"adapter-output-unverified":"ai-proposed-requires-review";
  if(options.spawnImpl)report.confidence="unverified-adapter-output";
  report.completedAt=new Date().toISOString();
  report.modelQuality=modelQuality;if(modelQuality.warnings.length)report.warnings.push("GLB geometry QA flagged "+modelQuality.warnings.length+" issue(s) for human review.");
  report.outputs={glb:{relativePath:path.relative(root,modelPath).split(path.sep).join("/"),bytes:bytes.length,sha256,meshCount:parsed.meshCount}};
  report.runner={executable:pythonPath,scriptPath:runner.path,scriptSha256:runnerScriptSha256,processAdapter:report.executionEvidence.processAdapter,exitCode:processResult.exitCode,stdoutTail:processResult.stdout.slice(-2000),stderrTail:processResult.stderr.slice(-4000)};
  await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  return {jobDir:realJobDir,modelPath,reportPath,report};
 }catch(error){
  report.status="failed";report.failedAt=new Date().toISOString();report.failureMessage=error instanceof Error?error.message:String(error);
  if(error?.processStarted===true)report.executionEvidence.workerStarted=true;
  if(Number.isInteger(error?.exitCode))report.executionEvidence.workerExitCode=error.exitCode;
  if(report.executionEvidence.processStatus!=="exited-0"){
   report.executionEvidence.processStatus=error?.processStarted===false?"not-started":error?.processStarted===true?"failed":"not-confirmed";
  }
  report.executionEvidence.failureMessage=report.failureMessage;
  await writeFile(reportPath,JSON.stringify(report,null,2)+"\n").catch(()=>{});
  error.reportPath=reportPath;throw error;
 }
}