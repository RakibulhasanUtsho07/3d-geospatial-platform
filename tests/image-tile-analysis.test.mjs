import assert from "node:assert/strict";
import test from "node:test";
import { mapTileBoxToSource, mergeOverlappingDetections, planImageTiles } from "../src/core/building-generation/image-tile-analysis.mjs";

test("plans deterministic overlapping tiles and covers image edges",()=>{
 const result=planImageTiles(2500,1800,{tileSize:1024,overlap:128});
 assert.equal(result.tileCount,6);
 assert.deepEqual(result.tiles[0],{id:"r001-c001",row:0,column:0,x:0,y:0,width:1024,height:1024,sourceWidth:2500,sourceHeight:1800});
 assert.equal(result.tiles.at(-1).x+result.tiles.at(-1).width,2500);
 assert.equal(result.tiles.at(-1).y+result.tiles.at(-1).height,1800);
 for(const tile of result.tiles){assert.ok(tile.x>=0&&tile.y>=0);assert.ok(tile.x+tile.width<=2500);assert.ok(tile.y+tile.height<=1800);}
});

test("uses one tile for images smaller than the configured tile size",()=>{
 const result=planImageTiles(640,480,{tileSize:1024,overlap:128});
 assert.equal(result.tileCount,1);
 assert.deepEqual({width:result.tiles[0].width,height:result.tiles[0].height},{width:640,height:480});
});

test("maps tile-local boxes back to original image coordinates",()=>{
 const result=planImageTiles(1800,1200,{tileSize:1024,overlap:128});
 const tile=result.tiles.find(item=>item.x===776&&item.y===0);
 assert.ok(tile);
 assert.deepEqual(mapTileBoxToSource(tile,{x:10,y:20,width:100,height:60}),{x:786,y:20,width:100,height:60});
 assert.throws(()=>mapTileBoxToSource(tile,{x:1000,y:20,width:100,height:60}),/within tile bounds/);
});

test("merges same-class duplicate boxes from overlapping tiles and preserves separate classes",()=>{
 const detections=[
  {x:100,y:100,width:80,height:100,score:0.8,label:"building",tileId:"a"},
  {x:104,y:102,width:80,height:100,score:0.95,label:"building",tileId:"b"},
  {x:104,y:102,width:80,height:100,score:0.9,label:"tree",tileId:"b"},
  {x:500,y:500,width:40,height:40,score:0.2,label:"building",tileId:"c"},
 ];
 const result=mergeOverlappingDetections(detections,{iouThreshold:0.5,minScore:0.3});
 assert.equal(result.length,2);
 const building=result.find(item=>item.label==="building");
 assert.equal(building.score,0.95);
 assert.equal(building.mergedDetectionCount,2);
 assert.deepEqual(building.mergedFrom,[1,0]);
 assert.equal(result.find(item=>item.label==="tree").mergedDetectionCount,1);
});

test("rejects invalid tile parameters and detections",()=>{
 assert.throws(()=>planImageTiles(100,100,{tileSize:64,overlap:64}),/overlap/);
 assert.throws(()=>planImageTiles(0,100),/width/);
 assert.throws(()=>mergeOverlappingDetections([{x:0,y:0,width:-1,height:10,score:1}]),/invalid box/);
 assert.throws(()=>mergeOverlappingDetections([],{iouThreshold:2}),/iouThreshold/);
});
