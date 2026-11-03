(() => {
"use strict";
const MAX_BYTES=30*1024*1024,MAX_PIXELS=15000000,MAX_OBSERVATIONS=2000;
const SAFE_ID=/^[a-z0-9][a-z0-9._-]{0,79}$/i,HASH=/^[a-f0-9]{64}$/i;
const CONVENTION="source-image-pixel-origin-top-left";
const CATEGORIES=new Set(["silhouette-bounds","roofline-segment","outer-corner","floor-band","facade-region","window-candidate","door-candidate","balcony-candidate","visible-occluder","arch-candidate","column-candidate","dome-candidate","cornice-candidate","pediment-candidate","staircase-candidate","parapet-candidate","ornament-candidate"]);
const VISIBILITY=new Set(["visible","partially-occluded","occluded","not-visible","not-detected"]);
const $=id=>document.getElementById(id);
const u={file:$("source-file"),building:$("building-id"),view:$("view-id"),sourceId:$("source-id"),sourceStatus:$("source-status"),hash:$("source-hash"),dimensions:$("source-dimensions"),batchFile:$("batch-file"),import:$("import-batch"),export:$("export-batch"),batchStatus:$("batch-status"),category:$("category"),tool:$("geometry-type"),visibility:$("visibility"),confidence:$("confidence"),confidenceValue:$("confidence-value"),help:$("coordinate-help"),image:$("source-image"),stage:$("image-stage"),empty:$("empty-stage"),canvas:$("annotation-canvas"),finish:$("finish-geometry"),undo:$("undo-point"),cancel:$("cancel-geometry"),addUnknown:$("add-no-geometry"),stats:$("drawing-stats"),editStatus:$("edit-status"),list:$("observation-list"),reviewer:$("reviewer-id"),selectedStatus:$("selected-status"),notes:$("review-notes"),review:$("review-observation"),reject:$("reject-observation"),reopen:$("reopen-observation"),reviewStatus:$("review-status")};
const ctx=u.canvas.getContext("2d");if(!ctx)throw new Error("Canvas 2D rendering is unavailable.");
const s={source:null,url:null,items:[],selected:null,vertices:[],dragStart:null,dragEnd:null,next:1,createdAt:null};
function status(el,message,kind="info"){el.textContent=message;el.dataset.kind=kind;}
function id(value,label){const v=value.trim();if(!SAFE_ID.test(v))throw new Error(label+" must be 1–80 safe characters, starting with a letter or number.");return v;}
function ids(){return{buildingId:id(u.building.value,"Building ID"),viewId:id(u.view.value,"View ID"),sourceId:id(u.sourceId.value,"Source ID")};}
async function hash(bytes){const input=bytes instanceof ArrayBuffer?bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);const h=new Uint8Array(await crypto.subtle.digest("SHA-256",input));return Array.from(h,x=>x.toString(16).padStart(2,"0")).join("");}
async function decode(file){const url=URL.createObjectURL(file);try{const image=new Image();image.src=url;await image.decode();return{image,url};}catch{URL.revokeObjectURL(url);throw new Error("Image decoding failed. Choose a valid PNG, JPEG or WebP.");}}
function lockIdentity(locked){u.building.disabled=locked;u.view.disabled=locked;u.sourceId.disabled=locked;u.file.disabled=locked;}
function controls(){
 const loaded=Boolean(s.source),selected=s.items.find(x=>x.id===s.selected)||null,geometry=u.tool.value;
 u.batchFile.disabled=!loaded;u.import.disabled=!loaded||!u.batchFile.files?.length;u.export.disabled=!loaded;
 u.category.disabled=!loaded;u.tool.disabled=!loaded;u.visibility.disabled=!loaded;u.confidence.disabled=!loaded;
 u.finish.disabled=!loaded||!["LineString","Polygon"].includes(geometry)||s.vertices.length<(geometry==="LineString"?2:3);
 u.undo.disabled=!loaded||!s.vertices.length;u.cancel.disabled=!loaded||(!s.vertices.length&&!s.dragStart);
 u.addUnknown.disabled=!loaded||!["occluded","not-visible","not-detected"].includes(u.visibility.value);
 u.reviewer.disabled=!selected;u.notes.disabled=!selected;
 u.review.disabled=!selected||!u.reviewer.value.trim()||selected.status==="reviewed";
 u.reject.disabled=!selected||!u.reviewer.value.trim()||selected.status==="rejected";
 u.reopen.disabled=!selected||selected.status==="proposed";
}
function desc(){u.help.textContent=u.tool.value==="Point"?"Click once to place a point.":u.tool.value==="BoundingBox"?"Press, drag and release to draw a rectangle.":u.tool.value==="LineString"?"Click at least two vertices, then Finish line / polygon.":"Click at least three vertices, then Finish line / polygon.";}
function point(e){const r=u.canvas.getBoundingClientRect();return[Math.max(0,Math.min(u.canvas.width-1,(e.clientX-r.left)*u.canvas.width/r.width)),Math.max(0,Math.min(u.canvas.height-1,(e.clientY-r.top)*u.canvas.height/r.height))];}
function paint(context,g,selected,state){
 if(!g)return;context.save();context.lineWidth=selected?Math.max(2,u.canvas.width/350):Math.max(1.5,u.canvas.width/500);context.strokeStyle=state==="rejected"?"#fa7777":selected?"#ffcf70":"#70c6ff";context.fillStyle=selected?"rgba(255,207,112,.18)":"rgba(80,180,255,.13)";
 if(g.type==="Point"){const [x,y]=g.coordinates;context.beginPath();context.arc(x,y,Math.max(4,context.lineWidth*2),0,Math.PI*2);context.fill();context.stroke();}
 else if(g.type==="BoundingBox"){const [x,y,w,h]=g.coordinates;context.fillRect(x,y,w,h);context.strokeRect(x,y,w,h);}
 else if(g.type==="LineString"||g.type==="Polygon"){const pts=g.type==="LineString"?g.coordinates:g.coordinates[0];context.beginPath();pts.forEach((p,i)=>i?context.lineTo(p[0],p[1]):context.moveTo(p[0],p[1]));if(g.type==="Polygon"){context.closePath();context.fill();}context.stroke();}
 context.restore();
}
function redraw(){
 if(!s.source)return;ctx.clearRect(0,0,u.canvas.width,u.canvas.height);
 for(const item of s.items)paint(ctx,item.geometry,item.id===s.selected,item.status);
 if(s.vertices.length){ctx.save();ctx.strokeStyle="#ffcf70";ctx.fillStyle="#ffcf70";ctx.lineWidth=Math.max(2,u.canvas.width/450);ctx.setLineDash([7,5]);ctx.beginPath();s.vertices.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.stroke();ctx.setLineDash([]);for(const p of s.vertices){ctx.beginPath();ctx.arc(p[0],p[1],Math.max(3,u.canvas.width/350),0,Math.PI*2);ctx.fill();}ctx.restore();}
 if(s.dragStart&&s.dragEnd){const x=Math.min(s.dragStart[0],s.dragEnd[0]),y=Math.min(s.dragStart[1],s.dragEnd[1]);ctx.save();ctx.strokeStyle="#ffcf70";ctx.lineWidth=Math.max(2,u.canvas.width/450);ctx.setLineDash([7,5]);ctx.strokeRect(x,y,Math.abs(s.dragEnd[0]-s.dragStart[0]),Math.abs(s.dragEnd[1]-s.dragStart[1]));ctx.restore();}
}
function addObservation(g){
 if(!s.source)throw new Error("Load a source image first.");
 if(s.items.length>=MAX_OBSERVATIONS)throw new Error("A batch may contain at most 2,000 observations.");
 const v=u.visibility.value;if(!VISIBILITY.has(v))throw new Error("Invalid visibility state.");
 if(!g&&!["occluded","not-visible","not-detected"].includes(v))throw new Error("Visible/partially-occluded observations require geometry.");
 const record={id:"obs-"+Date.now().toString(36)+"-"+(s.next++).toString(36),category:u.category.value,sourceId:s.source.sourceId,sourceSha256:s.source.sha256,viewId:s.source.viewId,geometry:g,confidence:Number(u.confidence.value),method:"human-review",status:"proposed",visibility:v,evidence:{}};
 s.items.push(record);s.selected=record.id;s.vertices=[];s.dragStart=null;s.dragEnd=null;list();redraw();u.stats.textContent=s.items.length+" observation(s). Coordinates are source-image pixels.";status(u.editStatus,"Observation added as proposed. No automatic acceptance occurs.","success");controls();
}
function finish(){const v=s.vertices.map(p=>[Number(p[0].toFixed(2)),Number(p[1].toFixed(2))]);if(u.tool.value==="LineString"&&v.length>=2)addObservation({type:"LineString",coordinates:v});else if(u.tool.value==="Polygon"&&v.length>=3){const ring=[...v];if(ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])ring.push([...ring[0]]);addObservation({type:"Polygon",coordinates:[ring]});}else status(u.editStatus,"Add at least two line points or three polygon points.","warning");}
function list(){
 u.list.replaceChildren();for(const item of s.items){const b=document.createElement("button");b.type="button";b.className="observation-item";b.setAttribute("aria-pressed",String(item.id===s.selected));const left=document.createElement("span");left.className="obs-label";const strong=document.createElement("strong");strong.textContent=item.category;const small=document.createElement("small");small.textContent=item.visibility+" · "+(item.geometry?.type??"no geometry")+" · "+(item.reviews?.length??0)+" review(s)";left.append(strong,small);const badge=document.createElement("span");badge.className="badge "+item.status;badge.textContent=item.status;b.append(left,badge);b.addEventListener("click",()=>select(item.id));u.list.append(b);}
 if(!s.items.length){const p=document.createElement("p");p.className="hint";p.textContent="No observations yet.";u.list.append(p);}
 const chosen=s.items.find(x=>x.id===s.selected);u.selectedStatus.textContent=chosen?chosen.status+" · "+chosen.visibility+" · "+(chosen.reviews?.length??0)+" review event(s)":"No observation selected.";
}
function select(key){s.selected=key;u.reviewer.value="";u.notes.value="";list();redraw();controls();}
function decide(decision){
 const current=s.items.find(x=>x.id===s.selected);if(!current)throw new Error("Select an observation first.");
 const reviewer=u.reviewer.value.trim(),notes=u.notes.value;if(!reviewer)throw new Error("Reviewer identifier is required.");if(notes.length>2000)throw new Error("Notes must not exceed 2,000 characters.");
 const at=new Date().toISOString(),original=current.originalProposal??{id:current.id,category:current.category,sourceId:current.sourceId,sourceSha256:current.sourceSha256,viewId:current.viewId,geometry:current.geometry,confidence:current.confidence,method:current.method,status:"proposed",visibility:current.visibility,evidence:{...current.evidence}};
 const reviews=[...(current.reviews??[]),{decision,reviewerId:reviewer,reviewedAt:at,notes:notes.trim()}];
 const updated={...current,originalProposal:original,reviews,status:decision,reviewedBy:reviewer,reviewedAt:at};s.items=s.items.map(x=>x.id===updated.id?updated:x);list();redraw();controls();status(u.reviewStatus,decision==="reviewed"?"Marked reviewed; earlier review events are retained. This is not ground truth.":"Rejected; the original proposal and review history are retained.","warning");
}
function reopen(){const current=s.items.find(x=>x.id===s.selected);if(!current)return;const next={...current,status:"proposed"};delete next.reviewedBy;delete next.reviewedAt;s.items=s.items.map(x=>x.id===next.id?next:x);list();redraw();controls();status(u.reviewStatus,"Reopened as proposed. Original proposal and all previous review events remain in the batch.","warning");}
function makeBatch(){return{schemaVersion:"1.0.0",batchId:"batch-"+Date.now().toString(36),buildingId:s.source.buildingId,viewId:s.source.viewId,createdAt:s.createdAt,coordinateConvention:CONVENTION,source:{id:s.source.sourceId,sha256:s.source.sha256,width:s.source.width,height:s.source.height},mask:null,observations:s.items.map(x=>structuredClone(x)),policy:{groundTruth:false,publicationEligible:false,publishable:false},limitations:["Observations are source-image pixel labels, not metric geometry or independently verified physical measurements.","Reviewer IDs and decisions are operator-supplied attestations; this editor does not authenticate identities.","Occluded, not-visible and not-detected states must not be converted into inferred architecture.","Source rights, camera calibration, building identity, held-out accuracy and publication approval require separate evidence."]};}
async function exportBatch(){try{if(!s.source)throw new Error("Load a source image first.");const batch=makeBatch(),blob=new Blob([JSON.stringify(batch,null,2)+"\n"],{type:"application/json"});const filename=[batch.buildingId,batch.viewId,"architectural-observations.json"].join("-").replace(/[^a-z0-9._-]/gi,"-");const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);status(u.batchStatus,"Exported "+batch.observations.length+" observation(s). Ground-truth and publication flags are false.","success");}catch(e){status(u.batchStatus,e.message,"error");}}
function validateGeo(g,w,h){
 const p=x=>Array.isArray(x)&&x.length===2&&x.every(Number.isFinite)&&x[0]>=0&&x[1]>=0&&x[0]<=w-1&&x[1]<=h-1;
 if(g===null)return;if(g?.type==="Point"&&p(g.coordinates))return;
 if(g?.type==="BoundingBox"){const [x,y,bw,bh]=g.coordinates??[];if([x,y,bw,bh].every(Number.isFinite)&&x>=0&&y>=0&&bw>0&&bh>0&&x+bw<=w&&y+bh<=h)return;}
 if(g?.type==="LineString"&&Array.isArray(g.coordinates)&&g.coordinates.length>=2&&g.coordinates.every(p))return;
 if(g?.type==="Polygon"&&Array.isArray(g.coordinates)&&g.coordinates.length&&g.coordinates.every(r=>Array.isArray(r)&&r.length>=4&&r.every(p)&&r[0][0]===r.at(-1)[0]&&r[0][1]===r.at(-1)[1]))return;
 throw new Error("Imported feature contains unsupported or out-of-image geometry.");
}
function validateObservation(o,src,view){
 if(!o||!SAFE_ID.test(o.id??"")||!CATEGORIES.has(o.category)||o.sourceId!==src.id||o.sourceSha256?.toLowerCase()!==src.sha256||o.viewId!==view||!VISIBILITY.has(o.visibility)||!["proposed","reviewed","rejected"].includes(o.status)||!Number.isFinite(o.confidence)||o.confidence<0||o.confidence>1||o.method!=="human-review")throw new Error("Imported observation has invalid schema, category, status or source/view provenance.");
 if(o.geometry===null&&!["occluded","not-visible","not-detected"].includes(o.visibility))throw new Error("Visible observations require geometry.");validateGeo(o.geometry,src.width,src.height);
 if(o.reviews!==undefined){if(!Array.isArray(o.reviews)||o.reviews.length>100)throw new Error("Review history exceeds 100 events.");for(const r of o.reviews)if(!["reviewed","rejected"].includes(r.decision)||typeof r.reviewerId!=="string"||!r.reviewerId.trim()||!Number.isFinite(Date.parse(r.reviewedAt))||typeof(r.notes??"")!=="string"||(r.notes??"").length>2000)throw new Error("Imported review event is invalid.");if(o.reviews.length&&!o.originalProposal)throw new Error("Original proposal snapshot is missing.");if(o.status!=="proposed"&&o.reviews.length){const last=o.reviews.at(-1);if(last.decision!==o.status||last.reviewerId!==o.reviewedBy||new Date(last.reviewedAt).toISOString()!==new Date(o.reviewedAt).toISOString())throw new Error("Current status does not match latest review event.");}}
 return structuredClone(o);
}
async function importBatch(){try{const file=u.batchFile.files?.[0];if(!file)throw new Error("Choose an observation JSON file.");if(file.size<1||file.size>10*1024*1024)throw new Error("Batch must be 1 byte to 10 MiB.");const b=JSON.parse(await file.text()),src=s.source;
 if(b?.schemaVersion!=="1.0.0"||b.coordinateConvention!==CONVENTION||b.buildingId!==src.buildingId||b.viewId!==src.viewId||b.source?.id!==src.sourceId||b.source?.sha256?.toLowerCase()!==src.sha256||b.source?.width!==src.width||b.source?.height!==src.height||!Array.isArray(b.observations)||b.observations.length>MAX_OBSERVATIONS)throw new Error("Batch does not match the exact loaded source, building, view or pixel coordinate convention.");
 const seen=new Set(),items=b.observations.map(o=>{if(seen.has(o.id))throw new Error("Batch has duplicate observation IDs.");seen.add(o.id);return validateObservation(o,{id:src.sourceId,sha256:src.sha256,width:src.width,height:src.height},src.viewId);});
 s.items=items;s.selected=items[0]?.id??null;s.createdAt=b.createdAt;list();redraw();controls();status(u.batchStatus,"Validated and imported "+items.length+" source-bound observation(s), including review history.","success");
 }catch(e){status(u.batchStatus,e.message,"error");}}
