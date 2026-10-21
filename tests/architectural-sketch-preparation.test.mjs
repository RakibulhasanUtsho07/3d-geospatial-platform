import assert from "node:assert/strict";
import test from "node:test";
import { buildArchitecturalSketchFilter, createSketchRecord, normalizeSketchOptions } from "../src/core/building-generation/architectural-sketch-preparation.mjs";

test("normalizes default sketch preview options",()=>{
 assert.deepEqual(normalizeSketchOptions(),{lowThreshold:0.08,highThreshold:0.25,maxEdge:4096});
});

test("builds deterministic grayscale edge filter with bounded dimensions",()=>{
 assert.equal(buildArchitecturalSketchFilter({lowThreshold:0.1,highThreshold:0.3,maxEdge:2048}),"scale=w='min(iw,2048)':h='min(ih,2048)':force_original_aspect_ratio=decrease:flags=lanczos,format=gray,edgedetect=low=0.1:high=0.3,negate");
});

test("rejects invalid thresholds and output resolution",()=>{
 assert.throws(()=>normalizeSketchOptions({lowThreshold:0.4,highThreshold:0.2}),/cannot exceed/);
 assert.throws(()=>normalizeSketchOptions({lowThreshold:-0.1}),/between 0 and 1/);
 assert.throws(()=>normalizeSketchOptions({maxEdge:128}),/from 256 to 16384/);
});

test("records per-image sketch provenance and known limitations",()=>{
 const record=createSketchRecord({sourceFile:"front.jpg",outputFile:"front.jpg.edges.png",width:4000,height:3000,sourceSha256:"a".repeat(64),options:{}});
 assert.equal(record.sketchType,"grayscale-edge-drawing-preview");
 assert.equal(record.status,"preview-generated-needs-building-segmentation");
 assert.equal(record.sourceWidth,4000);
 assert.equal(record.limitations.length,4);
 assert.throws(()=>createSketchRecord({sourceFile:"x",outputFile:"y",width:0,height:1,sourceSha256:"a".repeat(64),options:{}}),/positive integers/);
 assert.throws(()=>createSketchRecord({sourceFile:"x",outputFile:"y",width:1,height:1,sourceSha256:"bad",options:{}}),/SHA-256/);
});
