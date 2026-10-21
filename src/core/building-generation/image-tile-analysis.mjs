const DEFAULT_TILE_SIZE=1024;
const DEFAULT_OVERLAP=128;
const DEFAULT_MIN_TILE_SIZE=256;

function positiveInteger(value,label){
 if(!Number.isSafeInteger(value)||value<1)throw new RangeError(label+" must be a positive integer");
 return value;
}
function axisStarts(length,tileSize,overlap){
 if(length<=tileSize)return [0];
 const stride=tileSize-overlap,starts=[];
 for(let start=0;start+tileSize<length;start+=stride)starts.push(start);
 const last=length-tileSize;
 if(starts.at(-1)!==last)starts.push(last);
 return [...new Set(starts)];
}
/**
 * Plan overlapping tiles in source-image pixel coordinates. Planning is deterministic
 * and does not imply that any tile contains a building or that pixels were interpreted.
 */
export function planImageTiles(width,height,options={}){
 positiveInteger(width,"width");positiveInteger(height,"height");
 const tileSize=options.tileSize??DEFAULT_TILE_SIZE,overlap=options.overlap??DEFAULT_OVERLAP,minTileSize=options.minTileSize??DEFAULT_MIN_TILE_SIZE;
 positiveInteger(tileSize,"tileSize");positiveInteger(minTileSize,"minTileSize");
 if(!Number.isSafeInteger(overlap)||overlap<0||overlap>=tileSize)throw new RangeError("overlap must be an integer from 0 to tileSize-1");
 if(minTileSize>tileSize)throw new RangeError("minTileSize cannot exceed tileSize");
 const xs=axisStarts(width,tileSize,overlap),ys=axisStarts(height,tileSize,overlap),tiles=[];
 for(let row=0;row<ys.length;row++)for(let column=0;column<xs.length;column++){
  const x=xs[column],y=ys[row],w=Math.min(tileSize,width-x),h=Math.min(tileSize,height-y);
  // A small source image is valid as a single tile; minTileSize only constrains
  // edge tiles when that source axis is larger than tileSize.
  if((width>tileSize&&w<minTileSize)||(height>tileSize&&h<minTileSize))throw new RangeError("planned edge tile is smaller than minTileSize; reduce tileSize or minTileSize");
  tiles.push({id:"r"+String(row+1).padStart(3,"0")+"-c"+String(column+1).padStart(3,"0"),row,column,x,y,width:w,height:h,sourceWidth:width,sourceHeight:height});
 }
 return {schemaVersion:"1.0.0",strategy:"overlapping-grid-v1",source:{width,height},config:{tileSize,overlap,minTileSize},tileCount:tiles.length,tiles};
}

/** Map a tile-local rectangle into source-image pixel coordinates without clipping silently. */
export function mapTileBoxToSource(tile,box){
 if(!tile||![tile.x,tile.y,tile.width,tile.height,tile.sourceWidth,tile.sourceHeight].every(Number.isFinite))throw new TypeError("valid tile geometry is required");
 if(!box||![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.width<=0||box.height<=0)throw new TypeError("box must contain finite x/y and positive width/height");
 if(box.x<0||box.y<0||box.x+box.width>tile.width||box.y+box.height>tile.height)throw new RangeError("tile-local box must lie within tile bounds");
 return {x:tile.x+box.x,y:tile.y+box.y,width:box.width,height:box.height};
}
function intersectionOverUnion(a,b){
 const left=Math.max(a.x,b.x),top=Math.max(a.y,b.y),right=Math.min(a.x+a.width,b.x+b.width),bottom=Math.min(a.y+a.height,b.y+b.height);
 const intersection=Math.max(0,right-left)*Math.max(0,bottom-top),union=a.width*a.height+b.width*b.height-intersection;
 return union>0?intersection/union:0;
}
/**
 * Merge duplicate detections from overlapping tiles using deterministic class-aware NMS.
 * Input boxes must already be mapped to source-image coordinates.
 */
export function mergeOverlappingDetections(detections,options={}){
 if(!Array.isArray(detections))throw new TypeError("detections must be an array");
 const iouThreshold=options.iouThreshold??0.5;
 if(!Number.isFinite(iouThreshold)||iouThreshold<0||iouThreshold>1)throw new RangeError("iouThreshold must be from 0 to 1");
 const minScore=options.minScore??0;
 if(!Number.isFinite(minScore)||minScore<0||minScore>1)throw new RangeError("minScore must be from 0 to 1");
 const candidates=detections.map((d,index)=>{
  if(!d||![d.x,d.y,d.width,d.height,d.score].every(Number.isFinite)||d.width<=0||d.height<=0||d.score<0||d.score>1)throw new TypeError("detection "+index+" has invalid box or score");
  return {...d,sourceIndex:index};
 }).filter(d=>d.score>=minScore).sort((a,b)=>b.score-a.score||a.sourceIndex-b.sourceIndex);
 const kept=[];
 for(const candidate of candidates){
  const duplicate=kept.find(existing=>(existing.label??"unknown")===(candidate.label??"unknown")&&intersectionOverUnion(existing,candidate)>iouThreshold);
  if(duplicate){duplicate.mergedDetectionCount=(duplicate.mergedDetectionCount??1)+1;duplicate.mergedFrom=[...(duplicate.mergedFrom??[duplicate.sourceIndex]),candidate.sourceIndex];}
  else kept.push({...candidate,mergedDetectionCount:1,mergedFrom:[candidate.sourceIndex]});
 }
 return kept.map(({sourceIndex,...d})=>d);
}
