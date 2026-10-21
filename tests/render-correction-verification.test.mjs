import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { verifyRenderCorrectionTasks } from "../src/core/building-generation/render-correction-verification.mjs";

const modelSha = "a".repeat(64);
const manifestSha = "b".repeat(64);
const renderSha = "c".repeat(64);
const referenceSha = "d".repeat(64);
const changedModelSha = "e".repeat(64);
const changedManifestSha = "f".repeat(64);

function reviewReport(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    engine: "render-reference-review-v1",
    buildingId: "test-building",
    reviewStatus: "reviewer-reported-matches",
    valid: true,
    publicationEligible: false,
    provenance: { sourceModelSha256: changedModelSha, renderManifestSha256: changedManifestSha },
    comparisons: [{
      viewId: "front",
      renderFilename: "front.png",
      renderSha256: "1".repeat(64),
      referenceImageId: "reference-front",
      referenceSha256,
      comparisonBasis: "same-facade-known",
      outcome: "match",
      reviewer: "reviewer-01",
      reviewedAt: "2026-10-21T12:00:00Z",
      notes: "Visible opening rhythm is consistent in this view.",
      ...{},
    }],
    viewsWithoutComparisons: [],
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: "rrt-0123456789abcdefabcd",
    buildingId: "test-building",
    kind: "model-correction-review",
    priority: "high",
    status: "open",
    title: "Resolve render/reference mismatch: front",
    evidence: {
      reviewReportSha256: "9".repeat(64),
      sourceModelSha256: modelSha,
      renderManifestSha256: manifestSha,
      viewId: "front",
      renderFilename: "front.png",
      renderSha256,
      referenceImageId: "reference-front",
      referenceSha256,
      comparisonBasis: "same-facade-known",
      outcome: "mismatch",
      reviewer: "reviewer-01",
      reviewedAt: "2026-10-21T10:00:00Z",
      notes: "Facade openings differ.",
    },
    title: "Review front facade correction",
    ...overrides,
  };
}

function backlog(overrides = {}) {
  const originalTask = task();
  return {
    schemaVersion: "1.0.0",
    engine: "render-review-correction-tasks-v1",
    buildingId: "test-building",
    sourceReviewStatus: "needs-model-or-reference-correction",
    createdFromReviewReportSha256: "9".repeat(64),
    provenance: { sourceModelSha256: modelSha, renderManifestSha256: manifestSha },
    counts: { total: 1, open: 1, highPriority: 1, mediumPriority: 0, byKind: { "model-correction-review": 1 } },
    tasks: [originalTask],
    ...overrides,
  };
}

test("verifies a correction only with a fresh match for the exact pair and changed model plus render manifest", () => {
  const result = verifyRenderCorrectionTasks(backlog(), reviewReport());
  assert.equal(result.engine, "render-correction-verification-v1");
  assert.equal(result.counts.verified, 1);
  assert.equal(result.tasks[0].status, "verified");
  assert.equal(result.tasks[0].verified, true);
  assert.equal(result.tasks[0].matchedEvidence.referenceImageId, "reference-front");
  assert.equal(result.tasks[0].gates.sourceModelChanged, true);
  assert.equal(result.tasks[0].gates.renderManifestChanged, true);
  assert.equal(result.automationPolicy.backlogMutated, false);
  assert.equal(result.automationPolicy.publicationEligible, false);
});

test("does not verify a match when the source model has not changed", () => {
  const result = verifyRenderCorrectionTasks(backlog(), reviewReport({
    provenance: { sourceModelSha256: modelSha, renderManifestSha256: changedManifestSha },
  }));
  assert.equal(result.tasks[0].status, "stale-evidence");
  assert.equal(result.tasks[0].verified, false);
});

test("does not verify a match when the render manifest has not changed", () => {
  const result = verifyRenderCorrectionTasks(backlog(), reviewReport({
    provenance: { sourceModelSha256: changedModelSha, renderManifestSha256: manifestSha },
  }));
  assert.equal(result.tasks[0].status, "stale-evidence");
});

