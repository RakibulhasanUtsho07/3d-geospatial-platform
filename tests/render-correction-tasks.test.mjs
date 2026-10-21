import assert from "node:assert/strict";
import test from "node:test";
import { createRenderCorrectionTasks } from "../src/core/building-generation/render-correction-tasks.mjs";

const modelSha256 = "a".repeat(64);
const manifestSha256 = "b".repeat(64);
const renderSha256 = "c".repeat(64);
const referenceSha256 = "d".repeat(64);

function comparison(overrides = {}) {
  return {
    viewId: "front",
    renderFilename: "front.png",
    renderSha256,
    referenceImageId: "reference-front",
    referenceSha256,
    comparisonBasis: "same-facade-known",
    outcome: "mismatch",
    reviewer: "reviewer-01",
    reviewedAt: "2026-10-21T10:00:00Z",
    notes: "Main facade opening rhythm differs from the reference.",
    correctionRequest: "Review window spacing and facade proportions.",
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    engine: "render-reference-review-v1",
    buildingId: "test-building",
    reviewStatus: "needs-model-or-reference-correction",
    valid: true,
    publicationEligible: false,
    provenance: { sourceModelSha256: modelSha256, renderManifestSha256: manifestSha256 },
    comparisons: [comparison()],
    viewsWithoutComparisons: ["back"],
    ...overrides,
  };
}

test("builds high-priority, evidence-linked task for a mismatch", () => {
  const result = createRenderCorrectionTasks(report());
  assert.equal(result.engine, "render-review-correction-tasks-v1");
  assert.equal(result.counts.total, 2);
  const mismatch = result.tasks.find((task) => task.kind === "model-correction-review");
  assert.ok(mismatch);
  assert.equal(mismatch.priority, "high");
  assert.equal(mismatch.status, "open");
  assert.equal(mismatch.correctionRequest, "Review window spacing and facade proportions.");
  assert.equal(mismatch.evidence.renderSha256, renderSha256);
  assert.equal(mismatch.evidence.referenceSha256, referenceSha256);
  assert.equal(mismatch.autoApplied, false);
  assert.equal(mismatch.verificationStatus, "not-verified");
  assert.equal(mismatch.publicationEligible, false);
});

test("partial comparison creates medium priority task and missing request stays explicit triage", () => {
  const result = createRenderCorrectionTasks(report({
    comparisons: [comparison({ outcome: "partial", correctionRequest: null })],
    viewsWithoutComparisons: [],
  }));
  assert.equal(result.counts.total, 1);
  assert.equal(result.tasks[0].priority, "medium");
  assert.match(result.tasks[0].correctionRequest, /No structured correction request/);
});

test("match does not create a correction task", () => {
  const result = createRenderCorrectionTasks(report({
    reviewStatus: "reviewer-reported-matches",
    comparisons: [comparison({ outcome: "match", correctionRequest: null })],
    viewsWithoutComparisons: [],
  }));
  assert.equal(result.counts.total, 0);
  assert.deepEqual(result.tasks, []);
});

test("pending and not-comparable outcomes create review/evidence follow-ups, not model edits", () => {
  const result = createRenderCorrectionTasks(report({
    reviewStatus: "pending-human-review",
    comparisons: [
      comparison({ outcome: "pending", reviewer: "", reviewedAt: null, notes: "" }),
      comparison({
        viewId: "side",
        renderFilename: "side.png",
        renderSha256: "e".repeat(64),
        referenceImageId: "reference-side",
        referenceSha256: "f".repeat(64),
        comparisonBasis: "not-comparable",
        outcome: "not-comparable",
      }),
    ],
    viewsWithoutComparisons: [],
  }));
  assert.deepEqual(result.tasks.map((task) => task.kind), [
    "complete-reference-review",
    "resolve-reference-comparability",
  ]);
  assert.ok(result.tasks.every((task) => task.autoApplied === false));
});

test("creates a comparison coverage task without pretending the view is a mismatch", () => {
  const result = createRenderCorrectionTasks(report({
    comparisons: [],
    viewsWithoutComparisons: ["back"],
    reviewStatus: "pending-human-review",
  }));
  assert.equal(result.tasks[0].kind, "add-reference-comparison");
  assert.equal(result.tasks[0].evidence.renderSha256, null);
  assert.match(result.tasks[0].correctionRequest, /Do not infer a mismatch/);
});

test("rejects invalid report and incomplete hash evidence", () => {
  assert.throws(() => createRenderCorrectionTasks(report({ valid: false })), /invalid-review-report/);
  assert.throws(() => createRenderCorrectionTasks(report({
    comparisons: [comparison({ referenceSha256: "bad" })],
  })), /evidence-hash-invalid/);
  assert.throws(() => createRenderCorrectionTasks(report({
    provenance: { sourceModelSha256: "bad", renderManifestSha256: manifestSha256 },
  })), /source-model-sha256-invalid/);
});

