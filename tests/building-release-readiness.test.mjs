import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";
import { buildBuildingReleaseReadiness } from "../src/core/building-generation/building-release-readiness.mjs";
import { verifyRenderCorrectionTasks } from "../src/core/building-generation/render-correction-verification.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const modelSha = "a".repeat(64);
const oldModelSha = "b".repeat(64);
const oldManifestSha = "c".repeat(64);
const EARTH_RADIUS_M = 6378137;

function makeAccuracyEvidence() {
  const latitudeOrigin = 23.7;
  const longitudeOrigin = 90.4;
  const latitudeOriginRadians = latitudeOrigin * Math.PI / 180;
  const lonLatFromLocal = (east, north) => ({
    longitude: (longitudeOrigin + east / (EARTH_RADIUS_M * Math.cos(latitudeOriginRadians)) * 180 / Math.PI + 540) % 360 - 180,
    latitude: latitudeOrigin + north / EARTH_RADIUS_M * 180 / Math.PI,
  });
  const controlPoints = [[0, 0], [10, 0], [0, 10], [10, 10]].map(([modelX, modelZ], index) => ({
    id: "release-gcp-" + (index + 1),
    modelX,
    modelZ,
    ...lonLatFromLocal(modelX * 2.5 + 100, modelZ * 2.5 + 200),
    evidenceSourceId: "survey-set-2026-01",
  }));
  return {
    generatedAt: "2026-10-21T12:00:00Z",
    dimensionReference: {
      referenceDimensionsM: { x: 10, y: 20, z: 30 },
      metresPerModelUnit: 1,
      tolerancePercent: 1,
      evidence: {
        basis: "surveyed",
        referenceId: "release-survey-2026-01",
        sourceDescription: "Independent test survey dimensions.",
      },
    },
    groundControl: {
      modelCoordinatesGlbSha256: modelSha,
      coordinateEvidenceBasis: "surveyed",
      sourceDescription: "Independent horizontal survey controls in the exact candidate GLB frame.",
      controlPoints,
      maxRmsErrorM: 0.5,
      maxResidualM: 1,
    },
  };
}

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
  const backlogTask = {
    id: "rrt-example-task",
    buildingId: "test-building",
    kind: "model-correction-review",
    priority: "high",
    status: "open",
    title: "Review front facade correction",
    evidence: {
      reviewReportSha256: "d".repeat(64),
      sourceModelSha256: oldModelSha,
      renderManifestSha256: oldManifestSha,
      viewId: unverifiedTask ? "no-such-view" : "front",
      renderFilename: "front.png",
      renderSha256: hash("old-render:front"),
      referenceImageId: "ref-front",
      referenceSha256: hash("reference:front"),
      comparisonBasis: "same-facade-known",
      outcome: "mismatch",
      reviewer: "reviewer-01",
      reviewedAt: "2026-10-21T10:00:00Z",
      notes: "Opening rhythm differs from the reference.",
    },
    reviewChecklist: {
      schemaVersion: "1.0.0",
      correctionProposal: {
        status: "approved",
        proposalText: "Adjust the facade opening rhythm to match the reviewed source images.",
        proposedBy: "modeler-01",
        proposedAt: "2026-10-21T10:15:00Z",
        approval: {
          status: "approved",
          approvedBy: "reviewer-02",
          approvedAt: "2026-10-21T10:30:00Z",
          rationale: "Test fixture records explicit human approval before implementation.",
        },
      },
      implementationEvidence: {
        status: "qa-complete",
        changeSummary: "Updated facade opening rhythm.",
        implementedAt: "2026-10-21T11:00:00Z",
        outputModelSha256: modelSha,
        geometryQaReportSha256: hash("geometry-qa:release-fixture"),
        textureChangeApplicable: false,
        textureQaReportSha256: null,
        generatedRenderManifestSha256: manifestSha,
      },
    },
  };
  const backlog = {
    schemaVersion: "1.0.0",
    engine: "render-review-correction-tasks-v1",
    buildingId: "test-building",
    createdFromReviewReportSha256: "d".repeat(64),
    provenance: { sourceModelSha256: oldModelSha, renderManifestSha256: oldManifestSha },
    tasks: [backlogTask],
  };
  const verification = verifyRenderCorrectionTasks(backlog, review);
  return {
    input: {
      buildingId: "test-building",
      candidateGlbSha256: modelSha,
      renderManifest: manifest,
      renderManifestSha256: manifestSha,
      actualRenderFiles: renderViews.map((view) => ({
        filename: view.filename,
        sha256: view.sha256,
        width: view.width,
        height: view.height,
        bytes: view.bytes,
      })),
      geometryQa: {
        schemaVersion: "1.0.0", engine: "glb-geometry-qa-v2",
        status: "basic-geometry-check-passed", valid: true, warnings: geometryWarnings,
        bounds: { dimensions: [10, 20, 30] }, counts: { vertexCount: 100, triangleCount: 50 },
      },
      textureQa: {
        schemaVersion: "1.0.0", engine: "glb-texture-binding-qa-v1",
        status: "texture-bindings-structurally-valid", valid: true, errors: [],
        warnings: textureWarnings, counts: { textureContentRiskCount: 0, uvSeamCandidateCount: 0 },
      },
      renderReferenceReview: review,
      correctionTaskBacklog: backlog,
      correctionVerification: verification,
      accuracyEvidence: makeAccuracyEvidence(),
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
  assert.equal(result.qaSummary.accuracyBenchmark.status, "benchmark-passed-review-required");
  assert.equal(result.qaSummary.accuracyBenchmark.metrics.georeference.thresholdPass, true);
  assert.equal(result.qaSummary.accuracyBenchmark.metrics.dimensions.maxRelativeErrorPercent, 0);
  assert.ok(result.provenance.accuracyBenchmarkReportSha256);
});

