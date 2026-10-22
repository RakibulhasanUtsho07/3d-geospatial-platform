import assert from "node:assert/strict";
import test from "node:test";
import { projectTextureFaces } from "../src/core/building-generation/calibrated-texture-uv-projection.mjs";

const cameras = [{
  id: "front",
  projection: [[100,0,50,0],[0,100,50,0],[0,0,1,0]],
}];
const vertices = [
  { id: "a", position: [0, 0, 5] },
  { id: "b", position: [1, 0, 5] },
  { id: "c", position: [0, 1, 5] },
];
const image = {
  id: "front-image",
  cameraId: "front",
  sha256: "a".repeat(64),
  width: 100,
  height: 100,
  verifiedSource: true,
};
const calibration = {
  id: "front-calibration",
  cameraId: "front",
  status: "verified",
  reprojectionErrorPx: 0.25,
};
const candidate = (faceOverrides = {}, calibrationOverrides = {}, imageOverrides = {}) => ({
  images: [{ ...image, ...imageOverrides }],
  cameraCalibrations: [{ ...calibration, ...calibrationOverrides }],
  faces: [{
    vertices: ["a", "b", "c"],
    // A caller-supplied UV set must not be trusted by this worker.
    uv: [[0, 0], [1, 0], [0, 1]],
    sourceImageId: "front-image",
    cameraCalibrationId: "front-calibration",
    visibilityReviewed: true,
    ...faceOverrides,
  }],
});

test("computes normalized bottom-left UVs from a calibrated 3x4 pixel projection matrix", () => {
  const result = projectTextureFaces({ cameras, vertices, candidate: candidate() });
  assert.equal(result.projectedFaceCount, 1);
  assert.equal(result.status, "uv-projection-complete-requires-human-review");
  assert.deepEqual(result.faces[0].uv, [[0.5, 0.5], [0.7, 0.5], [0.5, 0.3]]);
  assert.equal(result.faces[0].projectionEvidence.cameraId, "front");
  assert.equal(result.faces[0].projectionEvidence.sourceImageSha256, "a".repeat(64));
  assert.deepEqual(result.faces[0].projectionEvidence.projectedPixels, [
    { x: 50, y: 50 }, { x: 70, y: 50 }, { x: 50, y: 70 },
  ]);
  assert.equal(result.policy.usesSuppliedUvs, false);
  assert.equal(result.policy.automaticallyChecksOcclusion, false);
  assert.equal(result.publicationEligible, false);
});

test("blocks UV generation unless the selected source view is explicitly reviewed visible", () => {
  const result = projectTextureFaces({
    cameras, vertices, candidate: candidate({ visibilityReviewed: false }),
  });
  assert.equal(result.projectedFaceCount, 0);
  assert.ok(result.rejectedFaces[0].reasons.includes("source-view-visibility-review-required"));
  assert.equal(result.faces[0].uv, undefined);
});

test("rejects faces outside the image and faces that project to a degenerate line", () => {
  const outsideVertices = vertices.map((vertex) => ({
    ...vertex,
    position: vertex.id === "b" ? [5, 0, 5] : vertex.position,
  }));
  const outside = projectTextureFaces({ cameras, vertices: outsideVertices, candidate: candidate() });
  assert.ok(outside.rejectedFaces[0].reasons.includes("projected-face-corners-outside-source-image"));

  const lineVertices = [
    { id: "a", position: [0, 0, 5] },
    { id: "b", position: [1, 0, 5] },
    { id: "c", position: [2, 0, 5] },
  ];
  const degenerate = projectTextureFaces({ cameras, vertices: lineVertices, candidate: candidate() });
  assert.ok(degenerate.rejectedFaces[0].reasons.includes("projected-face-is-degenerate-or-too-small"));
});

test("rejects unverified calibration, excessive reprojection error and source camera mismatches", () => {
  const unverified = projectTextureFaces({
    cameras, vertices, candidate: candidate({}, { status: "estimated" }),
  });
  assert.ok(unverified.rejectedFaces[0].reasons.includes("camera-calibration-not-verified"));

  const highError = projectTextureFaces({
    cameras, vertices, candidate: candidate({}, { reprojectionErrorPx: 4 }),
  });
  assert.ok(highError.rejectedFaces[0].reasons.includes("calibration-reprojection-error-exceeds-threshold"));

  const mismatch = projectTextureFaces({
    cameras, vertices, candidate: candidate({}, {}, { cameraId: "other-camera" }),
  });
  assert.ok(mismatch.rejectedFaces[0].reasons.includes("source-image-camera-does-not-match-calibration"));
});

test("rejects vertices behind the camera and validates all required inputs", () => {
  const behind = projectTextureFaces({
    cameras,
    vertices: vertices.map((vertex) => ({ ...vertex, position: vertex.position.map((value, i) => i === 2 ? -5 : value) })),
    candidate: candidate(),
  });
  assert.ok(behind.rejectedFaces[0].reasons.includes("vertex-behind-camera-or-at-projection-horizon"));
  assert.throws(() => projectTextureFaces({ cameras: [], vertices, candidate: candidate() }), /at least one calibrated camera/);
  assert.throws(() => projectTextureFaces({ cameras, vertices, candidate: candidate(), options: { minProjectedTriangleAreaPx: 0 } }), /positive finite number/);
});
