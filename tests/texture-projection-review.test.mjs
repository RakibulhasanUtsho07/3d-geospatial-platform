import assert from "node:assert/strict";
import test from "node:test";
import { reviewTextureProjection } from "../src/core/building-generation/texture-projection-review.mjs";

const valid = () => ({
  images: [{ id: "front", sha256: "a".repeat(64), width: 1600, height: 1200, verifiedSource: true }],
  cameraCalibrations: [{ id: "camera-front", status: "verified", reprojectionErrorPx: 1.2 }],
  faces: [{ vertices: ["a","b","c"], uv: [[0,0],[1,0],[0.5,1]], sourceImageId: "front", cameraCalibrationId: "camera-front" }],
});

test("accepts faces only when source and calibration evidence are verified", () => {
  const result = reviewTextureProjection(valid());
  assert.equal(result.status, "evidence-validation-passed");
  assert.deepEqual(result.evidenceEligibleFaceIndices, [0]);
  assert.equal(result.publicationEligible, false);
});

test("rejects out-of-range UV coordinates", () => {
  const candidate = valid();
  candidate.faces[0].uv[1] = [1.1, 0];
  const result = reviewTextureProjection(candidate);
  assert.ok(result.rejectedFaces[0].reasons.includes("uv-out-of-normalized-range"));
});

test("rejects unverified image and calibration", () => {
  const candidate = valid();
  candidate.images[0].verifiedSource = false;
  candidate.cameraCalibrations[0].status = "estimated";
  const result = reviewTextureProjection(candidate);
  assert.ok(result.rejectedFaces[0].reasons.includes("source-image-not-verified"));
  assert.ok(result.rejectedFaces[0].reasons.includes("camera-calibration-not-verified"));
});

test("rejects missing hashes and high reprojection error", () => {
  const candidate = valid();
  candidate.images[0].sha256 = "bad";
  candidate.cameraCalibrations[0].reprojectionErrorPx = 3;
  const result = reviewTextureProjection(candidate);
  assert.ok(result.rejectedFaces[0].reasons.includes("source-image-sha256-missing-or-invalid"));
  assert.ok(result.rejectedFaces[0].reasons.includes("calibration-reprojection-error-exceeds-threshold"));
});

test("validates options and input shape", () => {
  assert.throws(() => reviewTextureProjection({}), /images, cameraCalibrations and faces/);
  assert.throws(() => reviewTextureProjection(valid(), { maxReprojectionErrorPx: -1 }), /non-negative/);
});
