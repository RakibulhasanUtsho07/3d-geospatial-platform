import assert from "node:assert/strict";
import test from "node:test";
import { finalizeRenderReviewManifest, REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";

const hash = "a".repeat(64);
function fixture(overrides = {}) {
  const views = REQUIRED_REVIEW_VIEWS.map((id) => ({
    id,
    filename: id + ".png",
    width: 512,
    height: 512,
    renderComplete: true,
    pixelStatistics: {
      sampledPixels: 50000,
      luminanceMean: 0.4,
      luminanceStandardDeviation: 0.15,
      transparentRatio: 0,
    },
  }));
  const files = Object.fromEntries(views.map((view) => [view.filename, {
    width: 512, height: 512, bytes: 51200, sha256: hash,
  }]));
  return {
    rawManifest: {
      schemaVersion: "1.0.0",
      rendererVersion: "4.5.0",
      width: 512,
      height: 512,
      sceneBounds: { min: [-1,-1,0], max: [1,1,3], dimensions: [2,2,3], coordinateUnits: "imported-model-units-unverified" },
      views,
      ...overrides.raw,
    },
    modelSha256: hash,
    resolution: 512,
    files: overrides.files ?? files,
  };
}

test("finalizes the full five-axis plus eight-angle render set", () => {
  const report = finalizeRenderReviewManifest(fixture());
  assert.equal(report.valid, true);
  assert.equal(report.status, "render-set-ready-for-human-review");
  assert.equal(report.counts.generatedViews, 13);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.humanReview.status, "pending");
  assert.equal(report.humanReview.checklist.length, 5);
});

test("fails when a required view is missing", () => {
  const data = fixture();
  data.rawManifest.views = data.rawManifest.views.filter((view) => view.id !== "back");
  const report = finalizeRenderReviewManifest(data);
  assert.equal(report.valid, false);
  assert.ok(report.errors.includes("missing-required-view:back"));
});

test("fails for unsafe file names and wrong PNG dimensions", () => {
  const data = fixture();
  data.rawManifest.views[0].filename = "../front.png";
  const report = finalizeRenderReviewManifest(data);
  assert.ok(report.errors.includes("invalid-render-filename:front"));
  const bad = fixture();
  bad.files["front.png"].width = 256;
  const dimensions = finalizeRenderReviewManifest(bad);
  assert.ok(dimensions.errors.includes("render-dimensions-mismatch:front"));
});

test("reports low-contrast and transparency review candidates without calling them defects", () => {
  const data = fixture();
  data.rawManifest.views[0].pixelStatistics.luminanceStandardDeviation = 0.001;
  data.rawManifest.views[1].pixelStatistics.transparentRatio = 0.99;
  const report = finalizeRenderReviewManifest(data);
  assert.equal(report.valid, true);
  assert.ok(report.warnings.includes("low-contrast-render-review:front"));
  assert.ok(report.warnings.includes("mostly-transparent-render-review:back"));
  assert.equal(report.status, "review-required");
});

test("rejects invalid hashes, invalid dimensions and incomplete render records", () => {
  const data = fixture();
  data.modelSha256 = "not-a-sha";
  assert.throws(() => finalizeRenderReviewManifest(data), /modelSha256/);
  const bad = fixture();
  bad.rawManifest.views[0].renderComplete = false;
  bad.files["front.png"].sha256 = "bad";
  const report = finalizeRenderReviewManifest(bad);
  assert.ok(report.errors.includes("render-not-complete:front"));
  assert.ok(report.errors.includes("render-sha256-invalid:front"));
});
