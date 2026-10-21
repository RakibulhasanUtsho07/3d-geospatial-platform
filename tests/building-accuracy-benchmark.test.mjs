import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildBuildingAccuracyBenchmark } from "../src/core/building-generation/building-accuracy-benchmark.mjs";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
const built = generateProceduralGlb(fixture);
const geometryQa = analyzeGlbQuality(built.glb);
const candidateHash = createHash("sha256").update(built.glb).digest("hex");
const dimensions = geometryQa.bounds.dimensions;
const referenceEvidence = {
  basis: "surveyed",
  referenceId: "survey-book-2026-01",
  sourceDescription: "Independent total-station survey recorded in the site measurement book.",
};

const R = 6378137;
function lonLatFromLocal(east, north, longitude, latitude) {
  const lat0 = latitude * Math.PI / 180;
  return {
    longitude: (longitude + east / (R * Math.cos(lat0)) * 180 / Math.PI + 540) % 360 - 180,
    latitude: latitude + north / R * 180 / Math.PI,
  };
}
function controlPoints() {
  const scale = 2.5, theta = 30 * Math.PI / 180, c = Math.cos(theta), s = Math.sin(theta);
  return [[-10, -8], [10, -8], [10, 8], [-10, 8]].map(([modelX, modelZ], index) => {
    const east = scale * (c * modelX - s * modelZ) + 100;
    const north = scale * (s * modelX + c * modelZ) + 200;
    return {
      id: "accuracy-gcp-" + (index + 1),
      modelX,
      modelZ,
      ...lonLatFromLocal(east, north, 90.4, 23.7),
      evidenceSourceId: "site-survey-2026-01",
    };
  });
}
function referenceReview(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    engine: "render-reference-review-v1",
    buildingId: fixture.id,
    valid: true,
    reviewStatus: "reviewer-reported-matches",
    publicationEligible: false,
    provenance: { sourceModelSha256: candidateHash },
    counts: { comparisonCount: 2, match: 2, partial: 0, mismatch: 0, pending: 0, notComparable: 0, viewsWithoutComparisons: 0 },
    comparisons: [
      { viewId: "front", referenceImageId: "front-reference", comparisonBasis: "same-facade-known", outcome: "match", reviewer: "reviewer-a", reviewedAt: "2026-10-21T10:00:00Z", notes: "Facade openings align with the verified reference." },
      { viewId: "side", referenceImageId: "side-reference", comparisonBasis: "pose-estimated", outcome: "match", reviewer: "reviewer-b", reviewedAt: "2026-10-21T10:05:00Z", notes: "Visible side proportions align with the reference." },
    ],
    ...overrides,
  };
}
function completeInput(overrides = {}) {
  return {
    buildingId: fixture.id,
    candidateGlbSha256: candidateHash,
    geometryQa: { ...geometryQa, warnings: [] },
    dimensionReference: {
      referenceDimensionsM: { x: dimensions[0], y: dimensions[1], z: dimensions[2] },
      metresPerModelUnit: 1,
      tolerancePercent: 1,
      evidence: referenceEvidence,
    },
    groundControl: {
      modelCoordinatesGlbSha256: candidateHash,
      coordinateEvidenceBasis: "surveyed",
      sourceDescription: "Independent site survey control points measured in this exact GLB coordinate frame.",
      controlPoints: controlPoints(),
      maxRmsErrorM: 0.5,
      maxResidualM: 1,
    },
    renderReferenceReview: referenceReview(),
    generatedAt: "2026-10-21T12:00:00Z",
    ...overrides,
  };
}

