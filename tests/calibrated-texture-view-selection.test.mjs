import assert from "node:assert/strict";
import test from "node:test";
import { selectCalibratedTextureViews } from "../src/core/building-generation/calibrated-texture-view-selection.mjs";

const cameras = [
  { id: "wide", projection: [[100,0,50,0],[0,100,50,0],[0,0,1,0]] },
  { id: "zoom", projection: [[150,0,100,0],[0,150,100,0],[0,0,1,0]] },
];
const targetVertices = [
  { id: "a", position: [0, 0, 5] },
  { id: "b", position: [1, 0, 5] },
  { id: "c", position: [0, 1, 5] },
];
const images = [
  { id: "wide-photo", cameraId: "wide", sha256: "a".repeat(64), width: 100, height: 100, verifiedSource: true },
  { id: "zoom-photo", cameraId: "zoom", sha256: "b".repeat(64), width: 200, height: 200, verifiedSource: true },
];
const cameraCalibrations = [
  { id: "wide", status: "verified", reprojectionErrorPx: 0.2 },
  { id: "zoom", status: "verified", reprojectionErrorPx: 0.3 },
];
const makeCandidate = (face = {}) => ({
  images: structuredClone(images),
  cameraCalibrations: structuredClone(cameraCalibrations),
  faces: [{ vertices: ["a", "b", "c"], ...face }],
});

test("automatically chooses the calibrated visible view with the strongest projected detail", () => {
  const result = selectCalibratedTextureViews({
    cameras,
    vertices: targetVertices,
    triangles: [{ vertices: ["a", "b", "c"] }],
    candidate: makeCandidate(),
  });
  assert.equal(result.status, "texture-views-selected-requires-human-review");
  assert.equal(result.autoSelectedFaceCount, 1);
  assert.equal(result.visibilityCheckedFaceCount, 1);
  assert.equal(result.faces[0].sourceImageId, "zoom-photo");
  assert.equal(result.faces[0].cameraCalibrationId, "zoom");
  assert.equal(result.faces[0].visibilityEvidence.status, "visible-by-rasterized-depth-buffer");
  assert.equal(result.faces[0].visibilityEvidence.sampleCount, 4);
  assert.equal(result.faces[0].visibilityEvidence.visibilityMethod, "software-rasterized-inverse-depth-buffer");
  assert.ok(result.faces[0].visibilityEvidence.rasterWidth <= 512);
  assert.equal(result.faces[0].visibilityEvidence.visibleSampleCount, 4);
  assert.ok(result.faces[0].visibilityEvidence.rasterizedTriangleCount >= 1);
  assert.equal(result.faces[0].selectionEvidence.eligibleCandidateCount, 2);
  assert.equal(result.publicationEligible, false);
});

test("rejects a source view where another mesh triangle occludes the target face", () => {
  const occluder = [
    { id: "o1", position: [-1, -1, 2] },
    { id: "o2", position: [2, -1, 2] },
    { id: "o3", position: [-1, 2, 2] },
  ];
  const result = selectCalibratedTextureViews({
    cameras: [cameras[0]],
    vertices: [...targetVertices, ...occluder],
    triangles: [
      { vertices: ["a", "b", "c"] },
      { vertices: ["o1", "o2", "o3"] },
    ],
    candidate: {
      images: [images[0]],
      cameraCalibrations: [cameraCalibrations[0]],
      faces: [{ vertices: ["a", "b", "c"] }],
    },
  });
  assert.equal(result.status, "review-required");
  assert.equal(result.autoSelectedFaceCount, 0);
  assert.ok(result.rejectedFaces[0].reasons.includes("source-view-occludes-or-partially-occludes-face"));
  assert.equal(result.faces[0].sourceImageId, undefined);
});

