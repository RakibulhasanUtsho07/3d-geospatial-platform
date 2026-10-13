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
  andarDepth: V("footprint", "andarmahalDepth"),
  andarCenterZ: V("footprint", "andarmahalNorthOffset"),
  andarBayCount: V("footprint", "andarmahalBayCount"),
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
  stairWidthTop: V("stair", "topWidth"),
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
  stair: V("materials", "stairStone"),
  wood: V("materials", "doorWood"),
  sceneTrim: "#ECAE9B",
  sceneStone: "#B89A86",
  sceneDark: "#392B27",
  sceneGreen: "#45674D",
  sceneStep: "#6E625A",
  sceneDome: "#E4A18D",
  sceneGrass: "#8CA878",
  sceneWater: "#75B5D2",
  scenePath: "#D9CDB8",
  sceneWhite: "#F3D2C5",
  sceneWood: "#705039",
  sceneTree0: "#507D43",
  sceneTree1: "#62894C",
  sceneTree2: "#3F703D",
  sceneTree3: "#78925A",
  sceneBlock0: "#CFC3B0",
  sceneBlock1: "#BFB3A0",
  sceneBlock2: "#D8D0C2",
  sceneBlock3: "#A89C8C",
};
const REQUIRED_NODES = config.requiredNodeNames;
const SITE_CONTEXT_NODES = [
  "Site_Ground", "Site_River", "Site_Approach", "Site_Pond",
  "Site_Family_Mosque", "Site_Stable", "Site_Trees", "Site_Context_Blocks",
];

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
  const nodes = [...REQUIRED_NODES, ...SITE_CONTEXT_NODES].map((name) => ({ name, positions: [], normals: [], colors: [] }));
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
    // Door glazing is modelled on the wooden leaf below, inside the reveal.
    if (isDoor && detail >= 1) {
      // Recessed wooden double-door leaf; the historic glazing is represented
      // only by small upper panels because its exact pattern remains unknown.
      const doorZ = glassZ + side * 0.055;
      box(node, cx, base + stem / 2, doorZ, width * 0.88, stem * 0.90, 0.06, "wood");
      box(node, cx, base + stem * 0.12, doorZ + side * 0.045, width * 0.92, 0.10, 0.05, "trim");
      if (detail === 2) {
        const paneWidth = width / 3 - 0.07;
        const paneY = base + stem * 0.68;
        const paneHeight = stem * 0.34;
        for (let pane = 0; pane < 3; pane++) {
          box(
            node,
            cx + (pane - 1) * width / 3,
            paneY,
            doorZ + side * 0.045,
            paneWidth,
            paneHeight,
            0.045,
            ["#A76E62", "#D4A77B", "#9A7A67"][pane],
          );
        }
        // Timber rails and stiles remain visible around the coloured panes.
        for (const x of [-1, 0, 1]) {
          box(node, cx + x * width / 3, paneY, doorZ + side * 0.075, 0.045, paneHeight + 0.06, 0.045, "wood");
        }
        box(node, cx, base + stem * 0.50, doorZ + side * 0.075, width * 0.86, 0.05, 0.045, "wood");
      }
    }
    if (!isDoor && detail >= 1) {
      // The reference Three.js scene uses dark green shutters rather than
      // plain pale glazing. Keep the shutters recessed inside the arch and
      // add individual timber/painted slats at the highest LOD.
      const shutterZ = glassZ + side * 0.105;
      const shutterWidth = width * 0.76;
      const shutterHeight = stem * 0.62;
      const shutterBase = base + stem * 0.08;
      box(node, cx, shutterBase + shutterHeight / 2, shutterZ,
        shutterWidth, shutterHeight, 0.055, "#45674D");
      if (detail === 2) {
        for (let slat = 0; slat < 5; slat++) {
          const x = cx - shutterWidth * 0.38 + slat * shutterWidth * 0.19;
          box(node, x, shutterBase + shutterHeight / 2,
            shutterZ + side * 0.04, 0.035, shutterHeight * 0.94, 0.035, "#E99C8A");
        }
        box(node, cx, shutterBase + shutterHeight * 0.52,
          shutterZ + side * 0.055, shutterWidth * 0.98, 0.045, 0.035, "#392B27");
      }
    }
    if(detail===2 && !isDoor){
      // Traditional narrow muntins and transom divisions remain visible above
      // the shutter panel so the opening reads as an arched sash, not a solid box.
      const mullionZ=glassZ+side*.09;
      box(node,cx,base+stem*.82,mullionZ,.045,stem*.24,.04,"trim");
      box(node,cx,base+stem*.76,mullionZ,width*.72,.04,.04,"trim");
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
  function fillRectLouverWindow(node,cx,base,surfaceZ,side,width,height,wallThickness,detail){
    const paneZ=surfaceZ-side*(wallThickness-.09);
    const frameZ=surfaceZ+side*.055;
    box(node,cx,base+height/2,paneZ,width*.86,height*.9,.055,"glass");
    if(detail>=1){
      // Recessed reveal and pink-family rectangular casing.
      for(const x of [cx-width/2,cx+width/2]){
        box(node,x,base+height/2,frameZ,.10,height+.08,.12,"trim");
      }
      box(node,cx,base+.05,frameZ,width+.18,.10,.14,"trim");
      box(node,cx,base+height,frameZ,width+.22,.12,.14,"trim");
      // Wooden horizontal louvers remain visible over the dark glazing.
      for(let i=1;i<=5;i++){
        const y=base+height*(.18+i*.115);
        box(node,cx,y,frameZ+side*.045,width*.80,.055,.055,"wood");
      }
      box(node,cx,base+height+.16,frameZ+side*.12,width+.34,.14,.48,"trim");
      for(const support of [-1,1]){
        box(node,cx+support*(width/2+.08),base+height+.045,frameZ+side*.12,.08,.20,.35,"trim");
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
  function addFacadeSection(nodeName, x0, x1, bays, floors, lod, centerZ = 0, depth = DIM.depth) {
    const node=byName[nodeName], half=depth/2, thickness=DIM.wall;
    const pitch=(x1-x0)/bays;
    for(const floor of floors){
      if(lod===1){
        box(node,(x0+x1)/2,floor.base+floor.height/2,centerZ,x1-x0,floor.height,depth,"pink");
        continue;
      }
      for(const side of [-1,1]){
        const surface=centerZ+side*half,wallCenter=surface-side*thickness/2;
        for(let i=0;i<bays;i++){
          const cx=x0+(i+.5)*pitch;
          // Keep the projecting triple-arched portico open instead of stacking
          // a flat facade behind it. Upper portal doors are placed separately.
          if (
            nodeName.startsWith("Rangmahal") &&
            Math.abs(cx - (x0 + x1) / 2) < DIM.porticoWidth / 2 + pitch * 0.05
          ) continue;
          const w=Math.min(floor.width,pitch-.35),pierWidth=Math.max(.12,(pitch-w)/2);
          // Two separate piers leave an actual opening instead of painting glass onto a solid wall.
          box(node,cx-w/2-pierWidth/2,floor.base+floor.height/2,wallCenter,pierWidth,floor.height,thickness,"pink");
          box(node,cx+w/2+pierWidth/2,floor.base+floor.height/2,wallCenter,pierWidth,floor.height,thickness,"pink");
          if(floor.height>floor.crown){
            box(node,cx,floor.base+floor.crown+(floor.height-floor.crown)/2,wallCenter,w,floor.height-floor.crown,thickness,"pink");
          }
          const detail = lod===3 ? 2 : lod===2 ? 1 : 0;
          const endPavilionBay = nodeName !== "Andarmahal" && (i < 2 || i >= bays - 2);
          const upperStorey = floor.base > DIM.ground + DIM.plinth + DIM.gf / 2;
          const scheduledDoor = ((i+1)%Math.max(1,Math.round(DIM.doorBayInterval))===0);
          const isDoor = endPavilionBay && !upperStorey ? true : scheduledDoor;
          if (endPavilionBay && upperStorey && lod >= 2) {
            fillRectLouverWindow(node,cx,floor.base,surface,side,w,floor.crown,thickness,detail);
          } else {
            fillFacadeArch(node,cx,floor.base,surface,side,w,floor.crown,thickness,detail,isDoor);
          }
          if(lod===3 && upperStorey && !endPavilionBay && !isDoor){
            // Low iron/stone balustrade visible inside the upper-storey arches.
            const railZ=surface+side*.15;
            const railBottom=floor.base+.22,railTop=floor.base+.88;
            const left=cx-w/2+.08,right=cx+w/2-.08;
            barBetween(node,[left,railBottom,railZ],[right,railBottom,railZ],.055,"rail");
            barBetween(node,[left,railTop,railZ],[right,railTop,railZ],.055,"rail");
            for(let j=1;j<=3;j++){
              const x=left+(right-left)*j/4;
              verticalCylinder(node,x,railBottom,railTop,railZ,.025,"trim",6);
            }
          }
          if(lod===3 && i < bays - 1){
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
      box(node,x0+.2,floor.base+floor.height/2,centerZ,.4,floor.height,depth,"pink");
      box(node,x1-.2,floor.base+floor.height/2,centerZ,.4,floor.height,depth,"pink");
    }
  }
  /**
   * Build the two short end elevations with real recessed arched openings.
   * The end faces were previously almost absent, so orbiting the palace exposed
   * empty-looking sides. The angle keeps the reveals recessed toward the interior.
   */
  function addEndFacade(nodeName, edgeX, outwardSide, floors, bays, lod, centerZ = 0, depth = DIM.depth) {
    const node = byName[nodeName];
    const pitch = depth / bays;
    const halfDepth = depth / 2;
    const angle = outwardSide > 0 ? 0 : Math.PI;
    const wallCenter = edgeX - outwardSide * DIM.wall / 2;

    for (const floor of floors) {
      if (lod === 1) {
        orientedBoxXZ(
          node, wallCenter, floor.base + floor.height / 2, centerZ,
          depth, floor.height, DIM.wall, angle, "pink",
        );
        continue;
      }

      for (let i = 0; i < bays; i++) {
        const cz = centerZ - halfDepth + (i + 0.5) * pitch;
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
        node, edgeX + outwardSide * 0.06, floor.base + 0.12, centerZ,
        depth, 0.24, 0.16, angle, "roof",
      );
      orientedBoxXZ(
        node, edgeX + outwardSide * 0.08,
        floor.base + floor.height - 0.12, centerZ,
        depth, 0.24, 0.18, angle, "trim",
      );
    }
  }

  function addFacadeDisk(node,cx,cy,z,radius,key,side=1,segments=32){
    const center=[cx,cy,z];
    for(let i=0;i<segments;i++){
      const a=2*Math.PI*i/segments,b=2*Math.PI*(i+1)/segments;
      const p0=[cx+radius*Math.cos(a),cy+radius*Math.sin(a),z];
      const p1=[cx+radius*Math.cos(b),cy+radius*Math.sin(b),z];
      if(side>0) triangle(node,center,p0,p1,key);
      else triangle(node,center,p1,p0,key);
    }
  }
  function addFacadeRing(node,cx,cy,z,outerRadius,innerRadius,key,side=1,segments=32){
    for(let i=0;i<segments;i++){
      const a=2*Math.PI*i/segments,b=2*Math.PI*(i+1)/segments;
      const out0=[cx+outerRadius*Math.cos(a),cy+outerRadius*Math.sin(a),z];
      const out1=[cx+outerRadius*Math.cos(b),cy+outerRadius*Math.sin(b),z];
      const in0=[cx+innerRadius*Math.cos(a),cy+innerRadius*Math.sin(a),z];
      const in1=[cx+innerRadius*Math.cos(b),cy+innerRadius*Math.sin(b),z];
      if(side>0) quad(node,out0,out1,in1,in0,key);
      else quad(node,out1,out0,in0,in1,key);
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
  function horizontalPlane(node, cx, y, cz, width, depth, key) {
    const x0 = cx - width / 2, x1 = cx + width / 2;
    const z0 = cz - depth / 2, z1 = cz + depth / 2;
    // Winding faces upward so the site surface is visible from the map camera.
    quad(node, [x0,y,z0], [x0,y,z1], [x1,y,z1], [x1,y,z0], key);
  }
  function horizontalRing(node, cx, cz, y, radius, width, key, segments = 48) {
    const outer = radius + width / 2, inner = Math.max(.001, radius - width / 2);
    for (let i = 0; i < segments; i++) {
      const a = 2 * Math.PI * i / segments, b = 2 * Math.PI * (i + 1) / segments;
      const outA = [cx + outer * Math.cos(a), y, cz + outer * Math.sin(a)];
      const outB = [cx + outer * Math.cos(b), y, cz + outer * Math.sin(b)];
      const inA = [cx + inner * Math.cos(a), y, cz + inner * Math.sin(a)];
      const inB = [cx + inner * Math.cos(b), y, cz + inner * Math.sin(b)];
      quad(node, outA, outB, inB, inA, key);
    }
  }
  function horizontalEllipse(node, cx, y, cz, radiusX, radiusZ, key, segments = 36) {
    const center = [cx, y, cz];
    for (let i = 0; i < segments; i++) {
      const a = 2 * Math.PI * i / segments;
      const b = 2 * Math.PI * (i + 1) / segments;
      const p0 = [cx + radiusX * Math.cos(a), y, cz + radiusZ * Math.sin(a)];
      const p1 = [cx + radiusX * Math.cos(b), y, cz + radiusZ * Math.sin(b)];
      triangle(node, center, p1, p0, key);
    }
  }
  function ellipsoid(node, cx, cy, cz, rx, ry, rz, key, segments = 16, rings = 8) {
    const grid = [];
    for (let j = 0; j <= rings; j++) {
      const latitude = -Math.PI / 2 + Math.PI * j / rings;
      const cosLatitude = Math.cos(latitude), sinLatitude = Math.sin(latitude);
      grid.push(Array.from({ length: segments }, (_, i) => {
        const longitude = 2 * Math.PI * i / segments;
        return [
          cx + rx * cosLatitude * Math.cos(longitude),
          cy + ry * sinLatitude,
          cz + rz * cosLatitude * Math.sin(longitude),
        ];
      }));
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < segments; i++) {
        const next = (i + 1) % segments;
        // Latitude-first order produces outward-facing triangles.
        quad(node, grid[j][i], grid[j + 1][i], grid[j + 1][next], grid[j][next], key);
      }
    }
  }
  function siteBox(node, width, height, depth, cx, baseY, cz, key) {
    box(node, cx, baseY + height / 2, cz, width, height, depth, key);
  }
  function siteFrustum(node, cx, cz, y0, y1, bottomRadius, topRadius, key, segments = 8) {
    const lower = [], upper = [];
    for (let i = 0; i < segments; i++) {
      const a = 2 * Math.PI * i / segments;
      lower.push([cx + bottomRadius * Math.cos(a), y0, cz + bottomRadius * Math.sin(a)]);
      upper.push([cx + topRadius * Math.cos(a), y1, cz + topRadius * Math.sin(a)]);
    }
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      quad(node, lower[i], lower[next], upper[next], upper[i], key);
      triangle(node, [cx,y0,cz], lower[next], lower[i], key);
      triangle(node, [cx,y1,cz], upper[i], upper[next], key);
    }
  }
  function drumFaceWall(node,theta,faceLength,apothem,baseY,topY,cx,cz,lod){
    const tx=-Math.sin(theta),tz=Math.cos(theta),nx=Math.cos(theta),nz=Math.sin(theta);
    const centerX=cx+nx*apothem,centerZ=cz+nz*apothem,depth=.58,height=topY-baseY;
    if(lod===1){
      orientedBoxXZ(node,centerX,(baseY+topY)/2,centerZ,faceLength,height,depth,theta,"pink");
      return;
    }

    // Eight open arched bays create the documented columned/fenestrated drum.
    // Do not fill these openings with glass: the upper rotunda must read as a
    // colonnade when viewed from the front, rear, and all diagonal angles.
    const width=Math.min(DIM.drumOpeningWidth,faceLength*.64);
    const archHeight=Math.min(DIM.drumOpeningHeight,height-1.15);
    const openingBottom=baseY+.48;
    const spring=openingBottom+archHeight-width/2;
    const crown=spring+width/2;
    const sidePier=Math.max(.12,(faceLength-width)/2);

    for(const side of [-1,1]){
      orientedBoxXZ(
        node,centerX+tx*side*(width/2+sidePier/2),(baseY+topY)/2,
        centerZ+tz*side*(width/2+sidePier/2),
        sidePier,height,depth,theta,"pink",
      );
    }
    if(openingBottom>baseY){
      orientedBoxXZ(
        node,centerX,(baseY+openingBottom)/2,centerZ,
        width,openingBottom-baseY,depth,theta,"pink",
      );
    }
    if(topY>crown){
      orientedBoxXZ(
        node,centerX,(crown+topY)/2,centerZ,
        width,topY-crown,depth,theta,"pink",
      );
    }

    // A narrow moulded arch ring frames the void. Spring posts sit at the
    // opening jambs, while the eight octagon-corner columns are added outside.
    facetedArchBand(node,centerX,centerZ,theta,spring,width/2,.16,"trim",lod===3?20:12);
    if(lod===3){
      for(const u of [-width/2,width/2]){
        verticalCylinder(
          node,centerX+tx*u,openingBottom,spring,centerZ+tz*u,.105,"trim",10,
        );
      }
    }

    // Continuous base and crown courses visually tie all eight drum faces together.
    orientedBoxXZ(
      node,centerX,baseY+.12,centerZ,
      faceLength+.20,.24,depth+.20,theta,"trim",
    );
    orientedBoxXZ(
      node,centerX,topY-.10,centerZ,
      faceLength+.35,.22,depth+.35,theta,"trim",
    );
  }

  const n=byName,L=DIM.length,D=DIM.depth,half=D/2,xMin=-L/2,xMax=L/2;
  // The 183 ft source applies to the symmetric Rangmahal frontage. Keep the
  // 125.4 m reported total extent by adjoining a provisional rear-set Andarmahal
  // block to its west; this stepped plan remains [E] until a north-up footprint
  // trace resolves the conflict between published overall dimensions.
  const rangLength = DIM.rangmahalLength;
  const andarLength = L - rangLength;
  // Centre the overall extents at x=0 but keep the shorter Rangmahal frontage
  // at the east/south-facing end; the west Andarmahal occupies the remainder.
  const split = xMin + andarLength;
  const domeX = (split + xMax) / 2;
  const andarCenterX = (xMin + split) / 2;
  const andarDepth=DIM.andarDepth, andarCenterZ=DIM.andarCenterZ;
  const plinthTop=DIM.ground+DIM.plinth;
  const gfBase=plinthTop,gfHeight=DIM.gf;
  const ffBase=gfBase+gfHeight+DIM.slab,ffHeight=DIM.ff;
  const roofTop=DIM.roofline-DIM.parapet;
  const rangBays=V("footprint","exteriorBayCount");
  const andarBays=DIM.andarBayCount;
  const gf={base:gfBase,height:gfHeight,width:DIM.windowGF,crown:DIM.crownGF};
  const ff={base:ffBase,height:ffHeight,width:DIM.windowFF,crown:DIM.crownFF};

  box(n.Plinth,(split+xMax)/2,DIM.ground+DIM.plinth/2,0,rangLength,DIM.plinth,D,"roof");
  box(n.Plinth,andarCenterX,DIM.ground+DIM.plinth/2,andarCenterZ,andarLength,DIM.plinth,andarDepth,"roof");

  addFacadeSection("Rangmahal_GF",split,xMax,rangBays,[gf],lod);
  addFacadeSection("Rangmahal_FF",split,xMax,rangBays,[ff],lod);
  addFacadeSection("Andarmahal",xMin,split,andarBays,[gf,ff],lod,andarCenterZ,andarDepth);

  // Model the short elevations of both blocks, including the exposed Rangmahal
  // west end beside the rear-set Andarmahal junction.
  addEndFacade("Andarmahal", xMin, -1, [gf, ff], 6, lod,andarCenterZ,andarDepth);
  // Only the south half of the Rangmahal west end is exposed; its north
  // half joins the set-back Andarmahal instead of double-stacking two walls.
  addEndFacade("Rangmahal_GF", split, -1, [gf], 6, lod, D / 4, D / 2);
  addEndFacade("Rangmahal_FF", split, -1, [ff], 6, lod, D / 4, D / 2);
  addEndFacade("Rangmahal_GF", xMax, 1, [gf], 6, lod);
  addEndFacade("Rangmahal_FF", xMax, 1, [ff], 6, lod);

  box(n.Rangmahal_GF,(split+xMax)/2,gfBase+gfHeight+DIM.slab/2,0,rangLength,DIM.slab,D,"marble");
  box(n.Rangmahal_FF,(split+xMax)/2,ffBase+ffHeight+DIM.slab/2,0,rangLength,DIM.slab,D,"marble");
  box(n.Andarmahal,andarCenterX,gfBase+gfHeight+DIM.slab/2,andarCenterZ,andarLength,DIM.slab,andarDepth,"marble");
  box(n.Andarmahal,andarCenterX,ffBase+ffHeight+DIM.slab/2,andarCenterZ,andarLength,DIM.slab,andarDepth,"marble");

  // Separate roof decks preserve the stepped/L-shaped footprint: the main
  // Rangmahal faces the river, while Andarmahal is set back to the north.
  const rangCenterX = (split + xMax) / 2;
  box(n.Parapet,rangCenterX,roofTop-.08,0,rangLength,.16,D,"roof");
  box(n.Parapet,andarCenterX,roofTop-.08,andarCenterZ,andarLength,.16,andarDepth,"roof");

  for(const side of [-1,1]){
    const rangZ=side*(half+.12);
    const andarZ=andarCenterZ+side*(andarDepth/2+.12);
    if(lod<3){
      // Low-detail LODs keep a compact silhouette from neighbourhood scale.
      box(n.Parapet,rangCenterX,roofTop+DIM.parapet/2,side*(half-.12),rangLength,DIM.parapet,.4,"pink");
      box(n.Parapet,andarCenterX,roofTop+DIM.parapet/2,andarCenterZ+side*(andarDepth/2-.12),andarLength,DIM.parapet,.4,"pink");
    }else{
      // LOD3 uses the open baluster parapet from the HTML scene instead of
      // a solid pink wall, which was making the roof read as a block.
      box(n.Parapet,rangCenterX,roofTop+.71,rangZ,rangLength,.18,.42,"sceneTrim");
      box(n.Parapet,andarCenterX,roofTop+.71,andarZ,andarLength,.18,.42,"sceneTrim");
      for(let i=0;i<=28;i++){
        const x=split+rangLength*i/28;
        siteFrustum(n.Parapet,x,rangZ,roofTop+.03,roofTop+.65,.13,.09,"sceneTrim",8);
      }
      for(let i=0;i<=34;i++){
        const x=xMin+andarLength*i/34;
        siteFrustum(n.Parapet,x,andarZ,roofTop+.03,roofTop+.65,.13,.09,"sceneTrim",8);
      }
    }
  }

  // Short-end roof rails are open in the detailed model, as in the HTML scene.
  // Distant LODs retain simple solid returns to avoid expensive tiny balusters.
  const endRails=[
    {x:xMax+.12,z:0,depth:D},
    {x:split-.12,z:D/4,depth:D/2},
    {x:xMin-.12,z:andarCenterZ,depth:andarDepth},
  ];
  for (const edge of endRails) {
    if(lod<3){
      box(n.Parapet,edge.x,roofTop+DIM.parapet/2,edge.z,.4,DIM.parapet,edge.depth,"pink");
    }else{
      box(n.Parapet,edge.x,roofTop+.71,edge.z,.42,.18,edge.depth,"sceneTrim");
      const count=Math.max(4,Math.ceil(edge.depth/2));
      for(let i=0;i<=count;i++){
        const z=edge.z-edge.depth/2+edge.depth*i/count;
        siteFrustum(n.Parapet,edge.x,z,roofTop+.03,roofTop+.65,.13,.09,"sceneTrim",8);
      }
    }
  }

  // Small roofline pinnacles reinforce the main Rangmahal's symmetric silhouette.
  if (lod === 3) {
    for (const side of [-1, 1]) {
      for (const x of [
        split + 2.2,
        split + rangLength * .25,
        split + rangLength * .75,
        xMax - 2.2,
      ]) {
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

  // South veranda follows the 62.7 m Rangmahal facade; the north veranda follows
  // the rear edge of both blocks, with the columns kept aligned along the facade.
  for(const [name,side] of [["Veranda_S",1],["Veranda_N",-1]]){
    const verandaStart = side===1 ? split : xMin;
    const verandaLength = side===1 ? rangLength : L;
    const verandaCenterX = verandaStart + verandaLength/2;
    const verandaCount=Math.max(8,Math.round(verandaLength/DIM.verandaSpan));
    const verandaPitch=verandaLength/verandaCount;
    const z=side===1 ? half+1.22 : -(half+1.22);
    box(byName[name],verandaCenterX,gfBase+.12,z,verandaLength,.24,2.44,"marble");
    box(byName[name],verandaCenterX,ffBase+.12,z,verandaLength,.24,2.44,"marble");
    if(lod>=2){
      for(const [base,h] of [[gfBase,gfHeight],[ffBase,ffHeight]]){
        const spring=base+h-verandaPitch/2;
        for(let i=0;i<=verandaCount;i++){
          const x=verandaStart+i*verandaPitch;
          verticalCylinder(byName[name],x,base,base+h,z,.18,"trim",8);
          box(byName[name],x,base+.13,z,.48,.26,.48,"trim");
          box(byName[name],x,base+h-.12,z,.48,.24,.48,"trim");
        }
        if(lod===3){
          for(let i=0;i<verandaCount;i++){
            const x=verandaStart+(i+.5)*verandaPitch;
            archBand(byName[name],x,spring,z,verandaPitch/2,.10,"trim",12);
          }
        }
      }
    }
  }

  // Upper veranda balustrades: the public south-facing balcony belongs to
  // Rangmahal; the north/rear railing spans the full back edge.
  if (lod === 3) {
    const railBase = ffBase + 0.22;
    const railTop = railBase + DIM.balustradeHeight;
    for (const side of [-1, 1]) {
      const railStart = side===1 ? split : xMin;
      const railLength = side===1 ? rangLength : L;
      const railZ = side===1 ? half + 2.26 : -(half + 2.26);
      const balusterCount = Math.ceil(railLength / DIM.balusterSpacing);
      const node = byName[side === 1 ? "Veranda_S" : "Veranda_N"];
      barBetween(node,
        [railStart, railBase, railZ], [railStart+railLength, railBase, railZ], 0.11, "rail");
      barBetween(node,
        [railStart, railTop, railZ], [railStart+railLength, railTop, railZ], 0.11, "rail");
      for (let i = 0; i <= balusterCount; i++) {
        const x = railStart + (railLength * i / balusterCount);
        verticalCylinder(node,x,railBase,railTop,railZ,.035,"rail",6);
      }
    }
  }

  // Matching south (river-front) and north (rear) triple-arched porticos.
  for(const [name,side] of [["Portico_S",1],["Portico_N",-1]]){
    const width=DIM.porticoWidth,depth=DIM.porticoDepth,z=side*(half+depth/2+.18),faceZ=z+side*depth/2;
    box(byName[name],domeX,ffBase-.15,side*(half+depth/2),width,.30,depth,"marble");
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
      box(byName[name],domeX,ffBase-.15,faceZ,width+.5,.3,.8,"pink");

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

        // Recessed timber door with an arched glazed head behind the centre
        // upper arch. Side arches remain visually open.
        fillFacadeArch(
          byName[name], domeX, upperBase, side * half, side,
          3.8, 4.2, DIM.wall, lod === 3 ? 2 : lod === 2 ? 1 : 0, true,
        );

        if (lod === 3) {
          // Balcony rails are segmented at the centre so the main doorway remains clear.
          const balconyZ = faceZ + side * .38;
          const balconyBottom = upperBase + .25;
          const balconyTop = upperBase + .98;
          const segments = [
            [domeX - width / 2 + .34, domeX - span / 2 - .28],
            [domeX + span / 2 + .28, domeX + width / 2 - .34],
          ];
          for (const [left, right] of segments) {
            if (right <= left) continue;
            barBetween(byName[name],[left,balconyBottom,balconyZ],[right,balconyBottom,balconyZ],.09,"rail");
            barBetween(byName[name],[left,balconyTop,balconyZ],[right,balconyTop,balconyZ],.09,"rail");
            const count=Math.max(2,Math.ceil((right-left)/.48));
            for(let i=0;i<=count;i++){
              const x=left+(right-left)*i/count;
              verticalCylinder(byName[name],x,balconyBottom,balconyTop,balconyZ,.035,"trim",6);
            }
          }
        }
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
        // Moulded triangular outline and restrained central relief.
        barBetween(byName[name], pedimentLeft, pedimentRight, .22, "trim");
        barBetween(byName[name], pedimentLeft, pedimentApex, .18, "trim");
        barBetween(byName[name], pedimentApex, pedimentRight, .18, "trim");
        box(byName[name], domeX, pedimentBase + .42, frontZ + side * .09, 2.7, .55, .16, "trim");
        box(byName[name], domeX, pedimentBase + .42, frontZ + side * .18, 1.65, .25, .08, "roof");

        // Circular oculus on the temple-front pediment; the exact diameter is [E].
        const oculusY=pedimentBase+(pedimentTop-pedimentBase)*.60;
        const oculusZ=frontZ+side*.12;
        addFacadeDisk(byName[name],domeX,oculusY,oculusZ,.38,"glass",side,32);
        addFacadeRing(byName[name],domeX,oculusY,oculusZ+side*.015,.58,.41,"trim",side,32);

        // Small corner pinnacles frame the central pavilion without replacing the main dome.
        for(const pinSide of [-1,1]){
          const px=domeX+pinSide*(width/2+.95);
          const pz=frontZ+side*.05;
          box(byName[name],px,pedimentBase+.18,pz,.72,.36,.72,"trim");
          verticalCylinder(byName[name],px,pedimentBase+.36,pedimentTop+.42,pz,.12,"trim",8);
          addDomeProfile(
            byName[name],px,pz,pedimentTop+.30,
            [[.22,0],[.16,.16],[.09,.33],[.006,.58]],8,"roof",
          );
        }
      }
    }
  }

  // Broad garden-to-river stair rises to the upper portal.
  const stair=byName.Stair_S,steps=lod===1?8:lod===2?20:DIM.stepCount;
  const run=DIM.stairRun;
  const stepDepth=lod===3?DIM.stairTread:run/steps;
  const rise=lod===3?DIM.stairRiser:ffBase/steps;
  const stairBaseWidth = DIM.stairWidth;
  const stairTopWidth = DIM.stairWidthTop;
  const stairTopZ = half + 2.7; // matches the reference scene's projecting upper stair landing
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
    const t = steps <= 1 ? 1 : i / (steps - 1);
    const top=(i+1)*rise;
    const z=stairTopZ+run-stepDepth*(i+.5);
    const width=stairBaseWidth+(stairTopWidth-stairBaseWidth)*t;
    box(stair,domeX,top/2,z,width,top,stepDepth,"stair");
  }
  if(lod>=2){
    // Tapered cheek balustrades follow the stair and connect to the portal.
    for(const side of [-1,1]){
      const lowerX=domeX+side*(stairBaseWidth/2+.2);
      const upperX=domeX+side*(stairTopWidth/2+.2);
      const lowerZ=stairTopZ+run;
      const upperZ=stairTopZ;
      barBetween(stair,[lowerX,.35,lowerZ],[upperX,ffBase+.25,upperZ],lod===3?.24:.16,"rail");
      barBetween(stair,[lowerX,.70,lowerZ],[upperX,ffBase+.55,upperZ],.10,"trim");
      for(let i=1;i<12;i++){
        const t=i/12;
        const x=lowerX+(upperX-lowerX)*t;
        const z=lowerZ+(upperZ-lowerZ)*t;
        const y=.35+(ffBase+.25-.35)*t;
        verticalCylinder(stair,x,y,y+.48,z,.045,"rail",6);
      }
    }
    if(lod===3){
      // Paired low lamp posts anchor the broad stair to the garden.
      for(const side of [-1,1]){
        const x=domeX+side*(stairBaseWidth/2+1.1),z=stairTopZ+run+.35;
        box(stair,x,.18,z,.62,.36,.62,"trim");
        verticalCylinder(stair,x,.36,1.05,z,.13,"rail",10);
        box(stair,x,1.12,z,.48,.20,.48,"trim");
        verticalCylinder(stair,x,1.22,1.72,z,.18,"trim",10);
        addDomeProfile(stair,x,z,1.68,[[.19,0],[.14,.12],[.07,.24],[.006,.34]],10,"gold");
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
  const domeRadius=Math.max(...domeProfile.map(([radius])=>radius));
  const domeRise=Math.max(...domeProfile.map(([,height])=>height));
  // Match the smooth, vertically stretched hemispherical dome in the HTML scene.
  addDomeProfile(n.Dome,domeX,0,drumTop,domeProfile,lod===1?12:lod===2?20:36,"sceneDome");
  if(lod===3){
    // The HTML reference has four horizontal torus mouldings rather than
    // radial ribs. Thin annular bands reproduce that recognizable silhouette.
    for(const phi of [.35,.68,1.0,1.28]){
      horizontalRing(n.Dome,domeX,0,drumTop+domeRise*Math.sin(phi),
        domeRadius*Math.cos(phi),.15,"sceneTrim",48);
    }
    horizontalRing(n.Dome,domeX,0,drumTop+.16,domeRadius,.14,"sceneTrim",48);
  }
  const finialBase=DIM.peak-DIM.finialHeight;
  verticalCylinder(n.Finial,domeX,finialBase,finialBase+.9,0,.12,"trim",12);
  verticalCylinder(n.Finial,domeX,finialBase+.55,finialBase+.85,0,.24,"gold",12);
  addDomeProfile(n.Finial,domeX,0,finialBase,[[.24,0],[.18,.2],[.11,.55],[.04,.95],[.004,DIM.finialHeight]],12,"gold");

  // Port the surrounding site from the reference Three.js scene into the same
  // georeferenced GLB, so the in-map model includes its ground, approach, water,
  // pond, family mosque, trees and contextual Old Dhaka blocks—not only the palace.
  // The reference HTML has its Rangmahal centered at x=0; shift its site context
  // east by the same 34.8 m camera/footprint offset used by the existing map model.
  const siteShiftX = V("runtimeCamera", "frontFocusOffsetEastMeters");
  // Keep the land and river planes contiguous (rather than coplanar/overlapping)
  // and slightly above the globe's anchor surface so Cesium terrain does not hide them.
  horizontalPlane(byName.Site_Ground, siteShiftX, 0.015, -15, 440, 270, "sceneGrass");
  horizontalPlane(byName.Site_River, siteShiftX, 0.005, 205, 440, 170, "sceneWater");
  horizontalPlane(byName.Site_Approach, siteShiftX, 0.025, 63, 8, 58, "scenePath");

  // Family mosque, represented by the same illustrative massing used in the HTML.
  const mosque = byName.Site_Family_Mosque;
  siteBox(mosque,14,5.2,11,siteShiftX+64,0,-5,"sceneWhite");
  siteBox(mosque,14.5,.35,11.5,siteShiftX+64,5.2,-5,"sceneTrim");
  for (const [offset, radius] of [[-4.5,1.5],[0,2.25],[4.5,1.5]]) {
    ellipsoid(mosque,siteShiftX+64+offset,6.2,-5,radius,radius*.7,radius,
      "sceneWhite",lod===3?18:lod===2?12:8,lod===3?10:6);
  }
  for (const offset of [-4.5,4.5]) {
    siteBox(mosque,.65,8,.65,siteShiftX+64+offset,0,-5,"sceneWhite");
  }

  // Small stable/service building and the shallow oval pond behind the palace.
  const stable = byName.Site_Stable;
  siteBox(stable,25,3.4,8,siteShiftX-70,0,-32,"sceneStone");
  siteBox(stable,26,.4,8,siteShiftX-70,3.4,-32,"sceneDark");
  horizontalEllipse(byName.Site_Pond,siteShiftX-100,.02,-34,8,5,"sceneWater",lod===3?40:24);

  // Deterministic tree placement mirrors the reference HTML output.
  const siteRandom = (() => {
    let state = 24591;
    return () => ((state = (state * 16807) % 2147483647) - 1) / 2147483646;
  })();
  const trees = byName.Site_Trees;
  const treeColors = ["sceneTree0","sceneTree1","sceneTree2","sceneTree3"];
  const treeSegments = lod===3?12:lod===2?8:6;
  for (let i = 0; i < 70; i++) {
    const x = (siteRandom() - .5) * 210;
    const z = -55 + siteRandom() * 118;
    if (Math.abs(x) < 38 && z > -20 && z < 42) continue;
    const worldX = x + siteShiftX;
    siteFrustum(trees,worldX,z,0,3.6,.30,.18,"sceneWood",7);
    const rx = 1.6 + siteRandom() * 1.2;
    const ry = 1.8 + siteRandom() * 1.5;
    const rz = 1.6 + siteRandom() * 1.2;
    const crownY = 4.2 + siteRandom() * 1.2;
    ellipsoid(trees,worldX,crownY,z,rx,ry,rz,treeColors[i%4],treeSegments,Math.max(4,Math.round(treeSegments*.6)));
  }

  // Neighbouring Old Dhaka blocks in the northern/rear context.
  const blocks = byName.Site_Context_Blocks;
  const blockPalette = ["sceneBlock0","sceneBlock1","sceneBlock2","sceneBlock3"];
  for (let i = 0; i < 26; i++) {
    const x = -125 + i * 9.5;
    const z = -67 - siteRandom() * 16;
    const width = 5 + siteRandom() * 4;
    const height = 6 + siteRandom() * 10;
    const depth = 5 + siteRandom() * 4;
    siteBox(blocks,width,height,depth,siteShiftX+x,0,z,blockPalette[i%4]);
  }
  for (const side of [-1,1]) {
    for (let j = 0; j < 6; j++) {
      const x = side * (103 + siteRandom() * 13);
      const z = -40 + j * 13;
      const width = 6 + siteRandom() * 3;
      const height = 6 + siteRandom() * 8;
      const depth = 7 + siteRandom() * 3;
      siteBox(blocks,width,height,depth,siteShiftX+x,0,z,blockPalette[j%3]);
    }
  }

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
