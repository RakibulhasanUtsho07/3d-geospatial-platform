import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";
import { buildBuildingReviewPackageManifest } from "../src/core/building-generation/building-review-package.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function fixture({ blocked = false, invalidRights = null, missingView = null, badDigest = false } = {}) {
  const manifestDigest = hash("render-manifest");
  const reviewDigest = hash("reference-review");
  const backlogDigest = hash("correction-backlog");
  const verificationDigest = hash("correction-verification");
  const geometryDigest = hash("geometry-qa");
  const textureDigest = hash("texture-qa");
  const readiness = {
    schemaVersion: "1.0.0",
    engine: "building-release-readiness-gate-v1",
    buildingId: "test-building",
    status: blocked ? "blocked" : "ready-for-final-human-review",
    candidateGlbSha256: hash("candidate-glb"),
    finalHumanReviewRequired: true,
    publicationEligible: false,
    counts: { blockers: 0, warnings: 0 },
    provenance: {
      candidateGlbSha256: hash("candidate-glb"),
      renderManifestSha256: manifestDigest,
      renderReferenceReviewSha256: reviewDigest,
      correctionTaskBacklogSha256: backlogDigest,
      correctionVerificationReportSha256: verificationDigest,
      geometryQaReportSha256: geometryDigest,
      textureQaReportSha256: badDigest ? "0".repeat(64) : textureDigest,
    },
  };
  const artifacts = [
    { artifactType: "candidate-glb", relativePath: "model/candidate.glb", sha256: hash("candidate-glb"), bytes: 1000 },
    { artifactType: "geometry-qa", relativePath: "reports/geometry-qa.json", sha256: hash("geometry-file"), contentDigest: geometryDigest, bytes: 200 },
    { artifactType: "texture-qa", relativePath: "reports/texture-qa.json", sha256: hash("texture-file"), contentDigest: textureDigest, bytes: 200 },
    { artifactType: "render-manifest", relativePath: "renders/render-review-manifest.json", sha256: manifestDigest, contentDigest: hash("render-manifest-semantic"), bytes: 300 },
    { artifactType: "render-reference-review", relativePath: "reports/render-reference-review.json", sha256: hash("review-file"), contentDigest: reviewDigest, bytes: 300 },
    { artifactType: "correction-task-backlog", relativePath: "reports/correction-tasks.json", sha256: hash("backlog-file"), contentDigest: backlogDigest, bytes: 300 },
    { artifactType: "correction-verification", relativePath: "reports/correction-verification.json", sha256: hash("verification-file"), contentDigest: verificationDigest, bytes: 300 },
    { artifactType: "release-readiness-report", relativePath: "reports/release-readiness.json", sha256: hash("readiness-file"), contentDigest: hash(JSON.stringify(readiness)), bytes: 300 },
  ];
  for (const viewId of REQUIRED_REVIEW_VIEWS) {
    if (viewId === missingView) continue;
    const data = { artifactType: "render-image", relativePath: "renders/" + viewId + ".png", sha256: hash("render:" + viewId), viewId, width: 512, height: 512, bytes: 5120 };
    artifacts.push(data);
  }
  artifacts.push({
    artifactType: "reference-image",
    relativePath: "references/front.png",
    sha256: hash("reference:front"),
    referenceImageId: "ref-front",
    rightsStatus: invalidRights ? "pending" : "verified",
    width: 512,
    height: 512,
    bytes: 4096,
  });
  return { readiness, artifacts, renderManifestViews: artifacts.filter((item) => item.artifactType === "render-image").map((item) => ({ id: item.viewId, sha256: item.sha256, width: item.width, height: item.height })) };
}

test("creates a review-only package manifest when all required evidence types exist", () => {
  const { readiness, artifacts, renderManifestViews } = fixture();
  const result = buildBuildingReviewPackageManifest({ buildingId: "test-building", readinessReport: readiness, artifacts, renderManifestViews, generatedAt: "2026-10-21T12:00:00Z" });
  assert.equal(result.engine, "building-review-package-v1");
  assert.equal(result.packagePurpose, "final-human-release-review");
  assert.equal(result.readiness.status, "ready-for-final-human-review");
  assert.equal(result.counts.renderImages, REQUIRED_REVIEW_VIEWS.length);
  assert.equal(result.counts.artifacts, artifacts.length);
  assert.equal(result.policy.publicationEligible, false);
  assert.equal(result.policy.finalHumanReviewRequired, true);
});

test("refuses to package a blocked release candidate", () => {
  const { readiness, artifacts } = fixture({ blocked: true });
  assert.throws(() => buildBuildingReviewPackageManifest({ buildingId: "test-building", readinessReport: readiness, artifacts, renderManifestViews: fixture().renderManifestViews }), /blocked-release-candidate/);
});

test("refuses reference images with unverified rights", () => {
  const { readiness, artifacts, renderManifestViews } = fixture({ invalidRights: "front" });
  assert.throws(() => buildBuildingReviewPackageManifest({ buildingId: "test-building", readinessReport: readiness, artifacts, renderManifestViews }), /reference-image-invalid-or-rights-unverified/);
});

test("requires all predefined render views", () => {
  const { readiness, artifacts, renderManifestViews } = fixture({ missingView: "back" });
  assert.throws(() => buildBuildingReviewPackageManifest({ buildingId: "test-building", readinessReport: readiness, artifacts, renderManifestViews }), /required-render-view-missing:back/);
});

test("rejects unsafe relative paths and duplicate artifact paths", () => {
  const first = fixture();
  first.artifacts[0].relativePath = "../outside.glb";
  assert.throws(() => buildBuildingReviewPackageManifest({ buildingId: "test-building", readinessReport: first.readiness, artifacts: first.artifacts, renderManifestViews: first.renderManifestViews }), /artifact-invalid/);

  const second = fixture();
  second.artifacts.push({ ...second.artifacts[0], artifactType: "extra", relativePath: second.artifacts[0].relativePath });
  assert.throws(() => buildBuildingReviewPackageManifest({ buildingId: "test-building", readinessReport: second.readiness, artifacts: second.artifacts, renderManifestViews: second.renderManifestViews }), /duplicate-path/);
});

test("rejects evidence digest mismatch instead of creating a misleading package index", () => {
  const { readiness, artifacts, renderManifestViews } = fixture({ badDigest: true });
  assert.throws(() => buildBuildingReviewPackageManifest({ buildingId: "test-building", readinessReport: readiness, artifacts, renderManifestViews }), /evidence-digest-mismatch:texture-qa/);
});
