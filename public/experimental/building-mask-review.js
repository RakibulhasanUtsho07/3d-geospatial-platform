(() => {
"use strict";
const MAX_BYTES=30*1024*1024,MAX_PIXELS=15000000;
const SOURCE_ID=/^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MASK_ENCODING="binary-8bit-white-foreground-v1",COORDINATE_CONVENTION="pixel-origin-top-left";
const TOOL_ID="manual-mask-review-editor",TOOL_VERSION="1.0.0";
const byId=id=>document.getElementById(id);
const ui={
sourceFile:byId("source-file"),sourceId:byId("source-id"),sourceStatus:byId("source-status"),sourceHash:byId("source-hash"),sourceDimensions:byId("source-dimensions"),
existingMaskFile:byId("existing-mask-file"),existingMaskManifest:byId("existing-mask-manifest"),loadExistingMask:byId("load-existing-mask"),importStatus:byId("import-status"),
reviewerId:byId("reviewer-id"),confidence:byId("confidence"),confidenceValue:byId("confidence-value"),reviewConfirm:byId("review-confirm"),reviewStatus:byId("review-status"),
paintMode:byId("paint-mode"),brushSize:byId("brush-size"),brushValue:byId("brush-value"),clearMask:byId("clear-mask"),
sourceImage:byId("source-image"),stage:byId("image-stage"),emptyStage:byId("empty-stage"),maskCanvas:byId("mask-canvas"),maskStats:byId("mask-stats"),
editStatus:byId("edit-status"),exportMask:byId("export-mask-png"),downloadManifest:byId("download-manifest"),exportStatus:byId("export-status")
};
const context=ui.maskCanvas.getContext("2d",{willReadFrequently:true});
const state={source:null,sourceUrl:null,importedMask:null,preparedExport:null,drawing:false,lastPoint:null,reviewedAt:null};
function setStatus(element,message,kind="info"){element.textContent=message;element.dataset.kind=kind;}
function safeSourceId(){const value=ui.sourceId.value.trim();if(!SOURCE_ID.test(value))throw new Error("Source ID must be 1–80 characters using letters, numbers, dot, underscore or hyphen; it must start with a letter or number.");return value;}
async function digest(bytes){const input=bytes instanceof ArrayBuffer?bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);const result=new Uint8Array(await crypto.subtle.digest("SHA-256",input));return Array.from(result,v=>v.toString(16).padStart(2,"0")).join("");}
function currentSourceSnapshot(){if(!state.source)throw new Error("Load a source image first.");return {sourceId:safeSourceId(),filename:state.source.filename,sha256:state.source.sha256,bytes:state.source.bytes,width:state.source.width,height:state.source.height,mimeType:state.source.mimeType};}
function clearCanvas(){if(ui.maskCanvas.width&&ui.maskCanvas.height)context.clearRect(0,0,ui.maskCanvas.width,ui.maskCanvas.height);}
function invalidatePreparedExport(reason){state.preparedExport=null;ui.downloadManifest.disabled=true;ui.exportMask.disabled=!state.source;setStatus(ui.exportStatus,reason||"Mask/source changed. Prepare a fresh PNG before exporting its manifest.","warning");}
function updateBrushLabel(){ui.brushValue.textContent=ui.brushSize.value+" px";}
function updateReviewStatus(){if(ui.reviewConfirm.checked){setStatus(ui.reviewStatus,ui.reviewerId.value.trim()?"A reviewer attestation will be recorded. Publication and acceptance stay blocked.":"A reviewer identifier is required to export a reviewed mask.","warning");}else setStatus(ui.reviewStatus,"Review is pending. The manifest will use assessment.status = proposed.","info");}
function resetHumanReview(){state.reviewedAt=null;ui.reviewConfirm.checked=false;ui.reviewerId.value="";updateReviewStatus();}
function markMaskDirty(){resetHumanReview();invalidatePreparedExport("Mask has changed. Prepare a fresh PNG before exporting metadata.");if(state.source)setStatus(ui.editStatus,"Mask has unsaved edits. Create a fresh binary PNG before downloading the JSON manifest.","warning");}
function pointFromEvent(event){const rect=ui.maskCanvas.getBoundingClientRect();return{x:Math.max(0,Math.min(ui.maskCanvas.width,(event.clientX-rect.left)*ui.maskCanvas.width/rect.width)),y:Math.max(0,Math.min(ui.maskCanvas.height,(event.clientY-rect.top)*ui.maskCanvas.height/rect.height))};}
function paintSegment(start,end){const width=Number(ui.brushSize.value);context.save();if(ui.paintMode.value==="erase")context.globalCompositeOperation="destination-out";else{context.globalCompositeOperation="source-over";context.strokeStyle="#fff";context.fillStyle="#fff";}context.lineWidth=width;context.lineCap="round";context.lineJoin="round";context.beginPath();context.moveTo(start.x,start.y);context.lineTo(end.x,end.y);context.stroke();if(start.x===end.x&&start.y===end.y){context.beginPath();context.arc(start.x,start.y,width/2,0,Math.PI*2);context.fill();}context.restore();}
function safeFilename(sourceId,suffix){return sourceId.replace(/[^a-z0-9._-]/gi,"-")+suffix;}
function downloadBlob(blob,filename){const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=filename;link.hidden=true;document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),10000);}
function toBlob(canvas){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("Browser could not encode the mask as PNG.")),"image/png"));}
async function decodeImageFile(file){const url=URL.createObjectURL(file);try{const image=new Image();image.src=url;await image.decode();return{image,url};}catch{URL.revokeObjectURL(url);throw new Error("Image could not be decoded. Use a valid PNG, JPEG or WebP source.");}}
async function loadSource(file){
if(!file)return;
try{
if(!["image/png","image/jpeg","image/webp"].includes(file.type))throw new Error("Unsupported source image type. Choose PNG, JPEG or WebP.");
if(file.size<1||file.size>MAX_BYTES)throw new Error("Source image must be non-empty and no larger than 30 MiB.");
const fileBytes=await file.arrayBuffer(),sourceSha256=await digest(fileBytes),decoded=await decodeImageFile(file);
const width=decoded.image.naturalWidth,height=decoded.image.naturalHeight;
if(!width||!height||width*height>MAX_PIXELS){URL.revokeObjectURL(decoded.url);throw new Error("Decoded source dimensions are invalid or exceed the 15-million-pixel safety limit.");}
if(state.sourceUrl)URL.revokeObjectURL(state.sourceUrl);
state.sourceUrl=decoded.url;state.source={filename:file.name,sha256:sourceSha256,bytes:file.size,width,height,mimeType:file.type};
state.importedMask=null;state.preparedExport=null;state.reviewedAt=null;ui.reviewerId.value="";ui.reviewConfirm.checked=false;
ui.maskCanvas.width=width;ui.maskCanvas.height=height;clearCanvas();ui.sourceImage.src=decoded.url;ui.stage.hidden=false;ui.emptyStage.hidden=true;
ui.sourceHash.textContent=sourceSha256;ui.sourceDimensions.textContent=width+" × "+height+" pixels";
setStatus(ui.sourceStatus,"Loaded and hashed: "+file.name,"success");setStatus(ui.importStatus,"No existing mask loaded. Start painting or import a matching mask.","info");
setStatus(ui.editStatus,"New empty mask. Paint visible building pixels in white; erase non-building or uncertain pixels.","info");
ui.loadExistingMask.disabled=false;ui.clearMask.disabled=false;ui.exportMask.disabled=false;ui.downloadManifest.disabled=true;
ui.maskStats.textContent="Mask dimensions match the source image. Foreground coverage is checked before export.";updateReviewStatus();
invalidatePreparedExport("No export prepared. Mark the visible building region before creating a binary PNG.");
}catch(error){
state.source=null;ui.stage.hidden=true;ui.emptyStage.hidden=false;ui.sourceHash.textContent="Not available";ui.sourceDimensions.textContent="Not available";
ui.loadExistingMask.disabled=true;ui.clearMask.disabled=true;ui.exportMask.disabled=true;invalidatePreparedExport("No export prepared.");
setStatus(ui.sourceStatus,error instanceof Error?error.message:String(error),"error");
}}
async function loadExistingMask(){
try{
const source=currentSourceSnapshot(),maskFile=ui.existingMaskFile.files?.[0],manifestFile=ui.existingMaskManifest.files?.[0];
if(!maskFile||!manifestFile)throw new Error("Select both the existing mask PNG and its matching JSON manifest.");
if(maskFile.type!=="image/png"||maskFile.size<1||maskFile.size>MAX_BYTES)throw new Error("Existing mask must be a non-empty PNG no larger than 30 MiB.");
const maskBytes=await maskFile.arrayBuffer(),actualMaskSha256=await digest(maskBytes),manifest=JSON.parse(await manifestFile.text());
if(manifest?.artifactType!=="source-bound-manual-mask-review"||manifest?.source?.sourceId!==source.sourceId||
manifest?.source?.sha256?.toLowerCase()!==source.sha256.toLowerCase()||manifest?.source?.bytes!==source.bytes||
manifest?.source?.width!==source.width||manifest?.source?.height!==source.height)
throw new Error("Existing mask manifest does not match the exact loaded source ID, bytes, hash and dimensions.");
const result=manifest.result;
if(result?.schemaVersion!=="1.0.0"||result.sourceId!==source.sourceId||result.inputSha256?.toLowerCase()!==source.sha256.toLowerCase()||
result.mask?.sha256?.toLowerCase()!==actualMaskSha256||result.mask?.bytes!==maskFile.size||
result.mask?.width!==source.width||result.mask?.height!==source.height||result.mask?.encoding!==MASK_ENCODING||
result.mask?.coordinateConvention!==COORDINATE_CONVENTION)
throw new Error("Existing mask bytes or manifest contract do not match this source.");
const decoded=await decodeImageFile(maskFile);
try{
if(decoded.image.naturalWidth!==source.width||decoded.image.naturalHeight!==source.height)throw new Error("Existing mask image dimensions do not exactly match the source.");
const verifyCanvas=document.createElement("canvas");verifyCanvas.width=source.width;verifyCanvas.height=source.height;
const verifyContext=verifyCanvas.getContext("2d",{willReadFrequently:true});if(!verifyContext)throw new Error("Could not allocate a mask validation canvas.");
verifyContext.drawImage(decoded.image,0,0);const pixels=verifyContext.getImageData(0,0,source.width,source.height),preview=context.createImageData(source.width,source.height);
let foregroundCount=0;
for(let index=0;index<source.width*source.height;index++){const o=index*4,r=pixels.data[o],g=pixels.data[o+1],b=pixels.data[o+2],a=pixels.data[o+3];
if(a!==255||r!==g||g!==b||(r!==0&&r!==255))throw new Error("Existing mask is not an opaque, binary black/white PNG.");
if(r===255)foregroundCount++;preview.data[o]=255;preview.data[o+1]=255;preview.data[o+2]=255;preview.data[o+3]=r===255?255:0;}
context.putImageData(preview,0,0);state.importedMask={sha256:actualMaskSha256,filename:maskFile.name,priorStatus:result.assessment?.status??"unknown"};
state.reviewedAt=null;ui.reviewerId.value="";ui.reviewConfirm.checked=false;invalidatePreparedExport("Imported mask loaded; create a new PNG after any correction.");
setStatus(ui.importStatus,"Existing mask source/hash verified. Edits reset review state; inspect it again before attesting.","success");
setStatus(ui.editStatus,"Imported "+maskFile.name+". Re-review is required after correction.","warning");
ui.maskStats.textContent=foregroundCount+" foreground pixels ("+(100*foregroundCount/(source.width*source.height)).toFixed(2)+"%). This is coverage, not an accuracy score.";updateReviewStatus();
}finally{URL.revokeObjectURL(decoded.url);}
}catch(error){invalidatePreparedExport("Import failed; current annotation is unchanged. Prepare a fresh PNG before downloading metadata.");setStatus(ui.importStatus,error instanceof Error?error.message:String(error),"error");}
}
async function createMaskPng(){
try{
const source=currentSourceSnapshot(),width=ui.maskCanvas.width,height=ui.maskCanvas.height,total=width*height,imageData=context.getImageData(0,0,width,height),foreground=new Uint8Array(total);
let count=0;
for(let i=0;i<total;i++){const o=i*4;if(imageData.data[o+3]>0){foreground[i]=255;count++;}}
if(count===0||count===total)throw new Error("Mask must contain both building foreground and background pixels. Paint only the visible building, then erase non-building or uncertain pixels.");
for(let i=0;i<total;i++){const o=i*4,v=foreground[i];imageData.data[o]=v;imageData.data[o+1]=v;imageData.data[o+2]=v;imageData.data[o+3]=255;}
context.putImageData(imageData,0,0);let blob;
try{blob=await toBlob(ui.maskCanvas);}finally{for(let i=0;i<total;i++){const o=i*4;imageData.data[o]=255;imageData.data[o+1]=255;imageData.data[o+2]=255;imageData.data[o+3]=foreground[i];}context.putImageData(imageData,0,0);}
if(!blob)throw new Error("Mask PNG encoding failed.");if(blob.size>MAX_BYTES)throw new Error("Encoded mask exceeds the 30 MiB output limit.");
const maskBytes=await blob.arrayBuffer(),maskSha256=await digest(maskBytes);
const output={source,blob,maskSha256,maskBytes:maskBytes.byteLength,width,height,foregroundCount:count,filename:safeFilename(source.sourceId,"-mask.png"),parentMaskSha256:state.importedMask?.sha256??null,editMode:state.importedMask?"corrected-existing-mask":"new-manual-mask"};
state.preparedExport=output;downloadBlob(blob,output.filename);ui.downloadManifest.disabled=false;
setStatus(ui.exportStatus,"Mask PNG prepared and downloaded. SHA-256: "+maskSha256+" — "+blob.size+" bytes.","success");
setStatus(ui.editStatus,"PNG matches the current source dimensions. Review metadata before downloading the manifest.","success");
ui.maskStats.textContent=count+" foreground pixels ("+(100*count/total).toFixed(2)+"%). This is coverage, not an accuracy score.";
}catch(error){state.preparedExport=null;ui.downloadManifest.disabled=true;setStatus(ui.exportStatus,error instanceof Error?error.message:String(error),"error");}
}
async function downloadManifest(){
try{
const output=state.preparedExport;if(!output)throw new Error("Prepare and download a fresh mask PNG first.");
const sourceNow=currentSourceSnapshot();
if(sourceNow.sourceId!==output.source.sourceId||sourceNow.sha256!==output.source.sha256||sourceNow.bytes!==output.source.bytes||
sourceNow.width!==output.width||sourceNow.height!==output.height){invalidatePreparedExport("Source identity changed. Create a new mask PNG before metadata export.");throw new Error("Prepared mask no longer matches the loaded source identity.");}
const confirmed=ui.reviewConfirm.checked,reviewerId=ui.reviewerId.value.trim();
if(confirmed&&!reviewerId)throw new Error("Enter the reviewer identifier or uncheck the human-review attestation.");
if(confirmed&&!state.reviewedAt)state.reviewedAt=new Date().toISOString();if(!confirmed)state.reviewedAt=null;
const configurationSha256=await digest(new TextEncoder().encode(JSON.stringify({tool:TOOL_ID,version:TOOL_VERSION,brushSpace:"source-pixels",maskEncoding:MASK_ENCODING,coordinateConvention:COORDINATE_CONVENTION})));
const result={schemaVersion:"1.0.0",sourceId:sourceNow.sourceId,inputSha256:sourceNow.sha256,
provider:{id:TOOL_ID,kind:"human-reviewed-mask",version:TOOL_VERSION,configurationSha256},
mask:{sha256:output.maskSha256,bytes:output.maskBytes,width:output.width,height:output.height,encoding:MASK_ENCODING,coordinateConvention:COORDINATE_CONVENTION,backgroundValue:0,foregroundValue:255},
assessment:{status:confirmed?"reviewed":"proposed",confidence:Number(ui.confidence.value),humanReviewed:confirmed,...(confirmed?{reviewerId,reviewedAt:state.reviewedAt}:{})}};
const manifest={schemaVersion:"1.0.0",artifactType:"source-bound-manual-mask-review",generatedAt:new Date().toISOString(),source:sourceNow,result,
editHistory:{mode:output.editMode,supersedesMaskSha256:output.parentMaskSha256,note:"Only the mask is edited; exact source bytes and source hash remain unchanged."},
policy:{acceptanceEligible:false,publicationEligible:false,mapReady:false,automaticApproval:false,publishable:false},
limitations:["Reviewer identity and confidence are operator-supplied attestations, not independently authenticated facts.","The mask is a source-pixel annotation, not a 3D model, metric measurement, survey or proof of building identity.","Unknown, occluded and inferred architecture must remain separate from observed building pixels.","Source rights must be reviewed separately; this tool does not approve licences or publication."]};
const blob=new Blob([JSON.stringify(manifest,null,2)+"\n"],{type:"application/json"});downloadBlob(blob,safeFilename(sourceNow.sourceId,"-mask-review.json"));
setStatus(ui.reviewStatus,confirmed?"Reviewer attestation recorded. All release/approval flags remain false.":"Manifest will record a proposed mask; human review has not been attested.",confirmed?"warning":"info");
setStatus(ui.exportStatus,"Hash-bound JSON manifest downloaded. It references the last prepared mask PNG.","success");
}catch(error){setStatus(ui.exportStatus,error instanceof Error?error.message:String(error),"error");}
}
ui.sourceFile.addEventListener("change",()=>loadSource(ui.sourceFile.files?.[0]));
ui.sourceId.addEventListener("input",()=>{if(state.importedMask){state.importedMask=null;clearCanvas();setStatus(ui.importStatus,"Source ID changed. Imported mask cleared because its prior source binding no longer matches.","warning");}resetHumanReview();invalidatePreparedExport("Source ID changed. Prepare a new PNG before metadata export.");});
ui.loadExistingMask.addEventListener("click",loadExistingMask);
ui.brushSize.addEventListener("input",updateBrushLabel);
ui.confidence.addEventListener("input",()=>{ui.confidenceValue.textContent=Number(ui.confidence.value).toFixed(2);});
ui.reviewConfirm.addEventListener("change",()=>{state.reviewedAt=ui.reviewConfirm.checked?new Date().toISOString():null;updateReviewStatus();});
ui.reviewerId.addEventListener("input",()=>{if(ui.reviewConfirm.checked)state.reviewedAt=new Date().toISOString();updateReviewStatus();});
ui.maskCanvas.addEventListener("pointerdown",event=>{if(!state.source)return;event.preventDefault();ui.maskCanvas.setPointerCapture(event.pointerId);state.drawing=true;state.lastPoint=pointFromEvent(event);paintSegment(state.lastPoint,state.lastPoint);markMaskDirty();});
ui.maskCanvas.addEventListener("pointermove",event=>{if(!state.drawing||!state.lastPoint)return;const point=pointFromEvent(event);paintSegment(state.lastPoint,point);state.lastPoint=point;markMaskDirty();});
const endStroke=()=>{state.drawing=false;state.lastPoint=null;context.globalCompositeOperation="source-over";};
ui.maskCanvas.addEventListener("pointerup",endStroke);ui.maskCanvas.addEventListener("pointercancel",endStroke);
ui.clearMask.addEventListener("click",()=>{clearCanvas();state.importedMask=null;state.reviewedAt=null;ui.reviewConfirm.checked=false;ui.reviewerId.value="";markMaskDirty();setStatus(ui.importStatus,"Mask cleared; no prior mask is attached.","info");});
ui.exportMask.addEventListener("click",createMaskPng);ui.downloadManifest.addEventListener("click",downloadManifest);
updateBrushLabel();updateReviewStatus();
})();
