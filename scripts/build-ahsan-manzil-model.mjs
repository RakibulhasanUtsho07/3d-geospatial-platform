import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "data/heritage/ahsan-manzil.parameters.json");
const OUT = path.join(ROOT, "public", "models");
const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const P = config.parameters;
const V = (section, key) => P[section][key].value;
const DIM = {
  length: V("footprint", "overallLength"),
  depth: V("footprint", "overallDepth"),
  rangmahalLength: V("footprint", "rangmahalBlockLength"),
  ground: V("vertical", "naturalGround"),
  plinth: V("vertical", "plinthHeight"),
  gf: V("vertical", "groundFloorClearHeight"),
  ff: V("vertical", "firstFloorClearHeight"),
  slab: V("vertical", "slabThickness"),
  wall: V("vertical", "wallThickness"),
  parapet: V("vertical", "parapetHeight"),
  roofline: V("vertical", "rooflineHeight"),
  windowGF: V("facade", "gfOpeningWidth"),
  crownGF: V("facade", "gfOpeningCrownHeight"),
  windowFF: V("facade", "ffOpeningWidth"),
  crownFF: V("facade", "ffOpeningCrownHeight"),
  verandaSpan: V("facade", "verandaArchSpan"),
  porticoWidth: V("facade", "porticoWidth"),
  porticoDepth: V("facade", "porticoDepth"),
  balustradeHeight: V("facade", "balustradeHeight"),
  balusterSpacing: V("facade", "balusterSpacing"),
  pinnacleHeight: V("facade", "rooflinePinnacleHeight"),
  pedimentPeak: V("facade", "pedimentPeakHeightAboveGround"),
  doorBayInterval: V("facade", "doorBayInterval"),
  stoneInlayBandWidth: V("facade", "stoneInlayBandWidth"),
  stairRun: V("stair", "runLength"),
  stairWidth: V("stair", "width"),
  stairRiser: V("stair", "riserHeight"),
  stairTread: V("stair", "treadDepth"),
  stepCount: V("stair", "stepCount"),
  peak: V("dome", "peakHeight"),
  drumHeight: V("dome", "drumHeight"),
  finialHeight: V("dome", "finialHeight"),
  drumWidth: V("dome", "drumWidth"),
  drumOpeningCount: V("dome", "drumOpeningCount"),
  drumOpeningWidth: V("dome", "drumOpeningWidth"),
  drumOpeningHeight: V("dome", "drumOpeningCrownHeight"),
  domeRings: V("dome", "profileRings"),
};
const COLORS = {
  pink: V("materials", "facadePink"),
  trim: V("materials", "trimOffWhite"),
  glass: V("materials", "glass"),
  roof: V("materials", "roof"),
  marble: V("materials", "verandaFloor"),
  rail: "#6D444A",
  gold: "#B58B55",
};
const REQUIRED_NODES = config.requiredNodeNames;

