#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";

const ROOT = process.cwd();
const PARAMETER_PATH = path.resolve(ROOT, process.argv[2] || "data/heritage/bangabhaban.parameters.json");
const OUTPUT_DIR = path.resolve(ROOT, process.argv[3] || "public/models");
const PARAMS = JSON.parse(await readFile(PARAMETER_PATH, "utf8"));
const MODEL = PARAMS.provisionalDimensions;
const MATERIALS = [
  { name: "PalaceWhite", color: "#F0EEE7", roughness: 0.86 },
  { name: "IvoryTrim", color: "#FAF8F0", roughness: 0.8 },
  { name: "RoofStone", color: "#B8B6AD", roughness: 0.92 },
  { name: "WindowGlass", color: "#3D4B50", roughness: 0.42 },
  { name: "RecessShadow", color: "#30383A", roughness: 0.96 },
  { name: "StepStone", color: "#D8D5CD", roughness: 0.9 },
];
const PARTS = new Map();

function groupFor(partName, materialName) {
  let part = PARTS.get(partName);
  if (!part) { part = new Map(); PARTS.set(partName, part); }
  let group = part.get(materialName);
  if (!group) {
    group = { positions: [], normals: [], indices: [] };
    part.set(materialName, group);
  }
  return group;
}
function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-12 ? v.map(x => x / length) : [0, 1, 0];
}
function cross(a, b, c) {
  const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
  const v = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  return normalize([u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]);
}
function triangle(partName, materialName, a, b, c, vertexNormals = null) {
  const g = groupFor(partName, materialName);
  const faceNormal = cross(a, b, c);
  const points = [a, b, c];
  for (let i=0;i<3;i++) {
    const p = points[i], n = vertexNormals?.[i] || faceNormal;
    g.positions.push(p[0], p[1], p[2]);
    g.normals.push(n[0], n[1], n[2]);
    g.indices.push(g.indices.length);
  }
}
function quad(partName, materialName, a, b, c, d, normals = null) {
  if (normals) {
    triangle(partName, materialName, a, b, c, [normals[0], normals[1], normals[2]]);
    triangle(partName, materialName, a, c, d, [normals[0], normals[2], normals[3]]);
  } else {
    triangle(partName, materialName, a, b, c);
    triangle(partName, materialName, a, c, d);
  }
}
function box(part, material, x, y, z, width, height, depth) {
  if (![x,y,z,width,height,depth].every(Number.isFinite) || width<=0 || height<=0 || depth<=0) {
    throw new RangeError("invalid box dimensions for " + part);
  }
  const x0=x-width/2,x1=x+width/2,y0=y,y1=y+height,z0=z-depth/2,z1=z+depth/2;
  const v=[
    [x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
    [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],
  ];
  const faces=[[4,5,6,7],[1,0,3,2],[5,1,2,6],[0,4,7,3],[3,7,6,2],[0,1,5,4]];
  for (const f of faces) quad(part,material,v[f[0]],v[f[1]],v[f[2]],v[f[3]]);
}
function orientedBox(part, material, a, b, thickness, depth, extraLength=0) {
  const dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
  if (len<1e-4) throw new RangeError("degenerate beam in " + part);
  const ux=dx/len,uy=dy/len,vx=-uy,vy=ux,L=len+extraLength;
  const cx=(a[0]+b[0])/2,cy=(a[1]+b[1])/2,cz=(a[2]+b[2])/2;
  const corners=[];
  for (const [u,v,w] of [
    [-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],
    [-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],
  ]) corners.push([
    cx+ux*u*L/2+vx*v*thickness/2,
    cy+uy*u*L/2+vy*v*thickness/2,
    cz+w*depth/2,
  ]);
  const faces=[[4,5,6,7],[1,0,3,2],[5,1,2,6],[0,4,7,3],[3,7,6,2],[0,1,5,4]];
  for (const f of faces) quad(part,material,corners[f[0]],corners[f[1]],corners[f[2]],corners[f[3]]);
}
function cylinderY(part, material, cx, y0, y1, cz, radius, segments=24) {
  const lower=[],upper=[];
  for (let i=0;i<segments;i++) {
    const a=(i/segments)*Math.PI*2;
    lower.push([cx+radius*Math.cos(a),y0,cz+radius*Math.sin(a)]);
    upper.push([cx+radius*Math.cos(a),y1,cz+radius*Math.sin(a)]);
  }
  const bottom=[cx,y0,cz],top=[cx,y1,cz];
  for (let i=0;i<segments;i++) {
    const j=(i+1)%segments;
    quad(part,material,lower[i],upper[i],upper[j],lower[j]);
    triangle(part,material,top,upper[j],upper[i]);
    triangle(part,material,bottom,lower[i],lower[j]);
  }
}
function sphere(part, material, cx, cy, cz, rx, ry, rz, segments=24, rings=12) {
  const latitudes=[];
  for (let r=0;r<=rings;r++) {
    const theta=Math.PI*(0.03+0.94*r/rings),ring=[];
    for (let s=0;s<segments;s++) {
      const phi=2*Math.PI*s/segments;
      ring.push([cx+rx*Math.sin(theta)*Math.cos(phi),cy+ry*Math.cos(theta),cz+rz*Math.sin(theta)*Math.sin(phi)]);
    }
    latitudes.push({theta,points:ring});
  }
  const radialNormal=(theta,phi)=>normalize([Math.sin(theta)*Math.cos(phi)/Math.max(rx,0.01),Math.cos(theta)/Math.max(ry,0.01),Math.sin(theta)*Math.sin(phi)/Math.max(rz,0.01)]);
  for(let r=0;r<rings;r++){
    for(let s=0;s<segments;s++){
      const n=(s+1)%segments,a=latitudes[r].points[s],b=latitudes[r+1].points[s],c=latitudes[r+1].points[n],d=latitudes[r].points[n];
      const nA=radialNormal(latitudes[r].theta,2*Math.PI*s/segments),nB=radialNormal(latitudes[r+1].theta,2*Math.PI*s/segments);
      const nC=radialNormal(latitudes[r+1].theta,2*Math.PI*n/segments),nD=radialNormal(latitudes[r].theta,2*Math.PI*n/segments);
      quad(part,material,a,b,c,d,[nA,nB,nC,nD]);
    }
  }
  const first=latitudes[0].points,last=latitudes[latitudes.length-1].points,top=[cx,cy+ry,cz],bottom=[cx,cy-ry,cz];
  for(let s=0;s<segments;s++){const n=(s+1)%segments;triangle(part,material,top,first[n],first[s]);triangle(part,material,bottom,last[s],last[n]);}
}
function triangulatePolygon(rawPolygon) {
  let polygon=rawPolygon.map(p=>[p[0],p[1]]);
  const area=polygon.reduce((sum,p,i)=>{const q=polygon[(i+1)%polygon.length];return sum+p[0]*q[1]-q[0]*p[1];},0)/2;
  if(Math.abs(area)<1e-6) throw new Error("plinth footprint polygon has zero area");
  if(area<0) polygon=polygon.reverse();
  const indices=polygon.map((_,i)=>i),triangles=[];
  const cross2=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const pointInTriangle=(p,a,b,c)=>{
    const d1=cross2(p,a,b),d2=cross2(p,b,c),d3=cross2(p,c,a);
    const hasNeg=d1 < -1e-8 || d2 < -1e-8 || d3 < -1e-8,hasPos=d1 > 1e-8 || d2 > 1e-8 || d3 > 1e-8;
    return !(hasNeg&&hasPos);
  };
  let guard=0;
  while(indices.length>3&&guard++<polygon.length*polygon.length){
    let clipped=false;
    for(let i=0;i<indices.length;i++){
      const prev=indices[(i+indices.length-1)%indices.length],cur=indices[i],next=indices[(i+1)%indices.length];
      if(cross2(polygon[prev],polygon[cur],polygon[next])<=1e-8)continue;
      let contains=false;
      for(const candidate of indices){
        if(candidate===prev||candidate===cur||candidate===next)continue;
        if(pointInTriangle(polygon[candidate],polygon[prev],polygon[cur],polygon[next])){contains=true;break;}
      }
      if(contains)continue;
      triangles.push([prev,cur,next]);indices.splice(i,1);clipped=true;break;
    }
    if(!clipped)throw new Error("failed to triangulate provisional Bangabhaban footprint");
  }
  if(indices.length===3)triangles.push([indices[0],indices[1],indices[2]]);
  return {polygon,triangles};
}
function polygonPrism(part,material,rawPolygon,y0,y1) {
  const {polygon,triangles}=triangulatePolygon(rawPolygon);
  for(const t of triangles){
    const [a,b,c]=t,topA=[polygon[a][0],y1,polygon[a][1]],topB=[polygon[b][0],y1,polygon[b][1]],topC=[polygon[c][0],y1,polygon[c][1]];
    const botA=[polygon[a][0],y0,polygon[a][1]],botB=[polygon[b][0],y0,polygon[b][1]],botC=[polygon[c][0],y0,polygon[c][1]];
    triangle(part,material,topA,topC,topB);triangle(part,material,botA,botB,botC);
  }
  for(let i=0;i<polygon.length;i++){
    const j=(i+1)%polygon.length,a=polygon[i],b=polygon[j];
    quad(part,material,[a[0],y0,a[1]],[a[0],y1,a[1]],[b[0],y1,b[1]],[b[0],y0,b[1]]);
  }
}
function arch(part,material,cx,springY,z,radius,thickness,depth,segments=12){
  for(let i=0;i<segments;i++){
    const a0=(i/segments)*Math.PI,a1=((i+1)/segments)*Math.PI;
    orientedBox(part,material,[cx+radius*Math.cos(a0),springY+radius*Math.sin(a0),z],[cx+radius*Math.cos(a1),springY+radius*Math.sin(a1),z],thickness,depth,thickness*0.9);
  }
}
function addWindow(part,x,y,z,w,h,facing="front"){
  if(facing==="front"||facing==="back"){
    const sign=facing==="front"?1:-1;
    box(part,"IvoryTrim",x,y-h/2,z+sign*0.06,w+0.26,h+0.24,0.16);
    box(part,"WindowGlass",x,y-h/2+0.08,z+sign*0.16,w,h-0.16,0.055);
    box(part,"IvoryTrim",x-w/2-0.06,y-h/2,z+sign*0.19,0.09,h,0.12);
    box(part,"IvoryTrim",x+w/2+0.06,y-h/2,z+sign*0.19,0.09,h,0.12);
  } else {
    const sign=facing==="right"?1:-1;
    box(part,"IvoryTrim",x+sign*0.07,y-h/2,z,0.22,h+0.20,w+0.24);
    box(part,"WindowGlass",x+sign*0.16,y-h/2+0.08,z,0.06,h-0.16,w-0.16);
    box(part,"IvoryTrim",x+sign*0.19,y-h/2,z-w/2-0.06,0.12,h,0.09);
    box(part,"IvoryTrim",x+sign*0.19,y-h/2,z+w/2+0.06,0.12,h,0.09);
  }
}
function buildLod(lod) {
  PARTS.clear();
  const W=MODEL.overallWidthM.value,D=MODEL.overallDepthM.value,floor=MODEL.floorHeightM.value,base=MODEL.plinthHeightM.value;
  const widthW=MODEL.westWingWidthM.value,depthW=MODEL.westWingDepthM.value,heightW=floor*2;
  const widthC=MODEL.centralHallWidthM.value,depthC=MODEL.centralHallDepthM.value,heightC=floor*2+0.5;
  const widthE=MODEL.eastWingWidthM.value,depthE=MODEL.eastWingDepthM.value,heightE=floor*2;
  polygonPrism("Plinth","StepStone",[
    [-W/2,-D/2],[W/2,-D/2],[W/2,D*0.19],[W*0.34,D*0.19],[W*0.34,D/2],[-W/2,D/2],
  ],0,base);
  box("WestWing","PalaceWhite",-W*0.31,base,-1,widthW,heightW,depthW);
  box("CentralHall","PalaceWhite",-W*0.015,base,-D*0.035,widthC,heightC,depthC);
  box("EastWing","PalaceWhite",W*0.29,base,-D*0.035,widthE,heightE,depthE);
  box("RearHall","PalaceWhite",-W*0.015,base,-D*0.34,widthC*0.70,floor*1.75,depthC*0.50);
  box("RoofDeck","RoofStone",-W*0.31,base+heightW,-1,widthW+1.0,0.55,depthW+1.0);
  box("RoofDeck","RoofStone",-W*0.015,base+heightC,-D*0.035,widthC+1.1,0.65,depthC+1.1);
  box("RoofDeck","RoofStone",W*0.29,base+heightE,-D*0.035,widthE+1.0,0.55,depthE+1.0);
  box("RoofDeck","RoofStone",-W*0.015,base+heightC+0.65,-D*0.30,widthC*0.72,0.45,depthC*0.32);
  const domeX=W*0.205,domeZ=-D*0.065,drumY=base+heightE+0.55;
  box("DomePavilion","PalaceWhite",domeX,drumY-1.25,domeZ,15.5,2.5,15.0);
  box("RoofDeck","IvoryTrim",domeX,drumY+0.05,domeZ,16.2,0.35,15.7);
  cylinderY("DomeDrum","IvoryTrim",domeX,drumY,drumY+2.6,domeZ,5.25,lod===1?16:32);
  const domeBase=drumY+2.5,domeHeight=MODEL.domeHeightM.value,domeRadius=MODEL.domeRadiusM.value;
  const profile=[[0,1],[0.08,0.99],[0.20,0.93],[0.36,0.82],[0.53,0.67],[0.68,0.50],[0.81,0.34],[0.91,0.19],[0.975,0.07]];
  const segments=lod===1?20:lod===2?32:48;
  const rings=profile.map(([yf,rf])=>({y:domeBase+yf*domeHeight,r:domeRadius*rf,yf,rf}));
  const normalAt=(yf,phi)=>{
    let nearest=profile.findIndex(p=>p[0]>=yf);if(nearest<0)nearest=profile.length-1;
    const lo=Math.max(0,nearest-1),hi=Math.min(profile.length-1,nearest+1);
    const dr=(profile[hi][1]-profile[lo][1])*domeRadius,dy=(profile[hi][0]-profile[lo][0])*domeHeight;
    const slope=Math.abs(dy)>1e-6?dr/dy:0;
    return normalize([Math.cos(phi),-slope,Math.sin(phi)]);
  };
  for(let r=0;r<rings.length-1;r++){
    const lower=rings[r],upper=rings[r+1];
    for(let s=0;s<segments;s++){
      const next=(s+1)%segments,p0=2*Math.PI*s/segments,p1=2*Math.PI*next/segments;
      const a=[domeX+lower.r*Math.cos(p0),lower.y,domeZ+lower.r*Math.sin(p0)];
      const b=[domeX+upper.r*Math.cos(p0),upper.y,domeZ+upper.r*Math.sin(p0)];
      const c=[domeX+upper.r*Math.cos(p1),upper.y,domeZ+upper.r*Math.sin(p1)];
      const d=[domeX+lower.r*Math.cos(p1),lower.y,domeZ+lower.r*Math.sin(p1)];
      quad("Dome","PalaceWhite",a,b,c,d,[normalAt(lower.yf,p0),normalAt(upper.yf,p0),normalAt(upper.yf,p1),normalAt(lower.yf,p1)]);
    }
  }
  const domeBottom=[domeX,domeBase,domeZ];
  for(let s=0;s<segments;s++){
    const n=(s+1)%segments,a=[domeX+domeRadius*Math.cos(2*Math.PI*s/segments),domeBase,domeZ+domeRadius*Math.sin(2*Math.PI*s/segments)];
    const b=[domeX+domeRadius*Math.cos(2*Math.PI*n/segments),domeBase,domeZ+domeRadius*Math.sin(2*Math.PI*n/segments)];
    triangle("Dome","PalaceWhite",domeBottom,b,a);
  }
  cylinderY("Finial","IvoryTrim",domeX,domeBase+domeHeight-0.03,domeBase+domeHeight+1.15,domeZ,0.22,lod===1?8:12);
  sphere("Finial","IvoryTrim",domeX,domeBase+domeHeight+1.24,domeZ,0.34,0.34,0.34,16,8);
  if(lod>=2){
    const firstX=-W*0.37,lastX=W*0.12,bays=10,spacing=(lastX-firstX)/bays,faceZ=D/2-2.0;
    for(let i=0;i<=bays;i++){
      const x=firstX+i*spacing;
      cylinderY("Loggia","IvoryTrim",x,base+0.05,base+floor+0.35,faceZ,0.28,lod===2?10:16);
      cylinderY("Loggia","IvoryTrim",x,base+floor+0.20,base+floor*2+0.20,faceZ,0.23,lod===2?10:16);
      box("Loggia","IvoryTrim",x,base+floor-0.16,faceZ,0.72,0.32,0.78);
      box("Loggia","IvoryTrim",x,base+floor*2+0.02,faceZ,0.72,0.34,0.78);
    }
    box("Loggia","PalaceWhite",(firstX+lastX)/2,base+floor-0.25,faceZ,spacing*bays+0.4,0.5,0.95);
    box("Loggia","PalaceWhite",(firstX+lastX)/2,base+floor*2+0.05,faceZ,spacing*bays+0.5,0.5,0.95);
    if(lod>=3){
      for(let i=0;i<bays;i++){
        const cx=firstX+(i+0.5)*spacing;
        arch("Loggia","IvoryTrim",cx,base+floor-0.25,faceZ,spacing*0.46,0.26,0.85,12);
        arch("Loggia","IvoryTrim",cx,base+floor*2-0.15,faceZ,spacing*0.43,0.22,0.80,12);
      }
      for(const x of [-W*0.35,-W*0.24,-W*0.13,-W*0.02,W*0.09]){
        box("FacadeTrim","IvoryTrim",x,base+floor*0.95,D/2-2.2,0.18,floor*1.80,0.20);
      }
    }
  }
  if(lod>=2){
    const windowRows=[base+floor*0.50,base+floor+floor*0.50];
    for(const [centerX,width,frontZ,bayCount] of [
      [-W*0.31,widthW,-1+depthW/2,5],
      [-W*0.015,widthC,-D*0.035+depthC/2,8],
      [W*0.29,widthE,-D*0.035+depthE/2,5],
    ]){
      for(let row=0;row<windowRows.length;row++){
        for(let bay=0;bay<bayCount;bay++){
          const x=centerX-width*0.40+(bay+0.5)*(width*0.80/bayCount),y=windowRows[row];
          if(lod===2)box("WindowsAndDoors","WindowGlass",x,y-0.7,frontZ+0.10,1.05,1.40,0.08);
          else addWindow("WindowsAndDoors",x,y,frontZ,1.05,1.42,"front");
        }
      }
    }
    for(const side of [-1,1]){
      const x=side*(W*0.31+widthE*0.5+0.02);
      for(let i=0;i<4;i++)addWindow("WindowsAndDoors",x,base+floor*0.50,-D*0.23+i*7.2,1.2,1.4,side>0?"right":"left");
    }
    const topY=base+heightC+0.65;
    box("Parapet","IvoryTrim",0,topY,D*0.31,W*0.74,0.8,0.36);
    box("Parapet","IvoryTrim",-W*0.40,topY,-1,0.36,0.8,depthW*0.88);
    box("Parapet","IvoryTrim",W*0.40,topY,-1,0.36,0.8,depthE*0.85);
    if(lod>=3){
      for(let i=0;i<9;i++)box("FacadeTrim","IvoryTrim",-W*0.35+i*W*0.70/8,topY+0.30,D*0.31,0.42,0.20,0.42);
    }
  }
  const steps=lod===1?3:7,stairWidth=MODEL.stairWidthM.value,stairRun=MODEL.stairRunM.value,stairRise=MODEL.stairRiseM.value,stepDepth=stairRun/steps;
  for(let i=0;i<steps;i++){
    const height=0.24+(i+1)*stairRise/steps,y=0.12+i*stairRise/steps,z=D/2+(steps-i-0.5)*stepDepth;
    box("EntranceStair","StepStone",0,y,z,stairWidth,height,stepDepth+0.20);
  }
  return {parts:PARTS,lod};
}
function toGlb(parts,lod) {
  const binaryParts=[],bufferViews=[],accessors=[],meshes=[],nodes=[];
  let binaryOffset=0;
  const align4=buffer=>{const pad=(4-buffer.length%4)%4;return pad?Buffer.concat([buffer,Buffer.alloc(pad)]):buffer;};
  const appendView=(raw,target)=>{
    const bytes=align4(raw),index=bufferViews.length;
    bufferViews.push({buffer:0,byteOffset:binaryOffset,byteLength:bytes.length,target});
    binaryParts.push(bytes);binaryOffset+=bytes.length;return index;
  };
  for(const [partName,groups] of parts.entries()){
    const primitives=[];
    for(const [materialName,g] of groups.entries()){
      if(!g.indices.length)continue;
      const positions=Float32Array.from(g.positions),normals=Float32Array.from(g.normals),indices=Uint32Array.from(g.indices);
      const posView=appendView(Buffer.from(positions.buffer,positions.byteOffset,positions.byteLength),34962);
      const normalView=appendView(Buffer.from(normals.buffer,normals.byteOffset,normals.byteLength),34962);
      const indexView=appendView(Buffer.from(indices.buffer,indices.byteOffset,indices.byteLength),34963);
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
      for(let i=0;i<positions.length;i+=3){
        for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis],positions[i+axis]);max[axis]=Math.max(max[axis],positions[i+axis]);}
      }
      const posAccessor=accessors.length;
      accessors.push({bufferView:posView,componentType:5126,count:positions.length/3,type:"VEC3",min,max});
      const normalAccessor=accessors.length;accessors.push({bufferView:normalView,componentType:5126,count:normals.length/3,type:"VEC3"});
      const indexAccessor=accessors.length;accessors.push({bufferView:indexView,componentType:5125,count:indices.length,type:"SCALAR"});
      primitives.push({attributes:{POSITION:posAccessor,NORMAL:normalAccessor},indices:indexAccessor,material:MATERIALS.findIndex(m=>m.name===materialName),mode:4});
    }
    if(primitives.length){
      const meshIndex=meshes.length;meshes.push({name:partName,primitives});nodes.push({name:partName,mesh:meshIndex});
    }
  }
  const bin=Buffer.concat(binaryParts),pad4=b=>{const pad=(4-b.length%4)%4;return pad?Buffer.concat([b,Buffer.alloc(pad)]):b;};
  const gltf={
    asset:{version:"2.0",generator:"3D Geospatial Platform Bangabhaban provisional model builder",extras:{buildingId:"bangabhaban-dhaka",lod,geometryConfidence:"estimated",photogrammetryClaim:false,surveyVerified:false}},
    scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,meshes,
    materials:MATERIALS.map(m=>({name:m.name,doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[parseInt(m.color.slice(1,3),16)/255,parseInt(m.color.slice(3,5),16)/255,parseInt(m.color.slice(5,7),16)/255,1],metallicFactor:0,roughnessFactor:m.roughness}})),
    buffers:[{byteLength:bin.length}],bufferViews,accessors,
  };
  const jsonRaw=Buffer.from(JSON.stringify(gltf),"utf8");
  const jsonPadding=(4-jsonRaw.length%4)%4;
  const json=jsonPadding?Buffer.concat([jsonRaw,Buffer.alloc(jsonPadding,0x20)]):jsonRaw;
  const binChunk=pad4(bin),total=12+8+json.length+8+binChunk.length;
  const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(total,8);
  const jsonHeader=Buffer.alloc(8);jsonHeader.writeUInt32LE(json.length,0);jsonHeader.writeUInt32LE(0x4e4f534a,4);
  const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(binChunk.length,0);binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,jsonHeader,json,binHeader,binChunk]);
}
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
await mkdir(OUTPUT_DIR,{recursive:true});
const assets={};
for(const lod of [1,2,3]){
  const built=buildLod(lod),bytes=toGlb(built.parts,lod),quality=analyzeGlbQuality(bytes);
  if(!quality.valid||quality.counts.degenerateTriangleCount!==0)throw new Error("Bangabhaban LOD"+lod+" failed GLB structure/degenerate-triangle QA");
  const filename="bangabhaban-lod"+lod+".glb";
  await writeFile(path.join(OUTPUT_DIR,filename),bytes);
  await writeFile(path.join(OUTPUT_DIR,filename.replace(/\.glb$/,".report.json")),JSON.stringify({candidate:filename,sha256:sha256(bytes),byteLength:bytes.length,lod,quality,confidencePolicy:"provisional visual proxy only; dimensions and footprint are estimates"},null,2)+"\n");
  assets["lod"+lod]={uri:"/models/"+filename,lod,purpose:lod===1?"coarse massing":lod===2?"roofline and facade openings":"detailed exterior facade",sha256:sha256(bytes),byteLength:bytes.length,triangleCount:quality.counts.triangleCount,degenerateTriangleCount:quality.counts.degenerateTriangleCount};
}
const primary=await readFile(path.join(OUTPUT_DIR,"bangabhaban-lod3.glb"));
await writeFile(path.join(OUTPUT_DIR,"bangabhaban.glb"),primary);
assets.default={uri:"/models/bangabhaban.glb",lod:3,sha256:sha256(primary),byteLength:primary.length};
const manifest={
  manifestVersion:"1.0.0",schema:"3d-geospatial-platform/heritage-building-model",coordinateReferenceSystem:"EPSG:4326",
  entries:[{
    id:"bangabhaban-dhaka",featureType:"heritage-building",displayName:"Bangabhaban",displayNameBn:"বঙ্গভবন",
    location:{longitude:PARAMS.location.longitude,latitude:PARAMS.location.latitude,confidence:"[C]",note:"Public landmark coordinate from secondary mapping; not a surveyed footprint centroid or ground-control point."},
    orientation:{longAxisAzimuthDegrees:PARAMS.orientation.longAxisAzimuthDegrees,confidence:"[E]",note:"Approximate east-west arrangement inferred visually; confirm from a traced footprint."},
    units:"estimated model-space meters",
    localCoordinateFrame:{xAxis:"east-west long axis",yAxis:"up",zAxis:"south / front-facing facade",verticalDatum:"model ground at y=0; not survey datum"},
    assets,
    nodes:["Plinth","WestWing","CentralHall","EastWing","RearHall","RoofDeck","DomePavilion","DomeDrum","Dome","Finial","Loggia","WindowsAndDoors","FacadeTrim","Parapet","EntranceStair"],
    parameterConfig:"/data/heritage/bangabhaban.parameters.json",
    referencePack:"/data/heritage/bangabhaban-reference-pack.json",
    modelGenerator:{script:"scripts/build-bangabhaban-model.mjs",command:"npm run build:bangabhaban-model",strategy:"source-controlled parametric exterior proxy"},
    status:"provisional-visual-proxy-not-survey-verified",publicationEligible:false,
    limitations:[
      "Not generated by photogrammetry or image-to-geometry reconstruction; reference photos inform qualitative appearance only.",
      "All model dimensions, footprint and orientation are estimates pending rectified facade imagery, traced plan and independent survey.",
      "Published area descriptions differ; no reported area figure was used to scale this model.",
      "No images, texture atlas or UV coordinates are embedded in this candidate.",
      "Interior, security layouts, and hidden/occluded geometry are not modeled."
    ]
  }]
};
await writeFile(path.join(OUTPUT_DIR,"bangabhaban.manifest.json"),JSON.stringify(manifest,null,2)+"\n");
console.log(JSON.stringify({built:true,assets:Object.fromEntries(Object.entries(assets).map(([key,value])=>[key,{sha256:value.sha256,byteLength:value.byteLength,triangleCount:value.triangleCount}]))},null,2));
