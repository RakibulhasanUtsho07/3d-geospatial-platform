import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBuildingSpec } from "./building-spec.mjs";
import { convertPlyToUntexturedGlb, convertTexturedPlyToGlb } from "./textured-ply-to-glb.mjs";
import { analyzeImageQuality, compareImageQuality } from "./image-quality-preflight.mjs";
import { analyzeGlbQuality } from "./glb-geometry-qa.mjs";
import { assessColmapReconstruction } from "./colmap-diagnostics.mjs";
import { buildModelReviewSummary } from "./model-review-summary.mjs";
import { analyzeColmapTextModelFiles } from "./colmap-view-coverage.mjs";

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
async function locateSparseModel(workspace){
 const candidates=[
  path.join(workspace,"sparse","0"),
  path.join(workspace,"sparse"),
  path.join(workspace,"dense","sparse"),
  path.join(workspace,"dense","0","sparse")
 ];
 const required=["cameras.bin","images.bin","points3D.bin"];
 for(const directory of candidates){
  const found=await Promise.all(required.map(name=>fileExists(path.join(directory,name))));
  if(found.every(Boolean))return directory;
 }
 return null;
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
  report.stagedImages=staged;report.progress="image-quality-preflight";await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  const qualityAnalyzer=options.qualityAnalyzer||((args)=>analyzeImageQuality({...args,ffmpegPath:options.ffmpegPath,spawnImpl:options.ffmpegSpawnImpl||options.spawnImpl,timeoutMs:options.imageQualityTimeoutMs}));
  const qualityResults=[];
  for(let start=0;start<sources.length;start+=4){
   const batch=sources.slice(start,start+4);
   const analysed=await Promise.all(batch.map(async source=>({
    sourceId:source.id,
    ...(await qualityAnalyzer({imagePath:path.join(realImagesDir,staged.find(item=>item.sourceId===source.id).filename),sourceId:source.id}))
   })));
   qualityResults.push(...analysed);
  }
  report.imageQualityPreflight={engine:"ffmpeg-grayscale-thumbnail-heuristics-v1",views:compareImageQuality(qualityResults,options.imageQualityThresholds),flaggedViewCount:0,nearDuplicatePairCount:0};
  report.imageQualityPreflight.flaggedViewCount=report.imageQualityPreflight.views.filter(view=>view.warnings.length>0).length;
  report.imageQualityPreflight.nearDuplicatePairCount=report.imageQualityPreflight.views.reduce((sum,view)=>sum+view.nearDuplicateIds.length,0)/2;
  if(report.imageQualityPreflight.flaggedViewCount){
   report.warnings.push(report.imageQualityPreflight.flaggedViewCount+" of "+sources.length+" input views triggered image-quality/near-duplicate heuristics; inspect flagged views before accepting the mesh.");
  }
  report.progress="reconstruction";await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  const colmapPath=options.colmapPath||process.env.COLMAP_BIN||"colmap",spawnImpl=options.spawnImpl;
  // Default to CPU extraction/matching so COLMAP works on headless servers without CUDA/GLX.
  // GPU mode is explicit opt-in: the OpenGL-based fallback can fail before reconstruction starts
  // on a Linux runner without a display/GL context.
  const useGpu=options.useGpu===true;
  const reconstructionArgs=[
   "automatic_reconstructor","--workspace_path",outputJobDir,"--image_path",realImagesDir,"--quality",quality,
   "--use_gpu",useGpu?"1":"0",
   "--num_threads",String(options.featureThreads??4),
  ];
  const reconstructStart=Date.now();await runProcess(colmapPath,reconstructionArgs,timeoutMs,spawnImpl);report.timingsMs={reconstruction:Date.now()-reconstructStart};
  // A zero exit code only means COLMAP completed; it does not mean enough input views
  // registered or that the sparse reconstruction is strong enough for stable geometry.
  report.progress="reconstruction-quality-diagnostics";await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  const diagnosticsStart=Date.now(),sparseModelDir=await locateSparseModel(outputJobDir);
  if(!sparseModelDir){
   report.reconstructionDiagnostics={
    schemaVersion:"1.0.0",
    status:"unavailable",
    sourceImageCount:sources.length,
    warnings:["COLMAP sparse model files (cameras.bin, images.bin, points3D.bin) were not found; registration and sparse-point diagnostics are unavailable."],
    caveat:"Diagnostics are heuristic review hints, not proof of overlap, scale, completeness, or architectural accuracy."
   };
  }else{
   try{
    const modelAnalysis=await runProcess(colmapPath,["model_analyzer","--path",sparseModelDir],Math.min(timeoutMs,60000),spawnImpl);
    report.reconstructionDiagnostics={
     ...assessColmapReconstruction({
      analysisText:modelAnalysis.stdout+"\n"+modelAnalysis.stderr,
      sourceCount:sources.length,
      thresholds:options.reconstructionDiagnosticsThresholds
     }),
     sparseModelPath:path.relative(outputJobDir,sparseModelDir).split(path.sep).join("/")
    };
   }catch(diagnosticError){
    report.reconstructionDiagnostics={
     schemaVersion:"1.0.0",
     status:"unavailable",
     sourceImageCount:sources.length,
     sparseModelPath:path.relative(outputJobDir,sparseModelDir).split(path.sep).join("/"),
     warnings:["COLMAP model_analyzer could not run; reconstruction was kept for review. "+(diagnosticError instanceof Error?diagnosticError.message:String(diagnosticError))],
     caveat:"Diagnostics are heuristic review hints, not proof of overlap, scale, completeness, or architectural accuracy."
    };
   }
  }
  report.timingsMs.reconstructionDiagnostics=Date.now()-diagnosticsStart;
  const coverageStart=Date.now();
  if(!sparseModelDir){
   report.cameraCoverage={
    schemaVersion:"1.0.0",
    engine:"colmap-view-coverage-v1",
    status:"unavailable",
    registeredCameraPoseCount:0,
    sparsePointCount:0,
    warnings:["COLMAP sparse model is unavailable; camera-position and viewing-direction coverage could not be assessed."],
    caveat:"Camera coverage metrics are heuristic and cannot prove facade completeness or architectural accuracy."
   };
  }else{
   let coverageWorkspace=null;
   try{
    coverageWorkspace=await mkdtemp(path.join(outputJobDir,"colmap-view-coverage-"));
    await runProcess(colmapPath,["model_converter","--input_path",sparseModelDir,"--output_path",coverageWorkspace,"--output_type","TXT"],Math.min(timeoutMs,120000),spawnImpl);
    const imagesPath=path.join(coverageWorkspace,"images.txt"),points3DPath=path.join(coverageWorkspace,"points3D.txt");
    if(!(await fileExists(imagesPath))||!(await fileExists(points3DPath)))throw new Error("COLMAP model_converter did not write images.txt and points3D.txt");
    report.cameraCoverage={
     ...await analyzeColmapTextModelFiles({imagesPath,points3DPath,thresholds:options.cameraCoverageThresholds}),
     sparseModelPath:path.relative(outputJobDir,sparseModelDir).split(path.sep).join("/")
    };
   }catch(coverageError){
    report.cameraCoverage={
     schemaVersion:"1.0.0",
     engine:"colmap-view-coverage-v1",
     status:"unavailable",
     registeredCameraPoseCount:0,
     sparsePointCount:0,
     warnings:["COLMAP camera coverage analysis was unavailable; reconstruction was kept for review. "+(coverageError instanceof Error?coverageError.message:String(coverageError))],
     caveat:"Camera coverage metrics are heuristic and cannot prove facade completeness or architectural accuracy."
    };
   }finally{
    if(coverageWorkspace)await rm(coverageWorkspace,{recursive:true,force:true}).catch(()=>{});
   }
  }
  report.timingsMs.cameraCoverage=Date.now()-coverageStart;
  for(const warning of report.reconstructionDiagnostics.warnings||[])report.warnings.push("Reconstruction diagnostics: "+warning);
  for(const warning of report.cameraCoverage.warnings||[])report.warnings.push("Camera coverage: "+warning);
  await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  let inputMesh=null,denseWorkspace=null;
  try{
   inputMesh=await locateMesh(outputJobDir);
   denseWorkspace=path.dirname(inputMesh);
   report.geometryStrategy="colmap-dense-mvs";
  }catch(meshError){
   if(options.allowSparseMeshFallback!==true||!sparseModelDir)throw meshError;
   // Ubuntu's packaged COLMAP may be built without CUDA/HIP, so automatic_reconstructor
   // can complete sparse SfM but cannot produce a dense fused cloud/mesh. The explicitly
   // opted-in fallback creates a review-only Poisson surface from sparse points; it must
   // never be mistaken for full dense MVS reconstruction.
   const fallbackStart=Date.now();
   report.progress="experimental-sparse-poisson-fallback";
   report.geometryStrategy="experimental-sparse-poisson-fallback";
   report.warnings.push("Dense COLMAP MVS mesh was unavailable. An experimental Poisson surface was generated from sparse SfM points; it can invent surfaces and is not accuracy evidence.");
   await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
   denseWorkspace=path.join(outputJobDir,"dense");
   await mkdir(denseWorkspace,{recursive:true});
   await runProcess(colmapPath,[
    "image_undistorter","--image_path",realImagesDir,"--input_path",sparseModelDir,
    "--output_path",denseWorkspace,"--output_type","COLMAP","--max_image_size",String(options.maxImageSize??1600)
   ],Math.min(timeoutMs,600000),spawnImpl);
   const sparsePointsPath=path.join(outputJobDir,"sparse-reconstruction-points.ply");
   await runProcess(colmapPath,[
    "model_converter","--input_path",sparseModelDir,"--output_path",sparsePointsPath,"--output_type","PLY"
   ],Math.min(timeoutMs,120000),spawnImpl);
   const meshScript=options.sparseMeshScript||path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../../scripts/create-sparse-poisson-mesh.py");
   inputMesh=path.join(denseWorkspace,"meshed-poisson.ply");
   const fallbackSummaryPath=path.join(outputJobDir,"sparse-mesh-fallback-report.json");
   await runProcess(options.pythonPath||"python3",[
    meshScript,"--input",sparsePointsPath,"--output",inputMesh,"--summary",fallbackSummaryPath
   ],Math.min(timeoutMs,600000),spawnImpl);
   report.sparseMeshFallback=JSON.parse(await readFile(fallbackSummaryPath,"utf8"));
   report.timingsMs.sparseMeshFallback=Date.now()-fallbackStart;
   await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  }
  const texturedDir=path.join(outputJobDir,"textured");await mkdir(texturedDir,{recursive:true});
  const texturedMesh=path.join(texturedDir,"mesh.ply"),texturePath=path.join(texturedDir,"texture.png");
  const textureStart=Date.now();let converted=null,textureStatus="textured";
  try{
   await runProcess(colmapPath,["mesh_texturer","--workspace_path",denseWorkspace,"--input_path",inputMesh,"--output_path",texturedDir],timeoutMs,spawnImpl);
   if(!(await fileExists(texturedMesh))||!(await fileExists(texturePath)))throw new Error("COLMAP mesh_texturer did not produce textured/mesh.ply and textured/texture.png");
   converted=await convertTexturedPlyToGlb({plyPath:texturedMesh,texturePath,metresPerModelUnit:calibration.metresPerModelUnit,upAxis,scaleCalibrated:calibration.scaleCalibrated});
  }catch(textureError){
   if(options.allowSparseMeshFallback!==true||report.geometryStrategy!=="experimental-sparse-poisson-fallback")throw textureError;
   // Old distro COLMAP releases do not ship the mesh_texturer command. Preserve the
   // actual photogrammetry-derived geometry as a neutral-material GLB rather than
   // pretending that the original photographs were baked into a texture atlas.
   converted=await convertPlyToUntexturedGlb({plyPath:inputMesh,metresPerModelUnit:calibration.metresPerModelUnit,upAxis,scaleCalibrated:calibration.scaleCalibrated});
   textureStatus="not-available";
   report.warnings.push("Texture baking unavailable in this COLMAP build; the output GLB has a neutral material and must be visually compared as a silhouette only. Reference-photo texture accuracy was not validated.");
   report.textureFailure=textureError instanceof Error?textureError.message:String(textureError);
  }
  report.timingsMs.texturing=Date.now()-textureStart;report.textureStatus=textureStatus;
  const modelPath=path.join(outputJobDir,"model.glb");
  await writeFile(modelPath,converted.glb,{flag:"wx",mode:0o600});
  const glbSha256=createHash("sha256").update(converted.glb).digest("hex"),modelQuality=analyzeGlbQuality(converted.glb);
  report.status="completed-requires-review";report.completedAt=new Date().toISOString();report.modelQuality=modelQuality;if(modelQuality.warnings.length)report.warnings.push("GLB geometry QA flagged "+modelQuality.warnings.length+" issue(s) for human review.");if(report.geometryStrategy==="experimental-sparse-poisson-fallback")report.warnings.push("This GLB was generated from sparse points with experimental Poisson filling; it is not a dense photogrammetry mesh and must not be published without independent review.");report.outputs={glb:{relativePath:path.relative(root,modelPath).split(path.sep).join("/"),bytes:converted.glb.length,sha256:glbSha256},sourceMesh:{relativePath:path.relative(root,inputMesh).split(path.sep).join("/")},...(textureStatus==="textured"?{texturedMesh:{relativePath:path.relative(root,texturedMesh).split(path.sep).join("/")},texture:{relativePath:path.relative(root,texturePath).split(path.sep).join("/")}}:{}),geometry:converted.geometry,bounds:converted.bounds};
  report.warnings.push("Photogrammetry was run, but this worker does not compute ground-control-point registration to WGS84; the BuildingSpec location is a placement hint only.");
  report.warnings.push("Human review is required for scale, vertical axis, front-facing heading, mesh completeness, texture seams, occlusion and same-building identity.");
  if(!calibration.scaleCalibrated)report.warnings.push("No real-world scale was supplied; 1 model unit was provisionally treated as 1 metre for preview only.");
  if(!options.upAxisReviewed)report.warnings.push("Source up axis has not been reviewed; verify model orientation before map placement.");
  report.mapReady=false;report.publicationEligible=false;
  report.modelReview=buildModelReviewSummary({
   imageQualityPreflight:report.imageQualityPreflight,
   reconstructionDiagnostics:report.reconstructionDiagnostics,
   cameraCoverage:report.cameraCoverage,
   modelQuality,
   scaleCalibration:report.scaleCalibration,
   upAxisReviewed:report.confirmations.upAxisReviewed,
   georeference:report.georeference
  });
  report.warnings.push("Model review triage: "+report.modelReview.priority+" priority; "+report.modelReview.findingCount+" finding(s); human review remains required.");
  await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  return {jobDir:outputJobDir,modelPath,reportPath,report};
 }catch(error){report.status="failed";report.failedAt=new Date().toISOString();report.failureMessage=error instanceof Error?error.message:String(error);report.mapReady=false;await writeFile(reportPath,JSON.stringify(report,null,2)+"\n").catch(()=>{});error.reportPath=reportPath;throw error;}
}