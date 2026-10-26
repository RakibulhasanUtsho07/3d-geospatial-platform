import assert from "node:assert/strict";
import test from "node:test";
import { buildMultiViewWireframe, projectPoint, triangulateCorrespondence } from "../src/core/building-generation/multi-view-wireframe-registration.mjs";
const cameras=[
 {id:"left",projection:[[1,0,0,0],[0,1,0,0],[0,0,1,0]]},
 {id:"right",projection:[[1,0,0,-1],[0,1,0,0],[0,0,1,0]]}
];
test("projects 3D point through calibrated projection matrix",()=>{
 assert.deepEqual(projectPoint(cameras[0],[0,0,5]),{x:0,y:0});
 assert.deepEqual(projectPoint(cameras[1],[0,0,5]),{x:-0.2,y:0});
});
test("triangulates a shared feature from two calibrated views",()=>{
 const result=triangulateCorrespondence([{cameraId:"left",x:0,y:0},{cameraId:"right",x:-0.2,y:0}],cameras);
 assert.ok(Math.abs(result.point[0])<1e-8);
 assert.ok(Math.abs(result.point[1])<1e-8);
 assert.ok(Math.abs(result.point[2]-5)<1e-7);
 assert.ok(result.rmsReprojectionError<1e-8);
});
test("rejects missing calibration and duplicate view observations",()=>{
 assert.throws(()=>triangulateCorrespondence([{cameraId:"left",x:0,y:0}],cameras),/at least two image observations/);
 assert.throws(()=>triangulateCorrespondence([{cameraId:"left",x:0,y:0},{cameraId:"left",x:0,y:0}],cameras),/at most one observation/);
 assert.throws(()=>triangulateCorrespondence([{cameraId:"left",x:0,y:0},{cameraId:"other",x:1,y:1}],cameras),/known cameraId/);
});
test("creates a sparse wireframe and flags high reprojection errors",()=>{
 const features=[
  {id:"a",observations:[{cameraId:"left",x:0,y:0},{cameraId:"right",x:-0.2,y:0}]},
  {id:"b",observations:[{cameraId:"left",x:0.2,y:0},{cameraId:"right",x:0,y:0}]},
  {id:"bad",observations:[{cameraId:"left",x:1,y:1},{cameraId:"right",x:-2,y:2}]}
 ];
 const model=buildMultiViewWireframe({cameras,features,edges:[["a","b"],["a","missing"]],options:{maxRmsReprojectionError:0.01}});
 assert.equal(model.triangulatedVertexCount,3);
 assert.equal(model.edgeCount,1);
 assert.ok(model.issues.some(issue=>issue.type==="invalid-edge-reference"));
 assert.ok(model.issues.some(issue=>issue.type==="high-reprojection-error"));
 assert.equal(model.publicationEligible,false);
});

import { robustTriangulateCorrespondence } from "../src/core/building-generation/multi-view-wireframe-registration.mjs";
const cameraAt=(id,cx)=>({id,projection:[[100,0,0,-100*cx],[0,100,0,0],[0,0,1,0]]});
const truth=[cameraAt("c0",0),cameraAt("c1",1),cameraAt("c2",2),cameraAt("c3",3)];
const observe=(cameras,point)=>cameras.map(camera=>{const p=projectPoint(camera,point);return {cameraId:camera.id,x:p.x,y:p.y};});
test("robust consensus flags a mismatched corner and preserves the suspected observation",()=>{
 const point=[0.3,0.2,5],observations=observe(truth,point);
 observations[2]={...observations[2],x:observations[2].x+45};
 const result=robustTriangulateCorrespondence(observations,truth,{maxReprojectionErrorPixels:1,minParallaxDeg:0.5});
 assert.equal(result.status,"review-required");
 assert.equal(result.reason,"outlier-candidates-need-review");
 assert.ok(result.suspectedOutliers.some(item=>item.cameraId==="c2"));
 assert.equal(result.reprojectionErrors.length,4);
 assert.equal(observations.length,4);
 assert.ok(result.inlierRmsReprojectionError<1e-5);
 assert.equal(result.publicationEligible,false);
});
test("three-view mismatch remains a review candidate rather than an automatic rejection",()=>{
 const cameras=truth.slice(0,3),observations=observe(cameras,[0.3,0.2,5]);
 observations[1]={...observations[1],x:observations[1].x+35};
 const result=robustTriangulateCorrespondence(observations,cameras,{maxReprojectionErrorPixels:1,minParallaxDeg:0.5});
 assert.equal(result.status,"review-required");
 assert.equal(result.reason,"outlier-candidate-needs-more-views");
 assert.ok(result.suspectedOutliers.length>=1);
});
test("low-parallax correspondence is explicitly review-required",()=>{
 const cameras=[cameraAt("near0",0),cameraAt("near1",1),cameraAt("near2",2)];
 const observations=observe(cameras,[0.3,0.2,1000]);
 const result=robustTriangulateCorrespondence(observations,cameras,{maxReprojectionErrorPixels:1,minParallaxDeg:1});
 assert.equal(result.status,"review-required");
 assert.equal(result.reason,"low-parallax");
 assert.equal(result.parallax.status,"low");
 assert.ok(result.parallax.maxPairwiseParallaxDeg<1);
});
test("two-view triangulation cannot claim outlier rejection",()=>{
 const cameras=truth.slice(0,2),observations=observe(cameras,[0.3,0.2,5]);
 const result=robustTriangulateCorrespondence(observations,cameras);
 assert.equal(result.status,"review-required");
 assert.equal(result.reason,"insufficient-views-for-outlier-rejection");
 assert.equal(result.suspectedOutliers.length,0);
 assert.equal(result.publicationEligible,false);
});
test("robust validation rejects invalid thresholds and duplicate camera observations",()=>{
 const observations=observe(truth.slice(0,3),[0.3,0.2,5]);
 assert.throws(()=>robustTriangulateCorrespondence(observations,truth,{maxReprojectionErrorPixels:0}),/must be positive/);
 assert.throws(()=>robustTriangulateCorrespondence([observations[0],observations[0]],truth),/at most one observation/);
});
test("wireframe integrates per-feature robust QA and keeps publication disabled",()=>{
 const observations=observe(truth,[0.3,0.2,5]);
 observations[2]={...observations[2],x:observations[2].x+45};
 const model=buildMultiViewWireframe({cameras:truth,features:[{id:"corner-A",observations}],edges:[],options:{maxRmsReprojectionError:1,maxObservationReprojectionErrorPixels:1}});
 assert.equal(model.status,"review-required");
 assert.equal(model.vertices[0].status,"review-required");
 assert.deepEqual(model.vertices[0].suspectedOutlierCameraIds,["c2"]);
 assert.ok(model.issues.some(issue=>issue.type==="correspondence-review-required"));
 assert.equal(model.publicationEligible,false);
});
