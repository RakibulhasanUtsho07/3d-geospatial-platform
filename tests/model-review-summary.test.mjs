import assert from "node:assert/strict";
import test from "node:test";
import { buildModelReviewSummary } from "../src/core/building-generation/model-review-summary.mjs";

const cleanImages = {
  views: [
    { sourceId: "front", warnings: [], nearDuplicateIds: [] },
    { sourceId: "left", warnings: [], nearDuplicateIds: [] },
    { sourceId: "rear", warnings: [], nearDuplicateIds: [] },
  ],
  flaggedViewCount: 0,
  nearDuplicatePairCount: 0,
};

const cleanReconstruction = {
  status: "diagnostics-passed",
  sourceImageCount: 3,
  registeredImageRatio: 1,
  metrics: { registeredImages: 3, sparsePointCount: 900 },
  warnings: [],
};

const cleanMesh = {
  valid: true,
  warnings: [],
  counts: {
    primitiveCount: 1,
    triangleCount: 1200,
    degenerateTriangleCount: 0,
    degenerateTriangleRatio: 0,
  },
  meshDetails: [{
    meshIndex: 0,
    primitiveIndex: 0,
    topology: {
      topologyAnalyzed: true,
      triangleCount: 1200,
      connectedComponentCount: 1,
      smallDetachedComponentCount: 0,
      boundaryEdgeCount: 0,
      boundaryEdgeRatio: 0,
      nonManifoldEdgeCount: 0,
      longEdgeTriangleCount: 0,
      longEdgeTriangleRatio: 0,
      warnings: [],
    },
  }],
};

const cleanPlacement = {
  scaleCalibration: { scaleCalibrated: true, method: "operator-supplied-known-distance" },
  upAxisReviewed: true,
  georeference: { status: "registered" },
};

test("synthesizes actionable findings across photos, COLMAP, mesh, scale and placement", () => {
  const report = buildModelReviewSummary({
    imageQualityPreflight: {
      views: [
        { sourceId: "front", warnings: [], nearDuplicateIds: ["front-copy"] },
        { sourceId: "front-copy", warnings: ["near-duplicate-view"], nearDuplicateIds: ["front"] },
        { sourceId: "roof", warnings: ["possibly-blurry-or-out-of-focus"], nearDuplicateIds: [] },
      ],
      flaggedViewCount: 2,
      nearDuplicatePairCount: 1,
    },
    reconstructionDiagnostics: {
      status: "review-recommended",
      sourceImageCount: 4,
      registeredImageRatio: 0.25,
      metrics: { registeredImages: 1, sparsePointCount: 12 },
      warnings: ["Only 1 of 4 selected images registered.", "Sparse reconstruction has too few points."],
    },
    modelQuality: {
      ...cleanMesh,
      counts: { ...cleanMesh.counts, triangleCount: 100, degenerateTriangleCount: 3, degenerateTriangleRatio: 0.03 },
      warnings: ["degenerate-triangles-present", "degenerate-triangle-ratio-exceeds-threshold", "disconnected-mesh-components-present"],
      meshDetails: [{ ...cleanMesh.meshDetails[0], triangleCount: 100, topology: { ...cleanMesh.meshDetails[0].topology, triangleCount: 100, connectedComponentCount: 2, smallDetachedComponentCount: 1, warnings: ["disconnected-mesh-components-present"] } }],
    },
    scaleCalibration: { scaleCalibrated: false, method: "unknown-scale-preview-only" },
    upAxisReviewed: false,
    georeference: { status: "not-solved" },
  });

  assert.equal(report.status, "review-recommended");
  assert.equal(report.priority, "high");
  assert.equal(report.humanReviewRequired, true);
  assert.equal(report.mapReady, false);
  assert.equal(report.publicationEligible, false);
  assert.ok(report.findings.some((item) => item.code === "input-views-need-inspection"));
  assert.ok(report.findings.some((item) => item.code === "sparse-reconstruction-needs-review" && item.severity === "high"));
  assert.ok(report.findings.some((item) => item.code === "mesh-topology-needs-visual-review" && item.severity === "high"));
  assert.ok(report.findings.some((item) => item.code === "metric-scale-unverified"));
  assert.ok(report.findings.some((item) => item.code === "up-axis-not-reviewed"));
  assert.ok(report.findings.some((item) => item.code === "wgs84-placement-not-registered"));
  assert.ok(report.geometrySnapshot.connectedComponentsByPrimitive[0].smallDetachedComponentCount === 1);
  assert.ok(report.nextActions.length > 0);
});

test("does not remove the human approval gate when no automated signals are found", () => {
  const report = buildModelReviewSummary({
    imageQualityPreflight: cleanImages,
    reconstructionDiagnostics: cleanReconstruction,
    modelQuality: cleanMesh,
    ...cleanPlacement,
  });

  assert.equal(report.status, "no-automated-findings");
  assert.equal(report.priority, "none");
  assert.equal(report.findingCount, 0);
  assert.equal(report.humanReviewRequired, true);
  assert.equal(report.mapReady, false);
  assert.equal(report.publicationEligible, false);
});

test("reports missing diagnostics rather than treating them as a pass", () => {
  const report = buildModelReviewSummary({
    imageQualityPreflight: cleanImages,
    reconstructionDiagnostics: { status: "unavailable", warnings: ["model_analyzer unavailable"] },
    modelQuality: null,
    scaleCalibration: { scaleCalibrated: true },
    upAxisReviewed: true,
    georeference: { status: "not-solved" },
  });

  assert.ok(report.findings.some((item) => item.code === "reconstruction-diagnostics-unavailable"));
  assert.ok(report.findings.some((item) => item.code === "mesh-geometry-qa-unavailable"));
  assert.ok(report.findings.some((item) => item.code === "wgs84-placement-not-registered"));
  assert.notEqual(report.status, "no-automated-findings");
});

test("validates the summary input and emits a safe default action for a clean payload", () => {
  assert.throws(() => buildModelReviewSummary(null), /must be an object/);
  const report = buildModelReviewSummary({
    imageQualityPreflight: cleanImages,
    reconstructionDiagnostics: cleanReconstruction,
    modelQuality: cleanMesh,
    ...cleanPlacement,
  });
  assert.match(report.limitations[0], /does not prove architectural fidelity/);
});