function pointerDown(e){if(!s.source)return;const p=point(e);if(u.tool.value==="BoundingBox"){e.preventDefault();u.canvas.setPointerCapture(e.pointerId);s.dragStart=p;s.dragEnd=p;redraw();controls();return;}if(u.tool.value==="Point"){try{addObservation({type:"Point",coordinates:p.map(x=>Number(x.toFixed(2)))});}catch(err){status(u.editStatus,err.message,"error");}return;}s.vertices.push(p);redraw();u.stats.textContent=s.vertices.length+" geometry vertex/vertices added.";controls();}
function pointerMove(e){if(!s.dragStart)return;s.dragEnd=point(e);redraw();}
function pointerUp(e){if(!s.dragStart)return;const start=s.dragStart,end=point(e);s.dragStart=null;s.dragEnd=null;const x=Math.min(start[0],end[0]),y=Math.min(start[1],end[1]),w=Math.abs(end[0]-start[0]),h=Math.abs(end[1]-start[1]);if(w<1||h<1){status(u.editStatus,"Rectangle must have non-zero width and height.","warning");redraw();controls();return;}try{addObservation({type:"BoundingBox",coordinates:[Number(x.toFixed(2)),Number(y.toFixed(2)),Number(w.toFixed(2)),Number(h.toFixed(2))]});}catch(err){status(u.editStatus,err.message,"error");}}
function visibilityChange(){const no=["occluded","not-visible","not-detected"].includes(u.visibility.value);u.addUnknown.hidden=!no;u.help.textContent=no?"This state can be recorded without invented geometry. Choose Add without geometry.":desc();controls();}
u.file.addEventListener("change",async()=>{const file=u.file.files?.[0];if(!file)return;try{if(!["image/png","image/jpeg","image/webp"].includes(file.type)||file.size<1||file.size>MAX_BYTES)throw new Error("Choose a non-empty PNG/JPEG/WebP image up to 30 MiB.");const identity=ids(),bytes=await file.arrayBuffer(),sha=await hash(bytes),decoded=await decode(file),w=decoded.image.naturalWidth,h=decoded.image.naturalHeight;if(!w||!h||w*h>MAX_PIXELS){URL.revokeObjectURL(decoded.url);throw new Error("Image dimensions are invalid or exceed 15 million pixels.");}if(s.url)URL.revokeObjectURL(s.url);s.url=decoded.url;s.source={...identity,sha256:sha,width:w,height:h,bytes:file.size,filename:file.name};s.items=[];s.selected=null;s.vertices=[];s.createdAt=new Date().toISOString();u.image.src=decoded.url;u.stage.hidden=false;u.empty.hidden=true;u.canvas.width=w;u.canvas.height=h;u.hash.textContent=sha;u.dimensions.textContent=w+" × "+h+" pixels";lockIdentity(true);controls();list();redraw();status(u.sourceStatus,"Loaded and hashed "+file.name+". Source identity is now fixed for this batch.","success");status(u.batchStatus,"Source-bound annotation session ready.","success");status(u.editStatus,"Select a feature category, geometry tool and visibility before drawing.","success");}catch(e){status(u.sourceStatus,e.message,"error");}});
function lockIdentity(v){u.building.disabled=v;u.view.disabled=v;u.sourceId.disabled=v;u.file.disabled=v;}
u.batchFile.addEventListener("change",controls);u.import.addEventListener("click",importBatch);u.export.addEventListener("click",exportBatch);
u.tool.addEventListener("change",()=>{s.vertices=[];s.dragStart=null;s.dragEnd=null;desc();redraw();controls();});u.visibility.addEventListener("change",visibilityChange);
u.confidence.addEventListener("input",()=>u.confidenceValue.textContent=Number(u.confidence.value).toFixed(2));
u.canvas.addEventListener("pointerdown",pointerDown);u.canvas.addEventListener("pointermove",pointerMove);u.canvas.addEventListener("pointerup",pointerUp);u.canvas.addEventListener("pointercancel",()=>{s.dragStart=null;s.dragEnd=null;redraw();controls();});
u.finish.addEventListener("click",finish);u.undo.addEventListener("click",()=>{s.vertices.pop();redraw();controls();});u.cancel.addEventListener("click",()=>{s.vertices=[];s.dragStart=null;s.dragEnd=null;redraw();controls();});
u.addUnknown.addEventListener("click",()=>{try{addObservation(null);}catch(e){status(u.editStatus,e.message,"error");}});
u.review.addEventListener("click",()=>{try{decide("reviewed");}catch(e){status(u.reviewStatus,e.message,"error");}});u.reject.addEventListener("click",()=>{try{decide("rejected");}catch(e){status(u.reviewStatus,e.message,"error");}});u.reopen.addEventListener("click",reopen);
u.reviewer.addEventListener("input",controls);
desc();visibilityChange();list();controls();
})();