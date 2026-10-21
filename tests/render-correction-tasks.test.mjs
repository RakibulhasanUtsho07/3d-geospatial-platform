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
