import { buildArchitecturalSketchFilter, normalizeSketchOptions } from "./architectural-sketch-preparation.mjs";
export function validateMaskDimensions(source,mask){
 for(const [label,value] of [["source",source],["mask",mask]])if(!Number.isSafeInteger(value?.width)||value.width<1||!Number.isSafeInteger(value?.height)||value.height<1)throw new TypeError(label+" dimensions must be positive integers");
 if(source.width!==mask.width||source.height!==mask.height)throw new RangeError("mask dimensions must exactly match the source image pixel dimensions");
 return {width:source.width,height:source.height};
}
/** Build a filter graph for a human-reviewed binary mask: white=building, black=background. */
export function buildMaskedBuildingSketchFilter(options={}){
 const normalized=normalizeSketchOptions(options);
 const edge=buildArchitecturalSketchFilter(normalized).replace(/,negate$/,"");
 const scale="scale=w='min(iw,"+normalized.maxEdge+")':h='min(ih,"+normalized.maxEdge+")':force_original_aspect_ratio=decrease:flags=lanczos";
 return "[0:v]"+edge+"[edges];[1:v]"+scale+",format=gray,threshold=0.5[mask];[edges][mask]blend=all_mode=multiply,format=gray";
}
