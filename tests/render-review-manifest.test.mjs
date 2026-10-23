import assert from "node:assert/strict";
import test from "node:test";
import { finalizeRenderReviewManifest, REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";

const hash = "a".repeat(64);
function fixture(overrides = {}) {
  const views = REQUIRED_REVIEW_VIEWS.map((id, index) => {
    let direction;
    if (id === "front") direction = [0, 1, 0];
    else if (id === "back") direction = [0, -1, 0];
    else if (id === "left") direction = [1, 0, 0];
    else if (id === "right") direction = [-1, 0, 0];
    else if (id === "top") direction = [0, 0, -1];
    else {
      const angle = Number(id.slice("turntable-".length)) * Math.PI / 180;
      const elevation = 22 * Math.PI / 180;
      direction = [
        -Math.cos(angle) * Math.cos(elevation),
        -Math.sin(angle) * Math.cos(elevation),
        -Math.sin(elevation),
      ];
    }
    const position = [index + 2, -4, 2];
    const target = position.map((value, axis) => value + direction[axis]);
    return {
      id,
      filename: id + ".png",
      width: 512,
      height: 512,
      renderComplete: true,
      cameraPose: {
        projection: "ORTHO",
        positionWorld: position,
        targetWorld: target,
        viewDirectionWorld: direction,
        rotationEulerRadians: [0, 0, 0],
        orthographicScale: 3,
      },
      pixelStatistics: {
      sampledPixels: 50000,
      luminanceMean: 0.4,
      luminanceStandardDeviation: 0.15,
      transparentRatio: 0,
    },
  };
  });
  const files = Object.fromEntries(views.map((view) => [view.filename, {
    width: 512, height: 512, bytes: 51200, sha256: hash,
  }]));
  return {
    rawManifest: {
      schemaVersion: "1.0.0",
      rendererVersion: "4.5.0",
      renderProfile: "building-review-cycles-cpu-v1",
      renderSettings: {
        renderEngine: "CYCLES",
        cyclesDevice: "CPU",
        cyclesSamples: 16,
        cyclesUseDenoising: false,
        cyclesMaxBounces: 4,
        threadsMode: "FIXED",
        threads: 2,
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
        cameraCoordinateConvention: "z-up;front-view-direction=+Y",
        excludedRenderObjects: [],
        cameraDistanceMultiplier: 3,
        cameraOrthoScaleMultiplier: 1.45,
        frontViewFraming: "whole-model-bounds",
        frontCameraOrthoScaleMultiplier: 1.45,
        referenceObliqueOrthoScaleMultiplier: 1.45,
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


test("validates the Ahsan Manzil Y-up profile with south-front and overhead cameras", () => {
  const data = fixture();
  data.rawManifest.renderProfile = "ahsan-manzil-y-up-cycles-cpu-v1";
  data.rawManifest.renderSettings.cameraCoordinateConvention = "blender-z-up;source-glTF-y-up-imported;source+Z-south=>world-Y-negative;front-camera-from-world-Y-negative";
  data.rawManifest.renderSettings.frontViewFraming = "rangmahal-semantic-bounds-for-front-and-turntable-315;whole-palace-for-other-views";
  data.rawManifest.renderSettings.frontCameraOrthoScaleMultiplier = 1.12;
  data.rawManifest.renderSettings.excludedRenderObjects = [
    "Site_Approach", "Site_Context_Blocks", "Site_Family_Mosque",
    "Site_Pond", "Site_River", "Site_Stable", "Site_Trees",
  ];
  const elevation = 22 * Math.PI / 180;
  data.rawManifest.views = data.rawManifest.views.map((view) => {
    let direction;
    if (view.id === "front") direction = [0, 1, 0];
    else if (view.id === "back") direction = [0, -1, 0];
    else if (view.id === "left") direction = [1, 0, 0];
    else if (view.id === "right") direction = [-1, 0, 0];
    else if (view.id === "top") direction = [0, 0, -1];
    else {
      const azimuth = Number(view.id.slice("turntable-".length)) * Math.PI / 180;
      direction = [
        -Math.cos(azimuth) * Math.cos(elevation),
        -Math.sin(azimuth) * Math.cos(elevation),
        -Math.sin(elevation),
      ];
    }
    const position = [10, 20, 30];
    return {
      ...view,
      cameraPose: {
        ...view.cameraPose,
        positionWorld: position,
        targetWorld: position.map((value, axis) => value + direction[axis]),
        viewDirectionWorld: direction,
      },
    };
  });
  const report = finalizeRenderReviewManifest(data);
  assert.equal(report.valid, true);
  assert.equal(report.renderProfile, "ahsan-manzil-y-up-cycles-cpu-v1");
  assert.equal(report.renderSettings.cameraCoordinateConvention, "blender-z-up;source-glTF-y-up-imported;source+Z-south=>world-Y-negative;front-camera-from-world-Y-negative");
  assert.deepEqual(report.renderSettings.excludedRenderObjects, [
    "Site_Approach", "Site_Context_Blocks", "Site_Family_Mosque",
    "Site_Pond", "Site_River", "Site_Stable", "Site_Trees",
  ]);
  assert.equal(report.errors.length, 0);

  const wrongConvention = fixture();
  wrongConvention.rawManifest.renderProfile = "ahsan-manzil-y-up-cycles-cpu-v1";
  const rejected = finalizeRenderReviewManifest(wrongConvention);
  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.includes("render-settings-invalid-or-incomplete"));

  const unexpectedExclusions = fixture();
  unexpectedExclusions.rawManifest.renderProfile = "ahsan-manzil-y-up-cycles-cpu-v1";
  unexpectedExclusions.rawManifest.renderSettings.cameraCoordinateConvention = "blender-z-up;source-glTF-y-up-imported;source+Z-south=>world-Y-negative;front-camera-from-world-Y-negative";
  unexpectedExclusions.rawManifest.renderSettings.excludedRenderObjects = ["Site_Trees"];
  const exclusionReport = finalizeRenderReviewManifest(unexpectedExclusions);
  assert.equal(exclusionReport.valid, false);
  assert.ok(exclusionReport.errors.includes("render-settings-invalid-or-incomplete"));
});

test("finalizes the full five-axis plus eight-angle render set", () => {
  const report = finalizeRenderReviewManifest(fixture());
  assert.equal(report.valid, true);
  assert.equal(report.status, "render-set-ready-for-human-review");
  assert.equal(report.counts.generatedViews, 13);
  assert.equal(report.publicationEligible, false);
  assert.match(report.renderConfigSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.geometryQaSummary.engine, "glb-geometry-qa-v2");
  assert.equal(report.modelSha256, hash);
  assert.ok(report.views.every((view) => view.cameraPose.projection === "ORTHO"));
  assert.ok(report.views.every((view) => view.sha256 === hash && view.bytes > 0));
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

  const wrongRenderEngine = fixture();
  wrongRenderEngine.rawManifest.renderSettings.renderEngine = "BLENDER_EEVEE";
  const wrongEngineReport = finalizeRenderReviewManifest(wrongRenderEngine);
  assert.equal(wrongEngineReport.valid, false);
  assert.ok(wrongEngineReport.errors.includes("render-settings-invalid-or-incomplete"));
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