function color(key) {
  const hex = COLORS[key] || key;
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)).concat(255);
}
const sub = (a, b) => a.map((value, index) => value - b[index]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

function buildGlb(lod) {
  const nodes = REQUIRED_NODES.map((name) => ({ name, positions: [], normals: [], colors: [] }));
  const byName = Object.fromEntries(nodes.map((node) => [node.name, node]));
  function triangle(node, a, b, c, key) {
    const normal = normalize(cross(sub(b, a), sub(c, a)));
    const rgba = color(key);
    for (const point of [a, b, c]) {
      node.positions.push(...point);
      node.normals.push(...normal);
      node.colors.push(...rgba);
    }
  }
  function quad(node, a, b, c, d, key) {
    triangle(node, a, b, c, key);
    triangle(node, a, c, d, key);
  }
  function box(node, cx, cy, cz, dx, dy, dz, key) {
    if (dx <= 0 || dy <= 0 || dz <= 0) return;
    const x0 = cx - dx / 2, x1 = cx + dx / 2;
    const y0 = cy - dy / 2, y1 = cy + dy / 2;
    const z0 = cz - dz / 2, z1 = cz + dz / 2;
    const a = [x0,y0,z0], b = [x1,y0,z0], c = [x1,y1,z0], d = [x0,y1,z0];
    const e = [x0,y0,z1], f = [x1,y0,z1], g = [x1,y1,z1], h = [x0,y1,z1];
    quad(node,e,f,g,h,key); quad(node,b,a,d,c,key); quad(node,a,e,h,d,key);
    quad(node,f,b,c,g,key); quad(node,d,h,g,c,key); quad(node,a,b,f,e,key);
  }
  function orientedBoxXZ(node, cx, cy, cz, length, height, depth, angle, key) {
    const tx = -Math.sin(angle), tz = Math.cos(angle);
    const nx = Math.cos(angle), nz = Math.sin(angle);
    const point = (u, y, v) => [cx + tx * u + nx * v, y, cz + tz * u + nz * v];
    const l = length / 2, h = height / 2, d = depth / 2;
    const a = point(-l,cy-h,-d), b = point(l,cy-h,-d);
    const c = point(l,cy+h,-d), dd = point(-l,cy+h,-d);
    const e = point(-l,cy-h,d), f = point(l,cy-h,d);
    const g = point(l,cy+h,d), hh = point(-l,cy+h,d);
    quad(node,e,f,g,hh,key); quad(node,b,a,dd,c,key); quad(node,a,e,hh,dd,key);
    quad(node,f,b,c,g,key); quad(node,dd,hh,g,c,key); quad(node,a,b,f,e,key);
  }
  function verticalCylinder(node, cx, y0, y1, cz, radius, key, segments = 12) {
    const lower = [], upper = [];
    for (let i=0;i<segments;i++) {
      const angle = 2 * Math.PI * i / segments;
      lower.push([cx+radius*Math.cos(angle),y0,cz+radius*Math.sin(angle)]);
      upper.push([cx+radius*Math.cos(angle),y1,cz+radius*Math.sin(angle)]);
    }
    for (let i=0;i<segments;i++) {
      const next=(i+1)%segments;
      quad(node,lower[i],lower[next],upper[next],upper[i],key);
      triangle(node,[cx,y0,cz],lower[next],lower[i],key);
      triangle(node,[cx,y1,cz],upper[i],upper[next],key);
    }
  }
  function archBand(node, cx, spring, z, radius, thickness, key, segments=12) {
    for (let i=0;i<segments;i++) {
      const a = Math.PI*i/segments, b = Math.PI*(i+1)/segments;
      const point = (r,t) => [cx+r*Math.cos(t),spring+r*Math.sin(t),z];
      quad(node,point(radius+thickness,a),point(radius+thickness,b),point(radius,b),point(radius,a),key);
    }
  }
  function facetedArchBand(node, cx, cz, angle, spring, radius, thickness, key, segments=12) {
    const tx=-Math.sin(angle),tz=Math.cos(angle),nx=Math.cos(angle),nz=Math.sin(angle);
    for(let i=0;i<segments;i++){
      const a=Math.PI*i/segments,b=Math.PI*(i+1)/segments;
      const point=(r,t)=>[cx+tx*r*Math.cos(t)+nx*.04, spring+r*Math.sin(t), cz+tz*r*Math.cos(t)+nz*.04];
      const p0=point(radius+thickness,a),p1=point(radius+thickness,b),p2=point(radius,b),p3=point(radius,a);
      quad(node,p0,p1,p2,p3,key);
    }
  }
  function fillFacadeArch(node, cx, base, surfaceZ, side, width, height, wallThickness, detail, isDoor = false) {
    const radius=width/2,stem=height-radius,spring=base+stem;
    const glassZ=surfaceZ-side*(wallThickness-.09);
    box(node,cx,base+stem/2,glassZ,width,stem,.05,"glass");
    let previous=[cx+radius,spring,glassZ];
    for(let i=1;i<=12;i++){
      const angle=Math.PI*i/12, current=[cx+radius*Math.cos(angle),spring+radius*Math.sin(angle),glassZ];
      triangle(node,[cx,spring,glassZ],previous,current,"glass"); previous=current;
    }
    // Recess reveals; they make the [V/E] wall thickness visible around the pane.
    for(const x of [cx-radius,cx+radius]){
      quad(node,[x,base,surfaceZ],[x,base,glassZ],[x,spring,glassZ],[x,spring,surfaceZ],"pink");
    }
    let lastOuter=[cx+radius,spring,surfaceZ],lastInner=[cx+radius,spring,glassZ];
    for(let i=1;i<=12;i++){
      const angle=Math.PI*i/12;
      const outer=[cx+radius*Math.cos(angle),spring+radius*Math.sin(angle),surfaceZ];
      const inner=[outer[0],outer[1],glassZ];
      quad(node,lastOuter,outer,inner,lastInner,"pink");
      lastOuter=outer;lastInner=inner;
    }
    if(detail>=1){
      const trimZ=surfaceZ+side*.035;
      box(node,cx,base+.06,trimZ,width+.18,.12,.12,"trim");
      box(node,cx-radius-.05,base+stem/2,trimZ,.1,stem,.12,"trim");
      box(node,cx+radius+.05,base+stem/2,trimZ,.1,stem,.12,"trim");
      archBand(node,cx,spring,trimZ,radius+.02,.085,"trim",detail===2?16:10);
    }
    if (isDoor && detail === 2) {
      // Muted stained-glass panels are a visual approximation only; the exact
      // historic colours/pattern remain unverified. Keep them on the recessed
      // glazing plane rather than floating out on the exterior stone face.
      const paneWidth = width / 3 - 0.055;
      const paneHeight = Math.max(0.35, stem * 0.84);
      const paneY = base + stem / 2;
      const paneZ = glassZ + side * 0.045;
      const paneColors = ["#713F54", "#B78350", "#536C62"];
      for (let pane = 0; pane < 3; pane++) {
        box(
          node,
          cx + (pane - 1) * width / 3,
          paneY,
          paneZ,
          paneWidth,
          paneHeight,
          0.05,
          paneColors[pane],
        );
      }
    }
    if(detail===2){
      // Window muntins sit just proud of the actual glazing, inside the reveal.
      const mullionZ=glassZ+side*.09;
      box(node,cx,base+stem*.52,mullionZ,.045,stem*.88,.04,"trim");
      box(node,cx,base+stem*.28,mullionZ,width*.82,.04,.04,"trim");
      box(node,cx,base+stem*.70,mullionZ,width*.82,.04,.04,"trim");
    }
    if(isDoor && detail>=1){
      const inlay= DIM.stoneInlayBandWidth;
      const stoneZ=surfaceZ+side*.07;
      for(const jamb of [-1,1]){
        box(node,cx+jamb*(radius+inlay/2+.08),base+stem/2,stoneZ,inlay,stem,.14,"marble");
      }
      box(node,cx,base+.045,stoneZ,width+2*(inlay+.08),.09,.16,"marble");
      if(detail===2){
        // Extra narrow divisions suggest coloured glazed door panels.
        const paneW=width/3;
        for(const j of [-1,1]){
          box(node,cx+j*paneW,base+stem/2,stoneZ+side*.10,.035,stem*.9,.035,"trim");
        }
      }
    }
  }
  function fillFacetedArch(node,cx,base,cz,angle,width,height,wallDepth,detail){
    const radius=width/2,stem=height-radius,spring=base+stem;
    const tx=-Math.sin(angle),tz=Math.cos(angle),nx=Math.cos(angle),nz=Math.sin(angle);
    const inside=.42;
    const zcX=cx-nx*inside,zcZ=cz-nz*inside;
    orientedBoxXZ(node,zcX,base+stem/2,zcZ,width,stem,.05,angle,"glass");
    let prev=[zcX+tx*radius,spring,zcZ+tz*radius];
    for(let i=1;i<=12;i++){
      const a=Math.PI*i/12;
      const cur=[zcX+tx*radius*Math.cos(a),spring+radius*Math.sin(a),zcZ+tz*radius*Math.cos(a)];
      triangle(node,[zcX,spring,zcZ],prev,cur,"glass");prev=cur;
    }
    // reveal jambs and arch curve, connecting the face plane to the recessed glass.
    for(const u of [-radius,radius]){
      const outer=[cx+tx*u,base,cz+tz*u],outerTop=[outer[0],spring,outer[2]];
      const inner=[zcX+tx*u,base,zcZ+tz*u],innerTop=[inner[0],spring,inner[2]];
      quad(node,outer,inner,innerTop,outerTop,"pink");
    }
    let prevOut=[cx+tx*radius,spring,cz+tz*radius],prevIn=[zcX+tx*radius,spring,zcZ+tz*radius];
    for(let i=1;i<=12;i++){
      const a=Math.PI*i/12;
      const u=radius*Math.cos(a),y=spring+radius*Math.sin(a);
      const out=[cx+tx*u,y,cz+tz*u],inn=[zcX+tx*u,y,zcZ+tz*u];
      quad(node,prevOut,out,inn,prevIn,"pink");prevOut=out;prevIn=inn;
    }
    if(detail>=1){
      const ox=cx+nx*.035,oz=cz+nz*.035;
      box(node,ox,base+.06,oz,width+.16,.12,.12,"trim");
      box(node,cx+tx*(-radius-.05)+nx*.035,base+stem/2,cz+tz*(-radius-.05)+nz*.035,.1,stem,.12,"trim");
      box(node,cx+tx*(radius+.05)+nx*.035,base+stem/2,cz+tz*(radius+.05)+nz*.035,.1,stem,.12,"trim");
      facetedArchBand(node,cx,cz,angle,spring,radius+.02,.085,"trim",detail===2?16:10);
    }
  }
  function addFacadeSection(nodeName, x0, x1, bays, floors, lod) {
    const node=byName[nodeName], half=DIM.depth/2, thickness=DIM.wall;
    const pitch=(x1-x0)/bays;
    for(const floor of floors){
      if(lod===1){
        box(node,(x0+x1)/2,floor.base+floor.height/2,0,x1-x0,floor.height,DIM.depth,"pink");
        continue;
      }
      for(const side of [-1,1]){
        const surface=side*half,wallCenter=surface-side*thickness/2;
        for(let i=0;i<bays;i++){
          const cx=x0+(i+.5)*pitch;
          const w=Math.min(floor.width,pitch-.35),pierWidth=Math.max(.12,(pitch-w)/2);
          // Two separate piers leave an actual opening instead of painting glass onto a solid wall.
          box(node,cx-w/2-pierWidth/2,floor.base+floor.height/2,wallCenter,pierWidth,floor.height,thickness,"pink");
          box(node,cx+w/2+pierWidth/2,floor.base+floor.height/2,wallCenter,pierWidth,floor.height,thickness,"pink");
          if(floor.height>floor.crown){
            box(node,cx,floor.base+floor.crown+(floor.height-floor.crown)/2,wallCenter,w,floor.height-floor.crown,thickness,"pink");
          }
          fillFacadeArch(node,cx,floor.base,surface,side,w,floor.crown,thickness,lod===3?2:lod===2?1:0,((i+1)%Math.max(1,Math.round(DIM.doorBayInterval))===0));
          if(lod===3 && i%2===0){
            const px=x0+(i+1)*pitch-.11;
            box(node,px,floor.base+floor.height/2,surface+side*.10,.22,floor.height-.18,.20,"trim");
            box(node,px,floor.base+.14,surface+side*.12,.42,.24,.24,"trim");
            box(node,px,floor.base+floor.height-.14,surface+side*.12,.42,.24,.24,"trim");
          }
        }
        box(node,(x0+x1)/2,floor.base+.12,surface+side*.08,x1-x0,.24,.16,"roof");
        box(node,(x0+x1)/2,floor.base+floor.height-.12,surface+side*.10,x1-x0,.24,.20,"trim");
      }
      // Low-width end piers close the junction between adjacent wing meshes.
      // The actual short-end elevations are modelled separately by addEndFacade().
      box(node,x0+.2,floor.base+floor.height/2,0,.4,floor.height,DIM.depth,"pink");
      box(node,x1-.2,floor.base+floor.height/2,0,.4,floor.height,DIM.depth,"pink");
    }
  }
  /**
   * Build the two short end elevations with real recessed arched openings.
   * The end faces were previously almost absent, so orbiting the palace exposed
   * empty-looking sides. The angle keeps the reveals recessed toward the interior.
   */
  function addEndFacade(nodeName, edgeX, outwardSide, floors, bays, lod) {
    const node = byName[nodeName];
    const pitch = DIM.depth / bays;
    const angle = outwardSide > 0 ? 0 : Math.PI;
    const wallCenter = edgeX - outwardSide * DIM.wall / 2;

    for (const floor of floors) {
      if (lod === 1) {
        orientedBoxXZ(
          node, wallCenter, floor.base + floor.height / 2, 0,
          DIM.depth, floor.height, DIM.wall, angle, "pink",
        );
        continue;
      }

      for (let i = 0; i < bays; i++) {
        const cz = -half + (i + 0.5) * pitch;
        const width = Math.min(floor.width, pitch - 0.35);
        const pierWidth = Math.max(0.12, (pitch - width) / 2);

        orientedBoxXZ(
          node, wallCenter, floor.base + floor.height / 2,
          cz - width / 2 - pierWidth / 2,
          pierWidth, floor.height, DIM.wall, angle, "pink",
        );
        orientedBoxXZ(
          node, wallCenter, floor.base + floor.height / 2,
          cz + width / 2 + pierWidth / 2,
          pierWidth, floor.height, DIM.wall, angle, "pink",
        );
        if (floor.height > floor.crown) {
          orientedBoxXZ(
            node, wallCenter,
            floor.base + floor.crown + (floor.height - floor.crown) / 2,
            cz, width, floor.height - floor.crown, DIM.wall, angle, "pink",
          );
        }

        fillFacetedArch(
          node, edgeX, floor.base, cz, angle, width, floor.crown,
          DIM.wall, lod === 3 ? 2 : 1,
        );

        if (lod === 3) {
          orientedBoxXZ(
            node, edgeX + outwardSide * 0.06, floor.base + 0.13, cz,
            width + 0.18, 0.14, 0.14, angle, "trim",
          );
        }
      }

      // Continuous end-wall belt courses connect both storeys visually.
      orientedBoxXZ(
        node, edgeX + outwardSide * 0.06, floor.base + 0.12, 0,
        DIM.depth, 0.24, 0.16, angle, "roof",
      );
      orientedBoxXZ(
        node, edgeX + outwardSide * 0.08,
        floor.base + floor.height - 0.12, 0,
        DIM.depth, 0.24, 0.18, angle, "trim",
      );
    }
  }

  function addDomeProfile(node,cx,cz,baseY,profile,segments,key){
    const rings=profile.map(([radius,height])=>Array.from({length:segments},(_,i)=>{
      const a=2*Math.PI*i/segments;
      return [cx+radius*Math.cos(a),baseY+height,cz+radius*Math.sin(a)];
    }));
    for(let j=0;j<rings.length-1;j++)for(let i=0;i<segments;i++){
      const next=(i+1)%segments;quad(node,rings[j][i],rings[j][next],rings[j+1][next],rings[j+1][i],key);
    }
    for(let i=0;i<segments;i++)triangle(node,[cx,baseY,cz],rings[0][(i+1)%segments],rings[0][i],key);
  }
  function barBetween(node,p1,p2,width,key){
    const direction=normalize(sub(p2,p1));
    let across=normalize(cross(direction,[0,0,1]));
    if(Math.hypot(...across)<1e-5)across=[1,0,0];
    const second=normalize(cross(direction,across));
    const corners=[];
    for(const p of [p1,p2])for(const u of [-1,1])for(const v of [-1,1]){
      corners.push([p[0]+u*across[0]*width/2+v*second[0]*width/2,p[1]+u*across[1]*width/2+v*second[1]*width/2,p[2]+u*across[2]*width/2+v*second[2]*width/2]);
    }
    const q=(a,b,c,d)=>quad(node,corners[a],corners[b],corners[c],corners[d],key);
    q(0,2,3,1);q(4,5,7,6);q(0,1,5,4);q(2,6,7,3);q(0,4,6,2);q(1,3,7,5);
  }
  function drumFaceWall(node,theta,faceLength,apothem,baseY,topY,cx,cz,lod){
    const tx=-Math.sin(theta),tz=Math.cos(theta),nx=Math.cos(theta),nz=Math.sin(theta);
    const centerX=cx+nx*apothem,centerZ=cz+nz*apothem,depth=.58,height=topY-baseY;
    const isFrontBack=Math.abs(Math.abs(Math.sin(theta))-1)<.001;
    const openCount=isFrontBack?Math.max(0,Math.floor(DIM.drumOpeningCount/2)):0;
    if(!openCount||lod===1){
      orientedBoxXZ(node,centerX,(baseY+topY)/2,centerZ,faceLength,height,depth,theta,"pink");
      return;
    }
    const width=Math.min(DIM.drumOpeningWidth,faceLength*.28);
    const crown=Math.min(DIM.drumOpeningHeight,height-.6);
    const offsets=openCount===1?[0]:[-1.1,1.1];
    const holeIntervals=offsets.map(u=>[u-width/2,u+width/2]);
    const ranges=[-faceLength/2,...holeIntervals.flat(),faceLength/2].sort((a,b)=>a-b);
    const unique=ranges.filter((v,i)=>i===0||Math.abs(v-ranges[i-1])>.001);
    for(let i=0;i<unique.length-1;i++){
      const a=unique[i],b=unique[i+1],mid=(a+b)/2;
      const overlaps=holeIntervals.some(([l,r])=>mid>l&&mid<r);
      if(!overlaps){
        orientedBoxXZ(node,centerX+tx*mid,(baseY+topY)/2,centerZ+tz*mid,b-a,height,depth,theta,"pink");
      }else{
        const openingBottom=baseY+.6,openingTop=openingBottom+crown;
        if(openingBottom>baseY){
          orientedBoxXZ(node,centerX+tx*mid,(baseY+openingBottom)/2,centerZ+tz*mid,b-a,openingBottom-baseY,depth,theta,"pink");
        }
        if(topY>openingTop){
          orientedBoxXZ(node,centerX+tx*mid,(openingTop+topY)/2,centerZ+tz*mid,b-a,topY-openingTop,depth,theta,"pink");
        }
      }
    }
    for(const [left,right] of holeIntervals){
      fillFacetedArch(node,centerX+tx*((left+right)/2),baseY+.6,centerZ+tz*((left+right)/2),theta,width,crown,depth,lod===3?2:1);
    }
  }

  const n=byName,L=DIM.length,D=DIM.depth,half=D/2,xMin=-L/2,xMax=L/2;
  // The published description places the dome over the round room dividing
  // the two principal palace halves. Center that joint on the footprint origin.
  const rangLength=DIM.rangmahalLength,split=0,domeX=0;
  const plinthTop=DIM.ground+DIM.plinth;
  const gfBase=plinthTop,gfHeight=DIM.gf;
  const ffBase=gfBase+gfHeight+DIM.slab,ffHeight=DIM.ff;
  const roofTop=DIM.roofline-DIM.parapet;
  const rangBays=Math.max(2,Math.round(rangLength/(L/V("footprint","exteriorBayCount"))));
  const andarBays=Math.max(2,V("footprint","exteriorBayCount")-rangBays);
  const gf={base:gfBase,height:gfHeight,width:DIM.windowGF,crown:DIM.crownGF};
  const ff={base:ffBase,height:ffHeight,width:DIM.windowFF,crown:DIM.crownFF};

  box(n.Plinth,0,DIM.ground+DIM.plinth/2,0,L,DIM.plinth,D,"roof");
  addFacadeSection("Rangmahal_GF",split,xMax,rangBays,[gf],lod);
  addFacadeSection("Rangmahal_FF",split,xMax,rangBays,[ff],lod);
  addFacadeSection("Andarmahal",xMin,split,andarBays,[gf,ff],lod);

  // Close the east and west ends with matching arches rather than thin blank caps.
  addEndFacade("Andarmahal", xMin, -1, [gf, ff], 6, lod);
  addEndFacade("Rangmahal_GF", xMax, 1, [gf], 6, lod);
  addEndFacade("Rangmahal_FF", xMax, 1, [ff], 6, lod);

  box(n.Rangmahal_GF,(split+xMax)/2,gfBase+gfHeight+DIM.slab/2,0,rangLength,DIM.slab,D,"marble");
  box(n.Rangmahal_FF,(split+xMax)/2,ffBase+ffHeight+DIM.slab/2,0,rangLength,DIM.slab,D,"marble");
  box(n.Andarmahal,(xMin+split)/2,gfBase+gfHeight+DIM.slab/2,0,xMin*-1+split,DIM.slab,D,"marble");
  box(n.Andarmahal,(xMin+split)/2,ffBase+ffHeight+DIM.slab/2,0,xMin*-1+split,DIM.slab,D,"marble");

  // Roof deck below parapet; structure is only represented as exterior massing.
  box(n.Parapet,0,roofTop-.08,0,L,.16,D,"roof");
  for(const side of [-1,1]){
    box(n.Parapet,0,roofTop+DIM.parapet/2,side*(half-.12),L,DIM.parapet,.4,"pink");
    if(lod===3)for(let i=0;i<62;i++){
      const x=xMin+(i+.5)*L/62;
      box(n.Parapet,x,roofTop+DIM.parapet*.54,side*(half-.31),.30,DIM.parapet*.55,.20,"trim");
    }
  }
  // Close both short roof edges as well as the two long parapet runs so
  // elevated and rear three-quarter views do not reveal a roof with missing sides.
  for (const side of [-1, 1]) {
    box(
      n.Parapet, side * (L / 2 - 0.2),
      roofTop + DIM.parapet / 2, 0,
      0.4, DIM.parapet, D, "pink",
    );
  }

  // Small roofline pinnacles reinforce the palace silhouette at wing breaks
  // and corners; they remain a low-poly hint rather than invented sculpture.
  if (lod === 3) {
    for (const side of [-1, 1]) {
      for (const x of [xMin + 2.2, -L / 4, L / 4, xMax - 2.2]) {
        const z = side * (half - 0.32);
        const base = roofTop + DIM.parapet;
        box(n.Parapet, x, base + 0.18, z, 1.15, 0.36, 0.92, "trim");
        verticalCylinder(
          n.Parapet, x, base + 0.18 * DIM.pinnacleHeight,
          base + 0.50 * DIM.pinnacleHeight, z, 0.13, "trim", 8,
        );
        addDomeProfile(
          n.Parapet, x, z, base + 0.50 * DIM.pinnacleHeight,
          [[0.30, 0], [0.24, 0.12 * DIM.pinnacleHeight],
            [0.16, 0.24 * DIM.pinnacleHeight], [0.06, 0.38 * DIM.pinnacleHeight],
            [0.006, 0.50 * DIM.pinnacleHeight]],
          8, "roof",
        );
      }
    }
  }

  // Recessed north/south verandas with a true opening rhythm based on the estimated 3.3 m span.
  const verandaCount=Math.max(8,Math.round(L/DIM.verandaSpan)),verandaPitch=L/verandaCount;
  for(const [name,side] of [["Veranda_S",1],["Veranda_N",-1]]){
    const z=side*(half+1.22);
    box(byName[name],0,gfBase+.12,z,L,.24,2.44,"marble");
    box(byName[name],0,ffBase+.12,z,L,.24,2.44,"marble");
    if(lod>=2){
      for(const [base,h] of [[gfBase,gfHeight],[ffBase,ffHeight]]){
        const spring=base+h-verandaPitch/2;
        for(let i=0;i<=verandaCount;i++){
          const x=xMin+i*verandaPitch;
          verticalCylinder(byName[name],x,base,base+h,z,.18,"trim",8);
          box(byName[name],x,base+.13,z,.48,.26,.48,"trim");
          box(byName[name],x,base+h-.12,z,.48,.24,.48,"trim");
        }
        if(lod===3){
          for(let i=0;i<verandaCount;i++){
            const x=xMin+(i+.5)*verandaPitch;
            archBand(byName[name],x,spring,z,verandaPitch/2,.10,"trim",12);
          }
        }
      }
    }
  }

  // Dark, thin balustrades at the upper veranda edge add depth when viewed
  // obliquely. Keep this detail only in LOD3 to protect distant-view performance.
  if (lod === 3) {
    const railBase = ffBase + 0.22;
    const railTop = railBase + DIM.balustradeHeight;
    const balusterCount = Math.ceil(L / DIM.balusterSpacing);
    for (const side of [-1, 1]) {
      const railZ = side * (half + 2.26);
      barBetween(byName[side === 1 ? "Veranda_S" : "Veranda_N"],
        [xMin, railBase, railZ], [xMax, railBase, railZ], 0.11, "rail");
      barBetween(byName[side === 1 ? "Veranda_S" : "Veranda_N"],
        [xMin, railTop, railZ], [xMax, railTop, railZ], 0.11, "rail");
      for (let i = 0; i <= balusterCount; i++) {
        const x = xMin + (L * i / balusterCount);
        verticalCylinder(
          byName[side === 1 ? "Veranda_S" : "Veranda_N"],
          x, railBase, railTop, railZ, 0.035, "rail", 6,
        );
      }
    }
  }

  // Matching south (river-front) and north (rear) triple-arched porticos.
  for(const [name,side] of [["Portico_S",1],["Portico_N",-1]]){
    const width=DIM.porticoWidth,depth=DIM.porticoDepth,z=side*(half+depth/2+.18),faceZ=z+side*depth/2;
    box(byName[name],domeX,gfBase+gfHeight+.12,side*(half+depth/2),width,.24,depth,"marble");
    if(lod===1){
      box(byName[name],domeX,gfBase+gfHeight/2,z,width,gfHeight,.5,"pink");
    }else{
      const span=width/3;
      for(let i=0;i<=3;i++){
        const x=domeX-width/2+i*span;
        verticalCylinder(byName[name],x,gfBase,gfBase+gfHeight,faceZ,.25,"trim",12);
        box(byName[name],x,gfBase+.16,faceZ,.60,.32,.58,"trim");
        box(byName[name],x,gfBase+gfHeight-.12,faceZ,.70,.24,.62,"trim");
      }
      const spring=gfBase+gfHeight-span/2;
      for(let i=0;i<3;i++){
        const cx=domeX-width/2+(i+.5)*span;
        archBand(byName[name],cx,spring,faceZ,span/2,.15,"trim",16);
      }
      // Ground-floor portico roof / first-floor porch deck.
      box(byName[name],domeX,gfBase+gfHeight-.06,faceZ,width+.5,.3,.8,"pink");

      // Upper-storey triple-arched loggia. The former model stopped at the
      // ground-floor arches, which made the most recognizable central facade
      // feel incomplete in both frontal and orbit views.
      const upperBase = ffBase;
      const upperTop = ffBase + ffHeight;
      const upperSpring = upperTop - span / 2;
      if (lod >= 2) {
        for (let i = 0; i <= 3; i++) {
          const x = domeX - width / 2 + i * span;
          verticalCylinder(
            byName[name], x, upperBase, upperTop, faceZ, .22, "trim",
            lod === 3 ? 16 : 10,
          );
          box(byName[name], x, upperBase + .12, faceZ, .58, .24, .58, "trim");
          box(byName[name], x, upperTop - .12, faceZ, .68, .24, .68, "trim");
          if (lod === 3) {
            // Light impost/capital bands emphasize the upper arcade rhythm.
            box(byName[name], x, upperSpring, faceZ + side * .035, .82, .18, .80, "marble");
          }
        }
        for (let i = 0; i < 3; i++) {
          const cx = domeX - width / 2 + (i + .5) * span;
          archBand(byName[name], cx, upperSpring, faceZ, span / 2, .17, "trim", lod === 3 ? 20 : 12);
        }
        box(byName[name], domeX, upperTop - .06, faceZ, width + .65, .28, .76, "trim");
      }

      // The pediment belongs above the upper loggia, not midway up the facade.
      const pedimentBase = upperTop + .28;
      const pedimentTop = Math.max(DIM.pedimentPeak, pedimentBase + 1.2);
      const frontZ = faceZ + side * .45;
      const pedimentLeft = [domeX - width / 2 - .7, pedimentBase, frontZ];
      const pedimentRight = [domeX + width / 2 + .7, pedimentBase, frontZ];
      const pedimentApex = [domeX, pedimentTop, frontZ];
      triangle(byName[name], pedimentLeft, pedimentRight, pedimentApex, "pink");
      if (lod === 3) {
        // Moulded triangular outline and a restrained central relief panel.
        barBetween(byName[name], pedimentLeft, pedimentRight, .22, "trim");
        barBetween(byName[name], pedimentLeft, pedimentApex, .18, "trim");
        barBetween(byName[name], pedimentApex, pedimentRight, .18, "trim");
        box(byName[name], domeX, pedimentBase + .42, frontZ + side * .09, 2.7, .55, .16, "trim");
        box(byName[name], domeX, pedimentBase + .42, frontZ + side * .18, 1.65, .25, .08, "roof");
      }
    }
  }

  // Broad garden-to-river stair rises to the upper portal.
  const stair=byName.Stair_S,steps=lod===1?8:lod===2?20:DIM.stepCount;
  const run=DIM.stairRun;
  const stepDepth=lod===3?DIM.stairTread:run/steps;
  const rise=lod===3?DIM.stairRiser:ffBase/steps;
  if(lod===3){
    const modeledRun=steps*stepDepth,modeledRise=steps*rise;
    if(Math.abs(modeledRun-run)>.05){
      console.warn("[Heritage model] Stair tread total differs from runLength:",{modeledRun,run});
    }
    if(Math.abs(modeledRise-ffBase)>.05){
      console.warn("[Heritage model] Stair riser total differs from the first-floor portal elevation:",{modeledRise,portalHeight:ffBase});
    }
  }
  for(let i=0;i<steps;i++){
    const top=(i+1)*rise,z=half+run-stepDepth*(i+.5);
    box(stair,domeX,top/2,z,DIM.stairWidth,top,stepDepth,"marble");
  }
  if(lod>=2){
    for(const x of [domeX-DIM.stairWidth/2-.18,domeX+DIM.stairWidth/2+.18]){
      const outerZ=half+run,innerZ=half;
      barBetween(stair,[x,.35,outerZ],[x,ffBase+.25,innerZ],.14,"rail");
      for(let i=1;i<10;i++){
        const t=i/10,z=outerZ+(innerZ-outerZ)*t,y=.35+(ffBase+.25-.35)*t;
        verticalCylinder(stair,x-.05,y-.08,y+.08,z,.055,"trim",8);
      }
    }
  }

  // Square base room and octagonal drum with real arch apertures, not painted overlays.
  const drumBase=DIM.roofline,drumWidth=DIM.drumWidth,rad=drumWidth/2,apothem=rad*Math.cos(Math.PI/8);
  box(n.Dome_Drum,domeX,drumBase+.4,0,drumWidth,.8,drumWidth,"pink");
  const drumWallBottom=drumBase+.8,drumTop=drumBase+DIM.drumHeight;
  const faceLen=2*rad*Math.sin(Math.PI/8);
  for(let i=0;i<8;i++){
    const theta=i*Math.PI/4;
    drumFaceWall(n.Dome_Drum,theta,faceLen,apothem,drumWallBottom,drumTop,domeX,0,lod);
    if(lod===3){
      const vx=domeX+rad*Math.cos(theta+Math.PI/8),vz=rad*Math.sin(theta+Math.PI/8);
      verticalCylinder(n.Dome_Drum,vx,drumWallBottom,drumTop,vz,.12,"trim",8);
    }
  }
  const domeProfile=DIM.domeRings.map(([radius,height])=>[radius,height]);
  addDomeProfile(n.Dome,domeX,0,drumTop,domeProfile,lod===1?10:lod===2?18:28,"pink");
  if(lod===3){
    for(let i=0;i<8;i++){
      const angle=2*Math.PI*i/8;
      for(let j=0;j<domeProfile.length-1;j++){
        const [r0,h0]=domeProfile[j],[r1,h1]=domeProfile[j+1];
        barBetween(n.Dome,[domeX+r0*Math.cos(angle),drumTop+h0,r0*Math.sin(angle)],[domeX+r1*Math.cos(angle),drumTop+h1,r1*Math.sin(angle)],.10,"trim");
      }
    }
    verticalCylinder(n.Dome,domeX,drumTop+.08,drumTop+.20,0,Math.max(...domeProfile.map(x=>x[0])),"trim",28);
  }
  const finialBase=DIM.peak-DIM.finialHeight;
  verticalCylinder(n.Finial,domeX,finialBase,finialBase+.9,0,.12,"trim",12);
  verticalCylinder(n.Finial,domeX,finialBase+.55,finialBase+.85,0,.24,"gold",12);
  addDomeProfile(n.Finial,domeX,0,finialBase,[[.24,0],[.18,.2],[.11,.55],[.04,.95],[.004,DIM.finialHeight]],12,"gold");

  // Every LOD carries the full semantic node list, so viewer integrations remain stable.
  for(const node of nodes){
    if(node.positions.length===0)box(node,0,.05,0,.1,.1,.1,"pink");
  }
  const jsonBytesFor = (object) => Buffer.from(JSON.stringify(object),"utf8");
  const bufferViews=[],accessors=[],meshes=[],gltfNodes=[],binaryBuffers=[];
  let byteOffset=0;
  function addBuffer(typedArray,target=34962){
    const buffer=Buffer.from(typedArray.buffer,typedArray.byteOffset,typedArray.byteLength);
    const padding=(4-(byteOffset%4))%4;
    if(padding){binaryBuffers.push(Buffer.alloc(padding));byteOffset+=padding;}
    const index=bufferViews.length;
    bufferViews.push({buffer:0,byteOffset,byteLength:buffer.length,target});
    binaryBuffers.push(buffer);byteOffset+=buffer.length;return index;
  }
  for(const node of nodes){
    const positions=new Float32Array(node.positions),normals=new Float32Array(node.normals),colors=new Uint8Array(node.colors);
    const posView=addBuffer(positions),normView=addBuffer(normals),colView=addBuffer(colors);
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<positions.length;i+=3)for(let j=0;j<3;j++){min[j]=Math.min(min[j],positions[i+j]);max[j]=Math.max(max[j],positions[i+j]);}
    const pa=accessors.length;accessors.push({bufferView:posView,componentType:5126,count:positions.length/3,type:"VEC3",min,max});
    const na=accessors.length;accessors.push({bufferView:normView,componentType:5126,count:normals.length/3,type:"VEC3"});
    const ca=accessors.length;accessors.push({bufferView:colView,componentType:5121,normalized:true,count:colors.length/4,type:"VEC4"});
    meshes.push({name:node.name,primitives:[{attributes:{POSITION:pa,NORMAL:na,COLOR_0:ca},material:0,mode:4}]});
    gltfNodes.push({name:node.name,mesh:meshes.length-1,extras:{semanticNode:node.name,lod:"LOD"+lod,unit:"meters"}});
  }
  const binary=Buffer.concat(binaryBuffers);
  const gltf={
    asset:{version:"2.0",generator:"Ahsan Manzil parametric model generator",extras:{building:config.id,lod:"LOD"+lod,units:"meters",naturalGroundY:0,localAxes:"X east-west, Y up, +Z south",anchor:config.georeference,confidenceLegend:config.confidenceLegend}},
    scene:0,scenes:[{name:"Ahsan Manzil Exterior",nodes:gltfNodes.map((_,i)=>i)}],nodes:gltfNodes,meshes,
    materials:[{name:"Heritage vertex colours",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],metallicFactor:0,roughnessFactor:.86}}],
    accessors,bufferViews,buffers:[{byteLength:binary.length}]
  };
  const jsonRaw=jsonBytesFor(gltf),jsonPad=(4-jsonRaw.length%4)%4,binPad=(4-binary.length%4)%4;
  const jsonChunk=Buffer.concat([jsonRaw,Buffer.alloc(jsonPad,0x20)]),binChunk=Buffer.concat([binary,Buffer.alloc(binPad)]);
  const outLength=12+8+jsonChunk.length+8+binChunk.length;
  const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(outLength,8);
  const jsonHeader=Buffer.alloc(8);jsonHeader.writeUInt32LE(jsonChunk.length,0);jsonHeader.writeUInt32LE(0x4e4f534a,4);
  const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(binChunk.length,0);binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,jsonHeader,jsonChunk,binHeader,binChunk]);
}

await mkdir(OUT,{recursive:true});
for(const lod of [1,2,3]){
  const model=buildGlb(lod);
  await writeFile(path.join(OUT,"ahsan-manzil-lod"+lod+".glb"),model);
  console.log("Wrote LOD"+lod+" ("+model.length+" bytes).");
}
await copyFile(path.join(OUT,"ahsan-manzil-lod3.glb"),path.join(OUT,"ahsan-manzil.glb"));
console.log("Generated Ahsan Manzil LOD assets from the confidence-tagged parameter JSON.");
