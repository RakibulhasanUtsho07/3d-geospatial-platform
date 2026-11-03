import { createHash } from "node:crypto";
import { validateCameraProjectionEvidence } from "./camera-projection-validation.mjs";
import { registerModelToWgs84 } from "./ground-control-registration.mjs";

const HASH=/^[a-f0-9]{64}$/i;
const SAFE_ID=/^[a-z0-9][a-z0-9._-]{0,99}$/i;
const FALSE_FLAGS=["groundTruth","acceptanceEligible","publicationEligible","publishable","mapReady","automaticApproval"];
function isObject(value){return value!==null&&typeof value==="object"&&!Array.isArray(value);}
function sha(bytes){return createHash("sha256").update(bytes).digest("hex");}
function readBytes(value,label,max=30*1024*1024){
 const result=Buffer.isBuffer(value)?value:value instanceof Uint8Array?Buffer.from(value):null;
 if(!result||!result.length||result.length>max)throw new TypeError(label+" must be non-empty bytes within the configured limit.");
 return result;
}
function parse(bytes,label){
 try{const value=JSON.parse(bytes.toString("utf8"));if(!isObject(value))throw new Error();return value;}
 catch{throw new TypeError(label+" must be a JSON object.");}
}
function safeId(value){return typeof value==="string"&&SAFE_ID.test(value);}
function requireFalseFlags(policy,label){
 if(!isObject(policy)||FALSE_FLAGS.some(key=>policy[key]!==false))throw new TypeError(label+" must explicitly keep all release and truth flags false.");
}
function existingReleaseFlagsFalse(policy,label){
 const keys=["acceptanceEligible","publicationEligible","mapReady","automaticApproval"];
 if(!isObject(policy)||keys.some(key=>policy[key]!==false)||Object.keys(policy).some(key=>!keys.includes(key))) throw new TypeError(label+" must contain only recognized release flags, all explicitly false.");
}
function linkSource(source,bundle,label){
 if(!isObject(source)||source.id!==bundle.source.id||source.sha256?.toLowerCase()!==bundle.source.sha256)
  throw new TypeError(label+" must reference the exact visual-bundle source ID and SHA-256.");
}
function normalizeAssets(rows,bytesRows,label,bundle,candidateGlbSha256){
 if(!Array.isArray(rows)||rows.length<1||rows.length>64||!Array.isArray(bytesRows))throw new TypeError(label+" must declare 1–64 evidence assets and their actual bytes.");
 const supplied=new Map();
 for(const item of bytesRows){
  if(!isObject(item)||!safeId(item.id)||supplied.has(item.id))throw new TypeError(label+" byte assets need unique safe IDs.");
  supplied.set(item.id,readBytes(item.bytes,label+" asset "+item.id,25*1024*1024));
 }
 const seen=new Set();
 const normalized=rows.map(row=>{
  if(!isObject(row)||!safeId(row.id)||seen.has(row.id)||!HASH.test(row.sha256??"")||
    !Number.isSafeInteger(row.bytes)||row.bytes<1||row.sourceImageSha256?.toLowerCase()!==bundle.source.sha256||
    row.candidateGlbSha256?.toLowerCase()!==candidateGlbSha256)
   throw new TypeError(label+" metadata must bind unique evidence to this exact source image and candidate GLB.");
  seen.add(row.id);
  const actual=supplied.get(row.id);
  if(!actual||actual.length!==row.bytes||sha(actual)!==row.sha256.toLowerCase())
   throw new TypeError(label+" actual bytes do not match the declared size and SHA-256 for "+row.id+".");
  return {id:row.id,sha256:sha(actual),bytes:actual.length,evidenceType:row.evidenceType??null};
 });
 if(supplied.size!==seen.size)throw new TypeError(label+" contains unreferenced evidence bytes.");
 return normalized;
}

/**
 * Joins existing rights, camera-calibration and ground-control evidence to a
 * source-bound visual bundle. Camera and GCP computations are re-run here.
 * Rights validation is only hash-linked to the BRF-45 validator report; this
 * function does not re-run the filesystem-based legal-evidence validator.
 * No result from this module is a truth, approval, publication or map-ready gate.
 */
