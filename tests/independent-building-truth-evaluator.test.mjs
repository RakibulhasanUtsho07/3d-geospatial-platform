import assert from "node:assert/strict";
import test from "node:test";
import { evaluateIndependentBuildingTruth } from "../src/core/building-generation/independent-building-truth-evaluator.mjs";

const candidateHash = "a".repeat(64);
const referenceHash = "b".repeat(64);
const reviewedAt = "2026-10-26T10:00:00Z";
const square = () => [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }];
const cubeVertices = () => [
  [0,0,0], [2,0,0], [2,0,2], [0,0,2],
  [0,3,0], [2,3,0], [2,3,2], [0,3,2],
];
const cubeTriangles = () => [
  [0,2,1], [0,3,2], [4,5,6], [4,6,7],
  [0,1,5], [0,5,4], [1,2,6], [1,6,5],
  [2,3,7], [2,7,6], [3,0,4], [3,4,7],
];
const points = () => [
  { id: "corner-01", x: 0, y: 0, z: 0 },
  { id: "corner-02", x: 2, y: 0, z: 0 },
  { id: "corner-03", x: 2, y: 0, z: 2 },
  { id: "roof-01", x: 0, y: 3, z: 0 },
];
const tolerances = () => ({
  footprintAreaRelativeErrorPercent: 5,
  footprintBoundaryP95M: 0.1,
  footprintBoundaryMaxM: 0.2,
  dimensionRelativeErrorPercent: 5,
  checkPointRmseM: 0.1,
  checkPointMaxM: 0.2,
  surfaceDistanceP95M: 0.1,
  surfaceDistanceMaxM: 0.2,
});
function input(overrides = {}) {
  const candidate = {
    glbSha256: candidateHash, geometrySourceGlbSha256: candidateHash,
    coordinateFrameId: "site-local-enu-01", units: "m", footprint: square(),
    dimensionsM: { widthM: 2, depthM: 2, heightM: 3 },
    checkPoints: points(),
    surfaceMesh: { sourceGlbSha256: candidateHash, vertices: cubeVertices(), triangles: cubeTriangles() },
  };
  const reference = {
    sourceId: "survey-2026-01", sourceSha256: referenceHash, geometrySourceSha256: referenceHash,
    evidenceBasis: "surveyed", sourceDescription: "Independent total-station survey and checked mesh export.",
    reviewedBy: "reviewer-a", reviewedAt, coordinateFrameId: "site-local-enu-01", units: "m",
    footprint: square(), dimensionsM: { widthM: 2, depthM: 2, heightM: 3 },
    checkPoints: points().map((point) => ({ ...point, independentOfFit: true })),
    surfaceMesh: { sha256: referenceHash, vertices: cubeVertices(), triangles: cubeTriangles() },
  };
  return {
    schemaVersion: "1.0.0", evaluationId: "site-a-eval-01", buildingId: "site-a-building",
    generatedAt: "2026-10-27T08:00:00Z", candidate, reference, tolerances: tolerances(),
    ...overrides,
  };
}

test("reports independent footprint, dimension, checkpoint and optional mesh metrics without approving a model", () => {
  const report = evaluateIndependentBuildingTruth(input());
  assert.equal(report.status, "benchmark-review-required");
  assert.equal(report.metrics.footprint.areaRelativeErrorPercent, 0);
  assert.equal(report.metrics.footprint.boundaryDistance.symmetric.maxM, 0);
  assert.equal(report.metrics.dimensions.maxRelativeErrorPercent, 0);
  assert.equal(report.metrics.checkPoints.residuals.rmsM, 0);
  assert.equal(report.metrics.surfaceDistance.symmetric.maxM, 0);
  assert.equal(report.policy.acceptanceEligible, false);
  assert.equal(report.policy.publicationEligible, false);
  assert.equal(report.policy.mapReady, false);
  assert.equal(report.policy.automaticApproval, false);
  assert.equal(report.failures.length, 0);
  assert.equal(report.warnings.length, 0);
});

