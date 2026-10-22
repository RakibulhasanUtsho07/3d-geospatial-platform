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

test("builds high-priority, evidence-linked task for a human-confirmed mismatch", () => {
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
  assert.equal(mismatch.humanReviewConfirmed, true);
  assert.equal(result.similarityDiagnosticsSummary.humanConfirmedCorrectionTasks, 1);
  assert.equal(mismatch.autoApplied, false);
  assert.equal(mismatch.verificationStatus, "not-verified");
  assert.equal(mismatch.publicationEligible, false);
});

test("partial comparison creates medium-priority task only with a recorded human review", () => {
  const result = createRenderCorrectionTasks(report({
    comparisons: [comparison({ outcome: "partial", correctionRequest: null })],
    viewsWithoutComparisons: [],
  }));
  assert.equal(result.counts.total, 1);
  assert.equal(result.tasks[0].priority, "medium");
  assert.equal(result.tasks[0].humanReviewConfirmed, true);
  assert.match(result.tasks[0].correctionRequest, /No structured correction request/);
});

test("rejects mismatch or partial outcomes without reviewer, timestamp, and notes", () => {
  assert.throws(() => createRenderCorrectionTasks(report({
    comparisons: [comparison({ reviewer: "" })],
    viewsWithoutComparisons: [],
  })), /human-confirmation-missing/);
  assert.throws(() => createRenderCorrectionTasks(report({
    comparisons: [comparison({ outcome: "partial", notes: "  " })],
    viewsWithoutComparisons: [],
  })), /human-confirmation-missing/);
  assert.throws(() => createRenderCorrectionTasks(report({
    comparisons: [comparison({ reviewedAt: "not-a-timestamp" })],
    viewsWithoutComparisons: [],
  })), /human-confirmation-missing/);
});

test("match does not create a correction task even when similarity diagnostics warn", () => {
  const result = createRenderCorrectionTasks(report({
    reviewStatus: "reviewer-reported-matches",
    comparisons: [comparison({
      outcome: "match",
      correctionRequest: null,
      similarityDiagnostics: similarityDiagnostics({
        warnings: ["high-grayscale-pixel-error-screening-hint"],
        interpretation: "review-recommended",
      }),
    })],
    viewsWithoutComparisons: [],
  }));
  assert.equal(result.counts.total, 0);
  assert.deepEqual(result.tasks, []);
  assert.equal(result.similarityDiagnosticsSummary.diagnosticsCreateTasks, false);
  assert.equal(result.automationPolicy.diagnosticsCreateTasks, false);
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
  assert.ok(result.tasks.every((task) => task.humanReviewConfirmed === false));
});

test("creates a comparison coverage task without pretending the view is a mismatch", () => {
  const result = createRenderCorrectionTasks(report({
    comparisons: [],
    viewsWithoutComparisons: ["back"],
    reviewStatus: "pending-human-review",
  }));
  assert.equal(result.tasks[0].kind, "add-reference-comparison");
  assert.equal(result.tasks[0].evidence.renderSha256, null);
  assert.equal(result.tasks[0].humanReviewConfirmed, false);
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
  assert.equal(withDiagnostics.similarityDiagnosticsSummary.withSpatialHotspots, 0);
  assert.equal(withDiagnostics.similarityDiagnosticsSummary.automaticPriorityChanges, false);
  assert.equal(diagnosedMismatch.humanReviewConfirmed, true);
  assert.equal(diagnosedMismatch.autoApplied, false);
  assert.equal(diagnosedMismatch.publicationEligible, false);
});

