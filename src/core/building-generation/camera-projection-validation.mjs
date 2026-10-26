const EPS=1e-12;
const finiteNumber=value=>typeof value==="number"&&Number.isFinite(value);
function positiveInteger(value){return Number.isInteger(value)&&value>0;}
function validHash(value){return typeof value==="string"&&/^[a-f0-9]{64}$/i.test(value);}
function matrixRank3(matrix){
 const cols=[0,1,2,3];
 for(let a=0;a<4;a++)for(let b=a+1;b<4;b++)for(let c=b+1;c<4;c++){
  const m=matrix.map(row=>[row[a],row[b],row[c]]);
  const det=m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  if(Math.abs(det)>EPS)return true;
 }
 return false;
}
function project(projection,point){
 const q=projection.map(row=>row[0]*point[0]+row[1]*point[1]+row[2]*point[2]+row[3]);
 if(Math.abs(q[2])<EPS)return null;
 return {x:q[0]/q[2],y:q[1]/q[2]};
}
/**
 * Validate matrix shape and evidence metadata separately from proving calibration correctness.
 * Independent 3D control points, when supplied, are reprojected and reported per observation.
 */
export function validateCameraProjectionEvidence({cameras,observations=[],maxReprojectionErrorPixels=3}={}){
 const errors=[],warnings=[],cameraReports=[];
 if(!Array.isArray(cameras)||cameras.length===0)throw new TypeError("cameras must be a non-empty array");
 if(!Array.isArray(observations))throw new TypeError("observations must be an array");
 if(!finiteNumber(maxReprojectionErrorPixels)||maxReprojectionErrorPixels<=0)throw new RangeError("maxReprojectionErrorPixels must be positive");
 const seen=new Set(),byId=new Map();
 for(const camera of cameras){
  const local=[];
  if(!camera||typeof camera.id!=="string"||!camera.id){errors.push({code:"missing-camera-id"});continue;}
  if(seen.has(camera.id)){errors.push({code:"duplicate-camera-id",cameraId:camera.id});continue;}seen.add(camera.id);
  if(!Array.isArray(camera.projection)||camera.projection.length!==3||camera.projection.some(row=>!Array.isArray(row)||row.length!==4||row.some(v=>!finiteNumber(v)))){
   local.push("projection-must-be-finite-3x4");
  }else if(!matrixRank3(camera.projection)){local.push("projection-matrix-rank-below-three");}
  if(!camera.imageSize||!positiveInteger(camera.imageSize.width)||!positiveInteger(camera.imageSize.height))local.push("image-size-must-be-positive-integers");
  if(typeof camera.coordinateFrame!=="string"||!camera.coordinateFrame.trim())local.push("coordinate-frame-required");
  if(!["verified","review-required","unaudited"].includes(camera.calibrationStatus))local.push("calibration-status-invalid");
  if(camera.calibrationStatus==="verified"&&(!camera.calibrationEvidence||typeof camera.calibrationEvidence.sourceId!=="string"||!camera.calibrationEvidence.sourceId||!validHash(camera.calibrationEvidence.sha256))){
   local.push("verified-calibration-requires-source-id-and-sha256");
  }
  if(camera.calibrationStatus!=="verified")warnings.push({code:"calibration-not-independently-verified",cameraId:camera.id,status:camera.calibrationStatus??"missing"});
  if(local.length)errors.push(...local.map(code=>({code,cameraId:camera.id})));
  const report={cameraId:camera.id,status:local.length?"failed":camera.calibrationStatus==="verified"?"structurally-valid-evidence-linked":"review-required",issues:local};
  cameraReports.push(report);byId.set(camera.id,camera);
 }
 const reprojectionReports=[];
 for(let i=0;i<observations.length;i++){
  const obs=observations[i],id=obs?.cameraId;
  if(typeof id!=="string"||!byId.has(id)){errors.push({code:"observation-camera-unknown",index:i,cameraId:id??null});continue;}
  const camera=byId.get(id);
  if(!finiteNumber(obs.x)||!finiteNumber(obs.y)){errors.push({code:"observation-pixel-invalid",index:i,cameraId:id});continue;}
  if(camera.imageSize&&positiveInteger(camera.imageSize.width)&&positiveInteger(camera.imageSize.height)&&
    (obs.x<0||obs.y<0||obs.x>=camera.imageSize.width||obs.y>=camera.imageSize.height)){
   errors.push({code:"observation-outside-image-bounds",index:i,cameraId:id,x:obs.x,y:obs.y,width:camera.imageSize.width,height:camera.imageSize.height});
  }
  if(obs.worldPoint!==undefined){
   if(!Array.isArray(obs.worldPoint)||obs.worldPoint.length!==3||obs.worldPoint.some(v=>!finiteNumber(v))){
    errors.push({code:"control-world-point-invalid",index:i,cameraId:id});continue;
   }
   if(!Array.isArray(camera.projection)||camera.projection.length!==3||camera.projection.some(row=>!Array.isArray(row)||row.length!==4||row.some(v=>!finiteNumber(v))))continue;
   const projected=project(camera.projection,obs.worldPoint);
   if(!projected){errors.push({code:"control-point-at-camera-horizon",index:i,cameraId:id});reprojectionReports.push({index:i,cameraId:id,status:"failed"});continue;}
   const errorPixels=Math.hypot(projected.x-obs.x,projected.y-obs.y);
   reprojectionReports.push({index:i,cameraId:id,observed:{x:obs.x,y:obs.y},projected,errorPixels,status:errorPixels<=maxReprojectionErrorPixels?"within-threshold":"review-required"});
   if(errorPixels>maxReprojectionErrorPixels)errors.push({code:"reprojection-error-exceeds-threshold",index:i,cameraId:id,errorPixels,threshold:maxReprojectionErrorPixels});
  }
 }
 const status=errors.length?"failed":warnings.length||cameraReports.some(c=>c.status==="review-required")?"review-required":"structurally-valid";
 return {schemaVersion:"1.0.0",status,publicationEligible:false,cameraCount:cameras.length,observationCount:observations.length,maxReprojectionErrorPixels,cameraReports,reprojectionReports,errors,warnings,limitations:["Matrix shape and rank do not prove correct calibration.","Reprojection is evaluated only for observations carrying independently checked worldPoint coordinates.","No scale, world origin, camera pose, or missing geometry is inferred.","Source hashes establish artifact identity, not the truth of calibration or survey claims."]};
}
