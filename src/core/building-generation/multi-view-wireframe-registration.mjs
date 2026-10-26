const EPS=1e-12;
function finiteNumber(value){return typeof value==="number"&&Number.isFinite(value);}
function validateOptions(value,name){if(!finiteNumber(value)||value<=0)throw new RangeError(name+" must be positive");return value;}
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
function cameraByIdFor(cameras){
 if(!Array.isArray(cameras)||cameras.length<2)throw new RangeError("at least two calibrated cameras are required");
 const checked=cameras.map(validateCamera),map=new Map(checked.map(c=>[c.id,c]));
 if(map.size!==checked.length)throw new TypeError("camera ids must be unique");
 return map;
}
export function triangulateCorrespondence(observations,cameras){
 if(!Array.isArray(observations)||observations.length<2)throw new RangeError("at least two image observations are required");
 const cameraById=cameraByIdFor(cameras);
 const unique=new Set(),rows=[];
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
function cameraCenter(camera){
 const p=validateCamera(camera),normal=Array.from({length:4},()=>Array(4).fill(0));
 for(const row of p.projection)for(let i=0;i<4;i++)for(let j=0;j<4;j++)normal[i][j]+=row[i]*row[j];
 const h=smallestEigenvectorSymmetric4(normal);
 if(!finiteNumber(h[3])||Math.abs(h[3])<1e-10)return null;
 const center=h.slice(0,3).map(v=>v/h[3]);
 return center.every(finiteNumber)?center:null;
}
function parallaxReport(point,cameras,minParallaxDeg){
 const centers=cameras.map(camera=>({cameraId:camera.id,center:cameraCenter(camera)})).filter(item=>item.center);
 let maxPairwiseParallaxDeg=null;
 for(let i=0;i<centers.length;i++)for(let j=i+1;j<centers.length;j++){
  const a=point.map((v,k)=>v-centers[i].center[k]),b=point.map((v,k)=>v-centers[j].center[k]);
  const na=Math.hypot(...a),nb=Math.hypot(...b);if(na<EPS||nb<EPS)continue;
  const cos=Math.max(-1,Math.min(1,a.reduce((sum,v,k)=>sum+v*b[k],0)/(na*nb)));
  const angle=Math.acos(cos)*180/Math.PI;
  maxPairwiseParallaxDeg=maxPairwiseParallaxDeg===null?angle:Math.max(maxPairwiseParallaxDeg,angle);
 }
 const status=maxPairwiseParallaxDeg===null?"unknown":maxPairwiseParallaxDeg<minParallaxDeg?"low":"adequate";
 return {status,maxPairwiseParallaxDeg,minParallaxDeg,finiteCameraCenters:centers.length};
}
function residualsForPoint(point,observations,cameraById,threshold){
 return observations.map((obs,index)=>{
  try{
   const projected=projectPoint(cameraById.get(obs.cameraId),point),errorPixels=Math.hypot(projected.x-obs.x,projected.y-obs.y);
   const inlier=errorPixels<=threshold;
   return {index,cameraId:obs.cameraId,observed:{x:obs.x,y:obs.y},projected,errorPixels,inlier,classification:inlier?"inlier-candidate":"suspected-outlier-review"};
  }catch(error){return {index,cameraId:obs.cameraId,observed:{x:obs.x,y:obs.y},projected:null,errorPixels:null,inlier:false,classification:"projection-failed",message:error.message};}
 });
}
function rmsOf(errors){const valid=errors.map(e=>e.errorPixels).filter(finiteNumber);return valid.length?Math.sqrt(valid.reduce((sum,e)=>sum+e*e,0)/valid.length):null;}
function median(values){if(!values.length)return Infinity;const sorted=values.slice().sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;}
function candidatePairs(count){
 const pairs=[];for(let i=0;i<count;i++)for(let j=i+1;j<count;j++)pairs.push([i,j]);return pairs;
}
/**
 * Deterministic pair-hypothesis consensus and refit. Outliers are suggestions for review,
 * never deleted or silently treated as ground truth. Projection residual units follow P's
 * image coordinate convention (pixels when P maps world points to pixels).
 */
export function robustTriangulateCorrespondence(observations,cameras,options={}){
 if(!Array.isArray(observations)||observations.length<2)throw new RangeError("at least two image observations are required");
 const cameraById=cameraByIdFor(cameras);
 const threshold=validateOptions(options.maxReprojectionErrorPixels??3,"maxReprojectionErrorPixels");
 const minInlierViews=options.minInlierViews??2;
 const minParallaxDeg=validateOptions(options.minParallaxDeg??1,"minParallaxDeg");
 const maxPairHypotheses=options.maxPairHypotheses??128;
 if(!Number.isInteger(minInlierViews)||minInlierViews<2)throw new RangeError("minInlierViews must be an integer >= 2");
 if(!Number.isInteger(maxPairHypotheses)||maxPairHypotheses<1||maxPairHypotheses>512)throw new RangeError("maxPairHypotheses must be an integer from 1 to 512");
 const used=new Set();
 for(const obs of observations){normalizeObservation(obs,cameraById);if(used.has(obs.cameraId))throw new TypeError("a feature may have at most one observation per camera");used.add(obs.cameraId);}
 if(observations.length<3){
  const base=triangulateCorrespondence(observations,cameras);
  const reprojectionErrors=residualsForPoint(base.point,observations,cameraById,threshold);
  const parallax=parallaxReport(base.point,cameras.filter(c=>used.has(c.id)),minParallaxDeg);
  return {...base,status:"review-required",reason:"insufficient-views-for-outlier-rejection",inlierCameraIds:observations.map(o=>o.cameraId),suspectedOutliers:[],consensusSize:observations.length,inlierRmsReprojectionError:base.rmsReprojectionError,reprojectionErrors,parallax,hypothesesEvaluated:0,hypothesesSkipped:0,publicationEligible:false};
 }
 const allPairs=candidatePairs(observations.length);
 let pairs=allPairs;
 if(allPairs.length>maxPairHypotheses){
  pairs=Array.from({length:maxPairHypotheses},(_,i)=>allPairs[Math.floor(i*(allPairs.length-1)/(maxPairHypotheses-1||1))]);
  pairs=pairs.filter((pair,i,array)=>array.findIndex(p=>p[0]===pair[0]&&p[1]===pair[1])===i);
 }
 let best=null;
 for(const pair of pairs){
  try{
   const seed=triangulateCorrespondence(pair.map(index=>observations[index]),cameras);
   const residuals=residualsForPoint(seed.point,observations,cameraById,threshold);
   const inliers=residuals.filter(r=>r.inlier),scores=inliers.map(r=>r.errorPixels);
   const candidate={point:seed.point,residuals,inliers,suspectedOutliers:residuals.filter(r=>!r.inlier),consensusSize:inliers.length,medianInlierError:median(scores),inlierRmsReprojectionError:rmsOf(inliers)};
   if(!best||candidate.consensusSize>best.consensusSize||
    (candidate.consensusSize===best.consensusSize&&candidate.medianInlierError<best.medianInlierError)||
    (candidate.consensusSize===best.consensusSize&&candidate.medianInlierError===best.medianInlierError&&candidate.inlierRmsReprojectionError<best.inlierRmsReprojectionError))best=candidate;
  }catch{/* Invalid pair hypotheses are retained implicitly in the hypothesis count, not promoted. */}
 }
 if(!best){
  return {point:null,viewCount:observations.length,status:"review-required",reason:"no-valid-pair-hypothesis",rmsReprojectionError:null,inlierRmsReprojectionError:null,reprojectionErrors:[],inlierCameraIds:[],suspectedOutliers:observations.map((observation,index)=>({index,cameraId:observation.cameraId,observation,reason:"no-valid-pair-hypothesis"})),consensusSize:0,parallax:{status:"unknown",maxPairwiseParallaxDeg:null,minParallaxDeg,finiteCameraCenters:0},hypothesesEvaluated:pairs.length,hypothesesSkipped:allPairs.length-pairs.length,publicationEligible:false};
 }
 let inlierObservations=best.inliers.map(item=>observations[item.index]);
 if(inlierObservations.length>=2){
  try{best.point=triangulateCorrespondence(inlierObservations,cameras).point;}catch{/* Keep deterministic best pair solution and remain review-required. */}
 }
 const reprojectionErrors=residualsForPoint(best.point,observations,cameraById,threshold);
 const inlierErrors=reprojectionErrors.filter(r=>r.inlier),suspectedOutliers=reprojectionErrors.filter(r=>!r.inlier);
 const inlierCameraIds=inlierErrors.map(r=>r.cameraId),consensusSize=inlierErrors.length;
 const parallax=parallaxReport(best.point,cameras.filter(c=>used.has(c.id)),minParallaxDeg);
 const rmsReprojectionError=rmsOf(reprojectionErrors);
 const inlierRmsReprojectionError=rmsOf(inlierErrors);
 let reason=null;
 if(consensusSize<minInlierViews)reason="insufficient-consensus";
 else if(suspectedOutliers.length)reason=observations.length<4?"outlier-candidate-needs-more-views":"outlier-candidates-need-review";
 else if(parallax.status==="low")reason="low-parallax";
 else if(parallax.status==="unknown")reason="parallax-unavailable";
 const status=reason===null?"candidate":"review-required";
 return {point:best.point,viewCount:observations.length,status,reason,rmsReprojectionError,inlierRmsReprojectionError,reprojectionErrors,inlierCameraIds,suspectedOutliers,consensusSize,parallax,hypothesesEvaluated:pairs.length,hypothesesSkipped:allPairs.length-pairs.length,threshold,publicationEligible:false};
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
   const result=robustTriangulateCorrespondence(feature.observations,cameras,{
    maxReprojectionErrorPixels:options.maxObservationReprojectionErrorPixels??maxRms,
    minInlierViews:options.minInlierViews??2,
    minParallaxDeg:options.minParallaxDeg??1,
    maxPairHypotheses:options.maxPairHypotheses??128
   });
   const status=result.status==="candidate"&&result.rmsReprojectionError<=maxRms?"candidate":"review-required";
   const vertex={id:feature.id,point:result.point,viewCount:result.viewCount,rmsReprojectionError:result.rmsReprojectionError,inlierRmsReprojectionError:result.inlierRmsReprojectionError,status,reason:result.reason,inlierCameraIds:result.inlierCameraIds,suspectedOutlierCameraIds:result.suspectedOutliers.map(o=>o.cameraId),reprojectionErrors:result.reprojectionErrors,parallax:result.parallax,hypothesesEvaluated:result.hypothesesEvaluated};
   vertices.push(vertex);byId.set(feature.id,vertex);
   if(status!=="candidate")issues.push({type:"correspondence-review-required",featureId:feature.id,reason:result.reason??"rms-reprojection-error-exceeds-threshold",suspectedOutlierCameraIds:vertex.suspectedOutlierCameraIds,consensusSize:result.consensusSize,viewCount:result.viewCount,parallax:result.parallax});
   if(result.rmsReprojectionError!==null&&result.rmsReprojectionError>maxRms)issues.push({type:"high-reprojection-error",featureId:feature.id,rmsReprojectionError:result.rmsReprojectionError,threshold:maxRms});
  }catch(error){issues.push({type:"triangulation-failed",featureId:feature.id,message:error.message});}
 }
 const wireEdges=[];
 for(const edge of edges){
  if(!Array.isArray(edge)||edge.length!==2||edge[0]===edge[1]||!ids.has(edge[0])||!ids.has(edge[1])){issues.push({type:"invalid-edge-reference",edge});continue;}
  if(!byId.has(edge[0])||!byId.has(edge[1])||!byId.get(edge[0]).point||!byId.get(edge[1]).point){issues.push({type:"edge-endpoint-untriangulated",edge});continue;}
  wireEdges.push({from:edge[0],to:edge[1]});
 }
 const blockingIssueTypes=new Set(["triangulation-failed","high-reprojection-error","invalid-edge-reference","edge-endpoint-untriangulated"]);
 const blockingIssueCount=issues.filter(issue=>blockingIssueTypes.has(issue.type)).length+
  issues.filter(issue=>issue.type==="correspondence-review-required"&&issue.reason!=="insufficient-views-for-outlier-rejection").length;
 const qualityStatus=issues.length?"review-required":"candidate-wireframe";
 return {schemaVersion:"1.1.0",method:"deterministic-pair-consensus-then-linear-refit",status:blockingIssueCount?"review-required":"candidate-wireframe",qualityStatus,reviewRequiredFeatureCount:vertices.filter(vertex=>vertex.status==="review-required").length,assumptions:["Camera projection matrices must be correctly calibrated and expressed in a common coordinate frame.","Image observations must refer to the same physical architectural feature across views.","Reprojection thresholds use the projection matrix image-coordinate convention; these are pixels only if the projection matrices produce pixels.","Outlier labels are review suggestions; no observation is deleted or auto-rejected.","This is a sparse wireframe of supplied correspondences, not dense building geometry.","No camera calibration, semantic feature matching or automatic geometry repair is performed."],cameraCount:cameras.length,inputFeatureCount:features.length,triangulatedVertexCount:vertices.filter(v=>v.point).length,edgeCount:wireEdges.length,maxRmsReprojectionError:maxRms,vertices,edges:wireEdges,issues,repairPasses:0,publicationEligible:false};
}
