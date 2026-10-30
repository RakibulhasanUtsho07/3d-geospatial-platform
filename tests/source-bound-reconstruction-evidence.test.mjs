import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildSourceBoundReconstructionEvidence } from "../src/core/building-generation/source-bound-reconstruction-evidence.mjs";

const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const FALSE={acceptanceEligible:false,publicationEligible:false,mapReady:false,automaticApproval:false};
const sourceBytes=Buffer.from("synthetic building facade image");
const sourceSha=sha(sourceBytes),glbSha="b".repeat(64);
const rightsSource={
 schemaVersion:"1.0.0",sampleId:"sample-a",
 dataset:{sourceRepositoryCommit:"commit-a"},
 views:[{id:"front-01",filename:"front.jpg",sourceUrl:"https://example.test/front.jpg",expectedByteSize:sourceBytes.length,expectedSha256:sourceSha,declaredWidth:640,declaredHeight:480}],
};
const rightsSourceBytes=Buffer.from(JSON.stringify(rightsSource));
const rightsManifest={
 schemaVersion:"1.0.0",recordType:"brf-45-exact-asset-rights-admission",
 sourceBinding:{sampleId:"sample-a",sourceRepositoryCommit:"commit-a"},
 assets:[{sourceId:"front-01",sha256:sourceSha,decision:"approved"}],releaseFlags:{...FALSE},
};
const rightsManifestBytes=Buffer.from(JSON.stringify(rightsManifest));
const rightsReport={
 schemaVersion:"1.0.0",evaluationId:"BRF-45-EXACT-ASSET-RIGHTS-ADMISSION",
 sourceManifestSha256:sha(rightsSourceBytes),status:"rights-admission-complete-human-review-required",
 blockers:[],assets:[{sourceId:"front-01",sha256:sourceSha,status:"evidence-complete-human-review-required"}],
 releaseFlags:{...FALSE},
};
const rightsReportBytes=Buffer.from(JSON.stringify(rightsReport));
const cameraBytes=Buffer.from("synthetic camera calibration record");
const cameraSha=sha(cameraBytes);
const cameraManifest={
 schemaVersion:"1.0.0",buildingId:"building-a",source:{id:"front-01",sha256:sourceSha},
 calibrationAssets:[{id:"camera-cal-1",sha256:cameraSha,bytes:cameraBytes.length,sourceImageSha256:sourceSha,candidateGlbSha256:glbSha,cameraId:"camera-1",evidenceType:"synthetic-camera-calibration"}],
 cameras:[{id:"camera-1",projection:[[1,0,0,0],[0,1,0,0],[0,0,1,0]],imageSize:{width:640,height:480},coordinateFrame:"survey-local-v1",calibrationStatus:"verified",calibrationEvidence:{sourceId:"camera-cal-1",sha256:cameraSha}}],
 observations:[{cameraId:"camera-1",x:0,y:0,worldPoint:[0,0,5]}],
};
const cameraManifestBytes=Buffer.from(JSON.stringify(cameraManifest));
const R=6378137,baseLon=90.4,baseLat=23.7,scale=2.5,theta=Math.PI/6,tx=100,ty=200;
function lonLat(east,north){
 const lat0=baseLat*Math.PI/180;
 return {longitude:baseLon+east/(R*Math.cos(lat0))*180/Math.PI,latitude:baseLat+north/R*180/Math.PI};
}
const gcpBytes=Buffer.from("synthetic survey control evidence");
const gcpSha=sha(gcpBytes);
const controlPoints=[[-10,-8],[10,-8],[10,8],[-10,8]].map(([modelX,modelZ],i)=>{
 const east=scale*(Math.cos(theta)*modelX-Math.sin(theta)*modelZ)+tx;
 const north=scale*(Math.sin(theta)*modelX+Math.cos(theta)*modelZ)+ty;
 return {id:"gcp-"+(i+1),modelX,modelZ,...lonLat(east,north),evidenceSourceId:"survey-set-1"};
});
const groundManifest={
 schemaVersion:"1.0.0",buildingId:"building-a",source:{id:"front-01",sha256:sourceSha},candidateGlbSha256:glbSha,
 evidenceAssets:[{id:"survey-set-1",sha256:gcpSha,bytes:gcpBytes.length,sourceImageSha256:sourceSha,candidateGlbSha256:glbSha,evidenceType:"synthetic-survey-notes"}],
 controlPoints,
};
const groundManifestBytes=Buffer.from(JSON.stringify(groundManifest));
function input(overrides={}){
 const visual={schemaVersion:"1.0.0",bundleType:"source-bound-visual-evidence",bundleId:"visual-a",buildingId:"building-a",
  source:{id:"front-01",sha256:sourceSha},policy:{groundTruth:false,acceptanceEligible:false,publicationEligible:false,publishable:false,mapReady:false,automaticApproval:false}};
 return {
  visualBundleBytes:Buffer.from(JSON.stringify(visual)),candidateGlbSha256:glbSha,
  rightsSourceManifestBytes:rightsSourceBytes,rightsManifestBytes:rightsManifestBytes,rightsReportBytes,
  cameraManifestBytes,cameraEvidenceAssets:[{id:"camera-cal-1",bytes:cameraBytes}],
  groundControlManifestBytes:groundManifestBytes,groundControlEvidenceAssets:[{id:"survey-set-1",bytes:gcpBytes}],
  createdAt:"2026-10-30T12:00:00.000Z",...overrides,
 };
}