test("does not treat a triangle behind the target as an occluder", () => {
  const behind = [
    { id: "b1", position: [0, 0, 8] },
    { id: "b2", position: [1.6, 0, 8] },
    { id: "b3", position: [0, 1.6, 8] },
  ];
  const result = selectCalibratedTextureViews({
    cameras: [cameras[0]],
    vertices: [...targetVertices, ...behind],
    triangles: [
      { vertices: ["a", "b", "c"] },
      { vertices: ["b1", "b2", "b3"] },
    ],
    candidate: {
      images: [images[0]],
      cameraCalibrations: [cameraCalibrations[0]],
      faces: [{ vertices: ["a", "b", "c"] }],
    },
  });
  assert.equal(result.status, "texture-views-selected-requires-human-review");
  assert.equal(result.faces[0].visibilityEvidence.status, "visible-by-rasterized-depth-buffer");
});

test("fails closed when a mesh triangle crosses the camera near plane", () => {
  const crossing = [
    { id: "n1", position: [-1, -1, 2] },
    { id: "n2", position: [0, 0, -2] },
    { id: "n3", position: [2, -1, 2] },
  ];
  const result = selectCalibratedTextureViews({
    cameras: [cameras[0]],
    vertices: [...targetVertices, ...crossing],
    triangles: [
      { vertices: ["a", "b", "c"] },
      { vertices: ["n1", "n2", "n3"] },
    ],
    candidate: {
      images: [images[0]],
      cameraCalibrations: [cameraCalibrations[0]],
      faces: [{ vertices: ["a", "b", "c"] }],
    },
  });
  assert.equal(result.status, "review-required");
  assert.ok(result.rejectedFaces[0].reasons.includes("rasterized-visibility-check-indeterminate"));
  assert.ok(result.rejectedFaces[0].candidateFailures[0].reasons.includes("rasterized-visibility-check-indeterminate"));
});

test("keeps explicit human-reviewed assignments and records their provenance", () => {
  const result = selectCalibratedTextureViews({
    cameras,
    vertices: targetVertices,
    triangles: [{ vertices: ["a", "b", "c"] }],
    candidate: makeCandidate({
      sourceImageId: "wide-photo",
      cameraCalibrationId: "wide",
      visibilityReviewed: true,
    }),
  });
  assert.equal(result.faces[0].sourceImageId, "wide-photo");
  assert.equal(result.autoSelectedFaceCount, 0);
  assert.equal(result.visibilityCheckedFaceCount, 0);
  assert.equal(result.faces[0].selectionEvidence.status, "explicit-assignment-human-attested");
  assert.equal(result.policy.requiresExplicitViewVisibilityAttestation, true);
});

test("does not guess an automatic source when images have no camera association", () => {
  const candidate = makeCandidate();
  delete candidate.images[0].cameraId;
  delete candidate.images[1].cameraId;
  const result = selectCalibratedTextureViews({
    cameras,
    vertices: targetVertices,
    triangles: [{ vertices: ["a", "b", "c"] }],
    candidate,
  });
  assert.equal(result.status, "review-required");
  assert.ok(result.rejectedFaces[0].reasons.includes("no-calibrated-source-image-assignment-available"));
});

test("validates camera, mesh and quality thresholds", () => {
  assert.throws(() => selectCalibratedTextureViews({
    cameras: [], vertices: targetVertices, triangles: [{ vertices: ["a", "b", "c"] }], candidate: makeCandidate(),
  }), /at least one calibrated camera/);
  assert.throws(() => selectCalibratedTextureViews({
    cameras, vertices: targetVertices, triangles: [], candidate: makeCandidate(),
  }), /reviewed mesh triangles are required/);
  assert.throws(() => selectCalibratedTextureViews({
    cameras, vertices: targetVertices, triangles: [{ vertices: ["a", "b", "c"] }], candidate: makeCandidate(),
    options: { minFacingCosine: 2 },
  }), /between zero and one/);
  assert.throws(() => selectCalibratedTextureViews({
    cameras, vertices: targetVertices, triangles: [{ vertices: ["a", "b", "c"] }], candidate: makeCandidate(),
    options: { maxRasterResolution: 32 },
  }), /between 64 and 1024/);
});
