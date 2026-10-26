import assert from "node:assert/strict";
import test from "node:test";
import {
  assessSourceCameraForRender,
  finalizeSourceCameraRenderManifest,
  projectWorldPointToSourceCamera,
} from "../src/core/building-generation/source-camera-render.mjs";

const hash = (char) => char.repeat(64);
const cameraFixture = () => {
  const camera = {
    schemaVersion: "1.0.0",
    id: "camera-front-01",
    calibrationStatus: "verified",
    calibrationEvidence: { id: "calibration-report-01", sha256: hash("b") },
    frameAlignmentEvidence: { id: "glb-frame-fit-01", sha256: hash("c") },
    coordinateFrame: "model-local-blender-v1",
    sourceImage: { sha256: hash("a"), width: 640, height: 480 },
    pose: { position: [0, 0, 0], quaternionWxyz: [1, 0, 0, 0] },
    intrinsics: { fx: 400, fy: 400, cx: 320, cy: 240, distortionModel: "none" },
    controlPoints: [
      { id: "p1", worldPoint: [0, 0, -10], imagePoint: { x: 320, y: 240 } },
      { id: "p2", worldPoint: [1, 0, -10], imagePoint: { x: 360, y: 240 } },
      { id: "p3", worldPoint: [0, 1, -10], imagePoint: { x: 320, y: 200 } },
      { id: "p4", worldPoint: [-1, -1, -10], imagePoint: { x: 280, y: 280 } },
    ],
  };
  return camera;
};
const args = (camera = cameraFixture()) => ({
  camera,
  sourceImageSha256: hash("a"),
  sourceImageSize: { width: 640, height: 480 },
  cameraManifestSha256: hash("d"),
  calibrationEvidenceSha256: hash("b"),
  frameAlignmentEvidenceSha256: hash("c"),
  modelSha256: hash("e"),
});

test("projects calibrated 3D points using the documented Blender camera convention", () => {
  const camera = cameraFixture();
  assert.deepEqual(projectWorldPointToSourceCamera(camera, [1, 0, -10]), {
    visible: true, x: 360, y: 240, depth: 10,
  });
  assert.deepEqual(projectWorldPointToSourceCamera(camera, [0, 1, -10]), {
    visible: true, x: 320, y: 200, depth: 10,
  });
  assert.deepEqual(projectWorldPointToSourceCamera(camera, [0, 0, 10]), {
    visible: false, reason: "point-not-in-front-of-camera",
  });
});

test("allows same-camera comparison only with matching image identity, verified calibration and in-tolerance controls", () => {
  const report = assessSourceCameraForRender(args());
  assert.equal(report.status, "same-camera-comparable");
  assert.equal(report.sameCameraComparable, true);
  assert.equal(report.controlPointReports.length, 4);
  assert.ok(report.controlPointReports.every((point) => point.errorPixels === 0));
  assert.equal(report.publicationEligible, false);
});

test("blocks stale image hashes, dimension changes, and missing calibration evidence", () => {
  const staleHash = assessSourceCameraForRender({ ...args(), sourceImageSha256: hash("f") });
  assert.equal(staleHash.status, "not-comparable");
  assert.ok(staleHash.errors.includes("source-image-sha256-mismatch"));

  const wrongSize = assessSourceCameraForRender({ ...args(), sourceImageSize: { width: 320, height: 240 } });
  assert.ok(wrongSize.errors.includes("source-image-dimensions-mismatch"));

  const unverified = cameraFixture();
  unverified.calibrationStatus = "review-required";
  const unverifiedReport = assessSourceCameraForRender(args(unverified));
  assert.equal(unverifiedReport.status, "not-comparable");
  assert.ok(unverifiedReport.errors.includes("camera-calibration-not-verified"));
});

test("verifies evidence file bytes against the hashes declared by the camera manifest", () => {
  const mismatch = assessSourceCameraForRender({ ...args(), calibrationEvidenceSha256: hash("f") });
  assert.equal(mismatch.status, "not-comparable");
  assert.ok(mismatch.errors.includes("calibration-evidence-sha256-mismatch"));

  const missing = assessSourceCameraForRender({ ...args(), frameAlignmentEvidenceSha256: undefined });
  assert.ok(missing.errors.includes("frame-alignment-evidence-file-sha256-invalid"));
});

test("blocks control points outside the image and reprojection errors above tolerance", () => {
  const camera = cameraFixture();
  camera.controlPoints[0].imagePoint.x = -1;
  camera.controlPoints[1].imagePoint.x += 9;
  const report = assessSourceCameraForRender(args(camera));
  assert.equal(report.status, "not-comparable");
  assert.ok(report.errors.some((code) => code.startsWith("control-point-outside-image:")));
  assert.ok(report.errors.some((code) => code.startsWith("control-point-reprojection-error-exceeds-tolerance:")));
});

test("refuses same-camera output if the PNG is absent, wrong-sized, or not hashed", () => {
  const assessment = assessSourceCameraForRender(args());
  const missing = finalizeSourceCameraRenderManifest({ assessment });
  assert.equal(missing.status, "not-comparable");
  assert.ok(missing.errors.includes("source-camera-render-output-missing-or-invalid"));

  const valid = finalizeSourceCameraRenderManifest({
    assessment,
    renderFile: { filename: "source-camera.png", width: 640, height: 480, bytes: 9000, sha256: hash("f") },
  });
  assert.equal(valid.status, "same-camera-comparable");
  assert.equal(valid.render.sha256, hash("f"));

  const invalid = finalizeSourceCameraRenderManifest({
    assessment,
    renderFile: { filename: "source-camera.png", width: 320, height: 240, bytes: 10, sha256: hash("f") },
  });
  assert.equal(invalid.sameCameraComparable, false);
});

test("never records a render for a non-comparable camera", () => {
  const assessment = assessSourceCameraForRender({ ...args(), camera: null });
  const report = finalizeSourceCameraRenderManifest({ assessment, renderFile: { filename: "source-camera.png", width: 640, height: 480, bytes: 1, sha256: hash("f") } });
  assert.equal(report.sameCameraComparable, false);
  assert.equal(report.render, null);
  assert.ok(report.errors.includes("render-must-not-be-produced-for-non-comparable-camera"));
});
