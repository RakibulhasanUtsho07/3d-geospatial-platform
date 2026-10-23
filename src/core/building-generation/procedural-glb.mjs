import { normalizeBuildingSpec } from "./building-spec.mjs";
import { createFacadeFrame, offsetFacadePoint, surfaceInsertCenterOffset } from "./facade-placement.mjs";
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
  return { groups, triangle, box };
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
function encodeGlb(spec, geo) {
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
  const binary=Buffer.concat(bins), gltf={asset:{version:"2.0",generator:"Dhaka Building Generation Engine / procedural-glb v1",extras:{buildingId:spec.id,schemaVersion:spec.schemaVersion}},scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,meshes,materials,accessors,bufferViews:views,buffers:[{byteLength:binary.length}],extras:{building:{id:spec.id,name:spec.name,footprintAreaM2:spec.footprint.areaM2,floors:spec.dimensions.floorCount,roofType:spec.architecture.roofType}}};
  const jb=Buffer.from(JSON.stringify(gltf)), jp=(4-jb.length%4)%4, bp=(4-binary.length%4)%4;
  const json=Buffer.concat([jb,Buffer.alloc(jp,0x20)]), bin=bp?Buffer.concat([binary,Buffer.alloc(bp)]):binary, total=12+8+json.length+8+bin.length;
  const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(total,8);
  const jh=Buffer.alloc(8);jh.writeUInt32LE(json.length,0);jh.writeUInt32LE(0x4e4f534a,4);
  const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,jh,json,bh,bin]);
}
export function generateProceduralGlb(rawSpec) {
  const {spec,derived}=normalizeBuildingSpec(rawSpec), warnings=[];
  if(spec.architecture.roofType==="pitched"){
    throw new TypeError("roofType 'pitched' is not supported by the procedural generator; use 'flat'/'terrace' or implement pitched roof geometry before requesting it.");
  }
  if(spec.architecture.frontFacadeEdgeIndex===undefined){
    warnings.push("Front facade was inferred from the longest footprint edge; set architecture.frontFacadeEdgeIndex to select the entrance facade explicitly.");
  }
  if(spec.sources.some(s=>["image","video","video-frame"].includes(s.kind)))warnings.push("Image/video visual analysis is not run; media are preserved as provenance and cannot silently change geometry.");
  if(spec.sources.some(s=>!s.licence||s.usageStatus!=="approved"))warnings.push("At least one source has unconfirmed reuse rights or review status; verify licence/attribution before publishing.");
  const geo=geometryBuilder(), points=derived.localFootprint, floorCount=spec.dimensions.floorCount, floorH=spec.dimensions.floorHeightM, height=floorCount*floorH, wt=spec.dimensions.wallThicknessM;
  const footprintSignedArea=points.reduce((sum,p,i)=>{
    const n=points[(i+1)%points.length];
    return sum+p.x*n.z-n.x*p.z;
  },0)/2;
  const outwardSign=footprintSignedArea>=0?1:-1;
  const edges=points.map((p,i)=>{const n=points[(i+1)%points.length];return {p,n,...createFacadeFrame(p,n,outwardSign)};});
  const front=spec.architecture.frontFacadeEdgeIndex===undefined
    ? edges.reduce((best,e,i,all)=>e.len>all[best].len?i:best,0)
    : spec.architecture.frontFacadeEdgeIndex;
  for(let floor=0;floor<floorCount;floor++)for(let ei=0;ei<edges.length;ei++){
    const e=edges[ei],cx=(e.p.x+e.n.x)/2-e.out.x*wt/2,cz=(e.p.z+e.n.z)/2-e.out.z*wt/2;
    geo.box("wall",cx,floor*floorH+floorH/2,cz,e.len+wt*0.35,floorH,wt,e.yaw);
    const w=spec.architecture.windows;if(!w.enabled||e.len<2.7)continue;
    const bays=Math.max(1,Math.min(12,Math.floor(e.len/3.2)));
    const ww=Math.min(w.widthM,e.len/(bays+1)*0.68),wh=Math.min(w.heightM,floorH*0.52);
    for(let bay=0;bay<bays;bay++){
      if(floor===0&&ei===front&&bay===Math.floor(bays/2))continue;
      const t=(bay+1)/(bays+1);
      const edgePoint={x:e.p.x+(e.n.x-e.p.x)*t,z:e.p.z+(e.n.z-e.p.z)*t};
      const y=floor*floorH+floorH*0.56;
      const f=0.055,paneDepth=0.055,frameDepth=0.075;
      const panePoint=offsetFacadePoint(edgePoint,e,0,surfaceInsertCenterOffset(paneDepth));
      const framePoint=offsetFacadePoint(edgePoint,e,0,surfaceInsertCenterOffset(frameDepth));
      const leftJamb=offsetFacadePoint(edgePoint,e,-ww/2,surfaceInsertCenterOffset(frameDepth));
      const rightJamb=offsetFacadePoint(edgePoint,e,ww/2,surfaceInsertCenterOffset(frameDepth));
      geo.box("glass",panePoint.x,y,panePoint.z,ww,wh,paneDepth,e.yaw);
      geo.box("frame",framePoint.x,y+wh/2,framePoint.z,ww+f,f,frameDepth,e.yaw);
      geo.box("frame",framePoint.x,y-wh/2,framePoint.z,ww+f,f,frameDepth,e.yaw);
      geo.box("frame",leftJamb.x,y,leftJamb.z,f,wh,frameDepth,e.yaw);
      geo.box("frame",rightJamb.x,y,rightJamb.z,f,wh,frameDepth,e.yaw);
    }
  }
  if(spec.architecture.includeDoor&&edges[front].len>=2.5){
    const e=edges[front],edgePoint={x:(e.p.x+e.n.x)/2,z:(e.p.z+e.n.z)/2},w=Math.min(1.05,e.len*0.25);
    const doorPoint=offsetFacadePoint(edgePoint,e,0,surfaceInsertCenterOffset(0.07));
    const doorFramePoint=offsetFacadePoint(edgePoint,e,0,surfaceInsertCenterOffset(0.09));
    const leftJamb=offsetFacadePoint(edgePoint,e,-(w/2+0.035),surfaceInsertCenterOffset(0.09));
    const rightJamb=offsetFacadePoint(edgePoint,e,w/2+0.035,surfaceInsertCenterOffset(0.09));
    geo.box("door",doorPoint.x,1.08,doorPoint.z,w,2.16,0.07,e.yaw);
    geo.box("frame",doorFramePoint.x,2.19,doorFramePoint.z,w+0.14,0.08,0.09,e.yaw);
    geo.box("frame",leftJamb.x,1.08,leftJamb.z,0.07,2.16,0.09,e.yaw);
    geo.box("frame",rightJamb.x,1.08,rightJamb.z,0.07,2.16,0.09,e.yaw);
  }
  if(spec.architecture.balcony.enabled&&floorCount>1){const e=edges[front],b=spec.architecture.balcony,bays=Math.max(1,Math.min(6,Math.floor(e.len/Math.max(2.4,b.widthM+0.7)))),bw=Math.min(b.widthM,e.len/(bays+0.35));
    for(let floor=1;floor<floorCount;floor+=b.everyFloors)for(let bay=0;bay<bays;bay++){const t=(bay+1)/(bays+1),x=e.p.x+(e.n.x-e.p.x)*t+e.out.x*b.depthM*0.45,z=e.p.z+(e.n.z-e.p.z)*t+e.out.z*b.depthM*0.45,y=floor*floorH+0.06,rx=x+e.out.x*b.depthM*0.85,rz=z+e.out.z*b.depthM*0.85;
      geo.box("concrete",x,y,z,bw,0.12,b.depthM,e.yaw);geo.box("metal",rx,y+0.48,rz,bw,0.08,0.06,e.yaw);geo.box("metal",rx,y+0.24,rz,bw,0.04,0.045,e.yaw);
      for(let r=0;r<=4;r++){const offset=-bw/2+bw*r/4,px=rx+Math.cos(e.yaw)*offset,pz=rz-Math.sin(e.yaw)*offset;geo.box("metal",px,y+0.28,pz,0.035,0.48,0.04);}
    }
  }
  for(const [a,b,c] of triangulate(points)){const at=i=>[points[i].x,height,points[i].z];geo.triangle("roof",at(a),at(c),at(b),[0,1,0]);}
  if(spec.dimensions.parapetHeightM>0)for(const e of edges){geo.box("concrete",(e.p.x+e.n.x)/2-e.out.x*wt/2,height+spec.dimensions.parapetHeightM/2,(e.p.z+e.n.z)/2-e.out.z*wt/2,e.len+wt*0.3,spec.dimensions.parapetHeightM,wt,e.yaw);}
  if(spec.architecture.roofType==="terrace"){const b=spec.footprint.bounds,w=b.maxX-b.minX,d=b.maxZ-b.minZ;if(w>2.5&&d>2.5)geo.box("concrete",(b.minX+b.maxX)/2,height+0.025,(b.minZ+b.maxZ)/2,Math.min(w*0.55,4.2),0.05,Math.min(d*0.35,2.8));}
  const glb=encodeGlb(spec,geo);
  return {glb,normalizedSpec:spec,report:{
    engine:"procedural-glb-v1",buildingId:spec.id,schemaVersion:spec.schemaVersion,strategy:spec.sources.some(s=>["image","video","video-frame"].includes(s.kind))?"reference-assisted-procedural":"procedural-from-spec",
    output:{format:"glb",bytes:glb.byteLength,heightM:Number((height+spec.dimensions.parapetHeightM).toFixed(2))},
    geometry:{footprintAreaM2:spec.footprint.areaM2,perimeterM:spec.footprint.perimeterM,floorCount,polygonVertices:points.length,meshMaterialGroups:activeMaterialsFor(geo)},
    facadeSelection:{
      method:spec.architecture.frontFacadeEdgeIndex===undefined?"longest-edge-inferred":"explicit-edge-index",
      edgeIndex:front,
      confidence:spec.architecture.frontFacadeEdgeIndex===undefined?"estimated":"operator-specified",
    },
    georeference:{longitude:spec.location.longitude,latitude:spec.location.latitude,heightM:spec.location.heightM},
    evidence:spec.evidence.map(e=>({field:e.field,confidence:e.confidence,sourceIds:e.sourceIds})),
    sources:spec.sources.map(s=>({id:s.id,kind:s.kind, ...(s.url?{url:s.url}:{}),licence:s.licence||null,attribution:s.attribution||null,usageStatus:s.usageStatus})),
    confidenceSummary:Object.fromEntries(["verified","derived","estimated","ai-proposed","unknown"].map(level=>[level,spec.evidence.filter(e=>e.confidence===level).length])),
    reviewRequired:spec.evidence.some(e=>["estimated","ai-proposed","unknown"].includes(e.confidence))||
      spec.sources.some(s=>!s.licence||s.usageStatus!=="approved")||
      spec.architecture.frontFacadeEdgeIndex===undefined,
    warnings,limitations:["This is a deterministic parametric mesh, not a photogrammetry or AI reconstruction.","Images and videos are recorded as provenance but are not automatically interpreted in this version.","Hidden elevations, interior rooms, exact structure and measured dimensions require additional evidence and/or a specialist reconstruction route."]
  }};
}
function activeMaterialsFor(geo){return MATERIALS.filter(name=>geo.groups.get(name).indices.length>0);}