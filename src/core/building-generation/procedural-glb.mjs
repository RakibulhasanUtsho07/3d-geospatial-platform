import { normalizeBuildingSpec } from "./building-spec.mjs";
import { createFacadeFrame, offsetFacadePoint, selectFrontFacadeEdge, surfaceInsertCenterOffset } from "./facade-placement.mjs";
import { addExtrudedFacadeProfile, addWallPanelWithOpenings, createFacadeOpeningProfile } from "./facade-wall-openings.mjs";
const MATERIALS = ["wall", "roof", "glass", "frame", "concrete", "door", "metal"];
function rgba(hex) { const s = hex.slice(1); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255).concat(1); }
function normal(a, b, c) {
  const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], v = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  const n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]], length = Math.hypot(...n) || 1;
  return n.map(value => value / length);
}
function geometryBuilder() {
  const groups = new Map(MATERIALS.map(name => [name, { positions: [], normals: [], indices: [] }]));
  function triangle(material, a, b, c, expected) {
    let points = [a, b, c], n = normal(...points);
    if (expected && n.reduce((sum, value, i) => sum + value * expected[i], 0) < 0) { points = [a, c, b]; n = normal(...points); }
    const group = groups.get(material), base = group.positions.length / 3;
    for (const p of points) { group.positions.push(...p); group.normals.push(...n); }
    group.indices.push(base, base+1, base+2);
  }
  function quad(material, a, b, c, d, expected) { triangle(material,a,b,c,expected); triangle(material,a,c,d,expected); }
  function box(material, cx, cy, cz, w, h, d, yaw = 0) {
    const x=w/2, y=h/2, z=d/2, co=Math.cos(yaw), si=Math.sin(yaw);
    const p=(px,py,pz)=>[cx+px*co+pz*si,cy+py,cz-px*si+pz*co];
    quad(material,p(-x,y,-z),p(-x,y,z),p(x,y,z),p(x,y,-z),[0,1,0]);
    quad(material,p(-x,-y,-z),p(x,-y,-z),p(x,-y,z),p(-x,-y,z),[0,-1,0]);
    quad(material,p(x,-y,-z),p(x,y,-z),p(x,y,z),p(x,-y,z),[1,0,0]);
    quad(material,p(-x,-y,-z),p(-x,-y,z),p(-x,y,z),p(-x,y,-z),[-1,0,0]);
    quad(material,p(-x,-y,z),p(x,-y,z),p(x,y,z),p(-x,y,z),[0,0,1]);
    quad(material,p(-x,-y,-z),p(-x,y,-z),p(x,y,-z),p(x,-y,-z),[0,0,-1]);
  }
  function cylinder(material, cx, baseY, cz, radius, height, segments = 24) {
    for (let segment = 0; segment < segments; segment++) {
      const a0 = segment / segments * Math.PI * 2;
      const a1 = (segment + 1) / segments * Math.PI * 2;
      const b0 = [cx + radius * Math.cos(a0), baseY, cz + radius * Math.sin(a0)];
      const b1 = [cx + radius * Math.cos(a1), baseY, cz + radius * Math.sin(a1)];
      const t0 = [b0[0], baseY + height, b0[2]];
      const t1 = [b1[0], baseY + height, b1[2]];
      const mid = (a0 + a1) / 2;
      const outward = [Math.cos(mid), 0, Math.sin(mid)];
      quad(material, b0, b1, t1, t0, outward);
      triangle(material, [cx, baseY + height, cz], t0, t1, [0, 1, 0]);
      triangle(material, [cx, baseY, cz], b1, b0, [0, -1, 0]);
    }
  }
  return { groups, triangle, quad, box, cylinder };
}
function triangulate(points) {
  const area=points.reduce((s,p,i)=>{const n=points[(i+1)%points.length];return s+p.x*n.z-n.x*p.z;},0)/2;
  if (Math.abs(area)<1e-6) throw new RangeError("footprint is degenerate");
  const order=points.map((_,i)=>i); if(area<0) order.reverse();
  const cr=(a,b,c)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
  const inside=(p,a,b,c)=>{const x=cr(a,b,p),y=cr(b,c,p),z=cr(c,a,p);return x>=-1e-8&&y>=-1e-8&&z>=-1e-8;};
  const triangles=[]; let guard=0;
  while(order.length>3 && guard++<points.length*points.length) {
    let found=false;
    for(let i=0;i<order.length;i++) {
      const a=order[(i+order.length-1)%order.length], b=order[i], c=order[(i+1)%order.length];
      if(cr(points[a],points[b],points[c])<=1e-8) continue;
      if(order.some(k=>k!==a&&k!==b&&k!==c&&inside(points[k],points[a],points[b],points[c]))) continue;
      triangles.push([a,b,c]); order.splice(i,1); found=true; break;
    }
    if(!found) throw new RangeError("footprint could not be triangulated; check self-intersections or duplicate vertices");
  }
  if(order.length===3) triangles.push(order.slice()); return triangles;
}
function encodeGlb(spec, geo, facadeOrientation, structuralOpenings) {
  const active=MATERIALS.filter(name=>geo.groups.get(name).indices.length), indexOf=new Map(active.map((name,i)=>[name,i]));
  const materials=active.map(name=>({name:name==="wall"?"Facade":name[0].toUpperCase()+name.slice(1),pbrMetallicRoughness:{baseColorFactor:rgba(({wall:spec.architecture.wallColor,roof:spec.architecture.roofColor,glass:spec.architecture.glassColor,frame:spec.architecture.frameColor,concrete:spec.architecture.concreteColor,door:spec.architecture.doorColor,metal:"#4B5563"})[name]),metallicFactor:name==="metal"?0.65:0,roughnessFactor:name==="glass"?0.24:0.78}}));
  const bins=[], views=[], accessors=[], meshes=[], nodes=[]; let offset=0;
  function view(buffer,target){const pad=(4-offset%4)%4;if(pad){bins.push(Buffer.alloc(pad));offset+=pad;}const v={buffer:0,byteOffset:offset,byteLength:buffer.length};if(target)v.target=target;views.push(v);bins.push(buffer);offset+=buffer.length;return views.length-1;}
  function pack(values,type){const size=type==="uint16"?2:4,b=Buffer.alloc(values.length*size);values.forEach((v,i)=>{if(type==="float32")b.writeFloatLE(v,i*4);else if(type==="uint16")b.writeUInt16LE(v,i*2);else b.writeUInt32LE(v,i*4);});return b;}
  function accessor(bufferView,componentType,count,type,extra={}){accessors.push({bufferView,byteOffset:0,componentType,count,type,...extra});return accessors.length-1;}
  for(const name of active){
    const g=geo.groups.get(name), min=[Infinity,Infinity,Infinity], max=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<g.positions.length;i+=3)for(let a=0;a<3;a++){min[a]=Math.min(min[a],g.positions[i+a]);max[a]=Math.max(max[a],g.positions[i+a]);}
    const pi=view(pack(g.positions,"float32"),34962), ni=view(pack(g.normals,"float32"),34962);
    const small=g.positions.length/3<=65535, ivals=g.indices;let lo=Infinity,hi=-Infinity;for(const i of ivals){lo=Math.min(lo,i);hi=Math.max(hi,i);}
    const ii=view(pack(ivals,small?"uint16":"uint32"),34963);
    const pa=accessor(pi,5126,g.positions.length/3,"VEC3",{min,max}),na=accessor(ni,5126,g.normals.length/3,"VEC3"),ia=accessor(ii,small?5123:5125,ivals.length,"SCALAR",{min:[lo],max:[hi]});
    meshes.push({name:spec.id+"-"+name,primitives:[{attributes:{POSITION:pa,NORMAL:na},indices:ia,material:indexOf.get(name),mode:4}]});nodes.push({name:spec.name+" - "+name,mesh:meshes.length-1});
  }
  const binary=Buffer.concat(bins), gltf={asset:{version:"2.0",generator:"Dhaka Building Generation Engine / procedural-glb v1",extras:{buildingId:spec.id,schemaVersion:spec.schemaVersion}},scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,meshes,materials,accessors,bufferViews:views,buffers:[{byteLength:binary.length}],extras:{building:{id:spec.id,name:spec.name,footprintAreaM2:spec.footprint.areaM2,floors:spec.dimensions.floorCount,roofType:spec.architecture.roofType,facadeOrientation,structuralOpenings}}};
  const jb=Buffer.from(JSON.stringify(gltf)), jp=(4-jb.length%4)%4, bp=(4-binary.length%4)%4;
  const json=Buffer.concat([jb,Buffer.alloc(jp,0x20)]), bin=bp?Buffer.concat([binary,Buffer.alloc(bp)]):binary, total=12+8+json.length+8+bin.length;
  const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(total,8);
  const jh=Buffer.alloc(8);jh.writeUInt32LE(json.length,0);jh.writeUInt32LE(0x4e4f534a,4);
  const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,jh,json,bh,bin]);
}
export function generateProceduralGlb(rawSpec) {
  const {spec,derived}=normalizeBuildingSpec(rawSpec), warnings=[];
  if(spec.architecture.roofType==="pitched")warnings.push("Pitched roofs are not implemented; a flat roof cap is emitted.");
  if(spec.sources.some(s=>["image","video","video-frame"].includes(s.kind)))warnings.push("Image/video visual analysis is not run; media are preserved as provenance and cannot silently change geometry.");
  if(spec.sources.some(s=>!s.licence||s.usageStatus!=="approved"))warnings.push("At least one source has unconfirmed reuse rights or review status; verify licence/attribution before publishing.");
  const geo=geometryBuilder(), points=derived.localFootprint, floorCount=spec.dimensions.floorCount, floorH=spec.dimensions.floorHeightM, height=floorCount*floorH, wt=spec.dimensions.wallThicknessM;
  const footprintSignedArea=points.reduce((sum,p,i)=>{
    const next=points[(i+1)%points.length];
    return sum+p.x*next.z-next.x*p.z;
  },0)/2;
  const outwardSign=footprintSignedArea>=0?1:-1;
  const edges=points.map((point,index)=>{
    const next=points[(index+1)%points.length];
    return {p:point,n:next,...createFacadeFrame(point,next,outwardSign)};
  });
  const selectedFacade=selectFrontFacadeEdge(edges,{
    frontFacadeEdgeIndex:spec.architecture.frontFacadeEdgeIndex,
    frontFacingAzimuthDegrees:spec.architecture.frontFacingAzimuthDegrees
  });
  const front=selectedFacade.edgeIndex;
  warnings.push(...selectedFacade.warnings);
  const selectorEvidenceField=selectedFacade.method==="explicit-edge-index"
    ?"frontFacadeEdgeIndex"
    :selectedFacade.method==="azimuth-nearest-edge"
      ?"frontFacingAzimuthDegrees"
      :null;
  const selectorEvidenceValue=selectorEvidenceField==="frontFacadeEdgeIndex"
    ?spec.architecture.frontFacadeEdgeIndex
    :selectorEvidenceField==="frontFacingAzimuthDegrees"
      ?spec.architecture.frontFacingAzimuthDegrees
      :null;
  const selectorEvidence=selectorEvidenceField===null
    ?[]
    :spec.evidence.filter(item=>item.field===selectorEvidenceField);
  const selectorEvidenceConflict=selectorEvidence.some(item=>JSON.stringify(item.value)!==JSON.stringify(selectorEvidenceValue));
  const frontAxisConfidence=selectorEvidenceConflict
    ?"unknown"
    :selectorEvidence[0]?.confidence??selectedFacade.confidence;
  if(selectorEvidenceConflict){
    warnings.push("Front facade selector conflicts with its attached evidence; independent review is required.");
  }
  const frontAxisNeedsReview=frontAxisConfidence!=="verified";
  const structuralOpeningRecords = [];
  let wallPanelCount = 0;
  let totalWallFaceAreaM2 = 0;
  let totalOpeningAreaM2 = 0;
  for (let floor = 0; floor < floorCount; floor += 1) {
    for (let ei = 0; ei < edges.length; ei += 1) {
      const e = edges[ei];
      const openings = [];
      const w = spec.architecture.windows;
      const doorOnPanel = floor === 0 && ei === front && spec.architecture.includeDoor && e.len >= 2.5;
      if (w.enabled && e.len >= 2.7) {
        const bays = Math.max(1, Math.min(12, Math.floor(e.len / 3.2)));
        const widthM = Math.min(w.widthM, e.len / (bays + 1) * 0.68);
        const heightM = Math.min(w.heightM, floorH * 0.52);
        for (let bay = 0; bay < bays; bay += 1) {
          if (doorOnPanel && bay === Math.floor(bays / 2)) continue;
          const centerU = (bay + 1) / (bays + 1) * e.len;
          openings.push({
            id: "window-f" + (floor + 1) + "-e" + ei + "-b" + (bay + 1),
            kind: "window", shape: w.shape, centerU,
            bottomM: floorH * 0.56 - heightM / 2, widthM, heightM,
          });
        }
      }
      if (doorOnPanel) openings.push({
        id: "entrance-door", kind: "door", shape: spec.architecture.doorShape,
        centerU: e.len / 2, bottomM: 0,
        widthM: Math.min(1.05, e.len * 0.25), heightM: Math.min(2.16, floorH - 0.08),
      });
      const wall = addWallPanelWithOpenings(geo, {
        edge: e, baseY: floor * floorH, heightM: floorH, wallThicknessM: wt, openings,
      });
      wallPanelCount += 1;
      totalWallFaceAreaM2 += wall.wallFaceAreaM2;
      for (const opening of wall.openings) {
        structuralOpeningRecords.push({
          ...opening, edgeIndex: ei, floorIndex: floor,
          absoluteBottomM: Number((floor * floorH + opening.bottomM).toFixed(3)),
          confidence: "procedural-layout", sourceEvidenceIds: [], reviewRequired: true,
        });
        totalOpeningAreaM2 += opening.profileAreaM2;
        const edgePoint = { x: e.p.x + e.tangent.x * opening.centerU, z: e.p.z + e.tangent.z * opening.centerU };
        const baseY = floor * floorH;
        const paneDepth = 0.055, frameDepth = 0.075, faceClearanceM = 0.002;
        const paneCenterOffset = surfaceInsertCenterOffset(paneDepth, faceClearanceM);
        const frameCenterOffset = surfaceInsertCenterOffset(frameDepth, faceClearanceM);
        const paneFrontDepth = paneDepth + faceClearanceM;
        const frameFrontDepth = frameDepth + faceClearanceM;
        const centerY = baseY + opening.bottomM + opening.heightM / 2;
        if (opening.shape === "arched") {
          const profile = createFacadeOpeningProfile(opening);
          if (opening.kind === "window") {
            addExtrudedFacadeProfile(geo,{edge:e,baseY,profile,frontDepth:paneFrontDepth,depthM:paneDepth,material:"glass"});
          } else {
            const archRise = Math.min(opening.widthM / 2, opening.heightM * 0.55);
            const leafHeight = Math.max(0.25, opening.heightM - archRise);
            const doorCenter = offsetFacadePoint(edgePoint,e,0,surfaceInsertCenterOffset(0.07,faceClearanceM));
            geo.box("door",doorCenter.x,baseY+opening.bottomM+leafHeight/2,doorCenter.z,opening.widthM*0.96,leafHeight*0.96,0.07,e.yaw);
          }
          const frameBottom = Math.max(0,opening.bottomM-0.05);
          const frameHeight = Math.min(floorH-frameBottom-0.02,opening.heightM+0.1);
          const frameWidth = opening.widthM+(opening.kind==="door"?0.14:0.11);
          if(frameHeight>opening.heightM&&frameWidth>opening.widthM){
            const outerProfile=createFacadeOpeningProfile({...opening,bottomM:frameBottom,widthM:frameWidth,heightM:frameHeight});
            addExtrudedFacadeProfile(geo,{edge:e,baseY,profile:outerProfile,holes:[profile],frontDepth:frameFrontDepth,depthM:frameDepth,material:"frame"});
          } else warnings.push("An arched opening frame could not maintain its required surround clearance; human review is required.");
        } else if (opening.kind === "window") {
          const paneCenter=offsetFacadePoint(edgePoint,e,0,paneCenterOffset);
          const frameCenter=offsetFacadePoint(edgePoint,e,0,frameCenterOffset);
          const jamb=0.055;
          geo.box("glass",paneCenter.x,centerY,paneCenter.z,opening.widthM,opening.heightM,paneDepth,e.yaw);
          geo.box("frame",frameCenter.x,centerY+opening.heightM/2,frameCenter.z,opening.widthM+jamb,jamb,frameDepth,e.yaw);
          geo.box("frame",frameCenter.x,centerY-opening.heightM/2,frameCenter.z,opening.widthM+jamb,jamb,frameDepth,e.yaw);
          const left=offsetFacadePoint(edgePoint,e,-opening.widthM/2,frameCenterOffset);
          const right=offsetFacadePoint(edgePoint,e,opening.widthM/2,frameCenterOffset);
          geo.box("frame",left.x,centerY,left.z,jamb,opening.heightM,frameDepth,e.yaw);
          geo.box("frame",right.x,centerY,right.z,jamb,opening.heightM,frameDepth,e.yaw);
        } else {
          const doorCenter=offsetFacadePoint(edgePoint,e,0,surfaceInsertCenterOffset(0.07,faceClearanceM));
          const frameCenter=offsetFacadePoint(edgePoint,e,0,frameCenterOffset);
          geo.box("door",doorCenter.x,centerY,doorCenter.z,opening.widthM,opening.heightM,0.07,e.yaw);
          geo.box("frame",frameCenter.x,baseY+opening.bottomM+opening.heightM+0.04,frameCenter.z,opening.widthM+0.14,0.08,0.09,e.yaw);
          const left=offsetFacadePoint(edgePoint,e,-(opening.widthM/2+0.035),frameCenterOffset);
          const right=offsetFacadePoint(edgePoint,e,opening.widthM/2+0.035,frameCenterOffset);
          geo.box("frame",left.x,centerY,left.z,0.07,opening.heightM,0.09,e.yaw);
          geo.box("frame",right.x,centerY,right.z,0.07,opening.heightM,0.09,e.yaw);
        }
      }
    }
  }
  const structuralOpenings = {
    schemaVersion:"1.0.0", engine:"facade-wall-openings-v1",
    method:"scanline-triangulated-through-wall", wallPanelCount,
    openingCount:structuralOpeningRecords.length,
    wallFaceAreaM2:Number(totalWallFaceAreaM2.toFixed(3)),
    openingAreaM2:Number(totalOpeningAreaM2.toFixed(3)),
    confidence:"procedural-layout", reviewRequired:structuralOpeningRecords.length>0,
    openings:structuralOpeningRecords,
  };
  if(structuralOpeningRecords.length>0) warnings.push("Door and window openings are structural through-wall apertures, but their dimensions and locations are procedural and require independent architectural review.");
  if(spec.architecture.balcony.enabled&&floorCount>1){const e=edges[front],b=spec.architecture.balcony,bays=Math.max(1,Math.min(6,Math.floor(e.len/Math.max(2.4,b.widthM+0.7)))),bw=Math.min(b.widthM,e.len/(bays+0.35));
    for(let floor=1;floor<floorCount;floor+=b.everyFloors)for(let bay=0;bay<bays;bay++){const t=(bay+1)/(bays+1),x=e.p.x+(e.n.x-e.p.x)*t+e.out.x*b.depthM*0.45,z=e.p.z+(e.n.z-e.p.z)*t+e.out.z*b.depthM*0.45,y=floor*floorH+0.06,rx=x+e.out.x*b.depthM*0.85,rz=z+e.out.z*b.depthM*0.85;
      geo.box("concrete",x,y,z,bw,0.12,b.depthM,e.yaw);geo.box("metal",rx,y+0.48,rz,bw,0.08,0.06,e.yaw);geo.box("metal",rx,y+0.24,rz,bw,0.04,0.045,e.yaw);
      for(let r=0;r<=4;r++){const offset=-bw/2+bw*r/4,px=rx+Math.cos(e.yaw)*offset,pz=rz-Math.sin(e.yaw)*offset;geo.box("metal",px,y+0.28,pz,0.035,0.48,0.04);}
    }
  }
  for(const [a,b,c] of triangulate(points)){const at=i=>[points[i].x,height,points[i].z];geo.triangle("roof",at(a),at(c),at(b),[0,1,0]);}
  if(spec.dimensions.parapetHeightM>0)for(const e of edges){geo.box("concrete",(e.p.x+e.n.x)/2-e.out.x*wt/2,height+spec.dimensions.parapetHeightM/2,(e.p.z+e.n.z)/2-e.out.z*wt/2,e.len+wt*0.3,spec.dimensions.parapetHeightM,wt,e.yaw);}
  if(spec.architecture.roofType==="terrace"){const b=spec.footprint.bounds,w=b.maxX-b.minX,d=b.maxZ-b.minZ;if(w>2.5&&d>2.5)geo.box("concrete",(b.minX+b.maxX)/2,height+0.025,(b.minZ+b.maxZ)/2,Math.min(w*0.55,4.2),0.05,Math.min(d*0.35,2.8));}

  // Optional architectural massing features: retained in the normalized BuildingSpec
  // and generated deterministically so specialist buildings need not be reduced to a box.
  const dome=spec.architecture.centralDome;
  let domePlacement=null;
  if(dome.enabled){
    const e=edges[front],midX=(e.p.x+e.n.x)/2,midZ=(e.p.z+e.n.z)/2;
    const domeCenter=dome.anchor==="footprint-bounds-center"
      ? {x:(spec.footprint.bounds.minX+spec.footprint.bounds.maxX)/2,z:(spec.footprint.bounds.minZ+spec.footprint.bounds.maxZ)/2}
      : {x:midX-e.out.x*dome.insetFromFrontM,z:midZ-e.out.z*dome.insetFromFrontM};
    const cx=domeCenter.x,cz=domeCenter.z;
    domePlacement={
      anchor:dome.anchor,
      centerModelXZ:{x:Number(cx.toFixed(3)),z:Number(cz.toFixed(3))},
      confidence:"estimated",
      source:"buildingSpec.architecture.centralDome.anchor",
      reviewRequired:true
    };
    warnings.push("Central dome placement is a procedural anchor ("+dome.anchor+"); verify its position against independent architectural evidence.");
    const baseY=height+spec.dimensions.parapetHeightM;
    geo.cylinder("concrete",cx,baseY,cz,dome.radiusM*0.88,dome.drumHeightM,24);
    const domeY=baseY+dome.drumHeightM,segments=32,steps=12;
    for(let ring=0;ring<steps;ring++){
      const t0=ring/steps*Math.PI/2,t1=(ring+1)/steps*Math.PI/2;
      const r0=dome.radiusM*Math.cos(t0),r1=dome.radiusM*Math.cos(t1);
      const y0=domeY+dome.riseM*Math.sin(t0),y1=domeY+dome.riseM*Math.sin(t1);
      for(let segment=0;segment<segments;segment++){
        const a0=segment/segments*Math.PI*2,a1=(segment+1)/segments*Math.PI*2,am=(a0+a1)/2,tm=(t0+t1)/2;
        const p=(radius,y,angle)=>[cx+radius*Math.cos(angle),y,cz+radius*Math.sin(angle)];
        const p00=p(r0,y0,a0),p10=p(r0,y0,a1),p11=p(r1,y1,a1),p01=p(r1,y1,a0);
        const outward=[Math.cos(am)*Math.sin(tm),Math.cos(tm),Math.sin(am)*Math.sin(tm)];
        if (ring === steps - 1) {
          // The final ring meets at a single dome apex. Use one triangle per sector
          // rather than a quad with duplicate apex vertices (degenerate triangles).
          const apex=[cx,domeY+dome.riseM,cz];
          geo.triangle("roof",p00,p10,apex,outward);
        } else {
          geo.quad("roof",p00,p10,p11,p01,outward);
        }
      }
    }
    // Narrow clerestory-like panels around the drum create a readable transition into the dome.
    for(let segment=0;segment<12;segment++){
      const angle=segment/12*Math.PI*2;
      const radius=dome.radiusM*0.88+0.045;
      const x=cx+radius*Math.cos(angle),z=cz+radius*Math.sin(angle);
      geo.box("glass",x,baseY+dome.drumHeightM*0.52,z,0.22,Math.min(0.72,dome.drumHeightM*0.55),0.06,angle+Math.PI/2);
    }
  }

  const arcade=spec.architecture.frontArcade;
  if(arcade.enabled){
    const e=edges[front],ux=(e.n.x-e.p.x)/e.len,uz=(e.n.z-e.p.z)/e.len;
    const span=e.len*arcade.spanRatio,bay=span/arcade.bayCount,start=(e.len-span)/2;
    const arcadeHeight=Math.min(arcade.heightM,height-0.25);
    const outerRadius=Math.max(arcade.columnWidthM*1.6,(bay-arcade.columnWidthM)/2);
    const innerRadius=Math.max(0.35,outerRadius-arcade.archThicknessM);
    const springY=arcadeHeight-outerRadius;
    if(springY>0.5){
      const wallOffset=wt/2+0.08,columnOffset=wt/2+arcade.projectionM;
      const archOffset=columnOffset+arcade.columnDepthM/2+0.025;
      const point=(u,y,offset)=>[e.p.x+ux*u+e.out.x*offset,y,e.p.z+uz*u+e.out.z*offset];
      // Dark infill is intentionally placed over the uncut procedural wall to approximate
      // recessed arched openings without implying a structural BIM-level opening.
      for(let bayIndex=0;bayIndex<arcade.bayCount;bayIndex++){
        const centerU=start+(bayIndex+0.5)*bay,basePoint=point(centerU,springY/2,wallOffset);
        geo.box("glass",basePoint[0],basePoint[1],basePoint[2],Math.max(0.5,bay-arcade.columnWidthM*1.05),springY,0.08,e.yaw);
        const center=point(centerU,springY,wallOffset+0.045);
        const openingRadius=Math.max(0.3,innerRadius-0.08);
        for(let segment=0;segment<16;segment++){
          const a0=segment/16*Math.PI,a1=(segment+1)/16*Math.PI;
          const p0=point(centerU+openingRadius*Math.cos(a0),springY+openingRadius*Math.sin(a0),wallOffset+0.045);
          const p1=point(centerU+openingRadius*Math.cos(a1),springY+openingRadius*Math.sin(a1),wallOffset+0.045);
          geo.triangle("glass",center,p0,p1,[e.out.x,0,e.out.z]);
        }
        for(let segment=0;segment<16;segment++){
          const a0=segment/16*Math.PI,a1=(segment+1)/16*Math.PI;
          const outer0=point(centerU+outerRadius*Math.cos(a0),springY+outerRadius*Math.sin(a0),archOffset);
          const outer1=point(centerU+outerRadius*Math.cos(a1),springY+outerRadius*Math.sin(a1),archOffset);
          const inner1=point(centerU+innerRadius*Math.cos(a1),springY+innerRadius*Math.sin(a1),archOffset);
          const inner0=point(centerU+innerRadius*Math.cos(a0),springY+innerRadius*Math.sin(a0),archOffset);
          geo.quad("frame",outer0,outer1,inner1,inner0,[e.out.x,0,e.out.z]);
        }
      }
      for(let column=0;column<=arcade.bayCount;column++){
        const u=start+column*bay,p=point(u,arcadeHeight/2,columnOffset);
        geo.box("concrete",p[0],p[1],p[2],arcade.columnWidthM,arcadeHeight,arcade.columnDepthM,e.yaw);
        const base=point(u,0.2,columnOffset),capital=point(u,arcadeHeight-0.18,columnOffset);
        geo.box("concrete",base[0],base[1],base[2],arcade.columnWidthM*1.35,0.32,arcade.columnDepthM*1.35,e.yaw);
        geo.box("concrete",capital[0],capital[1],capital[2],arcade.columnWidthM*1.5,0.28,arcade.columnDepthM*1.45,e.yaw);
      }
      const cornice=point(start+span/2,arcadeHeight+0.15,columnOffset);
      geo.box("concrete",cornice[0],cornice[1],cornice[2],span+0.5,0.24,arcade.columnDepthM*1.4,e.yaw);
    }
  }
  const facadeOrientation = {
    schemaVersion:"1.0.0",
    coordinateFrame:"glTF-local:+X=east,+Y=up,+Z=north",
    selectionMethod:selectedFacade.method,
    edgeIndex:front,
    requestedAzimuthDegrees:selectedFacade.requestedAzimuthDegrees,
    actualAzimuthDegrees:selectedFacade.actualAzimuthDegrees,
    outwardNormal:{x:Number(edges[front].out.x.toFixed(6)),z:Number(edges[front].out.z.toFixed(6))},
    confidence:frontAxisConfidence,
    source:selectedFacade.source,
    reviewRequired:frontAxisNeedsReview||selectedFacade.reviewRequired
  };
  const glb=encodeGlb(spec,geo,facadeOrientation,structuralOpenings);
  return {glb,normalizedSpec:spec,report:{
    engine:"procedural-glb-v1",buildingId:spec.id,schemaVersion:spec.schemaVersion,strategy:spec.sources.some(s=>["image","video","video-frame"].includes(s.kind))?"reference-assisted-procedural":"procedural-from-spec",
    output:{format:"glb",bytes:glb.byteLength,heightM:Number((height+spec.dimensions.parapetHeightM).toFixed(2))},
    geometry:{footprintAreaM2:spec.footprint.areaM2,perimeterM:spec.footprint.perimeterM,floorCount,polygonVertices:points.length,meshMaterialGroups:activeMaterialsFor(geo)},
    facadeOrientation,
    structuralOpenings,
    facadeSelection:{
      method:selectedFacade.method,
      edgeIndex:front,
      confidence:frontAxisConfidence,
      requestedAzimuthDegrees:selectedFacade.requestedAzimuthDegrees,
      actualAzimuthDegrees:selectedFacade.actualAzimuthDegrees,
      source:selectedFacade.source,
      alignmentDot:selectedFacade.alignmentDot
    },
    architecturePlacement:{
      frontFacade:{
        edgeIndex:front,
        requestedAzimuthDegrees:selectedFacade.requestedAzimuthDegrees,
        actualAzimuthDegrees:selectedFacade.actualAzimuthDegrees,
        confidence:frontAxisConfidence,
        source:selectedFacade.source,
        outwardNormal:{x:Number(edges[front].out.x.toFixed(6)),z:Number(edges[front].out.z.toFixed(6))},
        insertFaceClearanceM:0.002
      },
      centralDome:domePlacement,
      structuralOpenings:{
        engine:structuralOpenings.engine,method:structuralOpenings.method,
        wallPanelCount:structuralOpenings.wallPanelCount,openingCount:structuralOpenings.openingCount,
        wallFaceAreaM2:structuralOpenings.wallFaceAreaM2,openingAreaM2:structuralOpenings.openingAreaM2,
        confidence:structuralOpenings.confidence,reviewRequired:structuralOpenings.reviewRequired
      }
    },
    georeference:{longitude:spec.location.longitude,latitude:spec.location.latitude,heightM:spec.location.heightM},
    evidence:spec.evidence.map(e=>({field:e.field,confidence:e.confidence,sourceIds:e.sourceIds})),
    sources:spec.sources.map(s=>({id:s.id,kind:s.kind, ...(s.url?{url:s.url}:{}),licence:s.licence||null,attribution:s.attribution||null,usageStatus:s.usageStatus})),
    confidenceSummary:Object.fromEntries(["verified","derived","estimated","ai-proposed","unknown"].map(level=>[level,spec.evidence.filter(e=>e.confidence===level).length])),
    reviewRequired:spec.evidence.some(e=>["estimated","ai-proposed","unknown"].includes(e.confidence))||
      spec.sources.some(s=>!s.licence||s.usageStatus!=="approved")||
      frontAxisNeedsReview||
      selectedFacade.reviewRequired||
      (domePlacement?.reviewRequired===true)||
      (structuralOpenings.reviewRequired===true),
    warnings,limitations:["This is a deterministic parametric mesh, not a photogrammetry or AI reconstruction.","Images and videos are recorded as provenance but are not automatically interpreted in this version.","Hidden elevations, interior rooms, exact structure and measured dimensions require additional evidence and/or a specialist reconstruction route.","Door/window apertures are geometrically cut through procedural wall panels; opening dimensions, spacing and architecture remain estimated until independently reviewed."]
  }};
}
function activeMaterialsFor(geo){return MATERIALS.filter(name=>geo.groups.get(name).indices.length>0);}