test("task ids and report hashes are deterministic for identical input", () => {
  const input = report();
  const one = createRenderCorrectionTasks(input);
  const two = createRenderCorrectionTasks(input);
  assert.deepEqual(one.tasks.map((task) => task.id), two.tasks.map((task) => task.id));
  assert.equal(one.createdFromReviewReportSha256, two.createdFromReviewReportSha256);
  assert.match(one.tasks[0].id, /^rrt-[a-f0-9]{20}$/);
});

function similarityDiagnostics(overrides = {}) {
  return {
    reportSha256: "1".repeat(64),
    engine: "render-image-similarity-diagnostics-v1",
    status: "diagnostics-computed",
    interpretation: "review-recommended",
    renderSha256,
    referenceSha256,
    metrics: {
      meanAbsoluteError: 41.25,
      rootMeanSquaredError: 52.1,
      psnrDb: 13.8,
      localSsim8x8: 0.21,
      differenceHashHammingDistance: 48,
    },
    comparability: {
      aspectRatioDifferencePercent: 0.5,
      aspectRatioWithinScreeningThreshold: true,
      sameFacadeConfirmedByTool: false,
      cameraPoseAlignmentVerifiedByTool: false,
    },
    warnings: ["low-grayscale-ssim-screening-hint"],
    automaticMatch: false,
    ...overrides,
  };
}

test("preserves valid similarity evidence on the exact correction task without changing human priority", () => {
  const baseline = createRenderCorrectionTasks(report());
  const withDiagnostics = createRenderCorrectionTasks(report({
    comparisons: [comparison({ similarityDiagnostics: similarityDiagnostics() })],
  }));
  const baselineMismatch = baseline.tasks.find((task) => task.kind === "model-correction-review");
  const diagnosedMismatch = withDiagnostics.tasks.find((task) => task.kind === "model-correction-review");

  assert.equal(diagnosedMismatch.priority, baselineMismatch.priority);
  assert.equal(diagnosedMismatch.kind, baselineMismatch.kind);
  assert.equal(diagnosedMismatch.evidence.outcome, baselineMismatch.evidence.outcome);
  assert.equal(diagnosedMismatch.evidence.similarityDiagnostics.reportSha256, "1".repeat(64));
  assert.equal(diagnosedMismatch.evidence.similarityDiagnostics.renderSha256, renderSha256);
  assert.equal(diagnosedMismatch.evidence.similarityDiagnostics.referenceSha256, referenceSha256);
  assert.equal(diagnosedMismatch.evidence.similarityDiagnostics.metrics.localSsim8x8, 0.21);
  assert.deepEqual(diagnosedMismatch.evidence.similarityDiagnostics.warnings, ["low-grayscale-ssim-screening-hint"]);
  assert.equal(diagnosedMismatch.evidence.similarityDiagnostics.automaticMatch, false);
  assert.equal(withDiagnostics.similarityDiagnosticsSummary.attachedToTasks, 1);
  assert.equal(withDiagnostics.similarityDiagnosticsSummary.withWarnings, 1);
  assert.equal(withDiagnostics.similarityDiagnosticsSummary.automaticPriorityChanges, false);
  assert.equal(diagnosedMismatch.autoApplied, false);
  assert.equal(diagnosedMismatch.publicationEligible, false);
});

test("rejects diagnostics bound to a different render/reference or malformed metric values", () => {
  assert.throws(() => createRenderCorrectionTasks(report({
    comparisons: [comparison({
      similarityDiagnostics: similarityDiagnostics({ renderSha256: "0".repeat(64) }),
    })],
  })), /similarity-diagnostics-invalid/);

  const invalidMetrics = similarityDiagnostics();
  invalidMetrics.metrics.localSsim8x8 = 9;
  assert.throws(() => createRenderCorrectionTasks(report({
    comparisons: [comparison({ similarityDiagnostics: invalidMetrics })],
  })), /similarity-diagnostics-invalid/);
});

test("tasks without image diagnostics keep a null evidence field", () => {
  const result = createRenderCorrectionTasks(report());
  const mismatch = result.tasks.find((task) => task.kind === "model-correction-review");
  assert.equal(mismatch.evidence.similarityDiagnostics, null);
  assert.equal(result.similarityDiagnosticsSummary.attachedToTasks, 0);
  assert.equal(result.similarityDiagnosticsSummary.withWarnings, 0);
});