export function buildSourceBoundReconstructionEvidence(input={}){
 if(!isObject(input))throw new TypeError("reconstruction evidence input must be an object.");
 const visualBytes=readBytes(input.visualBundleBytes,"visual evidence bundle");
 const visual=parse(visualBytes,"visual evidence bundle");
 if(visual.schemaVersion!=="1.0.0"||visual.bundleType!=="source-bound-visual-evidence"||
    !safeId(visual.buildingId)||!safeId(visual.source?.id)||!HASH.test(visual.source?.sha256??""))
  throw new TypeError("visual evidence bundle identity is invalid.");
 requireFalseFlags(visual.policy,"visual bundle policy");
 const candidateGlbSha256=String(input.candidateGlbSha256??"").toLowerCase();
 if(!HASH.test(candidateGlbSha256))throw new TypeError("candidateGlbSha256 must be a valid SHA-256.");
 const createdAt=new Date(input.createdAt??new Date().toISOString());
 if(!Number.isFinite(createdAt.getTime()))throw new TypeError("createdAt must be a valid timestamp.");

 const rightsSourceBytes=readBytes(input.rightsSourceManifestBytes,"rights source manifest");
 const rightsManifestBytes=readBytes(input.rightsManifestBytes,"rights register");
 const rightsReportBytes=readBytes(input.rightsReportBytes,"BRF-45 rights report");
 const rightsSource=parse(rightsSourceBytes,"rights source manifest");
 const rightsManifest=parse(rightsManifestBytes,"rights register");
 const rightsReport=parse(rightsReportBytes,"BRF-45 rights report");
 const rightsSourceSha256=sha(rightsSourceBytes),rightsManifestSha256=sha(rightsManifestBytes),rightsReportSha256=sha(rightsReportBytes);
 const rightsViews=Array.isArray(rightsSource.views)?rightsSource.views:[];
 const rightsRows=Array.isArray(rightsManifest.assets)?rightsManifest.assets:[];
 const rightsReportAssets=Array.isArray(rightsReport.assets)?rightsReport.assets:[];
 const exactRightsView=rightsViews.find(row=>row?.id===visual.source.id&&row.expectedSha256?.toLowerCase()===visual.source.sha256);
 const exactRightsRow=rightsRows.find(row=>row?.sourceId===visual.source.id&&row.sha256?.toLowerCase()===visual.source.sha256);
 const exactRightsReport=rightsReportAssets.find(row=>row?.sourceId===visual.source.id&&row.sha256?.toLowerCase()===visual.source.sha256);
 const rightsLinked=rightsSource.schemaVersion==="1.0.0"&&rightsManifest.recordType==="brf-45-exact-asset-rights-admission"&&
  rightsManifest.sourceBinding?.sampleId===rightsSource.sampleId&&
  rightsManifest.sourceBinding?.sourceRepositoryCommit===rightsSource.dataset?.sourceRepositoryCommit&&
  rightsReport.evaluationId==="BRF-45-EXACT-ASSET-RIGHTS-ADMISSION"&&
  rightsReport.sourceManifestSha256?.toLowerCase()===rightsSourceSha256&&
  Boolean(exactRightsView&&exactRightsRow&&exactRightsReport);
 const rightsComplete=rightsLinked&&rightsReport.status==="rights-admission-complete-human-review-required"&&
  Array.isArray(rightsReport.blockers)&&rightsReport.blockers.length===0&&
  exactRightsReport.status==="evidence-complete-human-review-required";
 if(isObject(rightsManifest.releaseFlags))existingReleaseFlagsFalse(rightsManifest.releaseFlags,"rights register release flags");
 if(isObject(rightsReport.releaseFlags))existingReleaseFlagsFalse(rightsReport.releaseFlags,"rights report release flags");

 const cameraManifestBytes=readBytes(input.cameraManifestBytes,"camera calibration manifest");
 const cameraManifest=parse(cameraManifestBytes,"camera calibration manifest");
 if(cameraManifest.schemaVersion!=="1.0.0"||cameraManifest.buildingId!==visual.buildingId)throw new TypeError("camera manifest building identity does not match the visual bundle.");
 linkSource(cameraManifest.source,visual,"camera manifest");
 const cameraAssets=normalizeAssets(cameraManifest.calibrationAssets,input.cameraEvidenceAssets,"camera calibration",visual,candidateGlbSha256);
 const cameraAssetMap=new Map(cameraAssets.map(item=>[item.id,item]));
 const cameraRows=Array.isArray(cameraManifest.cameras)?cameraManifest.cameras:[];
 for(const camera of cameraRows){
  const evidence=camera?.calibrationEvidence,asset=cameraAssetMap.get(evidence?.sourceId);
  if(!asset||asset.sha256!==evidence.sha256?.toLowerCase()||!cameraManifest.calibrationAssets.some(row=>row.id===evidence.sourceId&&row.cameraId===camera.id))
   throw new TypeError("each camera must reference its exact, byte-verified calibration evidence asset.");
 }
 const cameraReport=validateCameraProjectionEvidence({
  cameras:cameraRows,observations:cameraManifest.observations??[],
  maxReprojectionErrorPixels:cameraManifest.maxReprojectionErrorPixels??3,
 });
 const cameraManifestSha256=sha(cameraManifestBytes);
 const cameraComplete=cameraReport.status==="structurally-valid"&&cameraRows.length>0&&
  cameraReport.cameraReports.every(row=>row.status==="structurally-valid-evidence-linked");

 const groundManifestBytes=readBytes(input.groundControlManifestBytes,"ground-control manifest");
 const groundManifest=parse(groundManifestBytes,"ground-control manifest");
 if(groundManifest.schemaVersion!=="1.0.0"||groundManifest.buildingId!==visual.buildingId)throw new TypeError("ground-control manifest building identity does not match the visual bundle.");
 linkSource(groundManifest.source,visual,"ground-control manifest");
 if(groundManifest.candidateGlbSha256?.toLowerCase()!==candidateGlbSha256)throw new TypeError("ground-control manifest must bind the exact candidate GLB SHA-256.");
 const groundAssets=normalizeAssets(groundManifest.evidenceAssets,input.groundControlEvidenceAssets,"ground-control",visual,candidateGlbSha256);
 const groundAssetIds=new Set(groundAssets.map(item=>item.id));
 const controlPoints=Array.isArray(groundManifest.controlPoints)?groundManifest.controlPoints:[];
 if(controlPoints.length<3||controlPoints.some(point=>!groundAssetIds.has(point.evidenceSourceId)))
  throw new TypeError("every ground-control point must reference byte-verified survey evidence.");
 const registration=registerModelToWgs84({
  controlPoints,
  maxRmsErrorM:groundManifest.maxRmsErrorM??0.5,
  maxResidualM:groundManifest.maxResidualM??1,
 });
 const groundManifestSha256=sha(groundManifestBytes);
 const groundComplete=registration.status==="calibrated-needs-human-review"&&registration.controls.thresholdPass===true;

 const bundle={
  schemaVersion:"1.0.0",
  bundleType:"source-bound-reconstruction-evidence",
  bundleId:"reconstruction-evidence-"+sha(Buffer.from([
   visual.bundleId,rightsReportSha256,cameraManifestSha256,groundManifestSha256,candidateGlbSha256,
  ].join("\n"))).slice(0,24),
  createdAt:createdAt.toISOString(),
  buildingId:visual.buildingId,
  visualBundle:{bundleId:visual.bundleId,sha256:sha(visualBytes),sourceId:visual.source.id,sourceSha256:visual.source.sha256},
  candidateGlbSha256,
  rightsEvidence:{
   sourceManifestSha256:rightsSourceSha256,rightsRegisterSha256:rightsManifestSha256,validatorReportSha256:rightsReportSha256,
   linkedToExactSource:Boolean(exactRightsView&&exactRightsRow&&exactRightsReport),
   validatorStatus:rightsReport.status??"unknown",
   status:rightsComplete?"validator-report-linked-human-review-required":"blocked-or-incomplete",
   independentlyRecomputed:false,
  },
  cameraCalibration:{
   manifestSha256:cameraManifestSha256,
   evidenceAssets:cameraAssets,
   report:cameraReport,
   status:cameraComplete?"structurally-valid-evidence-linked-human-review-required":"blocked-or-review-required",
  },
  groundControl:{
   manifestSha256:groundManifestSha256,
   evidenceAssets:groundAssets,
   registration,
   status:groundComplete?"calibrated-needs-human-review":"blocked-or-review-required",
  },
  checks:{
   exactSourceRightsLink:Boolean(exactRightsView&&exactRightsRow&&exactRightsReport),
   rightsValidatorReportComplete:rightsComplete,
   cameraEvidenceByteBound:cameraAssets.length>0,
   cameraProjectionValidationRecomputed:true,
   groundControlEvidenceByteBound:groundAssets.length>0,
   groundControlRegistrationRecomputed:true,
   candidateGlbHashBound:true,
  },
  policy:{groundTruth:false,acceptanceEligible:false,publicationEligible:false,publishable:false,mapReady:false,automaticApproval:false,independentlyAuthenticatedReviewer:false},
  limitations:[
   "Rights evidence is linked to the supplied BRF-45 report hash; this module does not re-run the filesystem-based rights validator or independently authenticate grantor authority.",
   "Camera matrix and reprojection checks are recomputed, but calibration truth, camera pose and control-point authority still require independent review.",
   "Ground-control registration is recomputed from supplied WGS84 points; survey authority, physical correspondence, horizontal datum quality and vertical datum are not independently verified.",
   "The candidate GLB is hash-bound only; this module does not inspect its geometry or prove building identity or architectural accuracy.",
   "This bundle is evidence linkage and review preparation only; it cannot authorize publication or automatic map loading.",
  ],
 };
 return {bundle,rightsLinked,rightsComplete,cameraReport,registration};
}
