import assert from "node:assert/strict";
import test from "node:test";
import { validateCameraProjectionEvidence } from "../src/core/building-generation/camera-projection-validation.mjs";
const base={id:"cam-a",projection:[[1,0,0,0],[0,1,0,0],[0,0,1,0]],imageSize:{width:640,height:480},coordinateFrame:"survey-local-v1",calibrationStatus:"verified",calibrationEvidence:{sourceId:"survey-control-set-1",sha256:"a".repeat(64)}};
test("accepts structurally valid, evidence-linked camera and checks independent reprojection",()=>{
 const report=validateCameraProjectionEvidence({cameras:[base],observations:[{cameraId:"cam-a",x:0,y:0,worldPoint:[0,0,5]}]});
 assert.equal(report.status,"structurally-valid");
 assert.equal(report.reprojectionReports.length,1);
 assert.equal(report.reprojectionReports[0].errorPixels,0);
 assert.equal(report.publicationEligible,false);
});
test("rejects malformed matrices, dimensions, frame and unaudited verified claims",()=>{
 const report=validateCameraProjectionEvidence({cameras:[{...base,projection:[[1,2],[3,4]],imageSize:{width:0,height:2},coordinateFrame:"",calibrationEvidence:{sourceId:"x",sha256:"bad"}}]});
 assert.equal(report.status,"failed");
 assert.ok(report.errors.some(e=>e.code==="projection-must-be-finite-3x4"));
 assert.ok(report.errors.some(e=>e.code==="image-size-must-be-positive-integers"));
 assert.ok(report.errors.some(e=>e.code==="verified-calibration-requires-source-id-and-sha256"));
});
test("reports mismatched image dimensions and out-of-bounds observations",()=>{
 const report=validateCameraProjectionEvidence({cameras:[base],observations:[{cameraId:"cam-a",x:640,y:10}]});
 assert.equal(report.status,"failed");
 assert.ok(report.errors.some(e=>e.code==="observation-outside-image-bounds"));
});
test("reports per-observation reprojection failures without estimating scale or origin",()=>{
 const report=validateCameraProjectionEvidence({cameras:[base],observations:[{cameraId:"cam-a",x:100,y:100,worldPoint:[0,0,5]}],maxReprojectionErrorPixels:2});
 assert.ok(report.errors.some(e=>e.code==="reprojection-error-exceeds-threshold"));
 assert.equal(report.reprojectionReports[0].status,"review-required");
 assert.ok(report.limitations.some(s=>s.includes("No scale, world origin")));
});
test("keeps structurally valid but unverified calibration in review-required status",()=>{
 const report=validateCameraProjectionEvidence({cameras:[{...base,calibrationStatus:"unaudited",calibrationEvidence:undefined}]});
 assert.equal(report.status,"review-required");
 assert.ok(report.warnings.some(e=>e.code==="calibration-not-independently-verified"));
});
test("rejects duplicate camera IDs and unknown observation camera IDs",()=>{
 const report=validateCameraProjectionEvidence({cameras:[base,base],observations:[{cameraId:"missing",x:1,y:1}]});
 assert.equal(report.status,"failed");
 assert.ok(report.errors.some(e=>e.code==="duplicate-camera-id"));
 assert.ok(report.errors.some(e=>e.code==="observation-camera-unknown"));
});
