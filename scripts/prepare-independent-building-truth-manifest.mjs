#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractGlbGeometry, validateAffineMatrix4x4 } from "../src/core/building-generation/glb-geometry-extraction.mjs";
import { geometryPayloadSha256 } from "../src/core/building-generation/geometry-extraction-provenance.mjs";
import { adaptIndependentReferenceGeometry } from "../src/core/building-generation/independent-reference-geometry-adapter.mjs";

const SHA256=/^[a-f0-9]{64}$/i, ID=/^[a-z0-9][a-z0-9._-]{0,79}$/i;
const IMPLEMENTATION="src/core/building-generation/glb-geometry-extraction.mjs";
const REFERENCE_IMPLEMENTATION="src/core/building-generation/independent-reference-geometry-adapter.mjs";
function object(v){return v!==null&&typeof v==="object"&&!Array.isArray(v);}
function sha256(bytes){return createHash("sha256").update(bytes).digest("hex");}
function safeRelative(value,label){
  if(typeof value!=="string"||!value.trim()||value.includes("\\")||value.startsWith("/")||/^[a-z]:/i.test(value)||
    value.split("/").some(part=>!part||part==="."||part===".."))throw new TypeError(label+" must be a safe project-relative path.");
  return value;
}
async function safeRead(root,relative,label){
  const safe=safeRelative(relative,label),resolved=path.resolve(root,...safe.split("/"));
  if(!resolved.startsWith(root+path.sep))throw new TypeError(label+" resolves outside project root.");
  let current=root;for(const part of safe.split("/")){current=path.join(current,part);const info=await lstat(current);
    if(info.isSymbolicLink())throw new TypeError(label+" must not traverse symbolic links.");
    if(current===resolved&&!info.isFile())throw new TypeError(label+" must be a regular file.");
  }
  return {relative:safe,path:resolved,bytes:await readFile(resolved)};
}
async function safeOutput(root,relative){
  const safe=safeRelative(relative,"output manifest"),parts=safe.split("/");let current=root;
  for(const part of parts.slice(0,-1)){current=path.join(current,part);let info;
    try{info=await lstat(current);}catch(error){if(error?.code!=="ENOENT")throw error;await mkdir(current);info=await lstat(current);}
    if(info.isSymbolicLink()||!info.isDirectory())throw new TypeError("Output path traverses a symbolic link or non-directory.");
  }
  const result=path.resolve(root,...parts);if(!result.startsWith(root+path.sep))throw new TypeError("Output path escapes project root.");return result;
}
function requireId(v,label){if(typeof v!=="string"||!ID.test(v))throw new TypeError(label+" must be a safe identifier.");return v;}
function requireText(v,label){if(typeof v!=="string"||!v.trim())throw new TypeError(label+" is required.");return v;}
function timestamp(v,label){if(typeof v!=="string"||!Number.isFinite(Date.parse(v)))throw new TypeError(label+" must be a valid timestamp.");return v;}
function expectedHash(expected,actual,label){
  if(expected==null||expected==="")return false;
  if(typeof expected!=="string"||!SHA256.test(expected))throw new TypeError(label+" must be SHA-256.");
  if(expected.toLowerCase()!==actual.toLowerCase())throw new TypeError(label+" differs from actual source bytes.");
  return true;
}
function validateReference(truth,sourceFrameId){
  if(!object(truth)||truth.schemaVersion!=="1.0.0")throw new TypeError("Reference geometry must use schemaVersion 1.0.0.");
  requireId(truth.sourceId,"reference.sourceId");requireText(truth.sourceDescription,"reference.sourceDescription");
  requireText(truth.reviewedBy,"reference.reviewedBy");timestamp(truth.reviewedAt,"reference.reviewedAt");
  if(!["surveyed","official-survey","lidar","cad-bim","published-measurement","independently-reviewed"].includes(truth.evidenceBasis))
    throw new TypeError("Reference evidenceBasis must identify a supported independent reference class.");
  if(truth.coordinateFrameId!==sourceFrameId||truth.units!=="m")throw new TypeError("Reference coordinateFrameId must match reference.sourceCoordinateFrameId and units must be metres.");
  if(!Number.isFinite(truth.footprintElevationM))throw new TypeError("Reference footprintElevationM must be finite.");
  if(truth.surfaceMesh?.sha256!==undefined)throw new TypeError("Do not include surfaceMesh.sha256 in the input reference JSON; the adapter pins it to actual source bytes.");
  if(!Array.isArray(truth.footprint)||!object(truth.dimensionsM)||!Array.isArray(truth.checkPoints)||
    !object(truth.surfaceMesh)||!Array.isArray(truth.surfaceMesh.vertices)||!Array.isArray(truth.surfaceMesh.triangles))
    throw new TypeError("Reference JSON requires footprint, dimensionsM, checkPoints and surfaceMesh vertices/triangles.");
  if(truth.checkPoints.some(point=>point?.independentOfFit!==true))throw new TypeError("All reference checkpoints must mark independentOfFit: true.");
  for(const [i,p] of truth.surfaceMesh.vertices.entries())if(!Array.isArray(p)||p.length!==3||p.some(v=>typeof v!=="number"||!Number.isFinite(v)))
    throw new TypeError("Reference surface vertex "+i+" must be a finite [x,y,z] tuple.");
}
function provenance(role,sourceHash,geometry,configPath,configHash,artifactPath,artifactHash,commitSha,generatedAt){
  return {schemaVersion:"1.0.0",extractionRunId:"extract-"+sha256(Buffer.from(role+"|"+sourceHash+"|"+configHash+"|"+artifactHash)).slice(0,24),
    method:role==="candidate"?"glb-2.0-position-index-and-node-transform-v1":"reviewed-independent-reference-json-import-v1",
    extractedAt:generatedAt,inputArtifactSha256:sourceHash,outputGeometrySha256:geometryPayloadSha256(geometry),
    coordinateFrameId:geometry.coordinateFrameId,units:"m",
    extractor:{id:role==="candidate"?"brf-09-glb-geometry-extractor":"brf-09-independent-reference-frame-adapter",version:"1.0.0",commitSha,
      artifactPath,artifactSha256:artifactHash,
      configurationPath:configPath,configurationSha256:configHash}};
}
async function main(){
  const argv=process.argv.slice(2),rootArg=argv.find(a=>a.startsWith("--root=")),pos=argv.filter(a=>!a.startsWith("--root="));
  if(process.argv.includes("--help")||!pos[0]||pos.length>2){
    console.log("Usage: node scripts/prepare-independent-building-truth-manifest.mjs <config.json> [output-manifest.json] [--root=project-root]\nExtracts static GLB mesh geometry and imports reviewed reference geometry in the same metric frame. It writes evidence only; it does not approve a model.");
    process.exitCode=process.argv.includes("--help")?0:2;return;
  }
  const root=await realpath(path.resolve(rootArg?rootArg.slice("--root=".length):process.cwd()));
  const configFile=await safeRead(root,pos[0],"extraction config"),config=JSON.parse(configFile.bytes.toString("utf8"));
  if(!object(config)||config.schemaVersion!=="1.0.0")throw new TypeError("Config schemaVersion must be 1.0.0.");
  const evaluationId=requireId(config.evaluationId,"evaluationId"),buildingId=requireId(config.buildingId,"buildingId");
  const generatedAt=timestamp(config.generatedAt,"generatedAt"),commitSha=config.extractorCommitSha;
  if(typeof commitSha!=="string"||!/^[a-f0-9]{7,64}$/i.test(commitSha))throw new TypeError("extractorCommitSha must pin the source commit.");
  if(!object(config.candidate)||!object(config.reference)||!object(config.tolerances))throw new TypeError("candidate, reference and tolerances objects are required.");
  const frameId=requireText(config.candidate.coordinateFrameId,"candidate.coordinateFrameId");
  if(config.candidate.units!=="m")throw new TypeError("candidate.units must be m.");
  if(config.candidate.checkPoints!==undefined)throw new TypeError("candidate.checkPoints cannot be supplied as unbound coordinates; use candidate.checkPointBindings to extract held-out points from exact GLB vertices.");
  if(config.candidate.checkPointBindings!==undefined&&!Array.isArray(config.candidate.checkPointBindings))throw new TypeError("candidate.checkPointBindings must be an array.");
  const registration=validateAffineMatrix4x4(config.candidate.modelToEvaluationFrameMatrix4x4);
  const candidateFile=await safeRead(root,config.candidate.glbPath,"candidate GLB"),candidateSha=sha256(candidateFile.bytes);
  const candidatePinned=expectedHash(config.candidate.expectedGlbSha256,candidateSha,"candidate.expectedGlbSha256");
  const referenceFile=await safeRead(root,config.reference.sourcePath,"independent reference geometry"),referenceSha=sha256(referenceFile.bytes);
  const referencePinned=expectedHash(config.reference.expectedSourceSha256,referenceSha,"reference.expectedSourceSha256");
  const truth=JSON.parse(referenceFile.bytes.toString("utf8"));
  const sourceFrameId=requireText(config.reference.sourceCoordinateFrameId,"reference.sourceCoordinateFrameId");
  validateReference(truth,sourceFrameId);
  const adaptedReference=adaptIndependentReferenceGeometry(truth,{
    sourceCoordinateFrameId:sourceFrameId,
    evaluationCoordinateFrameId:frameId,
    sourceToEvaluationFrameMatrix4x4:config.reference.sourceToEvaluationFrameMatrix4x4,
  });
  const implementation=await safeRead(root,IMPLEMENTATION,"geometry extractor implementation"),implementationHash=sha256(implementation.bytes);
  const referenceImplementation=await safeRead(root,REFERENCE_IMPLEMENTATION,"independent reference frame adapter");
  const referenceImplementationHash=sha256(referenceImplementation.bytes);
  const extracted=extractGlbGeometry(candidateFile.bytes,{coordinateFrameId:frameId,units:"m",
    modelToEvaluationFrameMatrix4x4:registration,checkPointBindings:config.candidate.checkPointBindings??[]});
  const candidate={glbPath:candidateFile.relative,glbSha256:candidateSha,geometrySourceGlbSha256:candidateSha,
    coordinateFrameId:frameId,units:"m",footprint:extracted.footprint,dimensionsM:extracted.dimensionsM,
    checkPoints:extracted.checkPoints,
    surfaceMesh:{sourceGlbSha256:candidateSha,vertices:extracted.surfaceMesh.vertices,triangles:extracted.surfaceMesh.triangles},
    geometryExtractionSummary:extracted.extractionSummary,inputHashPinned:candidatePinned,
    modelCoordinateFrameId:config.candidate.modelCoordinateFrameId??"unspecified-glb-scene-frame",
    modelToEvaluationFrameMatrix4x4:registration,
    checkPointBindings:config.candidate.checkPointBindings??[]};
  const reference={sourcePath:referenceFile.relative,sourceId:truth.sourceId,sourceSha256:referenceSha,geometrySourceSha256:referenceSha,
    evidenceBasis:truth.evidenceBasis,sourceDescription:truth.sourceDescription,reviewedBy:truth.reviewedBy,reviewedAt:truth.reviewedAt,
    coordinateFrameId:adaptedReference.coordinateFrameId,units:"m",footprint:adaptedReference.footprint,dimensionsM:adaptedReference.dimensionsM,
    checkPoints:adaptedReference.checkPoints,
    surfaceMesh:{sha256:referenceSha,vertices:adaptedReference.surfaceMesh.vertices,triangles:adaptedReference.surfaceMesh.triangles},
    inputHashPinned:referencePinned,geometryExtractionSummary:{method:"reviewed-independent-reference-json-import-v1",
      exactSourceSha256:referenceSha,sourceCoordinateFrameId:truth.coordinateFrameId,coordinateFrameId:frameId,units:"m",
      frameTransform:adaptedReference.frameTransform,
      note:"Geometry coordinates are transformed from the declared independent source frame. Source identity, survey quality, reviewer independence and the correctness of frame registration still need independent human verification."}};
  const configHash=sha256(configFile.bytes);
  candidate.geometryExtractionProvenance=provenance("candidate",candidateSha,candidate,configFile.relative,configHash,
    implementation.relative,implementationHash,commitSha,generatedAt);
  reference.geometryExtractionProvenance=provenance("reference",referenceSha,reference,configFile.relative,configHash,
    referenceImplementation.relative,referenceImplementationHash,commitSha,generatedAt);
  const manifest={schemaVersion:"1.0.0",evaluationId,buildingId,generatedAt,candidate,reference,tolerances:config.tolerances,
    preparation:{method:"brf-09-actual-glb-and-independent-reference-adapter-v1",configPath:configFile.relative,configSha256:configHash,
      exactCandidateGlbSha256:candidateSha,candidateHashPinnedBeforeRun:candidatePinned,
      exactReferenceSourceSha256:referenceSha,referenceHashPinnedBeforeRun:referencePinned,
      candidateModelToEvaluationTransform:registration,
      referenceSourceCoordinateFrameId:sourceFrameId,
      referenceSourceToEvaluationFrameMatrix4x4:adaptedReference.frameTransform.sourceToEvaluationFrameMatrix4x4,
      extractedHeldOutCheckPointCount:extracted.checkPoints.length,
      acceptanceEligible:false,publicationEligible:false,mapReady:false,automaticApproval:false}};
  const outputRelative=pos[1]??path.join("artifacts","independent-building-truth",evaluationId+"-prepared-manifest.json").split(path.sep).join("/");
  const outputPath=await safeOutput(root,outputRelative);
  await writeFile(outputPath,JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});
  console.log(JSON.stringify({outputManifest:path.relative(root,outputPath).split(path.sep).join("/"),
    candidateGlbSha256:candidateSha,sourceVertices:extracted.extractionSummary.sourceVertexCount,
    sourceTriangles:extracted.extractionSummary.sourceTriangleCount,sampledVertices:extracted.extractionSummary.surfaceSampling.sampledVertexCount,
    sampledTriangles:extracted.extractionSummary.surfaceSampling.sampledTriangleCount,
    extractedHeldOutCheckPointCount:extracted.checkPoints.length,referenceSourceSha256:referenceSha,
    referenceSourceCoordinateFrameId:sourceFrameId,coordinateFrameId:frameId,
    candidateHashPinnedBeforeRun:candidatePinned,referenceHashPinnedBeforeRun:referencePinned,
    acceptanceEligible:false,publicationEligible:false,mapReady:false},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
