import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeSourceCameraRenderManifest,
  prepareSourceCameraRender,
  projectWorldPointToSourceImage,
} from "../src/core/building-generation/source-camera-render.mjs";

const hash = (character) => character.repeat(64);
function fixture(overrides = {}) {
  const sourceSha = hash("c");
  const camera = {
    id: "facade-south-camera-01",
    sourceImageSha256: sourceSha,
    calibrationStatus: "verified",
    evidence: { id: "calibration-01", sourceId: "survey-bundle-01", sha256: hash("b") },
    convention: "vision-x-right-y-down-z-forward",
    coordinateFrame: "building-local-enu-v1",
    imageSize: { width: 100, height: 80 },
    pose: { rotation: [[1,0,0],[0,1,0],[0,0,1]], translation: [0,0,0] },
    intrinsics: { fx: 100, fy: 50, cx: 49.5, cy: 39.5 },
    distortion: { model: "none", coefficients: [] },
  };
  const cameraEvidence = { schemaVersion: "1.0.0", camera, ...overrides.cameraEvidence };
  const sourceImage = { path: "/fixture/reference.png", sha256: sourceSha, imageSize: { width: 100, height: 80 },
    rightsAttestation: { status: "permitted", sourceId: "permission-record-01", sha256: hash("e") }, ...overrides.sourceImage };
  return {
    cameraEvidence,
    sourceImage,
    modelCoordinateFrame: "building-local-enu-v1",
    modelSha256: hash("a"),
    ...overrides.args,
  };
}

test("prepares a same-camera render plan with explicit axis conversion and original dimensions", () => {
  const result = prepareSourceCameraRender(fixture());
  assert.equal(result.valid, true);
  assert.equal(result.status, "ready-for-calibrated-render");
  const plan = result.renderPlan;
  assert.deepEqual(plan.blenderCamera.rotationMatrix, [[1,0,0],[0,-1,0],[0,0,-1]]);
  assert.equal(plan.blenderCamera.imageWidth, 100);
  assert.equal(plan.blenderCamera.imageHeight, 80);
  assert.equal(plan.blenderCamera.lensMm, 36);
  assert.equal(plan.blenderCamera.pixelAspectX, 1);
  assert.equal(plan.blenderCamera.pixelAspectY, 2);
  assert.equal(plan.blenderCamera.shiftX, 0);
  assert.equal(plan.blenderCamera.shiftY, 0);
  assert.equal(plan.publicationEligible, false);
});

test("fails closed when the source photo has no explicit permission attestation", () => {
  const data = fixture({ sourceImage: { rightsAttestation: null } });
  assert.ok(prepareSourceCameraRender(data).errors.includes("source-image-rights-attestation-invalid"));
});

test("projects known world points into the calibrated source-image pixels", () => {
  const { camera } = fixture().cameraEvidence;
  const centre = projectWorldPointToSourceImage(camera, [0,0,5]);
  assert.equal(centre.visible, true);
  assert.deepEqual(centre.pixel, { x: 49.5, y: 39.5 });
  const offset = projectWorldPointToSourceImage(camera, [1,1,5]);
  assert.ok(Math.abs(offset.pixel.x - 69.5) < 1e-12);
  assert.ok(Math.abs(offset.pixel.y - 49.5) < 1e-12);
});

test("marks a point at or behind the source camera as non-visible", () => {
  const { camera } = fixture().cameraEvidence;
  assert.equal(projectWorldPointToSourceImage(camera, [0,0,-1]).visible, false);
});

test("fails closed for unverified calibration, source hash mismatch, and frame mismatch", () => {
  const unverified = fixture();
  unverified.cameraEvidence.camera.calibrationStatus = "review-required";
  assert.ok(prepareSourceCameraRender(unverified).errors.includes("camera-calibration-not-verified"));

  const stale = fixture();
  stale.cameraEvidence.camera.sourceImageSha256 = hash("d");
  assert.ok(prepareSourceCameraRender(stale).errors.includes("camera-source-image-hash-mismatch"));

  const frame = fixture();
  frame.modelCoordinateFrame = "unrelated-world-frame";
  assert.ok(prepareSourceCameraRender(frame).errors.includes("camera-model-coordinate-frame-mismatch"));
});

test("rejects non-orthonormal pose, unsupported distortion, and malformed crop metadata", () => {
  const pose = fixture();
  pose.cameraEvidence.camera.pose.rotation = [[1,0,0],[0,2,0],[0,0,1]];
  assert.ok(prepareSourceCameraRender(pose).errors.includes("camera-rotation-not-orthonormal"));

  const distortion = fixture();
  distortion.cameraEvidence.camera.distortion = { model: "brown-conrady", coefficients: [0.01,0,0,0,0] };
  assert.ok(prepareSourceCameraRender(distortion).errors.includes("camera-distortion-unsupported-undistortion-required"));

  const crop = fixture({ sourceImage: { crop: { x: -1, y: 0, width: 100, height: 80, originalWidth: 120, originalHeight: 80, appliedToImage: true } } });
  assert.ok(prepareSourceCameraRender(crop).errors.includes("source-image-crop-metadata-invalid"));
});

test("records crop metadata only when it describes the exact already-cropped source raster", () => {
  const crop = fixture({
    sourceImage: {
      crop: { x: 10, y: 5, width: 100, height: 80, originalWidth: 160, originalHeight: 120, appliedToImage: true },
    },
  });
  const result = prepareSourceCameraRender(crop);
  assert.equal(result.valid, true);
  assert.deepEqual(result.renderPlan.sourceImageCrop, crop.sourceImage.crop);
});

test("finalizes candidate and overlay hashes without promoting publication", () => {
  const plan = prepareSourceCameraRender(fixture()).renderPlan;
  const report = finalizeSourceCameraRenderManifest({
    renderPlan: plan,
    renderFiles: {
      candidate: { width: 100, height: 80, bytes: 1000, sha256: hash("d") },
      overlay: { width: 100, height: 80, bytes: 1100, sha256: hash("e") },
    },
  });
  assert.equal(report.valid, true);
  assert.equal(report.status, "render-pair-ready-for-human-review");
  assert.equal(report.sourceImage.sha256, hash("c"));
  assert.equal(report.sourceImage.rightsAttestation.status, "permitted");
  assert.equal(report.camera.evidenceSha256, hash("b"));
  assert.equal(report.render.candidate.sha256, hash("d"));
  assert.equal(report.humanReview.status, "pending");
  assert.equal(report.publicationEligible, false);
});

test("rejects dimension mismatches and invalid render hashes", () => {
  const plan = prepareSourceCameraRender(fixture()).renderPlan;
  const report = finalizeSourceCameraRenderManifest({
    renderPlan: plan,
    renderFiles: {
      candidate: { width: 256, height: 80, bytes: 1000, sha256: hash("d") },
      overlay: { width: 100, height: 80, bytes: 1100, sha256: "bad" },
    },
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.includes("render-dimensions-mismatch:candidate"));
  assert.ok(report.errors.includes("render-file-metadata-invalid:overlay"));
});
