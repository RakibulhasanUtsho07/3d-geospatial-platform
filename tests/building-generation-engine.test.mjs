import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { coordinateToLocalMeters, normalizeBuildingSpec } from "../src/core/building-generation/building-spec.mjs";
import { createFacadeFrame } from "../src/core/building-generation/facade-placement.mjs";
import { generateBuildingModel, planGeneration } from "../src/core/building-generation/generation-engine.mjs";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
const fixture=JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json",import.meta.url),"utf8"));
function parseGlb(buffer){
 assert.equal(buffer.readUInt32LE(0),0x46546c67);assert.equal(buffer.readUInt32LE(4),2);assert.equal(buffer.readUInt32LE(8),buffer.byteLength);
 const size=buffer.readUInt32LE(12);assert.equal(buffer.readUInt32LE(16),0x4e4f534a);
 const gltf=JSON.parse(buffer.subarray(20,20+size).toString("utf8").trim()),bin=20+size;
 assert.equal(buffer.readUInt32LE(bin+4),0x004e4942);assert.ok(gltf.buffers[0].byteLength<=buffer.readUInt32LE(bin));return gltf;
}
test("normalizes BuildingSpec and derives metric footprint while retaining evidence",()=>{
 const {spec,derived}=normalizeBuildingSpec(fixture);assert.equal(spec.schemaVersion,"1.0.0");assert.equal(spec.location.longitude,fixture.location.longitude);
 assert.ok(derived.footprintAreaM2>50&&derived.footprintAreaM2<150);assert.equal(spec.evidence[0].confidence,"estimated");assert.deepEqual(spec.evidence[0].sourceIds,["survey-notes"]);
});
test("rejects malformed footprints, dangling evidence and unsafe sources",()=>{
 assert.throws(()=>normalizeBuildingSpec({...fixture,footprint:{type:"Point",coordinates:[90,23]}}),/GeoJSON Polygon/);
 assert.throws(()=>normalizeBuildingSpec({...fixture,evidence:[{field:"height",confidence:"verified",sourceIds:["missing"]}]}),/unknown source/);
 assert.throws(()=>normalizeBuildingSpec({...fixture,sources:[{id:"x",kind:"image",url:"http://example.com/a.jpg"}]}),/HTTPS/);
 assert.throws(()=>normalizeBuildingSpec({...fixture,dimensions:{floorCount:0}}),/between 1 and 100/);
 assert.throws(()=>normalizeBuildingSpec({...fixture,architecture:{wallColor:"blue"}}),/#RRGGBB/);
});
test("writes a binary GLB with metric geometry, nodes and materials",()=>{
 const {glb,report}=generateProceduralGlb(fixture);assert.ok(Buffer.isBuffer(glb));assert.ok(glb.byteLength>5000);
 const model=parseGlb(glb);assert.equal(model.asset.version,"2.0");assert.equal(model.asset.extras.buildingId,fixture.id);assert.ok(model.meshes.length>=3);
 assert.ok(model.accessors.some(a=>a.type==="VEC3"&&a.componentType===5126));assert.ok(model.materials.some(m=>m.name==="Glass"));
 assert.equal(report.output.format,"glb");assert.equal(report.geometry.floorCount,5);assert.equal(report.georeference.longitude,fixture.location.longitude);assert.equal(report.reviewRequired,true);
 assert.equal(model.extras.building.facadeOrientation.schemaVersion,"1.0.0");
 assert.equal(model.extras.building.facadeOrientation.coordinateFrame,"glTF-local:+X=east,+Y=up,+Z=north");
 assert.equal(model.extras.building.facadeOrientation.selectionMethod,"longest-edge-inferred");
 assert.equal(model.extras.building.facadeOrientation.confidence,"estimated");
 assert.equal(model.extras.building.facadeOrientation.reviewRequired,true);
 assert.deepEqual(report.facadeOrientation,model.extras.building.facadeOrientation);
});
test("labels media route candidates without claiming photogrammetry ran",()=>{
 const withVisuals={...fixture,sources:[
 {id:"front-photo",kind:"image",url:"https://example.org/front.jpg",licence:"CC BY 4.0",attribution:"Example",usageStatus:"approved",location:{longitude:90.406,latitude:23.709}},
 {id:"side-photo",kind:"image",url:"https://example.org/side.jpg",licence:"CC BY 4.0",attribution:"Example",usageStatus:"approved",location:{longitude:90.4061,latitude:23.709}},
 {id:"roof-video",kind:"video",url:"https://example.org/roof.mp4",licence:"CC BY 4.0",attribution:"Example",usageStatus:"approved",location:{longitude:90.4062,latitude:23.709}}],
 evidence:[{field:"floorCount",value:5,confidence:"derived",sourceIds:["front-photo"]}]};
 const plan=planGeneration(withVisuals);assert.equal(plan.sourceRoute,"multiview-photogrammetry-candidate");assert.equal(plan.additionalWorkersConfigured,false);
 const result=generateBuildingModel(withVisuals);assert.equal(result.report.strategy,"reference-assisted-procedural");
 assert.ok(result.report.warnings.some(w=>w.includes("does not run image understanding")));assert.ok(result.report.limitations.some(s=>s.includes("not a photogrammetry")));
});
test("is deterministic for a fixed BuildingSpec",()=>assert.deepEqual(generateBuildingModel(fixture).glb,generateBuildingModel(fixture).glb));

function extractMeshPositions(glb, suffix) {
 const gltf=parseGlb(glb);
 const mesh=gltf.meshes.find(item=>item.name.endsWith(suffix));
 assert.ok(mesh,"generated GLB includes "+suffix+" mesh");
 const accessor=gltf.accessors[mesh.primitives[0].attributes.POSITION];
 const view=gltf.bufferViews[accessor.bufferView];
 const binaryStart=28+glb.readUInt32LE(12);
 const stride=view.byteStride||12;
 const start=binaryStart+(view.byteOffset||0)+(accessor.byteOffset||0);
 return Array.from({length:accessor.count},(_,index)=>{
  const offset=start+index*stride;
  return {x:glb.readFloatLE(offset),y:glb.readFloatLE(offset+4),z:glb.readFloatLE(offset+8)};
 });
}

function facadeFramesFor(spec) {
 const {derived}=normalizeBuildingSpec(spec);
 const points=derived.localFootprint;
 const signedArea=points.reduce((sum,point,index)=>{
  const next=points[(index+1)%points.length];
  return sum+point.x*next.z-next.x*point.z;
 },0)/2;
 const outwardSign=signedArea>=0?1:-1;
 return points.map((point,index)=>createFacadeFrame(point,points[(index+1)%points.length],outwardSign));
}

function distancesFromFacade(points,edgeStart,frame) {
 return points.map(point=>{
  const dx=point.x-edgeStart.x,dz=point.z-edgeStart.z;
  return {
   along:dx*frame.tangent.x+dz*frame.tangent.z,
   outward:dx*frame.out.x+dz*frame.out.z
  };
 });
}

function facadeTestSpec({reverseWinding=false,architecture={}}={}) {
 const openRing=fixture.footprint.coordinates[0].slice(0,-1);
 const points=reverseWinding?[...openRing].reverse():openRing;
 const ring=[...points,points[0]];
 return {
  ...fixture,
  footprint:{...fixture.footprint,coordinates:[ring]},
  architecture:{
   ...fixture.architecture,
   balcony:{...fixture.architecture.balcony,enabled:false},
   ...architecture
  }
 };
}

test("normalizes explicit front facade edge and compass bearing as mutually exclusive selectors",()=>{
 const explicit=normalizeBuildingSpec(facadeTestSpec({architecture:{frontFacadeEdgeIndex:1}}));
 assert.equal(explicit.spec.architecture.frontFacadeEdgeIndex,1);
 assert.equal(explicit.spec.architecture.frontFacingAzimuthDegrees,null);
 const bearing=normalizeBuildingSpec(facadeTestSpec({architecture:{frontFacingAzimuthDegrees:90}}));
 assert.equal(bearing.spec.architecture.frontFacadeEdgeIndex,undefined);
 assert.equal(bearing.spec.architecture.frontFacingAzimuthDegrees,90);
 assert.throws(
  ()=>normalizeBuildingSpec(facadeTestSpec({architecture:{frontFacadeEdgeIndex:1,frontFacingAzimuthDegrees:90}})),
  /specify either frontFacadeEdgeIndex or frontFacingAzimuthDegrees/
 );
 assert.throws(
  ()=>normalizeBuildingSpec(facadeTestSpec({architecture:{frontFacadeEdgeIndex:4}})),
  /frontFacadeEdgeIndex must be between 0 and 3/
 );
 assert.throws(
  ()=>normalizeBuildingSpec(facadeTestSpec({architecture:{frontFacadeEdgeIndex:1.5}})),
  /frontFacadeEdgeIndex must be an integer/
 );
 assert.throws(
  ()=>normalizeBuildingSpec(facadeTestSpec({architecture:{frontFacingAzimuthDegrees:361}})),
  /frontFacingAzimuthDegrees must be between 0 and 360/
 );
});

test("uses the nearest outward edge for a clockwise-from-north bearing in the existing map frame",()=>{
 const result=generateProceduralGlb(facadeTestSpec({architecture:{frontFacingAzimuthDegrees:90}}));
 assert.equal(result.report.facadeSelection.method,"azimuth-nearest-edge");
 assert.equal(result.report.facadeSelection.edgeIndex,1);
 assert.equal(result.report.facadeSelection.actualAzimuthDegrees,90);
 assert.equal(result.report.facadeSelection.source,"buildingSpec.architecture.frontFacingAzimuthDegrees");
 assert.equal(result.report.reviewRequired,true,"operator-specified orientation is not independent verification");
 const offAxis=generateProceduralGlb(facadeTestSpec({architecture:{frontFacingAzimuthDegrees:45}}));
 assert.ok(offAxis.report.warnings.some(message=>message.includes("more than 15 degrees")));
 assert.equal(offAxis.report.facadeSelection.alignmentDot,Number(Math.SQRT1_2.toFixed(6)));
});

test("uses the explicitly selected edge for front-facade door placement",()=>{
 const spec=facadeTestSpec({architecture:{frontFacadeEdgeIndex:1}});
 const result=generateProceduralGlb(spec);
 assert.equal(result.report.facadeSelection.method,"explicit-edge-index");
 assert.equal(result.report.facadeSelection.edgeIndex,1);
 assert.equal(result.report.facadeSelection.source,"buildingSpec.architecture.frontFacadeEdgeIndex");
 assert.equal(result.report.architecturePlacement.frontFacade.insertFaceClearanceM,0.002);
 const {derived}=normalizeBuildingSpec(spec);
 const points=derived.localFootprint;
 const frames=facadeFramesFor(spec);
 const doorPoints=extractMeshPositions(result.glb,"-door");
 const distances=distancesFromFacade(doorPoints,points[1],frames[1])
  .filter(value=>value.along>0.1&&value.along<frames[1].len-0.1&&value.outward>0&&value.outward<0.1)
  .map(value=>value.outward);
 assert.ok(distances.length>0);
 assert.ok(Math.abs(Math.min(...distances)-0.002)<0.0001,"door inner face keeps 2 mm clearance");
 assert.ok(Math.abs(Math.max(...distances)-0.072)<0.0001,"door outer face matches its 70 mm depth");
});

test("window glass inner face is flush-offset 2 mm from every facade for both footprint windings",()=>{
 for(const reverseWinding of [false,true]){
  const spec=facadeTestSpec({reverseWinding});
  const result=generateProceduralGlb(spec);
  const {derived}=normalizeBuildingSpec(spec);
  const points=derived.localFootprint,frames=facadeFramesFor(spec);
  const glassPoints=extractMeshPositions(result.glb,"-glass");
  for(let edgeIndex=0;edgeIndex<frames.length;edgeIndex++){
   const distances=distancesFromFacade(glassPoints,points[edgeIndex],frames[edgeIndex])
    .filter(value=>value.along>0.25&&value.along<frames[edgeIndex].len-0.25&&value.outward>0&&value.outward<0.1)
    .map(value=>value.outward);
   assert.ok(distances.length>0,"window glass exists on edge "+edgeIndex+" (reversed="+reverseWinding+")");
   assert.ok(Math.abs(Math.min(...distances)-0.002)<0.0001,"window inner face keeps 2 mm clearance on edge "+edgeIndex);
   assert.ok(Math.abs(Math.max(...distances)-0.057)<0.0001,"55 mm pane depth is preserved on edge "+edgeIndex);
  }
 }
});

test("local latitude increases remain positive model-space northing; facade work does not flip the coordinate convention",()=>{
 const origin={longitude:90.406,latitude:23.709};
 const north=coordinateToLocalMeters([origin.longitude,origin.latitude+0.0001],origin);
 const east=coordinateToLocalMeters([origin.longitude+0.0001,origin.latitude],origin);
 assert.ok(north.z>0,"northing remains +Z in the existing generator frame");
 assert.ok(east.x>0,"easting remains +X in the existing generator frame");
});


test("embeds the selected facade normal and review provenance in GLB extras",()=>{
 const result=generateProceduralGlb(facadeTestSpec({architecture:{frontFacingAzimuthDegrees:90}}));
 const model=parseGlb(result.glb);
 const metadata=model.extras.building.facadeOrientation;
 assert.equal(metadata.selectionMethod,"azimuth-nearest-edge");
 assert.equal(metadata.edgeIndex,1);
 assert.equal(metadata.requestedAzimuthDegrees,90);
 assert.equal(metadata.actualAzimuthDegrees,90);
 assert.deepEqual(metadata.outwardNormal,{x:1,z:0});
 assert.equal(metadata.confidence,"operator-specified");
 assert.equal(metadata.reviewRequired,true);
 assert.deepEqual(metadata,result.report.facadeOrientation);
});
