import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";
import { buildBuildingReleaseReadiness } from "../src/core/building-generation/building-release-readiness.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const modelSha = "a".repeat(64);
const oldModelSha = "b".repeat(64);
const oldManifestSha = "c".repeat(64);

function fixture({ mismatchView = null, missingView = null, unverifiedRights = null, geometryWarnings = [], textureWarnings = [], unverifiedTask = false } = {}) {
  const renderViews = REQUIRED_REVIEW_VIEWS
    .filter((id) => id !== missingView)
    .map((id) => ({ id, filename: id + ".png", width: 512, height: 512, bytes: 4000, sha256: hash("render:" + id), renderComplete: true }));
  const manifest = {
    schemaVersion: "1.0.0",
    engine: "building-render-review-manifest-v1",
    status: "render-set-ready-for-human-review",
    valid: true,
    publicationEligible: false,
    modelSha256: modelSha,
    views: renderViews,
    warnings: [],
    errors: [],
  };
  const manifestSha = hash(JSON.stringify(manifest));
  const referenceImages = renderViews.map((view) => ({
    id: "ref-" + view.id,
    sha256: hash("reference:" + view.id),
    rightsStatus: view.id === unverifiedRights ? "pending" : "verified",
    sourceDescription: "Test reference for " + view.id,
  }));
  const comparisons = renderViews.map((view) => ({
    viewId: view.id,
    renderSha256: view.sha256,
    referenceImageId: "ref-" + view.id,
    referenceSha256: hash("reference:" + view.id),
    comparisonBasis: "same-facade-known",
    outcome: view.id === mismatchView ? "partial" : "match",
    reviewer: "reviewer-01",
    reviewedAt: "2026-10-21T12:00:00Z",
    notes: "Reviewed visible shape and opening rhythm.",
  }));
  const review = {
    schemaVersion: "1.0.0",
    engine: "render-reference-review-v1",
    buildingId: "test-building",
    reviewStatus: mismatchView ? "needs-model-or-reference-correction" : "reviewer-reported-matches",
    valid: true,
    publicationEligible: false,
    provenance: { sourceModelSha256: modelSha, renderManifestSha256: manifestSha },
    referenceImages,
    comparisons,
    warnings: [],
    errors: [],
  };
  const reviewSha = hash(JSON.stringify(review));

  const backlogTask = {
    id: "rrt-example-task",
    buildingId: "test-building",
    kind: "model-correction-review",
    status: "open",
  };
  const backlog = {
    schemaVersion: "1.0.0",
    engine: "render-review-correction-tasks-v1",
    buildingId: "test-building",
    createdFromReviewReportSha256: "d".repeat(64),
    provenance: { sourceModelSha256: oldModelSha, renderManifestSha256: oldManifestSha },
    tasks: [backlogTask],
  };
  const backlogSha = hash(JSON.stringify(backlog));
  const verification = {
    schemaVersion: "1.0.0",
    engine: "render-correction-verification-v1",
    buildingId: "test-building",
    sourceBacklogSha256: backlogSha,
    sourceBacklogReviewReportSha256: backlog.createdFromReviewReportSha256,
    verificationReviewReportSha256: reviewSha,
    provenance: {
      verificationSourceModelSha256: modelSha,
      verificationRenderManifestSha256: manifestSha,
    },
    tasks: [{
      taskId: backlogTask.id,
      status: unverifiedTask ? "needs-more-work" : "verified",
      verified: !unverifiedTask,
    }],
  };
  return {
    input: {
      buildingId: "test-building",
      candidateGlbSha256: modelSha,
      renderManifest: manifest,
      renderManifestSha256: manifestSha,
      geometryQa: {
        schemaVersion: "1.0.0", engine: "glb-geometry-qa-v2",
        status: "basic-geometry-check-passed", valid: true, warnings: geometryWarnings,
      },
      textureQa: {
        schemaVersion: "1.0.0", engine: "glb-texture-binding-qa-v1",
        status: "texture-bindings-structurally-valid", valid: true, errors: [],
        warnings: textureWarnings, counts: { textureContentRiskCount: 0, uvSeamCandidateCount: 0 },
      },
      renderReferenceReview: review,
      correctionTaskBacklog: backlog,
      correctionVerification: verification,
    },
    review,
    backlog,
    verification,
  };
}

