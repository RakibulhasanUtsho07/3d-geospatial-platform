import assert from "node:assert/strict";
import test from "node:test";
import { reviewTextureImageContent } from "../src/core/building-generation/texture-image-content-review.mjs";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lYsAAAAASUVORK5CYII=", "base64");

test("inspects PNG dimensions and reports tiny texture resolution as a review risk", () => {
  const report = reviewTextureImageContent(onePixelPng,"image/png");
  assert.equal(report.format,"png");
  assert.equal(report.width,1);
  assert.equal(report.height,1);
  assert.ok(report.risks.includes("low-resolution-texture-review"));
  assert.ok(["sampled-8bit-png","invalid-png-data","unsupported-png-layout"].includes(report.pixelAnalysis));
});

test("does not pretend unsupported image formats have decoded pixel statistics", () => {
  const report = reviewTextureImageContent(Buffer.from([1,2,3]),"image/jpeg");
  assert.equal(report.pixelAnalysis,"not-available");
  assert.ok(report.risks.includes("pixel-content-not-analysed-for-this-image-format"));
});

test("rejects invalid analysis configuration", () => {
  assert.throws(()=>reviewTextureImageContent(onePixelPng,"image/png",{maxPixels:0}),/maxPixels/);
  assert.throws(()=>reviewTextureImageContent(onePixelPng,"image/png",{minRecommendedDimension:0}),/minRecommendedDimension/);
});
