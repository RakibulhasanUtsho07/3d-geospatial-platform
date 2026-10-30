(() => {
"use strict";
const MAX_BYTES=30*1024*1024,MAX_JSON=10*1024*1024,MAX_PIXELS=15000000;
const MASK_ENCODING="binary-8bit-white-foreground-v1",MASK_COORDINATES="pixel-origin-top-left";
const OBS_COORDINATES="source-image-pixel-origin-top-left";
const $=id=>document.getElementById(id);
const ui={source:$("source-file"),mask:$("mask-file"),manifest:$("mask-manifest"),observations:$("observations"),build:$("build"),download:$("download"),status:$("status")};
let outputBlob=null,outputName="source-bound-visual-evidence.json";
function status(message,kind="info"){ui.status.textContent=message;ui.status.dataset.kind=kind;}
async function digest(bytes){const result=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));return Array.from(result,v=>v.toString(16).padStart(2,"0")).join("");}
async function read(file,max,label){if(!file||file.size<1||file.size>max)throw new Error(label+" must be non-empty and within its size limit.");return await file.arrayBuffer();}
async function json(file){const raw=await read(file,MAX_JSON,file.name);let value;try{value=JSON.parse(new TextDecoder().decode(raw));}catch{throw new Error(file.name+" is not valid JSON.");}if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(file.name+" must contain a JSON object.");return{value,bytes:raw};}
async function dimensions(file,label,inspectMask=false){
 const bitmap=await createImageBitmap(file);
 try{
  const {width,height}=bitmap;if(!width||!height||width*height>MAX_PIXELS)throw new Error(label+" dimensions are invalid or exceed 15 million pixels.");
  if(inspectMask){
   const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
   const context=canvas.getContext("2d",{willReadFrequently:true});if(!context)throw new Error("Canvas pixel inspection is unavailable.");
   context.drawImage(bitmap,0,0);const pixels=context.getImageData(0,0,width,height).data;
   for(let i=0;i<pixels.length;i+=4){const alpha=pixels[i+3];if(alpha!==0&&alpha!==255)throw new Error("Mask PNG must contain only binary alpha values (0 or 255).");if(alpha===255&&(pixels[i]!==255||pixels[i+1]!==255||pixels[i+2]!==255))throw new Error("Mask foreground pixels must be opaque white.");}
  }
  return{width,height};
 }finally{bitmap.close();}
}
function assertFalse(policy,keys,label){if(!policy||keys.some(key=>policy[key]!==false))throw new Error(label+" must explicitly keep "+keys.join(", ")+" false.");}
function safeId(value){return typeof value==="string"&&/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value);}
async function build(){
 ui.download.disabled=true;outputBlob=null;
 try{
  const sourceFile=ui.source.files?.[0],maskFile=ui.mask.files?.[0],manifestFile=ui.manifest.files?.[0],observationFile=ui.observations.files?.[0];
  if(!sourceFile||!maskFile||!manifestFile||!observationFile)throw new Error("Choose the source image, mask PNG, mask manifest and observation batch.");
  if(!["image/png","image/jpeg","image/webp"].includes(sourceFile.type))throw new Error("Source image must be PNG, JPEG or WebP.");
  if(maskFile.type!=="image/png")throw new Error("Mask artifact must be a PNG.");
  status("Reading and hashing exact input bytes…");
  const [sourceBytes,maskBytes,manifest,observations,sourceSize,maskSize]=await Promise.all([
   read(sourceFile,MAX_BYTES,"Source image"),read(maskFile,MAX_BYTES,"Mask PNG"),json(manifestFile),json(observationFile),
   dimensions(sourceFile,"Source image"),dimensions(maskFile,"Mask PNG",true)
  ]);
  const [sourceSha256,maskSha256,maskManifestSha256,observationInputSha256]=await Promise.all([
   digest(sourceBytes),digest(maskBytes),digest(manifest.bytes),digest(observations.bytes)
  ]);
  const m=manifest.value,b=observations.value,src=m.source,r=m.result,mask=r?.mask;
  if(m.schemaVersion!=="1.0.0"||m.artifactType!=="source-bound-manual-mask-review"||!src||!r||r.schemaVersion!=="1.0.0"||
     !safeId(src.sourceId)||! /^[a-f0-9]{64}$/i.test(src.sha256||""))throw new Error("Mask manifest schema or source identity is invalid.");
  if(src.sha256.toLowerCase()!==sourceSha256||r.inputSha256?.toLowerCase()!==sourceSha256||r.sourceId!==src.sourceId||src.bytes!==sourceBytes.byteLength)
   throw new Error("Mask manifest does not bind to the exact selected source-image bytes.");
  if(src.width!==sourceSize.width||src.height!==sourceSize.height||maskSize.width!==sourceSize.width||maskSize.height!==sourceSize.height)
   throw new Error("Decoded source and mask dimensions must exactly match the mask manifest.");
  if(!mask||mask.sha256?.toLowerCase()!==maskSha256||mask.bytes!==maskBytes.byteLength||mask.width!==sourceSize.width||mask.height!==sourceSize.height||
     mask.encoding!==MASK_ENCODING||mask.coordinateConvention!==MASK_COORDINATES||mask.backgroundValue!==0||mask.foregroundValue!==255)
   throw new Error("Mask PNG bytes, dimensions or encoding do not match its manifest.");
  if(b.schemaVersion!=="1.0.0"||b.coordinateConvention!==OBS_COORDINATES||b.source?.id!==src.sourceId||
     b.source?.sha256?.toLowerCase()!==sourceSha256||b.source?.width!==sourceSize.width||b.source?.height!==sourceSize.height||
     !safeId(b.buildingId)||!safeId(b.viewId)||!Array.isArray(b.observations)||b.observations.length>2000)
   throw new Error("Observation batch must match the exact source ID, bytes, dimensions and pixel coordinate convention.");
  if(b.mask&&(b.mask.sha256?.toLowerCase()!==maskSha256||b.mask.width!==sourceSize.width||b.mask.height!==sourceSize.height))
   throw new Error("Observation batch already contains a conflicting mask reference.");
  for(const item of b.observations){
   if(!item||item.sourceId!==src.sourceId||item.sourceSha256?.toLowerCase()!==sourceSha256||item.viewId!==b.viewId)
    throw new Error("An observation has mismatched source or view provenance.");
   for(const evidence of [item.evidence,item.originalProposal?.evidence])if(evidence?.maskSha256&&evidence.maskSha256.toLowerCase()!==maskSha256)
    throw new Error("An observation references a different mask SHA-256.");
  }
  assertFalse(m.policy,["acceptanceEligible","publicationEligible","mapReady","automaticApproval","publishable"],"Mask manifest policy");
  assertFalse(b.policy,["groundTruth","publicationEligible","publishable"],"Observation batch policy");
  const assessment=r.assessment;
  if(!assessment||!["proposed","reviewed"].includes(assessment.status)||typeof assessment.humanReviewed!=="boolean"||
     (assessment.status==="reviewed"&&(!assessment.humanReviewed||!assessment.reviewerId?.trim()||!Number.isFinite(Date.parse(assessment.reviewedAt||""))))||
     (assessment.status==="proposed"&&assessment.humanReviewed))throw new Error("Mask review assessment is inconsistent.");
  const normalizedBatch={...b,mask:{sha256:maskSha256,width:sourceSize.width,height:sourceSize.height}};
  const normalizedBatchBytes=new TextEncoder().encode(JSON.stringify(normalizedBatch,null,2)+"\n");
  const normalizedBatchSha256=await digest(normalizedBatchBytes);
  const createdAt=new Date().toISOString();
  const bundleId="visual-evidence-"+(await digest(new TextEncoder().encode([sourceSha256,maskSha256,normalizedBatchSha256,b.buildingId,b.viewId].join("\n")))).slice(0,24);
  const bundle={
   schemaVersion:"1.0.0",bundleType:"source-bound-visual-evidence",bundleId,createdAt,buildingId:b.buildingId,viewId:b.viewId,
   coordinateConvention:OBS_COORDINATES,
   source:{id:src.sourceId,sha256:sourceSha256,bytes:sourceBytes.byteLength,mimeType:sourceFile.type,width:sourceSize.width,height:sourceSize.height},
   maskArtifact:{manifestSha256:maskManifestSha256,sha256:maskSha256,bytes:maskBytes.byteLength,width:mask.width,height:mask.height,
    encoding:mask.encoding,coordinateConvention:mask.coordinateConvention,assessment:{status:assessment.status,humanReviewed:assessment.humanReviewed,
     ...(assessment.humanReviewed?{reviewerId:assessment.reviewerId,reviewedAt:assessment.reviewedAt}:{})}},
   observationArtifact:{inputFileSha256:observationInputSha256,normalizedBatchSha256,batchId:normalizedBatch.batchId,observationCount:normalizedBatch.observations.length,batch:normalizedBatch},
   evidenceLinks:{sourceImageSha256:sourceSha256,maskPngSha256:maskSha256,maskManifestSha256,observationInputSha256,
    normalizedObservationBatchSha256:normalizedBatchSha256,maskAndObservationsShareExactSource:true,observationsReferenceExactMask:true},
   policy:{groundTruth:false,acceptanceEligible:false,publicationEligible:false,publishable:false,mapReady:false,automaticApproval:false,independentlyAuthenticatedReviewer:false},
   limitations:["This bundle links source bytes, a manually reviewed mask artifact and per-view architectural observations; it does not prove semantic correctness.",
    "Reviewer identity and decisions remain operator-supplied attestations and are not independently authenticated.",
    "Source rights, building identity, camera calibration, metric dimensions, held-out accuracy and survey truth require separate evidence.",
    "A linked mask is not ground truth; unknown, occluded, not-visible and not-detected observations remain distinct.",
    "The manifest records artifact hashes but does not embed the source image or mask PNG. Retain all original artifacts together.",
    "The bundle is review evidence only and cannot authorize publication or automatic map loading."]
  };
  outputBlob=new Blob([JSON.stringify(bundle,null,2)+"\n"],{type:"application/json"});
  outputName=[b.buildingId,b.viewId,"source-bound-visual-evidence.json"].join("-").replace(/[^a-z0-9._-]/gi,"-");
  ui.download.disabled=false;
  status("Bundle validation passed.\nSource SHA-256: "+sourceSha256+"\nMask SHA-256: "+maskSha256+"\nMask manifest SHA-256: "+maskManifestSha256+"\nNormalized observation batch SHA-256: "+normalizedBatchSha256+"\nObservations: "+normalizedBatch.observations.length+"\nAll release gates remain false.","success");
 }catch(error){status(error instanceof Error?error.message:String(error),"error");}
}
ui.build.addEventListener("click",build);
ui.download.addEventListener("click",()=>{if(!outputBlob)return;const url=URL.createObjectURL(outputBlob),a=document.createElement("a");a.href=url;a.download=outputName;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
})();
