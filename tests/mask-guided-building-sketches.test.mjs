import assert from "node:assert/strict";
import test from "node:test";
import { buildMaskedBuildingSketchFilter, validateMaskDimensions } from "../src/core/building-generation/mask-guided-building-sketches.mjs";

test("builds a mask-guided filter that clips edges to white building foreground",()=>{
 const filter=buildMaskedBuildingSketchFilter({maxEdge:2048,lowThreshold:0.1,highThreshold:0.3});
 assert.match(filter,/edgedetect=low=0.1:high=0.3/);
 assert.match(filter,/blend=all_mode=multiply/);
 assert.match(filter,/format=gray/);
});

test("requires exact source-to-mask pixel dimension alignment",()=>{
 assert.deepEqual(validateMaskDimensions({width:4000,height:3000},{width:4000,height:3000}),{width:4000,height:3000});
 assert.throws(()=>validateMaskDimensions({width:4000,height:3000},{width:2000,height:1500}),/must exactly match/);
 assert.throws(()=>validateMaskDimensions({width:0,height:2},{width:0,height:2}),/positive integers/);
});
