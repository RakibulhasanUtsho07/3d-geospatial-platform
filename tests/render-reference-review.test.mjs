import assert from "node:assert/strict";
import test from "node:test";
import { buildRenderReferenceReview } from "../src/core/building-generation/render-reference-review.mjs";

const modelSha256 = "a".repeat(64);
const renderManifestSha256 = "b".repeat(64);
const renderHash = "c".repeat(64);
const referenceHash = "d".repeat(64);

function fixture(overrides = {}) {
  const renderManifest = {
    schemaVersion:"1.0.0",
    engine:"building-render-review-manifest-v1",
    status:"render-set-ready-for-human-review",
    valid:true,
    publicationEligible:false,
    modelSha256,
    views:[
      { id:"front", filename:"front.png", sha256:renderHash, width:512, height:512, renderComplete:true },
      { id:"back", filename:"back.png", sha256:"e".repeat(64), width:512, height:512, renderComplete:true },
    ],
  };
  const referenceImages = [{
    id:"reference-front-01",
    path:"./references/front.jpg",
    sha256:referenceHash,
    width:1600,
    height:1200,
    sourceDescription:"Independently supplied front facade photograph",
    sourceUrl:"https://example.org/heritage/front",
    attribution:"Example archive credit",
    rightsStatus:"verified",
    facadeLabel:"front",
    captureHeadingDegrees:180,
    captureHeadingBasis:"measured",
  }];
  const comparisons = [{
    viewId:"front",
    referenceImageId:"reference-front-01",
    comparisonBasis:"same-facade-known",
    outcome:"match",
    reviewer:"reviewer-01",
    reviewedAt:"2026-10-21T10:00:00Z",
    notes:"Facade arrangement visually compared with the supplied reference.",
  }];
  return {
    renderManifest,
    renderManifestSha256,
    reviewInput:{ schemaVersion:"1.0.0", buildingId:"test-building", referenceImages, comparisons, ...overrides.reviewInput },
    renderFiles:[
      { filename:"front.png", sha256:renderHash, width:512, height:512, bytes:25000 },
      { filename:"back.png", sha256:"e".repeat(64), width:512, height:512, bytes:26000 },
    ],
    referenceFiles:[{
      id:"reference-front-01", filename:"front.jpg", sha256:referenceHash, width:1600, height:1200, bytes:300000,
    }],
    ...overrides,
  };
}

test("creates traceable reviewer-reported result without claiming publication eligibility", () => {
  const report = buildRenderReferenceReview(fixture());
  assert.equal(report.valid,true);
  assert.equal(report.reviewStatus,"pending-human-review");
  assert.equal(report.counts.match,1);
  assert.equal(report.counts.viewsWithoutComparisons,1);
  assert.equal(report.publicationEligible,false);
  assert.equal(report.provenance.sourceModelSha256,modelSha256);
  assert.equal(report.comparisons[0].renderSha256,renderHash);
  assert.ok(report.warnings.includes("no-reference-comparison-for-view:back"));
});

test("reports a review as reviewer-reported-matches only when all render views have assessments", () => {
  const data = fixture();
  data.reviewInput.comparisons.push({
    viewId:"back",
    referenceImageId:"reference-front-01",
    comparisonBasis:"same-facade-known",
    outcome:"match",
    reviewer:"reviewer-02",
    reviewedAt:"2026-10-21T11:00:00Z",
    notes:"Back camera render compared against the declared view of this test fixture.",
  });
  const report = buildRenderReferenceReview(data);
  assert.equal(report.valid,true);
  assert.equal(report.reviewStatus,"reviewer-reported-matches");
  assert.equal(report.counts.match,2);
  assert.equal(report.counts.viewsWithoutComparisons,0);
});

test("never allows a match label when the comparison basis is context-only or unknown", () => {
  const data = fixture();
  data.reviewInput.comparisons[0].comparisonBasis = "context-only";
  const report = buildRenderReferenceReview(data);
  assert.equal(report.valid,false);
  assert.ok(report.errors.includes("comparison-match-needs-facade-or-pose-basis:front"));
});

test("reports partial and mismatch assessments as requiring corrective action", () => {
  const data = fixture();
  data.reviewInput.comparisons[0].outcome = "mismatch";
  data.reviewInput.comparisons[0].correctionRequest = "Recheck facade orientation and window spacing.";
  const report = buildRenderReferenceReview(data);
  assert.equal(report.reviewStatus,"needs-model-or-reference-correction");
  assert.ok(report.warnings.includes("reference-mismatch-needs-correction:front"));
  assert.equal(report.comparisons[0].correctionRequest,"Recheck facade orientation and window spacing.");
});

test("checks source image hashes and dimensions against bytes inspected on disk", () => {
  const data = fixture();
  data.referenceFiles[0].sha256 = "0".repeat(64);
  data.referenceFiles[0].width = 800;
  const report = buildRenderReferenceReview(data);
  assert.ok(report.errors.includes("reference-file-sha256-mismatch:reference-front-01"));
  assert.ok(report.errors.includes("reference-file-dimensions-mismatch:reference-front-01"));
  assert.equal(report.reviewStatus,"invalid-review-package");
});

test("detects modified render files using hash and dimension mismatch", () => {
  const data = fixture();
  data.renderFiles[0].sha256 = "0".repeat(64);
  data.renderFiles[0].width = 256;
  const report = buildRenderReferenceReview(data);
  assert.ok(report.errors.includes("render-image-sha256-mismatch:front"));
  assert.ok(report.errors.includes("render-image-dimensions-mismatch:front"));
});

test("requires reviewer identity, timestamp and notes for completed comparisons", () => {
  const data = fixture();
  data.reviewInput.comparisons[0].reviewer = "";
  data.reviewInput.comparisons[0].reviewedAt = "yesterday";
  data.reviewInput.comparisons[0].notes = "";
  const report = buildRenderReferenceReview(data);
  assert.ok(report.errors.includes("comparison-reviewer-missing:front"));
  assert.ok(report.errors.includes("comparison-reviewedAt-invalid:front"));
  assert.ok(report.errors.includes("comparison-notes-required:front"));
});

test("marks pending assessments and unverified rights/camera evidence as warnings", () => {
  const data = fixture();
  data.reviewInput.comparisons[0] = {
    viewId:"front", referenceImageId:"reference-front-01", comparisonBasis:"not-comparable", outcome:"pending",
  };
  data.reviewInput.referenceImages[0].rightsStatus = "pending";
  data.reviewInput.referenceImages[0].captureHeadingBasis = "unknown";
  data.reviewInput.referenceImages[0].facadeLabel = "unknown";
  const report = buildRenderReferenceReview(data);
  assert.equal(report.reviewStatus,"pending-human-review");
  assert.ok(report.warnings.includes("comparison-pending:front:reference-front-01"));
  assert.ok(report.warnings.includes("reference-rights-review-pending:reference-front-01"));
  assert.ok(report.warnings.includes("reference-camera-heading-unverified:reference-front-01"));
});

test("rejects malformed manifest and inconsistent comparison references", () => {
  assert.throws(()=>buildRenderReferenceReview({ ...fixture(), renderManifestSha256:"bad" }),/renderManifestSha256/);
  const data = fixture();
  data.reviewInput.comparisons[0].viewId = "missing-view";
  const report = buildRenderReferenceReview(data);
  assert.ok(report.errors.includes("comparison-unknown-render-view:missing-view"));
});