test("clean evidence is ready for final human review but never publication-eligible", () => {
  const { input } = fixture();
  const result = buildBuildingReleaseReadiness(input);
  assert.equal(result.engine, "building-release-readiness-gate-v1");
  assert.equal(result.status, "ready-for-final-human-review");
  assert.equal(result.counts.qualifyingReviewedViews, REQUIRED_REVIEW_VIEWS.length);
  assert.equal(result.counts.blockers, 0);
  assert.equal(result.publicationEligible, false);
  assert.equal(result.finalHumanReviewRequired, true);
  assert.equal(result.automationPolicy.assetPublished, false);
});

test("changed candidate GLB cannot reuse render evidence from another model", () => {
  const { input } = fixture();
  const result = buildBuildingReleaseReadiness({ ...input, candidateGlbSha256: "e".repeat(64) });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "rendered-candidate-hash"));
  assert.ok(result.blockers.some((item) => item.id === "reference-review-candidate-hash"));
});

test("partial/mismatch comparison blocks release readiness", () => {
  const { input } = fixture({ mismatchView: "front" });
  const result = buildBuildingReleaseReadiness(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "comparison-outcome:front"));
  assert.ok(result.blockers.some((item) => item.id === "reference-review-status"));
});

test("missing required render view and review coverage are blockers", () => {
  const { input } = fixture({ missingView: "back" });
  const result = buildBuildingReleaseReadiness(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "required-render-view:back"));
  assert.ok(result.blockers.some((item) => item.id === "review-coverage:back"));
});

test("unverified reference rights blocks release readiness", () => {
  const { input } = fixture({ unverifiedRights: "front" });
  const result = buildBuildingReleaseReadiness(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "reference-rights:ref-front"));
});

test("failed QA blocks while non-empty QA warnings require final human review", () => {
  const clean = fixture();
  const failed = buildBuildingReleaseReadiness({
    ...clean.input,
    textureQa: { ...clean.input.textureQa, valid: false, errors: ["broken-texture-binding"] },
  });
  assert.equal(failed.status, "blocked");
  assert.ok(failed.blockers.some((item) => item.id === "texture-qa-valid"));

  const warned = fixture({ geometryWarnings: ["topology-review-recommended"] });
  const result = buildBuildingReleaseReadiness(warned.input);
  assert.equal(result.status, "ready-for-final-human-review-with-warnings");
  assert.equal(result.counts.blockers, 0);
  assert.equal(result.counts.warnings, 1);
});

test("unverified correction tasks block readiness", () => {
  const { input } = fixture({ unverifiedTask: true });
  const result = buildBuildingReleaseReadiness(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "correction-task-verification:rrt-example-task"));
});

test("stale manifest and review/backlog evidence digests are rejected", () => {
  const { input } = fixture();
  const badManifest = buildBuildingReleaseReadiness({
    ...input,
    renderManifestSha256: "f".repeat(64),
  });
  assert.equal(badManifest.status, "blocked");
  assert.ok(badManifest.blockers.some((item) => item.id === "reference-review-manifest-hash"));

  const badReview = buildBuildingReleaseReadiness({
    ...input,
    correctionVerification: {
      ...input.correctionVerification,
      verificationReviewReportSha256: "0".repeat(64),
    },
  });
  assert.equal(badReview.status, "blocked");
  assert.ok(badReview.blockers.some((item) => item.id === "verification-review-digest"));

  const badBacklog = buildBuildingReleaseReadiness({
    ...input,
    correctionVerification: {
      ...input.correctionVerification,
      sourceBacklogSha256: "0".repeat(64),
    },
  });
  assert.equal(badBacklog.status, "blocked");
  assert.ok(badBacklog.blockers.some((item) => item.id === "verification-backlog-digest"));
});

test("unresolved or unrelated verification tasks cannot be silently ignored", () => {
  const { input } = fixture();
  const extra = {
    ...input.correctionVerification,
    tasks: [...input.correctionVerification.tasks, { taskId: "orphan", status: "verified", verified: true }],
  };
  const result = buildBuildingReleaseReadiness({ ...input, correctionVerification: extra });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "verification-task-count"));
  assert.ok(result.blockers.some((item) => item.id === "verification-no-orphan-task:orphan"));
});
