import assert from "node:assert/strict";
import test from "node:test";
import { assessBuildingAccuracyEvidencePack, REQUIRED_RENDER_VIEWS } from "../src/core/building-generation/building-accuracy-evidence-pack.mjs";

const hash = (seed) => seed.toString(16).padStart(64, "0").slice(-64);
const date = "2026-10-24T10:00:00Z";
function building(buildingId, category, overrides = {}) {
  const sourceMedia = ["front", "back", "left", "right"].map((side, index) => ({
    id: buildingId + "-source-" + side, kind: "photo", side, path: "media/" + buildingId + "-" + side + ".jpg",
    sourceId: "source-01", rightsStatus: "verified", rightsEvidenceId: "rights-01", verifiedBy: "reviewer-a", verifiedAt: date,
    bytes: 4000 + index, sha256: hash(index + 1), expectedSha256: hash(index + 1),
  }));
  const referenceImages = ["front", "back", "left", "right"].map((side, index) => ({
    id: buildingId + "-ref-" + side, side, path: "references/" + buildingId + "-" + side + ".jpg",
    sourceId: "reference-source-01", rightsStatus: "verified", rightsEvidenceId: "reference-rights-01",
    verifiedBy: "reviewer-a", verifiedAt: date, bytes: 5000 + index, sha256: hash(index + 20), expectedSha256: hash(index + 20),
  }));
  const modelHash = hash(90);
  const review = {
    valid: true, buildingId, reviewStatus: "reviewer-reported-matches", provenance: { sourceModelSha256: modelHash },
    referenceImages: referenceImages.map(({ id, sha256 }) => ({ id, sha256 })),
    comparisons: REQUIRED_RENDER_VIEWS.map((viewId, index) => ({
      viewId, referenceImageId: referenceImages[index % referenceImages.length].id,
      referenceSha256: referenceImages[index % referenceImages.length].sha256, outcome: "match", reviewer: "reviewer-a",
      reviewedAt: date, notes: "Reviewed " + viewId + " against the independent reference.",
    })),
  };
  const benchmarkReport = { status: "benchmark-passed-review-required", candidateGlbSha256: modelHash,
    checks: ["dimension-reference-provenance", "reference-dimensions-within-tolerance", "ground-control-model-binding",
      "ground-control-residuals-within-tolerance", "render-reference-report-valid",
      "render-reference-candidate-binding", "render-reference-outcomes"].map((id) => ({ id, status: "passed" })) };
  const views = REQUIRED_RENDER_VIEWS.map((id, index) => ({
    id, filename: id + ".png", sha256: hash(index + 50), bytes: 20000 + index, width: 1024, height: 1024, verified: true,
  }));
  const manifestHash = hash(70);
  return {
    buildingId, category, sourceIdentity: { verified: true, sourceId: "official-record-01",
      evidenceDescription: "Matched to a site record.", verifiedBy: "reviewer-a", verifiedAt: date },
    candidate: { path: "models/" + buildingId + ".glb", bytes: 40000, sha256: modelHash, expectedSha256: modelHash,
      geometryQa: { valid: true, status: "basic-geometry-check-passed", warnings: [] } },
    sourceMedia, referenceImages, renderEvidence: { valid: true, modelSha256: modelHash,
      manifestSha256: manifestHash, expectedManifestSha256: manifestHash, views },
    renderReferenceReview: review, benchmarkReport,
    verticalDatum: { status: "verified", sourceId: "vertical-survey-01", sourceDescription: "Documented level datum.",
      verifiedBy: "surveyor-a", verifiedAt: date },
    ...overrides,
  };
}
function pack(buildings = [building("landmark-a", "complex-landmark"), building("house-a", "ordinary-low-rise")]) {
  return { packId: "dhaka-pilot-01", generatedAt: date, candidateCommit: "a1234567", buildings };
}

