export const BOX_POSITIONS=[[0,0,0],[2,0,0],[2,3,0],[0,3,0],[0,0,4],[2,0,4],[2,3,4],[0,3,4]];
export const BOX_TRIANGLES=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
export const TARGET_VERTICES=BOX_POSITIONS.map(([x,y,z])=>[x+11,y+1,z+22]);
export const TARGET_FOOTPRINT=[{x:11,z:22},{x:13,z:22},{x:13,z:26},{x:11,z:26}];
export const TARGET_CHECK_POINTS=[{id:"survey-check-01",x:11,y:1,z:22},{id:"survey-check-02",x:13,y:1,z:22},{id:"survey-check-03",x:13,y:4,z:26}];
export const MODEL_TO_EVALUATION=[1,0,0,0,0,1,0,0,0,0,1,0,10,0,20,1];
function pad4(buffer,value){const n=(4-buffer.length%4)%4;return n?Buffer.concat([buffer,Buffer.alloc(n,value)]):buffer;}
export function createBuildingGlb(mutate=null){
  const pos=Buffer.alloc(BOX_POSITIONS.length*12);let offset=0;
  for(const p of BOX_POSITIONS)for(const v of p){pos.writeFloatLE(v,offset);offset+=4;}
  const ids=BOX_TRIANGLES.flat(),index=Buffer.alloc(ids.length*2);ids.forEach((v,i)=>index.writeUInt16LE(v,i*2));
  const binary=Buffer.concat([pos,index]);
  const json={asset:{version:"2.0",generator:"brf-09-fixture"},scene:0,scenes:[{nodes:[0]}],
    nodes:[{translation:[1,0,2],children:[1]},{mesh:0,translation:[0,1,0]}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,mode:4}]}],
    buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:pos.length},{buffer:0,byteOffset:pos.length,byteLength:index.length}],
    accessors:[{bufferView:0,componentType:5126,count:BOX_POSITIONS.length,type:"VEC3"},{bufferView:1,componentType:5123,count:ids.length,type:"SCALAR"}]};
  if(mutate)mutate(json);
  const j=pad4(Buffer.from(JSON.stringify(json)),0x20),b=pad4(binary,0),total=12+8+j.length+8+b.length;
  const h=Buffer.alloc(12);h.writeUInt32LE(0x46546c67,0);h.writeUInt32LE(2,4);h.writeUInt32LE(total,8);
  const jh=Buffer.alloc(8);jh.writeUInt32LE(j.length,0);jh.writeUInt32LE(0x4e4f534a,4);
  const bh=Buffer.alloc(8);bh.writeUInt32LE(b.length,0);bh.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([h,jh,j,bh,b]);
}
export function surveyGeometryDocument({coordinateFrameId="test-building-frame-y-up-v1",localCoordinates=false}={}){
  const footprint=localCoordinates
    ? [{x:0,z:0},{x:2,z:0},{x:2,z:4},{x:0,z:4}]
    : TARGET_FOOTPRINT;
  const vertices=localCoordinates?BOX_POSITIONS:TARGET_VERTICES;
  const points=localCoordinates
    ? [{id:"survey-check-01",x:0,y:0,z:0},{id:"survey-check-02",x:2,y:0,z:0},{id:"survey-check-03",x:2,y:3,z:4}]
    : TARGET_CHECK_POINTS;
  return {schemaVersion:"1.0.0",sourceId:"surveyed-test-building-01",evidenceBasis:"surveyed",
    sourceDescription:"Synthetic fixture used only for parser regression tests, not real-world evidence.",
    reviewedBy:"test-reviewer",reviewedAt:"2026-10-27T08:00:00.000Z",
    coordinateFrameId,units:"m",footprintElevationM:localCoordinates?0:1,footprint,
    dimensionsM:{widthM:2,depthM:4,heightM:3},
    checkPoints:points.map(p=>({...p,independentOfFit:true})),
    surfaceMesh:{vertices,triangles:BOX_TRIANGLES}};
}
