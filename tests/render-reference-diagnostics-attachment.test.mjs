import assert from "node:assert/strict";
import test from "node:test";
import { buildRenderReferenceReview } from "../src/core/building-generation/render-reference-review.mjs";

const modelSha256 = "a".repeat(64);
const manifestSha256 = "b".repeat(64);
const frontRenderHash = "c".repeat(64);
const backRenderHash = "e".repeat(64);
const referenceHash = "d".repeat(64);

function diagnostic({ renderSha256 = frontRenderHash, referenceSha256 = referenceHash, warnings = [] } = {}) {
  return {
    schemaVersion: "1.0.0",
    engine: "render-image-similarity-diagnostics-v1",
    status: "diagnostics-computed",
    interpretation: warnings.length ? "review-recommended" : "no-screening-warning",
    pair: {
      reference: { filename: "front.jpg", bytes: 300000, sha256: referenceSha256, width: 1600, height: 1200 },
      candidateRender: { filename: "front.png", bytes: 25000, sha256: renderSha256, width: 512, height: 512 },
    },
    comparability: {
      aspectRatioDifferencePercent: 33.333,
      aspectRatioWithinScreeningThreshold: false,
      sameFacadeConfirmedByTool: false,
      cameraPoseAlignmentVerifiedByTool: false,
    },
    metrics: {
      meanAbsoluteError: 10.5,
      rootMeanSquaredError: 22.25,
      psnrDb: 21.184,
      localSsim8x8: 0.83,
      differenceHashHammingDistance: 12,
      referenceEdgePixelCount: 512,
      candidateEdgePixelCount: 450,
      referenceEdgeDensity: 0.1332,
      candidateEdgeDensity: 0.1171,
      edgeDensityAbsoluteDifference: 0.0161,
      referenceMeanGradientMagnitude: 35.2,
      candidateMeanGradientMagnitude: 31.7,
      referenceLaplacianVariance: 500,
      candidateLaplacianVariance: 420,
      candidateToReferenceSharpnessRatio: 0.84,
      referenceEdgeOrientationHistogram: [0.2, 0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1],
      candidateEdgeOrientationHistogram: [0.15, 0.1, 0.1, 0.15, 0.2, 0.1, 0.1, 0.1],
      edgeOrientationHistogramDistance: 0.05,
      referenceSpatialEdgePixelCount: 200,
      candidateSpatialEdgePixelCount: 190,
      referenceSpatialActiveEdgeCellCount: 4,
      candidateSpatialActiveEdgeCellCount: 4,
      referenceSpatialEdgeCoverage: 0.25,
      candidateSpatialEdgeCoverage: 0.25,
      referenceSpatialEdgeDistribution: [0.25, 0.25, 0.25, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      candidateSpatialEdgeDistribution: [0.25, 0.25, 0.25, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      referenceSpatialActiveCells: [true, true, true, true, false, false, false, false, false, false, false, false, false, false, false, false],
      candidateSpatialActiveCells: [true, true, true, true, false, false, false, false, false, false, false, false, false, false, false, false],
      spatialEdgeDistributionDistance: 0,
      activeEdgeCellJaccardDistance: 0,
    },
    warnings,
    policy: {
      automaticMatch: false,
      architecturalAccuracyCertified: false,
      publicationEligible: false,
      mapReady: false,
    },
  };
}
function fixture() {
  return {
    renderManifest: {
      schemaVersion: "1.0.0",
      engine: "building-render-review-manifest-v1",
      status: "render-set-ready-for-human-review",
      valid: true,
      publicationEligible: false,
      modelSha256,
      views: [
        { id: "front", filename: "front.png", sha256: frontRenderHash, width: 512, height: 512, renderComplete: true },
        { id: "back", filename: "back.png", sha256: backRenderHash, width: 512, height: 512, renderComplete: true },
      ],
    },
    renderManifestSha256: manifestSha256,
    reviewInput: {
      schemaVersion: "1.0.0",
      buildingId: "test-building",
      referenceImages: [{
        id: "reference-front-01",
        path: "./references/front.jpg",
        sha256: referenceHash,
        width: 1600,
        height: 1200,
        sourceDescription: "Independent facade photograph",
        rightsStatus: "verified",
        facadeLabel: "front",
        captureHeadingDegrees: 180,
        captureHeadingBasis: "measured",
      }],
      comparisons: [
        {
          viewId: "front",
          referenceImageId: "reference-front-01",
          comparisonBasis: "same-facade-known",
          outcome: "match",
          reviewer: "reviewer-01",
          reviewedAt: "2026-10-21T10:00:00Z",
          notes: "Human review compared the named facade.",
        },
        {
          viewId: "back",
          referenceImageId: "reference-front-01",
          comparisonBasis: "pose-estimated",
          outcome: "match",
          reviewer: "reviewer-02",
          reviewedAt: "2026-10-21T10:01:00Z",
          notes: "Fixture coverage only; real use must select a back reference.",
        },
      ],
    },
    renderFiles: [
      { filename: "front.png", sha256: frontRenderHash, width: 512, height: 512, bytes: 25000 },
      { filename: "back.png", sha256: backRenderHash, width: 512, height: 512, bytes: 26000 },
    ],
    referenceFiles: [{
      id: "reference-front-01", filename: "front.jpg", sha256: referenceHash, width: 1600, height: 1200, bytes: 300000,
    }],
  };
}

test("attaches diagnostic metrics only to the exact verified render/reference pair", () => {
  const input = fixture();
  const report = buildRenderReferenceReview({
    ...input,
    similarityDiagnostics: [{
      viewId: "front",
      referenceImageId: "reference-front-01",
      report: diagnostic(),
      reportSha256: "f".repeat(64),
    }],
  });
  assert.equal(report.valid, true);
  assert.equal(report.reviewStatus, "reviewer-reported-matches");
  assert.equal(report.comparisons[0].outcome, "match");
  assert.equal(report.comparisons[0].similarityDiagnostics.metrics.localSsim8x8, 0.83);
  assert.equal(report.comparisons[0].similarityDiagnostics.metrics.edgeOrientationHistogramDistance, 0.05);
  assert.equal(report.comparisons[0].similarityDiagnostics.metrics.candidateToReferenceSharpnessRatio, 0.84);
  assert.deepEqual(report.comparisons[0].similarityDiagnostics.metrics.referenceEdgeOrientationHistogram,
    [0.2, 0.1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1]);
  assert.equal(report.comparisons[0].similarityDiagnostics.metrics.spatialEdgeDistributionDistance, 0);
  assert.equal(report.comparisons[0].similarityDiagnostics.metrics.activeEdgeCellJaccardDistance, 0);
  assert.equal(report.comparisons[0].similarityDiagnostics.metrics.referenceSpatialEdgeCoverage, 0.25);
  assert.equal(report.comparisons[0].similarityDiagnostics.metrics.referenceSpatialEdgeDistribution.length, 16);
  assert.equal(report.comparisons[0].similarityDiagnostics.renderSha256, frontRenderHash);
  assert.equal(report.comparisons[0].similarityDiagnostics.referenceSha256, referenceHash);
  assert.equal(report.comparisons[0].similarityDiagnostics.automaticMatch, false);
  assert.equal(report.similarityDiagnosticsSummary.count, 1);
  assert.equal(report.publicationEligible, false);
});

test("diagnostic threshold warnings never rewrite reviewer outcome or review status", () => {
  const input = fixture();
  const report = buildRenderReferenceReview({
    ...input,
    similarityDiagnostics: [{
      viewId: "front",
      referenceImageId: "reference-front-01",
      report: diagnostic({ warnings: ["low-grayscale-ssim-screening-hint"] }),
      reportSha256: "f".repeat(64),
    }],
  });
  assert.equal(report.valid, true);
  assert.equal(report.reviewStatus, "reviewer-reported-matches");
  assert.equal(report.comparisons[0].outcome, "match");
  assert.ok(report.warnings.includes("image-similarity-screening-warnings:front:reference-front-01"));
  assert.deepEqual(report.comparisons[0].similarityDiagnostics.warnings, ["low-grayscale-ssim-screening-hint"]);
  assert.equal(report.similarityDiagnosticsSummary.withWarnings, 1);
});

test("rejects a diagnostic report bound to a different render or reference hash", () => {
  const input = fixture();
  const report = buildRenderReferenceReview({
    ...input,
    similarityDiagnostics: [{
      viewId: "front",
      referenceImageId: "reference-front-01",
      report: diagnostic({ renderSha256: "0".repeat(64) }),
      reportSha256: "f".repeat(64),
    }],
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.includes("similarity-diagnostic-render-bytes-mismatch:front"));
  assert.equal(report.comparisons[0].similarityDiagnostics, null);
});

test("rejects malformed metrics, invalid report hashes, duplicates and unknown pairs", () => {
  const input = fixture();
  const badMetric = diagnostic();
  badMetric.metrics.localSsim8x8 = 3;
  const report = buildRenderReferenceReview({
    ...input,
    similarityDiagnostics: [
      { viewId: "front", referenceImageId: "reference-front-01", report: badMetric, reportSha256: "f".repeat(64) },
      { viewId: "front", referenceImageId: "reference-front-01", report: diagnostic(), reportSha256: "f".repeat(64) },
      { viewId: "back", referenceImageId: "unknown-reference", report: diagnostic(), reportSha256: "f".repeat(64) },
      { viewId: "back", referenceImageId: "reference-front-01", report: diagnostic({ renderSha256: backRenderHash }), reportSha256: "bad" },
    ],
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.includes("similarity-diagnostic-metrics-invalid:front:reference-front-01"));
  assert.ok(report.errors.includes("duplicate-similarity-diagnostic:front:reference-front-01"));
  assert.ok(report.errors.includes("similarity-diagnostic-unknown-reference-image:unknown-reference"));
  assert.ok(report.errors.includes("similarity-diagnostic-report-sha256-invalid:back:reference-front-01"));
});

test("rejects malformed edge-structure metrics instead of attaching untrusted values", () => {
  const input = fixture();
  const badMetric = diagnostic();
  badMetric.metrics.edgeOrientationHistogramDistance = 1.25;
  const report = buildRenderReferenceReview({
    ...input,
    similarityDiagnostics: [{
      viewId: "front",
      referenceImageId: "reference-front-01",
      report: badMetric,
      reportSha256: "f".repeat(64),
    }],
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.includes("similarity-diagnostic-metrics-invalid:front:reference-front-01"));
  assert.equal(report.comparisons[0].similarityDiagnostics, null);
});

test("rejects malformed spatial edge-layout evidence and inconsistent derived distances", () => {
  const input = fixture();
  const badMetric = diagnostic();
  badMetric.metrics.referenceSpatialEdgeDistribution = [1.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const report = buildRenderReferenceReview({
    ...input,
    similarityDiagnostics: [{
      viewId: "front",
      referenceImageId: "reference-front-01",
      report: badMetric,
      reportSha256: "f".repeat(64),
    }],
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.includes("similarity-diagnostic-metrics-invalid:front:reference-front-01"));
  assert.equal(report.comparisons[0].similarityDiagnostics, null);
});

test("existing reviews remain valid and report no diagnostic when none is supplied", () => {
  const report = buildRenderReferenceReview(fixture());
  assert.equal(report.valid, true);
  assert.equal(report.similarityDiagnosticsSummary.supplied, false);
  assert.equal(report.similarityDiagnosticsSummary.count, 0);
  assert.equal(report.comparisons[0].similarityDiagnostics, null);
});