test("complete two-building pack waits for final release review and never enables publication", () => {
  const result = assessBuildingAccuracyEvidencePack(pack());
  assert.equal(result.status, "benchmark-passed-review-required");
  assert.equal(result.counts.buildings, 2);
  assert.equal(result.accuracyPercent, null);
  assert.equal(result.policy.mapReady, false);
  assert.equal(result.policy.publicationEligible, false);
  assert.equal(result.policy.automaticApproval, false);
});
test("three-building pilot must cover landmark, low-rise and high-rise", () => {
  const three = pack([building("landmark", "complex-landmark"), building("house", "ordinary-low-rise"), building("tower", "ordinary-high-rise")]);
  assert.equal(assessBuildingAccuracyEvidencePack(three).status, "benchmark-passed-review-required");
  three.buildings[2].category = "ordinary-low-rise";
  const result = assessBuildingAccuracyEvidencePack(three);
  assert.equal(result.status, "benchmark-failed");
  assert.ok(result.checks.some((item) => item.id === "representative-category-coverage" && item.status === "failed"));
});
test("un-pinned media hashes and unsolved vertical datum remain incomplete", () => {
  const item = building("landmark", "complex-landmark");
  delete item.sourceMedia[0].expectedSha256;
  item.verticalDatum = { status: "not-solved" };
  const result = assessBuildingAccuracyEvidencePack(pack([item, building("house", "ordinary-low-rise")]));
  assert.equal(result.status, "benchmark-incomplete");
  assert.ok(result.checks.some((entry) => entry.id === "source-media-rights-and-side-coverage" && entry.status === "passed"));
  assert.ok(result.buildings[0].checks.some((entry) => entry.id === "source-media-hash-pins" && entry.status === "warning"));
  assert.ok(result.buildings[0].checks.some((entry) => entry.id === "vertical-datum-evidence" && entry.status === "warning"));
});
test("candidate geometry failure or an explicitly mismatched view fails closed", () => {
  const invalid = building("landmark", "complex-landmark");
  invalid.candidate.geometryQa.valid = false;
  assert.equal(assessBuildingAccuracyEvidencePack(pack([invalid, building("house", "ordinary-low-rise")])).status, "benchmark-failed");
  const mismatch = building("landmark", "complex-landmark");
  mismatch.renderReferenceReview.comparisons[0].outcome = "mismatch";
  assert.equal(assessBuildingAccuracyEvidencePack(pack([mismatch, building("house", "ordinary-low-rise")])).status, "benchmark-failed");
});
test("stale render/model hashes and missing required views block the pack", () => {
  const item = building("landmark", "complex-landmark");
  item.renderEvidence.modelSha256 = hash(999);
  item.renderEvidence.views = item.renderEvidence.views.filter((view) => view.id !== "top");
  const result = assessBuildingAccuracyEvidencePack(pack([item, building("house", "ordinary-low-rise")]));
  assert.equal(result.status, "benchmark-failed");
  assert.ok(result.buildings[0].checks.some((entry) => entry.id === "fixed-camera-render-integrity"));
});
test("missing survey evidence is incomplete rather than a false accuracy pass", () => {
  const item = building("landmark", "complex-landmark");
  item.benchmarkReport.status = "benchmark-incomplete";
  item.verticalDatum = { status: "not-solved" };
  const result = assessBuildingAccuracyEvidencePack(pack([item, building("house", "ordinary-low-rise")]));
  assert.equal(result.status, "benchmark-incomplete");
});
test("rejects wrong pilot size, duplicate ids and invalid timestamps", () => {
  assert.throws(() => assessBuildingAccuracyEvidencePack({ packId: "x", generatedAt: date, buildings: [] }), /2 or 3 buildings/);
  assert.throws(() => assessBuildingAccuracyEvidencePack(pack([building("same", "complex-landmark"), building("same", "ordinary-low-rise")])), /duplicate buildingId/);
  assert.throws(() => assessBuildingAccuracyEvidencePack({ ...pack(), generatedAt: "invalid-date" }), /valid timestamp/);
});
