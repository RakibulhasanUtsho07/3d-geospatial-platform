import assert from "node:assert/strict";
import test from "node:test";
import { registerModelToWgs84 } from "../src/core/building-generation/ground-control-registration.mjs";

const R=6378137;
function lonLatFromLocal(east,north,longitude,latitude){
 const lat0=latitude*Math.PI/180;
 return {longitude:(longitude+east/(R*Math.cos(lat0))*180/Math.PI+540)%360-180,latitude:latitude+north/R*180/Math.PI};
}
function fixtureControls({scale=2.5,thetaDegrees=30,tx=100,ty=200,outlierIndex=-1}={}){
 const theta=thetaDegrees*Math.PI/180,c=Math.cos(theta),s=Math.sin(theta),longitude=90.4,latitude=23.7;
 return [[-10,-8],[10,-8],[10,8],[-10,8]].map(([x,z],index)=>{
  const east=scale*(c*x-s*z)+tx,north=scale*(s*x+c*z)+ty;
  const point=lonLatFromLocal(east,north,longitude,latitude);
  if(index===outlierIndex)point.latitude+=0.00005;
  return {id:"gcp-"+(index+1),modelX:x,modelZ:z,...point,evidenceSourceId:"survey-notes"};
 });
}
test("recovers horizontal scale, rotation and model-origin WGS84 location from measured control points",()=>{
 const result=registerModelToWgs84({controlPoints:fixtureControls()});
 assert.equal(result.status,"calibrated-needs-human-review");
 assert.ok(Math.abs(result.transform.metresPerModelUnit-2.5)<1e-5);
 assert.ok(Math.abs(result.transform.rotationFromModelXToEastNorthDegrees-30)<0.001);
 assert.ok(Math.abs(result.transform.modelOrigin.longitude-90.4)<0.00001);
 assert.ok(Math.abs(result.transform.modelOrigin.latitude-23.7)<0.00001);
 assert.ok(result.controls.rmsErrorM<0.002);assert.equal(result.vertical.status,"not-solved");
 assert.equal(result.mapReady,false);assert.equal(result.publicationEligible,false);
});
test("returns a failed calibration state when a control-point outlier exceeds tolerance",()=>{
 const result=registerModelToWgs84({controlPoints:fixtureControls({outlierIndex:2}),maxRmsErrorM:0.3,maxResidualM:0.5});
 assert.equal(result.status,"calibration-failed-review-required");assert.equal(result.controls.thresholdPass,false);
 assert.ok(result.controls.maxResidualM>0.5);assert.ok(result.warnings.some(w=>w.includes("exceeds")));
});
test("requires three non-collinear unique ground-control points",()=>{
 assert.throws(()=>registerModelToWgs84({controlPoints:fixtureControls().slice(0,2)}),/at least 3/);
 const collinear=[[-2,0],[0,0],[2,0]].map(([modelX,modelZ],i)=>({id:"p"+i,modelX,modelZ,longitude:90.4+i*0.00001,latitude:23.7}));
 assert.throws(()=>registerModelToWgs84({controlPoints:collinear}),/non-collinear/);
 const duplicate=fixtureControls();duplicate[3].id=duplicate[0].id;
 assert.throws(()=>registerModelToWgs84({controlPoints:duplicate}),/duplicate/);
});
test("rejects invalid WGS84 points and absurd fitted scale",()=>{
 const invalid=fixtureControls();invalid[0].latitude=91;
 assert.throws(()=>registerModelToWgs84({controlPoints:invalid}),/latitude/);
 assert.throws(()=>registerModelToWgs84({controlPoints:fixtureControls({scale:2000})}),/derived metresPerModelUnit/);
});