test("passes only when dimensions, exact-model ground controls and direct visual reviews are complete", () => {
  const report = buildBuildingAccuracyBenchmark(completeInput());
  assert.equal(report.status, "benchmark-passed-review-required");
  assert.equal(report.candidateGlbSha256, candidateHash);
  assert.equal(report.metrics.dimensions.maxRelativeErrorPercent, 0);
  assert.equal(report.metrics.georeference.thresholdPass, true);
  assert.equal(report.metrics.visualReference.match, 2);
  assert.equal(report.policy.mapReady, false);
  assert.equal(report.policy.publicationEligible, false);
  assert.equal(report.policy.automaticApproval, false);
  assert.equal("accuracyPercent" in report.metrics, false);
  assert.ok(report.checks.every((check) => check.status === "passed"));
});

test("fails a candidate when any independently supplied dimension exceeds tolerance", () => {
  const input = completeInput();
  input.dimensionReference.referenceDimensionsM.z *= 1.2;
  const report = buildBuildingAccuracyBenchmark(input);
  assert.equal(report.status, "benchmark-failed");
  assert.equal(report.metrics.dimensions.status, "dimension-mismatch-review-required");
  assert.ok(report.checks.some((check) => check.id === "reference-dimensions-within-tolerance" && check.status === "failed"));
});

test("fails when ground-control model coordinates were measured against a different GLB", () => {
  const input = completeInput();
  input.groundControl.modelCoordinatesGlbSha256 = "f".repeat(64);
  const report = buildBuildingAccuracyBenchmark(input);
  assert.equal(report.status, "benchmark-failed");
  assert.ok(report.checks.some((check) => check.id === "ground-control-model-binding" && check.status === "failed"));
});

test("fails stale reference review and reviewer-reported mismatches", () => {
  const stale = completeInput();
  stale.renderReferenceReview.provenance.sourceModelSha256 = "e".repeat(64);
  assert.equal(buildBuildingAccuracyBenchmark(stale).status, "benchmark-failed");

  const mismatch = completeInput();
  mismatch.renderReferenceReview.comparisons[0].outcome = "mismatch";
  assert.equal(buildBuildingAccuracyBenchmark(mismatch).status, "benchmark-failed");
});

test("does not pass when ground control or visual-review evidence is absent", () => {
  const report = buildBuildingAccuracyBenchmark(completeInput({ groundControl: undefined, renderReferenceReview: undefined }));
  assert.equal(report.status, "benchmark-incomplete");
  assert.ok(report.checks.some((check) => check.id === "ground-control-evidence" && check.status === "warning"));
  assert.ok(report.checks.some((check) => check.id === "render-reference-review" && check.status === "warning"));
});

test("keeps pending and non-comparable visual evidence incomplete", () => {
  const pending = completeInput();
  pending.renderReferenceReview.reviewStatus = "pending-human-review";
  pending.renderReferenceReview.comparisons[0].outcome = "pending";
  const report = buildBuildingAccuracyBenchmark(pending);
  assert.equal(report.status, "benchmark-incomplete");
  assert.ok(report.warnings.some((check) => check.id === "render-reference-outcomes"));
});

test("rejects estimated dimensions as ground truth", () => {
  const input = completeInput();
  input.dimensionReference.evidence = { basis: "operator-estimate", referenceId: "guess-01", sourceDescription: "Approximate visual guess" };
  const report = buildBuildingAccuracyBenchmark(input);
  assert.equal(report.status, "benchmark-failed");
  assert.ok(report.checks.some((check) => check.id === "dimension-reference-provenance" && check.status === "failed"));
});

test("validates candidate identifiers, hashes, model dimensions and timestamp", () => {
  assert.throws(() => buildBuildingAccuracyBenchmark(completeInput({ candidateGlbSha256: "bad" })), /SHA-256/);
  assert.throws(() => buildBuildingAccuracyBenchmark(completeInput({ buildingId: "../unsafe" })), /buildingId/);
  assert.throws(() => buildBuildingAccuracyBenchmark(completeInput({ generatedAt: "not-a-date" })), /timestamp/);
  assert.throws(() => buildBuildingAccuracyBenchmark(completeInput({ geometryQa: { ...geometryQa, bounds: { dimensions: [0, 1, 2] } } })), /greater than zero/);
});
