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