test("links exact rights report, recomputes camera validation and WGS84 registration without opening release gates",()=>{
 const result=buildSourceBoundReconstructionEvidence(input());
 assert.equal(result.rightsLinked,true);
 assert.equal(result.rightsComplete,true);
 assert.equal(result.cameraReport.status,"structurally-valid");
 assert.equal(result.registration.status,"calibrated-needs-human-review");
 assert.equal(result.bundle.candidateGlbSha256,glbSha);
 assert.equal(result.bundle.checks.cameraProjectionValidationRecomputed,true);
 assert.equal(result.bundle.checks.groundControlRegistrationRecomputed,true);
 assert.ok(Object.values(result.bundle.policy).every(value=>value===false));
 assert.equal(result.bundle.groundControl.registration.vertical.status,"not-solved");
});

test("rejects a rights report bound to a different source manifest",()=>{
 const bad={...rightsReport,sourceManifestSha256:"f".repeat(64)};
 const result=buildSourceBoundReconstructionEvidence(input({rightsReportBytes:Buffer.from(JSON.stringify(bad))}));
 assert.equal(result.rightsLinked,false);
 assert.equal(result.bundle.rightsEvidence.status,"blocked-or-incomplete");
 assert.equal(result.bundle.policy.publicationEligible,false);
});

test("rejects camera evidence whose actual bytes differ from the declared hash",()=>{
 assert.throws(()=>buildSourceBoundReconstructionEvidence(input({cameraEvidenceAssets:[{id:"camera-cal-1",bytes:Buffer.from("tampered")}]})),/actual bytes/);
});

test("rejects ground-control evidence whose actual bytes differ from the declared hash",()=>{
 assert.throws(()=>buildSourceBoundReconstructionEvidence(input({groundControlEvidenceAssets:[{id:"survey-set-1",bytes:Buffer.from("tampered")}]})),/actual bytes/);
});

test("does not call unverified camera calibration complete",()=>{
 const camera={...cameraManifest,cameras:[{...cameraManifest.cameras[0],calibrationStatus:"unaudited"}]};
 const result=buildSourceBoundReconstructionEvidence(input({cameraManifestBytes:Buffer.from(JSON.stringify(camera))}));
 assert.equal(result.cameraReport.status,"review-required");
 assert.equal(result.bundle.cameraCalibration.status,"blocked-or-review-required");
 assert.equal(result.bundle.policy.mapReady,false);
});

test("rejects a visual evidence bundle that attempts to promote a truth or release flag",()=>{
 const visual={schemaVersion:"1.0.0",bundleType:"source-bound-visual-evidence",bundleId:"visual-a",buildingId:"building-a",
  source:{id:"front-01",sha256:sourceSha},policy:{groundTruth:true,acceptanceEligible:false,publicationEligible:false,publishable:false,mapReady:false,automaticApproval:false}};
 assert.throws(()=>buildSourceBoundReconstructionEvidence(input({visualBundleBytes:Buffer.from(JSON.stringify(visual))})),/flags false/);
});