test("dimension mismatch blocks release readiness and retains the benchmark failure", () => {
  const { input } = fixture();
  input.accuracyEvidence.dimensionReference.referenceDimensionsM.x = 13;
  const result = buildBuildingReleaseReadiness(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "accuracy-dimensions-within-tolerance"));
  assert.equal(result.qaSummary.accuracyBenchmark.status, "benchmark-failed");
  assert.equal(result.publicationEligible, false);
});

test("ground-control coordinates must bind to this exact candidate GLB", () => {
  const { input } = fixture();
  input.accuracyEvidence.groundControl.modelCoordinatesGlbSha256 = "f".repeat(64);
  const result = buildBuildingReleaseReadiness(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "accuracy-ground-control-model-binding"));
  assert.ok(result.blockers.some((item) => item.id === "accuracy-benchmark-status"));
});

test("missing ground-control evidence blocks geospatial release readiness", () => {
  const { input } = fixture();
  input.accuracyEvidence.groundControl = null;
  const result = buildBuildingReleaseReadiness(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "accuracy-ground-control-model-binding"));
  assert.equal(result.qaSummary.accuracyBenchmark.status, "benchmark-incomplete");
});

test("missing dimension evidence is a blocker instead of silently assuming a model scale", () => {
  const { input } = fixture();
  input.accuracyEvidence = null;
  const result = buildBuildingReleaseReadiness(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "accuracy-evidence-input"));
  assert.equal(result.qaSummary.accuracyBenchmark, null);
});

test("changed candidate GLB cannot reuse render evidence from another model", () => {
  const { input } = fixture();
  const result = buildBuildingReleaseReadiness({ ...input, candidateGlbSha256: "e".repeat(64) });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "rendered-candidate-hash"));
  assert.ok(result.blockers.some((item) => item.id === "reference-review-candidate-hash"));
});

test("changed render image bytes or dimensions block readiness even when the manifest is unchanged", () => {
  const { input } = fixture();
  const alteredHash = buildBuildingReleaseReadiness({
    ...input,
    actualRenderFiles: input.actualRenderFiles.map((file) =>
      file.filename === "front.png" ? { ...file, sha256: "f".repeat(64) } : file
    ),
  });
  assert.equal(alteredHash.status, "blocked");
  assert.ok(alteredHash.blockers.some((item) => item.id === "render-image-content-hash:front"));

  const alteredDimensions = buildBuildingReleaseReadiness({
    ...input,
    actualRenderFiles: input.actualRenderFiles.map((file) =>
      file.filename === "front.png" ? { ...file, width: file.width + 1 } : file
    ),
  });
  assert.equal(alteredDimensions.status, "blocked");
  assert.ok(alteredDimensions.blockers.some((item) => item.id === "render-image-dimensions:front"));
});

test("duplicate render filenames cannot stand in for separate review views", () => {
  const { input } = fixture();
  const manifest = {
    ...input.renderManifest,
    views: input.renderManifest.views.map((view) =>
      view.id === "back" ? { ...view, filename: "front.png" } : view
    ),
  };
  const result = buildBuildingReleaseReadiness({ ...input, renderManifest: manifest });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "render-view-filename:back"));
  assert.ok(result.blockers.some((item) => item.id === "render-image-content-hash:back"));
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
  assert.ok(badReview.blockers.some((item) => item.id === "verification-report-recomputed"));

  const badBacklog = buildBuildingReleaseReadiness({
    ...input,
    correctionVerification: {
      ...input.correctionVerification,
      sourceBacklogSha256: "0".repeat(64),
    },
  });
  assert.equal(badBacklog.status, "blocked");
  assert.ok(badBacklog.blockers.some((item) => item.id === "verification-report-recomputed"));
});

test("externally altered verification JSON is rejected instead of trusted", () => {
  const { input } = fixture();
  const extra = {
    ...input.correctionVerification,
    tasks: [...input.correctionVerification.tasks, { taskId: "orphan", status: "verified", verified: true }],
  };
  const result = buildBuildingReleaseReadiness({ ...input, correctionVerification: extra });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((item) => item.id === "verification-report-recomputed"));
});
