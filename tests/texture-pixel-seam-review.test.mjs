import assert from "node:assert/strict";
import test from "node:test";
import { reviewTexturePixelSeams } from "../src/core/building-generation/texture-pixel-seam-review.mjs";

const positions = [[0,0,0],[1,0,0],[1,1,0],[1,0,0],[1,1,0],[0,1,0]];
const indices = [0,1,2,3,4,5];
const splitUvs = [[0,0],[1,0],[1,1],[0,0],[0,1],[1,1]];
const continuousUvs = [[0,0],[1,0],[1,1],[1,0],[1,1],[0,1]];

function pixelData(width, height, sample) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y=0; y<height; y++) {
    for (let x=0; x<width; x++) {
      const color = sample(x,y);
      const offset = (y*width+x)*3;
      pixels[offset]=color[0];pixels[offset+1]=color[1];pixels[offset+2]=color[2];
    }
  }
  return { width, height, channels:3, colorType:2, pixels };
}

test("flags large pixel-color jumps along an atlas edge with a UV discontinuity", () => {
  const report = reviewTexturePixelSeams({
    positions, indices, uvs:splitUvs,
    pixelData:pixelData(16,16,(x)=>x<8?[20,20,20]:[220,220,220]),
  });
  assert.equal(report.uvSeamCandidateCount,1);
  assert.equal(report.analyzedSeamCount,1);
  assert.equal(report.highDiscontinuityCount,1);
  assert.equal(report.status,"review-required");
  assert.ok(report.candidates[0].meanEdgeRgbDelta > 150);
  assert.ok(report.warnings.includes("high-pixel-discontinuity-review-required"));
  assert.equal(report.publicationEligible,false);
});

test("does not report a large discontinuity when both atlas islands have matching edge colors", () => {
  const report = reviewTexturePixelSeams({
    positions, indices, uvs:splitUvs,
    pixelData:pixelData(16,16,()=>[128,140,150]),
  });
  assert.equal(report.highDiscontinuityCount,0);
  assert.equal(report.moderateDiscontinuityCount,0);
  assert.equal(report.status,"low-discontinuity-signals-detected");
});

test("does not invent a pixel-level clean result when decoded image bytes are unavailable", () => {
  const report = reviewTexturePixelSeams({ positions, indices, uvs:splitUvs, pixelData:null });
  assert.equal(report.status,"pixel-analysis-unavailable");
  assert.ok(report.warnings.includes("embedded-pixel-data-unavailable-or-unsupported"));
});

test("returns resolution risk rather than a clean result for tiny textures", () => {
  const report = reviewTexturePixelSeams({
    positions, indices, uvs:splitUvs,
    pixelData:pixelData(4,4,()=>[1,1,1]),
  });
  assert.equal(report.status,"insufficient-resolution");
  assert.ok(report.warnings.includes("texture-too-small-for-reliable-pixel-seam-analysis"));
});

test("does not treat continuous UV edges as pixel seam candidates", () => {
  const report = reviewTexturePixelSeams({
    positions, indices, uvs:continuousUvs,
    pixelData:pixelData(16,16,(x)=>x<8?[0,0,0]:[255,255,255]),
  });
  assert.equal(report.uvSeamCandidateCount,0);
  assert.equal(report.status,"no-uv-seam-candidates");
});

test("validates sampling budgets and thresholds", () => {
  const common = { positions, indices, uvs:splitUvs, pixelData:pixelData(16,16,()=>[30,60,90]) };
  assert.throws(()=>reviewTexturePixelSeams(common,{ pixelDifferenceThreshold:300 }),/between zero and 255/);
  assert.throws(()=>reviewTexturePixelSeams(common,{ maxCandidates:0 }),/between 1 and 10000/);
  assert.throws(()=>reviewTexturePixelSeams(common,{ sampleFractions:[0,0.5] }),/strictly between/);
});