test("keeps a task active when the latest comparison is partial or mismatch", () => {
  const partial = reviewReport({
    comparisons: [reviewReport().comparisons[0] && {
      ...reviewReport().comparisons[0],
      outcome: "partial",
    }],
  });
  assert.equal(verifyRenderCorrectionTasks(backlog(), partial).tasks[0].status, "needs-more-work");
  const mismatch = reviewReport({
    comparisons: [reviewReport().comparisons[0] && {
      ...reviewReport().comparisons[0],
      outcome: "mismatch",
    }],
  });
  assert.equal(verifyRenderCorrectionTasks(backlog(), mismatch).tasks[0].status, "needs-more-work");
});

test("pending comparison waits and not-comparable evidence blocks model verification", () => {
  const pending = reviewReport({
    comparisons: [{
      viewId: "front",
      renderSha256: "1".repeat(64),
      referenceImageId: "reference-front",
      referenceSha256,
      comparisonBasis: "same-facade-known",
      outcome: "pending",
      reviewer: "",
      reviewedAt: null,
      notes: "",
    }],
  });
  assert.equal(verifyRenderCorrectionTasks(backlog(), pending).tasks[0].status, "awaiting-review");

  const incomparable = reviewReport({
    comparisons: [{
      viewId: "front",
      renderSha256: "1".repeat(64),
      referenceImageId: "reference-front",
      referenceSha256,
      comparisonBasis: "not-comparable",
      outcome: "not-comparable",
      reviewer: "reviewer-01",
      reviewedAt: "2026-10-21T12:00:00Z",
      notes: "Camera orientation cannot be aligned.",
    }],
  });
  assert.equal(verifyRenderCorrectionTasks(backlog(), incomparable).tasks[0].status, "blocked");
});

test("missing exact view/reference evidence cannot close a correction task", () => {
  const result = verifyRenderCorrectionTasks(backlog(), reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      viewId: "side",
    }],
  }));
  assert.equal(result.tasks[0].status, "missing-evidence");
  assert.equal(result.tasks[0].verified, false);
});

test("review-only tasks can complete without claiming geometry correction", () => {
  const sourceTask = task({
    kind: "complete-reference-review",
    evidence: { ...task().evidence, referenceImageId: "reference-front" },
  });
  const sourceBacklog = backlog({ tasks: [sourceTask] });
  const report = reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      outcome: "mismatch",
    }],
  });
  const result = verifyRenderCorrectionTasks(sourceBacklog, report);
  assert.equal(result.tasks[0].status, "completed");
  assert.equal(result.tasks[0].verified, false);
});

test("uncovered-view task completes only after the new report has an outcome", () => {
  const sourceTask = task({
    kind: "add-reference-comparison",
    evidence: { ...task().evidence, referenceImageId: null, viewId: "back" },
  });
  const sourceBacklog = backlog({ tasks: [sourceTask] });
  const report = reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      viewId: "back",
      referenceImageId: "reference-back",
    }],
  });
  assert.equal(verifyRenderCorrectionTasks(sourceBacklog, report).tasks[0].status, "completed");
});

test("rejects same report reuse, wrong building, invalid hashes and duplicate comparisons", () => {
  const sameReport = {
    ...reviewReport(),
    provenance: { sourceModelSha256: modelSha, renderManifestSha256: manifestSha },
  };
  // Explicitly reuse the exact source report digest to ensure it is not accepted as a fresh cycle.
  const exactDigest = createHash("sha256").update(JSON.stringify(sameReport)).digest("hex");
  assert.throws(() => verifyRenderCorrectionTasks(backlog({
    createdFromReviewReportSha256: exactDigest,
    tasks: [task({ evidence: { ...task().evidence, reviewReportSha256: exactDigest } })],
  }), sameReport), /must-be-new-review-evidence/);
  assert.throws(() => verifyRenderCorrectionTasks(backlog(), reviewReport({ buildingId: "another-building" })), /does-not-match-backlog/);
  assert.throws(() => verifyRenderCorrectionTasks(backlog(), reviewReport({
    provenance: { sourceModelSha256: "bad", renderManifestSha256: changedManifestSha },
  })), /source-model-sha256-invalid/);
  assert.throws(() => verifyRenderCorrectionTasks(backlog(), reviewReport({
    comparisons: [
      reviewReport().comparisons[0],
      reviewReport().comparisons[0],
    ],
  })), /duplicate-verification-comparison/);
});