test("fails when the candidate footprint boundary and dimensions exceed configured tolerances", () => {
  const data = input();
  data.candidate.footprint = data.candidate.footprint.map((point) => ({ ...point, x: point.x + 0.5 }));
  data.candidate.dimensionsM.widthM = 2.4;
  const report = evaluateIndependentBuildingTruth(data);
  assert.equal(report.status, "benchmark-failed");
  assert.ok(report.metrics.footprint.boundaryDistance.symmetric.maxM >= 0.49);
  assert.ok(report.metrics.dimensions.axes.find((axis) => axis.dimension === "widthM").relativeErrorPercent > 5);
  assert.ok(report.failures.some((check) => check.id === "footprint-boundary-max-within-tolerance"));
  assert.ok(report.failures.some((check) => check.id === "dimension-relative-error-max-within-tolerance"));
});

test("fails when mesh vertices depart from the independent reference surface", () => {
  const data = input();
  data.candidate.surfaceMesh.vertices = data.candidate.surfaceMesh.vertices.map(([x, y, z]) => [x + 0.25, y, z]);
  const report = evaluateIndependentBuildingTruth(data);
  assert.equal(report.status, "benchmark-failed");
  assert.ok(report.metrics.surfaceDistance.symmetric.maxM >= 0.24);
  assert.ok(report.failures.some((check) => check.id === "surface-distance-max-within-tolerance"));
});

test("fails closed for stale candidate hashes, different coordinate frames and untrusted estimated truth", () => {
  const stale = input();
  stale.candidate.geometrySourceGlbSha256 = "c".repeat(64);
  assert.equal(evaluateIndependentBuildingTruth(stale).status, "benchmark-failed");

  const mismatchedFrame = input();
  mismatchedFrame.reference.coordinateFrameId = "different-frame";
  assert.ok(evaluateIndependentBuildingTruth(mismatchedFrame).failures.some((check) => check.id === "shared-metric-coordinate-frame"));

  const guessed = input();
  guessed.reference.evidenceBasis = "operator-estimate";
  assert.ok(evaluateIndependentBuildingTruth(guessed).failures.some((check) => check.id === "independent-truth-provenance"));
});

test("requires held-out check points to be explicitly marked independent of fit", () => {
  const data = input();
  data.reference.checkPoints[0].independentOfFit = false;
  const report = evaluateIndependentBuildingTruth(data);
  assert.equal(report.status, "benchmark-failed");
  assert.ok(report.failures.some((check) => check.id === "check-points-valid"));
});

test("reports missing geometry as incomplete instead of inventing a pass", () => {
  const data = input();
  delete data.candidate.footprint;
  delete data.reference.footprint;
  const report = evaluateIndependentBuildingTruth(data);
  assert.equal(report.status, "benchmark-incomplete");
  assert.equal(report.metrics.footprint, null);
  assert.ok(report.warnings.some((check) => check.id === "footprint-evidence-present"));
});

test("requires an explicit threshold even when independent geometry metrics can be computed", () => {
  const data = input();
  delete data.tolerances.footprintBoundaryP95M;
  const report = evaluateIndependentBuildingTruth(data);
  assert.equal(report.status, "benchmark-incomplete");
  assert.equal(report.metrics.footprint.areaRelativeErrorPercent, 0);
  assert.ok(report.warnings.some((check) => check.id === "footprint-boundary-p95-threshold-configured"));
});

test("self-intersecting footprint is reported as a failed geometry check", () => {
  const data = input();
  data.reference.footprint = [
    { x: 0, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 2, z: 0 },
  ];
  const report = evaluateIndependentBuildingTruth(data);
  assert.equal(report.status, "benchmark-failed");
  assert.ok(report.failures.some((check) => check.id === "footprint-geometry-valid"));
});

test("surface comparison is optional unless only one mesh is supplied", () => {
  const data = input();
  delete data.candidate.surfaceMesh;
  delete data.reference.surfaceMesh;
  const report = evaluateIndependentBuildingTruth(data);
  assert.equal(report.status, "benchmark-review-required");
  assert.equal(report.metrics.surfaceDistance, null);

  const partial = input();
  delete partial.reference.surfaceMesh;
  const incomplete = evaluateIndependentBuildingTruth(partial);
  assert.equal(incomplete.status, "benchmark-incomplete");
  assert.ok(incomplete.warnings.some((check) => check.id === "surface-reference-pair-complete"));
});
