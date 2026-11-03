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
    framing: id === "front" ? "rangmahal-south-facade" : "whole-model",
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
      modelCoordinateFrame: "gltf-right-handed-x-east-y-up-z-south",
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
  assert.equal(report.frontCameraEffectiveBearingDegrees, 180, "legacy/default review camera is south-facing in the glTF frame");
  assert.equal(report.humanReview.status, "pending");
  assert.equal(report.humanReview.checklist.length, 5);
  assert.equal(report.views.find((view) => view.id === "front").framing, "rangmahal-south-facade");
  assert.equal(report.views.find((view) => view.id === "back").framing, "whole-model");
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


test("preserves a validated GLB front bearing and source in the review manifest", () => {
  const data = fixture();
  data.rawManifest.frontFacingAzimuthDegrees = 180;
  data.rawManifest.frontAxisSource = "buildingSpec.architecture.frontFacingAzimuthDegrees";
  data.rawManifest.frontAxisConfidence = "estimated";
  const report = finalizeRenderReviewManifest(data);
  assert.equal(report.valid, true);
  assert.equal(report.frontFacingAzimuthDegrees, 180);
  assert.equal(report.modelCoordinateFrame, "gltf-right-handed-x-east-y-up-z-south");
  assert.equal(report.frontCameraEffectiveBearingDegrees, 180);
  assert.equal(report.frontAxisConfidence, "estimated");
  assert.equal(report.frontAxisSource, "buildingSpec.architecture.frontFacingAzimuthDegrees");
});

test("fails closed when front bearing metadata has an invalid value or source", () => {
  const invalidBearing = fixture();
  invalidBearing.rawManifest.frontFacingAzimuthDegrees = 361;
  invalidBearing.rawManifest.frontAxisSource = "buildingSpec.architecture.frontFacingAzimuthDegrees";
  assert.ok(finalizeRenderReviewManifest(invalidBearing).errors.includes("render-front-bearing-metadata-invalid"));

  const wrongSource = fixture();
  wrongSource.rawManifest.frontFacingAzimuthDegrees = 90;
  wrongSource.rawManifest.frontAxisSource = "renderer-default";
  wrongSource.rawManifest.frontAxisConfidence = "estimated";
  assert.ok(finalizeRenderReviewManifest(wrongSource).errors.includes("render-front-bearing-metadata-invalid"));

  const invalidConfidence = fixture();
  invalidConfidence.rawManifest.frontFacingAzimuthDegrees = 90;
  invalidConfidence.rawManifest.frontAxisSource = "buildingSpec.architecture.frontFacingAzimuthDegrees";
  invalidConfidence.rawManifest.frontAxisConfidence = "false-verified";
  assert.ok(finalizeRenderReviewManifest(invalidConfidence).errors.includes("render-front-bearing-metadata-invalid"));

  const missingBearingSource = fixture();
  missingBearingSource.rawManifest.frontAxisSource = "buildingSpec.architecture.frontFacingAzimuthDegrees";
  assert.ok(finalizeRenderReviewManifest(missingBearingSource).errors.includes("render-front-bearing-source-mismatch"));
});



test("accepts only the generator's supported front-axis provenance sources", () => {
  for (const source of [
    "buildingSpec.architecture.frontFacingAzimuthDegrees",
    "buildingSpec.architecture.frontFacadeEdgeIndex",
    "longest-edge-inferred",
  ]) {
    const data = fixture();
    data.rawManifest.frontFacingAzimuthDegrees = 180;
    data.rawManifest.frontAxisSource = source;
    data.rawManifest.frontAxisConfidence = "estimated";
    const report = finalizeRenderReviewManifest(data);
    assert.equal(report.valid, true, source);
    assert.equal(report.frontAxisSource, source);
  }

  const unsupported = fixture();
  unsupported.rawManifest.frontFacingAzimuthDegrees = 180;
  unsupported.rawManifest.frontAxisSource = "untrusted-arbitrary-string";
  unsupported.rawManifest.frontAxisConfidence = "estimated";
  assert.ok(finalizeRenderReviewManifest(unsupported).errors.includes("render-front-bearing-metadata-invalid"));
});

test("fails closed when effective front camera bearing contradicts the source bearing or default", () => {
  const explicitMismatch = fixture();
  explicitMismatch.rawManifest.frontFacingAzimuthDegrees = 180;
  explicitMismatch.rawManifest.frontAxisSource = "buildingSpec.architecture.frontFacingAzimuthDegrees";
  explicitMismatch.rawManifest.frontAxisConfidence = "estimated";
  explicitMismatch.rawManifest.frontCameraEffectiveBearingDegrees = 90;
  assert.ok(finalizeRenderReviewManifest(explicitMismatch).errors.includes("render-effective-front-bearing-mismatch"));

  const defaultMismatch = fixture();
  defaultMismatch.rawManifest.frontCameraEffectiveBearingDegrees = 0;
  assert.ok(finalizeRenderReviewManifest(defaultMismatch).errors.includes("render-effective-front-bearing-mismatch"));
});


test("fails closed when a GLB bearing is supplied without the right-handed geospatial coordinate frame", () => {
  const data = fixture();
  data.rawManifest.frontFacingAzimuthDegrees = 180;
  data.rawManifest.frontAxisSource = "buildingSpec.architecture.frontFacingAzimuthDegrees";
  data.rawManifest.frontAxisConfidence = "estimated";
  data.rawManifest.modelCoordinateFrame = "x-east,y-up,z-north";
  const report = finalizeRenderReviewManifest(data);
  assert.ok(report.errors.includes("render-model-coordinate-frame-invalid"));
  assert.ok(report.errors.includes("render-bearing-requires-right-handed-model-coordinate-frame"));
  assert.equal(report.publicationEligible, false);
});
