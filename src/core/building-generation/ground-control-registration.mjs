const EARTH_RADIUS_M=6378137;
const ID=/^[a-z0-9][a-z0-9._-]{0,79}$/i;
function finite(value,label){if(typeof value!=="number"||!Number.isFinite(value))throw new TypeError(label+" must be a finite number");return value;}
function wrapRadians(value){return ((value+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;}
function wrapDegrees(value){return ((value%360)+360)%360;}
function mean(values){return values.reduce((sum,value)=>sum+value,0)/values.length;}
function insideRange(value,min,max,label){if(value<min||value>max)throw new RangeError(label+" must be between "+min+" and "+max);return value;}
function normalizedControlPoints(raw){
 if(!Array.isArray(raw)||raw.length<3||raw.length>100)throw new RangeError("at least 3 and at most 100 ground-control points are required");
 const seen=new Set();
 return raw.map((point,index)=>{
  if(!point||typeof point!=="object"||Array.isArray(point))throw new TypeError("controlPoints["+index+"] must be an object");
  const id=point.id;
  if(typeof id!=="string"||!ID.test(id))throw new TypeError("controlPoints["+index+"].id is invalid");
  if(seen.has(id))throw new TypeError("duplicate ground-control point ID: "+id);seen.add(id);
  return {
   id,modelX:finite(point.modelX,"modelX"),modelZ:finite(point.modelZ,"modelZ"),
   longitude:insideRange(finite(point.longitude,"longitude"),-180,180,"longitude"),
   latitude:insideRange(finite(point.latitude,"latitude"),-85,85,"latitude"),
   ...(point.evidenceSourceId!==undefined?{evidenceSourceId:point.evidenceSourceId}:{}),
   ...(point.description!==undefined?{description:String(point.description).slice(0,500)}:{})
  };
 });
}
function localProjection(points){
 const lat0=mean(points.map(p=>p.latitude))*Math.PI/180;
 const lonSin=mean(points.map(p=>Math.sin(p.longitude*Math.PI/180))),lonCos=mean(points.map(p=>Math.cos(p.longitude*Math.PI/180)));
 const lon0=Math.atan2(lonSin,lonCos);
 const coords=points.map(p=>{
  const lat=p.latitude*Math.PI/180,lon=p.longitude*Math.PI/180;
  return {
   east:wrapRadians(lon-lon0)*EARTH_RADIUS_M*Math.cos(lat0),
   north:(lat-lat0)*EARTH_RADIUS_M
  };
 });
 return {originLongitude:lon0*180/Math.PI,originLatitude:lat0*180/Math.PI,lat0,lon0,coords};
}
function covariance(points,keyX,keyZ){
 const xs=points.map(p=>p[keyX]),zs=points.map(p=>p[keyZ]),mx=mean(xs),mz=mean(zs);
 let xx=0,zz=0,xz=0;
 for(let i=0;i<points.length;i++){const x=xs[i]-mx,z=zs[i]-mz;xx+=x*x;zz+=z*z;xz+=x*z;}
 return {mx,mz,xx,zz,xz,determinant:xx*zz-xz*xz,spread:xx+zz};
}
function inverseProjection(east,north,lon0,lat0){
 const latitude=lat0+north/EARTH_RADIUS_M,cosLat=Math.cos(lat0);
 if(Math.abs(cosLat)<1e-6)throw new RangeError("control-point mean latitude is too close to a pole for local tangent-plane registration");
 return {longitude:wrapRadians(lon0+east/(EARTH_RADIUS_M*cosLat))*180/Math.PI,latitude:latitude*180/Math.PI};
}

/**
 * Fit a 2D similarity transform from GLB model-ground coordinates (X,Z; Y is up)
 * to operator-surveyed WGS84 control points. This estimates horizontal scale,
 * rotation and translation; it does not solve vertical datum or publish a model.
 */
export function registerModelToWgs84(options){
 if(!options||typeof options!=="object")throw new TypeError("registration options are required");
 const points=normalizedControlPoints(options.controlPoints);
 const maxRmsErrorM=options.maxRmsErrorM??0.5,maxResidualM=options.maxResidualM??1.0;
 if(!Number.isFinite(maxRmsErrorM)||maxRmsErrorM<=0||maxRmsErrorM>100)throw new RangeError("maxRmsErrorM must be in (0,100]");
 if(!Number.isFinite(maxResidualM)||maxResidualM<=0||maxResidualM>100)throw new RangeError("maxResidualM must be in (0,100]");
 const model=covariance(points,"modelX","modelZ");
 if(model.spread<0.01||model.determinant<1e-8)throw new RangeError("control points must cover a two-dimensional, non-collinear area in model X/Z coordinates");
 const ground=localProjection(points),targets=ground.coords;
 const mx=model.mx,mz=model.mz,me=mean(targets.map(p=>p.east)),mn=mean(targets.map(p=>p.north));
 let numeratorA=0,numeratorB=0;
 for(let i=0;i<points.length;i++){
  const x=points[i].modelX-mx,z=points[i].modelZ-mz,e=targets[i].east-me,n=targets[i].north-mn;
  numeratorA+=x*e+z*n;
  numeratorB+=x*n-z*e;
 }
 const a=numeratorA/model.spread,b=numeratorB/model.spread,scale=Math.hypot(a,b);
 if(!Number.isFinite(scale)||scale<0.0001||scale>1000)throw new RangeError("derived metresPerModelUnit must be between 0.0001 and 1000");
 const theta=Math.atan2(b,a),cos=Math.cos(theta),sin=Math.sin(theta);
 const tx=me-(a*mx-b*mz),ty=mn-(b*mx+a*mz);
 const residuals=points.map((point,index)=>{
  const predictedEast=a*point.modelX-b*point.modelZ+tx,predictedNorth=b*point.modelX+a*point.modelZ+ty;
  const de=predictedEast-targets[index].east,dn=predictedNorth-targets[index].north;
  return {id:point.id,errorM:Number(Math.hypot(de,dn).toFixed(4)),eastResidualM:Number(de.toFixed(4)),northResidualM:Number(dn.toFixed(4)),...(point.evidenceSourceId?{evidenceSourceId:point.evidenceSourceId}:{})};
 });
 const rmsErrorM=Math.sqrt(residuals.reduce((sum,p)=>sum+p.errorM*p.errorM,0)/residuals.length),maxErrorM=Math.max(...residuals.map(p=>p.errorM));
 const thresholdPass=rmsErrorM<=maxRmsErrorM&&maxErrorM<=maxResidualM;
 const modelXAxisBearingDegrees=wrapDegrees(Math.atan2(a,b)*180/Math.PI);
 const modelOrigin=inverseProjection(tx,ty,ground.lon0,ground.lat0);
 return {
  schemaVersion:"1.0.0",engine:"ground-control-similarity-registration-v1",
  status:thresholdPass?"calibrated-needs-human-review":"calibration-failed-review-required",
  method:"2D least-squares similarity fit from operator-supplied WGS84 ground-control points",
  controls:{count:points.length,ids:points.map(p=>p.id),residuals,maxResidualM:Number(maxErrorM.toFixed(4)),rmsErrorM:Number(rmsErrorM.toFixed(4)),maxRmsErrorM,maxAllowedResidualM:maxResidualM,thresholdPass},
  transform:{metresPerModelUnit:Number(scale.toFixed(9)),rotationFromModelXToEastNorthDegrees:Number((theta*180/Math.PI).toFixed(6)),modelXAxisBearingDegrees:Number(modelXAxisBearingDegrees.toFixed(6)),translationEastM:Number(tx.toFixed(4)),translationNorthM:Number(ty.toFixed(4)),modelOrigin},
  referenceOrigin:{longitude:Number(ground.originLongitude.toFixed(9)),latitude:Number(ground.originLatitude.toFixed(9)),projection:"local tangent-plane approximation using WGS84 mean latitude"},
  vertical:{status:"not-solved",reason:"Ground-control inputs contain horizontal WGS84 coordinates only; vertical datum/height must be calibrated separately."},
  mapReady:false,publicationEligible:false,
  warnings:[
   ...(thresholdPass?[]:["Ground-control residual exceeds the configured tolerance; do not accept this transform."]),
   "Check control-point IDs, physical correspondence, model X/Z orientation and survey accuracy before applying this registration.",
   "Horizontal registration does not validate the building mesh, vertical elevation datum, facade-facing semantics or architectural accuracy.",
   "This report is not a publish/approve action; mapReady and publicationEligible remain false.",
  ],
 };
}