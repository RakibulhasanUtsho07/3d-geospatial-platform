const DEFAULT_LOW=0.08,DEFAULT_HIGH=0.25,DEFAULT_MAX_EDGE=4096;
export function normalizeSketchOptions(options={}){
 const low=options.lowThreshold??DEFAULT_LOW,high=options.highThreshold??DEFAULT_HIGH,maxEdge=options.maxEdge??DEFAULT_MAX_EDGE;
 if(!Number.isFinite(low)||low<0||low>1)throw new RangeError("lowThreshold must be between 0 and 1");
 if(!Number.isFinite(high)||high<0||high>1)throw new RangeError("highThreshold must be between 0 and 1");
 if(low>high)throw new RangeError("lowThreshold cannot exceed highThreshold");
 if(!Number.isSafeInteger(maxEdge)||maxEdge<256||maxEdge>16384)throw new RangeError("maxEdge must be an integer from 256 to 16384");
 return {lowThreshold:low,highThreshold:high,maxEdge};
}
/** FFmpeg filter for a grayscale edge-drawing preview. This is not semantic building segmentation. */
export function buildArchitecturalSketchFilter(options={}){
 const normalized=normalizeSketchOptions(options);
 return "scale=w='min(iw,"+normalized.maxEdge+")':h='min(ih,"+normalized.maxEdge+")':force_original_aspect_ratio=decrease:flags=lanczos,format=gray,edgedetect=low="+normalized.lowThreshold+":high="+normalized.highThreshold+",negate";
}
export function createSketchRecord({sourceFile,outputFile,width,height,options,sourceSha256}){
 if(typeof sourceFile!=="string"||!sourceFile||typeof outputFile!=="string"||!outputFile)throw new TypeError("sourceFile and outputFile are required");
 if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1)throw new TypeError("source dimensions must be positive integers");
 if(typeof sourceSha256!=="string"||!/^[a-f0-9]{64}$/i.test(sourceSha256))throw new TypeError("sourceSha256 must be a SHA-256 hex digest");
 return {sourceFile,outputFile,sourceWidth:width,sourceHeight:height,sourceSha256,sketchType:"grayscale-edge-drawing-preview",options:normalizeSketchOptions(options),status:"preview-generated-needs-building-segmentation",limitations:["Edges include background objects and texture boundaries.","This is not a vector architectural drawing.","No multi-view alignment or 3D reconstruction is performed.","Occluded or hidden architecture is not inferred." ]};
}