function richSpatialDiagnosticMetrics() {
  const cells = Array.from({ length: 16 }, (_, index) => {
    const cellX = index % 4;
    const cellY = Math.floor(index / 4);
    const edgeSampleCount = (cellX === 0 || cellX === 3 ? 15 : 16) *
      (cellY === 0 || cellY === 3 ? 15 : 16);
    const referenceEdgePixelCount = index + 1;
    const candidateEdgePixelCount = (index * 3) % 17;
    const edgeDensityAbsoluteDifference = Number((
      Math.abs(referenceEdgePixelCount - candidateEdgePixelCount) / edgeSampleCount
    ).toFixed(4));
    return {
      cellX,
      cellY,
      meanAbsoluteError: index + 1,
      meanSignedLuminanceOffset: index - 8,
      localSsim16x16: Number((0.5 + index / 100).toFixed(4)),
      edgeSampleCount,
      referenceEdgePixelCount,
      candidateEdgePixelCount,
      referenceEdgeDensity: Number((referenceEdgePixelCount / edgeSampleCount).toFixed(4)),
      candidateEdgeDensity: Number((candidateEdgePixelCount / edgeSampleCount).toFixed(4)),
      edgeDensityAbsoluteDifference,
    };
  });
  const maeValues = cells.map((cell) => cell.meanAbsoluteError).sort((a, b) => a - b);
  const edgeDifferences = cells.map((cell) => cell.edgeDensityAbsoluteDifference);
  const edgeSorted = [...cells].sort((left, right) =>
    right.edgeDensityAbsoluteDifference - left.edgeDensityAbsoluteDifference ||
    left.cellY - right.cellY || left.cellX - right.cellX);
  const pixelSorted = [...cells].sort((left, right) =>
    right.meanAbsoluteError - left.meanAbsoluteError ||
    left.cellY - right.cellY || left.cellX - right.cellX);
  const mid = Math.floor(edgeDifferences.length / 2);
  const medianEdgeDifference = ([
    ...edgeDifferences,
  ].sort((a, b) => a - b)[mid - 1] + [...edgeDifferences].sort((a, b) => a - b)[mid]) / 2;
  return {
    medianCandidateMinusReferenceLuminanceOffset: -7,
    luminanceOffsetNormalizedMeanAbsoluteError: 21,
    luminanceOffsetNormalizedRootMeanSquaredError: 30,
    luminanceOffsetNormalizedSsim8x8: 0.45,
    luminanceOffsetNormalizedMaeReductionPercent: ((41.25 - 21) / 41.25) * 100,
    edgeDensityAbsoluteDifference: 0.02,
    edgeOrientationHistogramDistance: 0.1,
    candidateToReferenceSharpnessRatio: 0.84,
    spatialEdgeDistributionDistance: 0.13,
    activeEdgeCellJaccardDistance: 0.2,
    referenceSpatialEdgeCoverage: 0.5,
    candidateSpatialEdgeCoverage: 0.5,
    spatialCellDiagnostics: cells,
    spatialCellMaeMedian: (maeValues[7] + maeValues[8]) / 2,
    spatialCellMaeMaximum: Math.max(...maeValues),
    spatialCellMaeMedianGap: Math.max(...maeValues) - (maeValues[7] + maeValues[8]) / 2,
    highestDifferenceCells: pixelSorted.slice(0, 4).map(({ cellX, cellY }) => ({ cellX, cellY })),
    localEdgeDensityDifferenceMedian: medianEdgeDifference,
    localEdgeDensityDifferenceMaximum: Math.max(...edgeDifferences),
    highestEdgeDifferenceCells: edgeSorted.slice(0, 4).map(({ cellX, cellY }) => ({ cellX, cellY })),
  };
}

test("attaches validated top pixel/edge hotspots and normalized-luminance metrics as image-space context", () => {
  const diagnostics = similarityDiagnostics();
  diagnostics.metrics = {
    ...diagnostics.metrics,
    ...richSpatialDiagnosticMetrics(),
  };
  const result = createRenderCorrectionTasks(report({
    comparisons: [comparison({ similarityDiagnostics: diagnostics })],
    viewsWithoutComparisons: [],
  }));
  const task = result.tasks[0];
  const attached = task.evidence.similarityDiagnostics;

  assert.equal(result.counts.total, 1);
  assert.equal(task.humanReviewConfirmed, true);
  assert.equal(task.priority, "high");
  assert.equal(attached.metrics.luminanceOffsetNormalizedMeanAbsoluteError, 21);
  assert.equal(attached.metrics.luminanceOffsetNormalizedSsim8x8, 0.45);
  assert.equal(attached.metrics.edgeOrientationHistogramDistance, 0.1);
  assert.equal(attached.spatialHotspots.coordinateSpace, "normalized-64x64-grayscale-preview-4x4-grid");
  assert.equal(attached.spatialHotspots.gridSize, 4);
  assert.match(attached.spatialHotspots.note, /not mapped facade coordinates/);
  assert.equal(attached.spatialHotspots.pixelDifference.highestDifferenceCells.length, 4);
  assert.deepEqual(
    attached.spatialHotspots.pixelDifference.highestDifferenceCells.map(({ cellX, cellY }) => [cellX, cellY]),
    [[3, 3], [2, 3], [1, 3], [0, 3]],
  );
  assert.equal(attached.spatialHotspots.edgeStructure.highestEdgeDifferenceCells.length, 4);
  assert.equal(result.similarityDiagnosticsSummary.withSpatialHotspots, 1);
  assert.equal(result.similarityDiagnosticsSummary.diagnosticsCreateTasks, false);
  assert.equal(result.automationPolicy.reviewerJudgementReinterpreted, false);
  assert.equal(result.automationPolicy.publicationEligible, false);
});

test("rejects spatial hotspot rankings or per-cell counts inconsistent with the attached diagnostics", () => {
  const badRanking = similarityDiagnostics();
  badRanking.metrics = { ...badRanking.metrics, ...richSpatialDiagnosticMetrics() };
  badRanking.metrics.highestDifferenceCells = [{ cellX: 0, cellY: 0 }, { cellX: 1, cellY: 0 },
    { cellX: 2, cellY: 0 }, { cellX: 3, cellY: 0 }];
  assert.throws(() => createRenderCorrectionTasks(report({
    comparisons: [comparison({ similarityDiagnostics: badRanking })],
    viewsWithoutComparisons: [],
  })), /spatial-hotspots-invalid/);

  const badCounts = similarityDiagnostics();
  badCounts.metrics = { ...badCounts.metrics, ...richSpatialDiagnosticMetrics() };
  badCounts.metrics.spatialCellDiagnostics[0].referenceEdgePixelCount += 1;
  assert.throws(() => createRenderCorrectionTasks(report({
    comparisons: [comparison({ similarityDiagnostics: badCounts })],
    viewsWithoutComparisons: [],
  })), /spatial-hotspots-invalid/);
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
  assert.equal(result.similarityDiagnosticsSummary.withSpatialHotspots, 0);
});
