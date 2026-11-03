import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFacadeOpeningProfile, createWallPanelTopology } from "../src/core/building-generation/facade-wall-openings.mjs";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
const spec=JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json",import.meta.url),"utf8"));
function area(ring){return Math.abs(ring.reduce((sum,p,i)=>{const n=ring[(i+1)%ring.length];return sum+p.u*n.y-n.u*p.y;},0)/2);}
function parseGlbJson(glb){assert.equal(glb.toString("ascii",0,4),"glTF");assert.equal(glb.readUInt32LE(4),2);assert.equal(glb.readUInt32LE(8),glb.length);const length=glb.readUInt32LE(12);assert.equal(glb.readUInt32LE(16),0x4e4f534a);return JSON.parse(glb.toString("utf8",20,20+length).trim());}
test("rectangular door and window apertures are removed from both wall faces",()=>{
 const result=createWallPanelTopology({lengthM:10,heightM:4,openings:[
  {id:"door",kind:"door",shape:"rectangular",centerU:2.5,bottomM:0,widthM:1,heightM:2.1},
  {id:"window",kind:"window",shape:"rectangular",centerU:7,bottomM:1.1,widthM:2,heightM:1.2},
 ]});
 assert.equal(result.method,"scanline-triangulated-through-wall");
 assert.equal(result.openings.length,2);
 assert.equal(result.openings[0].profileAreaM2,2.1);
 assert.equal(result.openings[1].profileAreaM2,2.4);
 assert.equal(result.wallFaceAreaM2,35.5);
 assert.ok(result.frontQuads.length>0);
 assert.equal(result.boundaryEdges.length,12);
});
test("arched profile area is conserved by the wall scanline tessellator",()=>{
 const profile=createFacadeOpeningProfile({centerU:5,bottomM:0.8,widthM:2,heightM:2,shape:"arched",archSegments:32});
 assert.equal(profile.length,35);
 assert.ok(area(profile)>3.45&&area(profile)<3.58);
 const result=createWallPanelTopology({lengthM:10,heightM:4,openings:[
  {id:"arch",kind:"window",shape:"arched",centerU:5,bottomM:0.8,widthM:2,heightM:2,archSegments:32},
 ]});
 assert.ok(Math.abs(result.wallFaceAreaM2-(40-area(profile)))<1e-5);
});
test("rejects overlapping, duplicate and out-of-bounds openings",()=>{
 assert.throws(()=>createWallPanelTopology({lengthM:10,heightM:4,openings:[
  {id:"a",kind:"window",centerU:4,bottomM:1,widthM:2,heightM:1},
  {id:"b",kind:"door",centerU:5,bottomM:0,widthM:2,heightM:2},
 ]}),/must not overlap/);
 assert.throws(()=>createWallPanelTopology({lengthM:10,heightM:4,openings:[
  {id:"same",kind:"window",centerU:3,bottomM:1,widthM:1,heightM:1},
  {id:"same",kind:"window",centerU:7,bottomM:1,widthM:1,heightM:1},
 ]}),/duplicate wall opening id/);
 assert.throws(()=>createWallPanelTopology({lengthM:10,heightM:4,openings:[
  {id:"out",kind:"door",centerU:0.2,bottomM:0,widthM:1,heightM:2},
 ]}),/fully inside its wall panel/);
});
test("generator binds arched structural apertures to the exact GLB and report",()=>{
 const input={...spec,architecture:{...spec.architecture,windows:{...spec.architecture.windows,shape:"arched"},doorShape:"arched"}};
 const result=generateProceduralGlb(input);
 const building=parseGlbJson(result.glb).extras.building;
 const openings=building.structuralOpenings;
 assert.equal(openings.engine,"facade-wall-openings-v1");
 assert.equal(openings.method,"scanline-triangulated-through-wall");
 assert.ok(openings.openingCount>0);
 assert.ok(openings.openings.every((opening)=>opening.shape==="arched"));
 assert.equal(openings.reviewRequired,true);
 assert.deepEqual(result.report.structuralOpenings,openings);
 assert.equal(result.report.architecturePlacement.structuralOpenings.openingCount,openings.openingCount);
 assert.equal(result.report.reviewRequired,true);
 assert.ok(result.report.warnings.some((warning)=>warning.includes("structural through-wall apertures")));
});
test("rectangular openings remain the compatibility default",()=>{
 const result=generateProceduralGlb(spec);
 const openings=parseGlbJson(result.glb).extras.building.structuralOpenings;
 assert.ok(openings.openingCount>0);
 assert.ok(openings.openings.every((opening)=>opening.shape==="rectangular"));
});
