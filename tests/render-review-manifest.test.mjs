import assert from "node:assert/strict";
import test from "node:test";
import { finalizeRenderReviewManifest, REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";

const hash = "a".repeat(64);
function fixture(overrides = {}) {
  const views = REQUIRED_REVIEW_VIEWS.map((id, index) => ({
    id,
    filename: id + ".png",
    width: 512,
    height: 512,
    renderComplete: true,
    cameraPose: {
      projection: "ORTHO",
      positionWorld: [index + 2, -4, 2],
      targetWorld: [index + 2, 0, 2],
      viewDirectionWorld: [0, 1, 0],
      rotationEulerRadians: [0, 0, 0],
      orthographicScale: 3,
    },
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
      renderProfile: "building-review-fixed-cameras-v1",
      renderSettings: {
        renderEngine: "BLENDER_EEVEE_NEXT",
        resolutionX: 512,
        resolutionY: 512,
        resolutionPercentage: 100,
        imageFormat: "PNG",
        imageColorMode: "RGBA",
        imageColorDepth: "8",
        imageCompression: 12,
        filmTransparent: false,
        viewTransform: "AgX",
        cameraProjection: "ORTHO",
        cameraDistanceMultiplier: 3,
        cameraOrthoScaleMultiplier: 1.45,
        turntableElevationDegrees: 22,
        worldBackgroundRgba: [0.38,0.4,0.43,1],
        worldBackgroundStrength: 0.7,
        lights: [
          { name: "key", type: "AREA", positionWorld: [1,2,3], energy: 100, size: 2 },
          { name: "fill", type: "AREA", positionWorld: [-1,2,3], energy: 80, size: 2.5 },
          { name: "rim", type: "AREA", positionWorld: [0,2,4], energy: 65, size: 2 },
        ],
      },
      width: 512,
      height: 512,
      sceneBounds: { min: [-1,-1,0], max: [1,1,3], dimensions: [2,2,3], coordinateUnits: "imported-model-units-unverified" },
      views,
      ...overrides.raw,
    },
    modelSha256: hash,
    resolution: 512,
    geometryQaSummary: Object.hasOwn(overrides, "geometryQaSummary") ? overrides.geometryQaSummary : {
      schemaVersion: "1.0.0",
      engine: "glb-geometry-qa-v2",
      status: "basic-geometry-check-passed",
      valid: true,
      counts: { meshCount: 3, vertexCount: 100, triangleCount: 30, degenerateTriangleCount: 0 },
      bounds: { min: [-1,-1,0], max: [1,1,3], dimensions: [2,2,3], units: "model-space-unverified" },
      warnings: [],
      errors: [],
    },
    files: overrides.files ?? files,
  };
}

test("finalizes the full five-axis plus eight-angle render set", () => {
  const report = finalizeRenderReviewManifest(fixture());
  assert.equal(report.valid, true);
  assert.equal(report.status, "render-set-ready-for-human-review");
  assert.equal(report.counts.generatedViews, 13);
  assert.equal(report.publicationEligible, false);
  assert.match(report.renderConfigSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.geometryQaSummary.engine, "glb-geometry-qa-v2");
  assert.ok(report.views.every((view) => view.cameraPose.projection === "ORTHO"));
  assert.equal(report.humanReview.status, "pending");
  assert.equal(report.humanReview.checklist.length, 5);
});

test("requires geometry QA and camera/settings evidence before calling a render set valid", () => {
  const missingQa = fixture({ geometryQaSummary: null });
  const noQaReport = finalizeRenderReviewManifest(missingQa);
  assert.equal(noQaReport.valid, false);
  assert.ok(noQaReport.errors.includes("geometry-qa-missing"));

  const missingPose = fixture();
  missingPose.rawManifest.views[0].cameraPose = null;
  const poseReport = finalizeRenderReviewManifest(missingPose);
  assert.equal(poseReport.valid, false);
  assert.ok(poseReport.errors.includes("render-camera-pose-invalid:front"));

  const inconsistentPose = fixture();
  inconsistentPose.rawManifest.views[0].cameraPose.viewDirectionWorld = [1, 0, 0];
  const inconsistentReport = finalizeRenderReviewManifest(inconsistentPose);
  assert.equal(inconsistentReport.valid, false);
  assert.ok(inconsistentReport.errors.includes("render-camera-pose-invalid:front"));

  const missingSettings = fixture();
  delete missingSettings.rawManifest.renderSettings.lights;
  const settingsReport = finalizeRenderReviewManifest(missingSettings);
  assert.equal(settingsReport.valid, false);
  assert.ok(settingsReport.errors.includes("render-settings-invalid-or-incomplete"));
});

test("flags geometry warnings for human review and fingerprints fixed render configuration", () => {
  const cleanData = fixture();
  const cleanA = finalizeRenderReviewManifest(cleanData);
  const cleanB = finalizeRenderReviewManifest(fixture());
  assert.equal(cleanA.renderConfigSha256, cleanB.renderConfigSha256);

  cleanData.geometryQaSummary.status = "review-recommended";
  cleanData.geometryQaSummary.warnings.push("disconnected-mesh-components-present");
  const warned = finalizeRenderReviewManifest(cleanData);
  assert.equal(warned.valid, true);
  assert.equal(warned.status, "review-required");
  assert.ok(warned.warnings.includes("glb-geometry-qa-review-required"));

  const changedPose = fixture();
  changedPose.rawManifest.views[0].cameraPose.orthographicScale = 3.25;
  const changed = finalizeRenderReviewManifest(changedPose);
  assert.notEqual(changed.renderConfigSha256, cleanA.renderConfigSha256);
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
