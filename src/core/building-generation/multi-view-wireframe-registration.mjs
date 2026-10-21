const EPS=1e-12;
function finiteNumber(value){return typeof value==="number"&&Number.isFinite(value);}
export function validateCamera(camera){
 if(!camera||typeof camera.id!=="string"||!camera.id)throw new TypeError("camera id is required");
 if(!Array.isArray(camera.projection)||camera.projection.length!==3||camera.projection.some(row=>!Array.isArray(row)||row.length!==4||row.some(v=>!finiteNumber(v))))throw new TypeError("camera projection must be a finite 3x4 calibrated projection matrix");
 return camera;
}
export function projectPoint(camera,point){
 validateCamera(camera);
 if(!Array.isArray(point)||point.length!==3||point.some(v=>!finiteNumber(v)))throw new TypeError("3D point must contain three finite coordinates");
 const p=camera.projection,x=point[0],y=point[1],z=point[2];
 const q=p.map(row=>row[0]*x+row[1]*y+row[2]*z+row[3]);
 if(Math.abs(q[2])<EPS)throw new RangeError("point projects to the camera horizon");
 return {x:q[0]/q[2],y:q[1]/q[2]};
}
function smallestEigenvectorSymmetric4(matrix){
 const a=matrix.map(row=>row.slice()),v=Array.from({length:4},(_,i)=>Array.from({length:4},(_,j)=>i===j?1:0));
 for(let iter=0;iter<100;iter++){
  let p=0,q=1,max=Math.abs(a[0][1]);
  for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)if(Math.abs(a[i][j])>max){max=Math.abs(a[i][j]);p=i;q=j;}
  if(max<1e-14)break;
  const angle=0.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(angle),s=Math.sin(angle);
  const app=c*c*a[p][p]-2*s*c*a[p][q]+s*s*a[q][q],aqq=s*s*a[p][p]+2*s*c*a[p][q]+c*c*a[q][q];
  for(let k=0;k<4;k++)if(k!==p&&k!==q){const akp=a[k][p],akq=a[k][q];a[k][p]=a[p][k]=c*akp-s*akq;a[k][q]=a[q][k]=s*akp+c*akq;}
  a[p][p]=app;a[q][q]=aqq;a[p][q]=a[q][p]=0;
  for(let k=0;k<4;k++){const vkp=v[k][p],vkq=v[k][q];v[k][p]=c*vkp-s*vkq;v[k][q]=s*vkp+c*vkq;}
 }
 let index=0;for(let i=1;i<4;i++)if(a[i][i]<a[index][index])index=i;
 return v.map(row=>row[index]);
}
function normalizeObservation(observation,cameraById){
 if(!observation||typeof observation.cameraId!=="string"||!cameraById.has(observation.cameraId)||!finiteNumber(observation.x)||!finiteNumber(observation.y))throw new TypeError("each observation needs a known cameraId and finite image x/y");
 return observation;
}
export function triangulateCorrespondence(observations,cameras){
 if(!Array.isArray(cameras)||cameras.length<2)throw new RangeError("at least two calibrated cameras are required");
 if(!Array.isArray(observations)||observations.length<2)throw new RangeError("at least two image observations are required");
 const cameraById=new Map(cameras.map(validateCamera).map(c=>[c.id,c]));
 if(cameraById.size!==cameras.length)throw new TypeError("camera ids must be unique");
 const unique=new Set();const rows=[];
 for(const raw of observations){
  const obs=normalizeObservation(raw,cameraById);if(unique.has(obs.cameraId))throw new TypeError("a feature may have at most one observation per camera");unique.add(obs.cameraId);
  const p=cameraById.get(obs.cameraId).projection;
  rows.push(p[0].map((v,i)=>obs.x*p[2][i]-v),p[1].map((v,i)=>obs.y*p[2][i]-v));
 }
 const normal=Array.from({length:4},()=>Array(4).fill(0));
 for(const row of rows)for(let i=0;i<4;i++)for(let j=0;j<4;j++)normal[i][j]+=row[i]*row[j];
 const h=smallestEigenvectorSymmetric4(normal);
 if(Math.abs(h[3])<EPS)throw new RangeError("triangulated point is at infinity or ill-conditioned");
 const point=h.slice(0,3).map(v=>v/h[3]);
 const errors=observations.map(obs=>{const pixel=projectPoint(cameraById.get(obs.cameraId),point);return {cameraId:obs.cameraId,observed:{x:obs.x,y:obs.y},projected:pixel,errorPixels:Math.hypot(pixel.x-obs.x,pixel.y-obs.y)};});
 const rmsReprojectionError=Math.sqrt(errors.reduce((sum,e)=>sum+e.errorPixels**2,0)/errors.length);
 return {point,viewCount:observations.length,rmsReprojectionError,reprojectionErrors:errors};
}
export function buildMultiViewWireframe({cameras,features,edges,options={}}){
 if(!Array.isArray(features)||!features.length)throw new TypeError("features must be a non-empty array");
 if(!Array.isArray(edges))throw new TypeError("edges must be an array of feature-id pairs");
 const maxRms=options.maxRmsReprojectionError??3;
 if(!finiteNumber(maxRms)||maxRms<=0)throw new RangeError("maxRmsReprojectionError must be positive");
 const ids=new Set(),vertices=[],issues=[],byId=new Map();
 for(const feature of features){
  if(!feature||typeof feature.id!=="string"||!feature.id||ids.has(feature.id))throw new TypeError("feature ids must be non-empty and unique");
  ids.add(feature.id);
  try{
   const result=triangulateCorrespondence(feature.observations,cameras);
   const status=result.rmsReprojectionError<=maxRms?"candidate":"review-required";
   const vertex={id:feature.id,point:result.point,viewCount:result.viewCount,rmsReprojectionError:result.rmsReprojectionError,status,reprojectionErrors:result.reprojectionErrors};
   vertices.push(vertex);byId.set(feature.id,vertex);
   if(status!=="candidate")issues.push({type:"high-reprojection-error",featureId:feature.id,rmsReprojectionError:result.rmsReprojectionError,threshold:maxRms});
  }catch(error){issues.push({type:"triangulation-failed",featureId:feature.id,message:error.message});}
 }
 const wireEdges=[];
 for(const edge of edges){
  if(!Array.isArray(edge)||edge.length!==2||edge[0]===edge[1]||!ids.has(edge[0])||!ids.has(edge[1])){issues.push({type:"invalid-edge-reference",edge});continue;}
  if(!byId.has(edge[0])||!byId.has(edge[1])){issues.push({type:"edge-endpoint-untriangulated",edge});continue;}
  wireEdges.push({from:edge[0],to:edge[1]});
 }
 return {schemaVersion:"1.0.0",method:"calibrated-multi-view-linear-triangulation",status:issues.length?"review-required":"candidate-wireframe",assumptions:["Camera projection matrices must be correctly calibrated and expressed in a common coordinate frame.","Image observations must refer to the same physical architectural feature across views.","This is a sparse wireframe of supplied correspondences, not dense building geometry.","No camera calibration, semantic feature matching or automatic geometry repair is performed."],cameraCount:cameras.length,inputFeatureCount:features.length,triangulatedVertexCount:vertices.length,edgeCount:wireEdges.length,maxRmsReprojectionError:maxRms,vertices,edges:wireEdges,issues,repairPasses:0,publicationEligible:false};
}
