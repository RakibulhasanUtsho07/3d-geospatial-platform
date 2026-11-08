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
  const accuracyDigest = hash("accuracy-evidence");
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
      accuracyEvidenceSha256: accuracyDigest,
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
    { artifactType: "accuracy-evidence", relativePath: "reports/accuracy-evidence.json", sha256: hash("accuracy-file"), contentDigest: accuracyDigest, bytes: 300 },
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


test("binds the complete D3M-08 georeference evidence group to the exact review candidate", () => {
  const { readiness, artifacts, renderManifestViews } = fixture();
  const candidateHash = artifacts.find((item) => item.artifactType === "candidate-glb").sha256;
  const evidenceBodies = [
    ["single-image-smoke-report", "reports/single-image-runtime-smoke.json", "smoke-report"],
    ["single-image-generation-artifact-receipt", "reports/single-image-generation-artifact-receipt.json", "generation-receipt"],
    ["single-image-workflow-report", "reports/single-image-workflow-report.json", "workflow-report"],
    ["single-image-control-point-manifest", "evidence/single-image-control-points.json", "control-point-manifest"],
  ];
  const hashes = {};
  for (const [artifactType, relativePath, body] of evidenceBodies) {
    const bytes = Buffer.from(body);
    const digest = hash(bytes);
    hashes[artifactType] = digest;
    artifacts.push({ artifactType, relativePath, sha256: digest, bytes: bytes.length });
  }
  const singleImageEvidence = {
    schemaVersion: "1.0.0",
    jobId: "smoke-job-1",
    buildingId: "test-building",
    sourceId: "front-image",
    sourceSha256: hash("source-image"),
    candidateGlbSha256: candidateHash,
    georeferenceStatus: "calibrated-needs-human-review",
    controlPointManifestSha256: hashes["single-image-control-point-manifest"],
    smokeReportSha256: hashes["single-image-smoke-report"],
    generationArtifactReceiptSha256: hashes["single-image-generation-artifact-receipt"],
    workflowReportSha256: hashes["single-image-workflow-report"],
    verticalDatum: "not-solved",
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    files: evidenceBodies,
  };
  const result = buildBuildingReviewPackageManifest({
    buildingId: "test-building",
    readinessReport: readiness,
    artifacts,
    renderManifestViews,
    singleImageEvidence,
    generatedAt: "2026-10-21T12:00:00Z",
  });
  assert.equal(result.singleImageEvidence.jobId, "smoke-job-1");
  assert.equal(result.singleImageEvidence.candidateGlbSha256, candidateHash);
  assert.equal(result.singleImageEvidence.publicationEligible, false);
  assert.equal(Object.hasOwn(result.singleImageEvidence, "files"), false);
});

test("rejects partial, unbound or non-reviewable D3M-08 evidence groups", () => {
  const partial = fixture();
  partial.artifacts.push({
    artifactType: "single-image-smoke-report",
    relativePath: "reports/single-image-runtime-smoke.json",
    sha256: hash("smoke-report"),
    bytes: 12,
  });
  assert.throws(() => buildBuildingReviewPackageManifest({
    buildingId: "test-building",
    readinessReport: partial.readiness,
    artifacts: partial.artifacts,
    renderManifestViews: partial.renderManifestViews,
  }), /metadata-missing/);

  const invalid = fixture();
  const evidence = {
    schemaVersion: "1.0.0",
    jobId: "smoke-job-1",
    buildingId: "test-building",
    sourceId: "front-image",
    sourceSha256: hash("source-image"),
    candidateGlbSha256: hash("different-candidate"),
    georeferenceStatus: "calibrated-needs-human-review",
    controlPointManifestSha256: hash("manifest"),
    smokeReportSha256: hash("smoke"),
    generationArtifactReceiptSha256: hash("receipt"),
    workflowReportSha256: hash("workflow"),
    verticalDatum: "not-solved",
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
  };
  assert.throws(() => buildBuildingReviewPackageManifest({
    buildingId: "test-building",
    readinessReport: invalid.readiness,
    artifacts: invalid.artifacts,
    renderManifestViews: invalid.renderManifestViews,
    singleImageEvidence: evidence,
  }), /single-image-evidence-metadata-invalid/);
});


test("binds the optional EPSG:4979 ellipsoidal-height summary to the same single-image package group", () => {
  const { readiness, artifacts, renderManifestViews } = fixture();
  const candidateHash = artifacts.find((item) => item.artifactType === "candidate-glb").sha256;
  const evidenceBodies = [
    ["single-image-smoke-report", "reports/single-image-runtime-smoke.json", "smoke-report"],
    ["single-image-generation-artifact-receipt", "reports/single-image-generation-artifact-receipt.json", "generation-receipt"],
    ["single-image-workflow-report", "reports/single-image-workflow-report.json", "workflow-report"],
    ["single-image-control-point-manifest", "evidence/single-image-control-points.json", "control-point-manifest"],
  ];
  const hashes = {};
  for (const [artifactType, relativePath, body] of evidenceBodies) {
    const bytes = Buffer.from(body);
    hashes[artifactType] = hash(bytes);
    artifacts.push({ artifactType, relativePath, sha256: hashes[artifactType], bytes: bytes.length });
  }
  const singleImageEvidence = {
    schemaVersion: "1.1.0",
    jobId: "smoke-job-vertical",
    buildingId: "test-building",
    sourceId: "front-image",
    sourceSha256: hash("source-image"),
    candidateGlbSha256: candidateHash,
    georeferenceStatus: "calibrated-needs-human-review",
    controlPointManifestSha256: hashes["single-image-control-point-manifest"],
    smokeReportSha256: hashes["single-image-smoke-report"],
    generationArtifactReceiptSha256: hashes["single-image-generation-artifact-receipt"],
    workflowReportSha256: hashes["single-image-workflow-report"],
    verticalDatum: "EPSG:4979-ellipsoidal",
    verticalStatus: "calibrated-needs-human-review",
    verticalEvidenceSha256: hash("canonical-vertical-evidence"),
    verticalReferenceFrame: "WGS 84 (G2139)",
    verticalCoordinateEpoch: 2022.25,
    verticalHeightOffsetM: 135.5,
    verticalRmsErrorM: 0.025,
    verticalMaxResidualM: 0.041,
    verticalControlPointCount: 4,
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    files: evidenceBodies,
  };
  const result = buildBuildingReviewPackageManifest({
    buildingId: "test-building", readinessReport: readiness, artifacts,
    renderManifestViews, singleImageEvidence, generatedAt: "2026-10-21T12:00:00Z",
  });
  assert.equal(result.singleImageEvidence.verticalDatum, "EPSG:4979-ellipsoidal");
  assert.equal(result.singleImageEvidence.verticalReferenceFrame, "WGS 84 (G2139)");
  assert.equal(result.singleImageEvidence.verticalCoordinateEpoch, 2022.25);
  assert.equal(result.singleImageEvidence.verticalHeightOffsetM, 135.5);
  assert.equal(result.singleImageEvidence.verticalControlPointCount, 4);
  assert.equal(result.singleImageEvidence.publicationEligible, false);
});

test("rejects ellipsoidal metadata without the complete vertical-evidence digest binding", () => {
  const { readiness, artifacts, renderManifestViews } = fixture();
  const evidence = {
    schemaVersion: "1.1.0",
    jobId: "smoke-job-vertical",
    buildingId: "test-building",
    sourceId: "front-image",
    sourceSha256: hash("source-image"),
    candidateGlbSha256: hash("candidate-glb"),
    georeferenceStatus: "calibrated-needs-human-review",
    controlPointManifestSha256: hash("manifest"),
    smokeReportSha256: hash("smoke"),
    generationArtifactReceiptSha256: hash("receipt"),
    workflowReportSha256: hash("workflow"),
    verticalDatum: "EGM96-orthometric",
    verticalStatus: "calibrated-needs-human-review",
    verticalReferenceFrame: "WGS 84 (G2139)",
    verticalCoordinateEpoch: 2022.25,
    verticalHeightOffsetM: 135.5,
    verticalRmsErrorM: 0.025,
    verticalMaxResidualM: 0.041,
    verticalControlPointCount: 4,
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
  };
  assert.throws(() => buildBuildingReviewPackageManifest({
    buildingId: "test-building", readinessReport: readiness, artifacts,
    renderManifestViews, singleImageEvidence: evidence,
  }), /single-image-evidence-metadata-invalid/);
});


test("binds independent held-out 3D checkpoint metrics to the single-image review package", () => {
  const { readiness, artifacts, renderManifestViews } = fixture();
  const candidateHash = artifacts.find((item) => item.artifactType === "candidate-glb").sha256;
  const evidenceBodies = [
    ["single-image-smoke-report", "reports/single-image-runtime-smoke.json", "smoke-report"],
    ["single-image-generation-artifact-receipt", "reports/single-image-generation-artifact-receipt.json", "generation-receipt"],
    ["single-image-workflow-report", "reports/single-image-workflow-report.json", "workflow-report"],
    ["single-image-control-point-manifest", "evidence/single-image-control-points.json", "control-point-manifest"],
  ];
  const hashes = {};
  for (const [artifactType, relativePath, body] of evidenceBodies) {
    const bytes = Buffer.from(body);
    hashes[artifactType] = hash(bytes);
    artifacts.push({ artifactType, relativePath, sha256: hashes[artifactType], bytes: bytes.length });
  }
  const singleImageEvidence = {
    schemaVersion: "1.2.0",
    jobId: "smoke-job-checkpoints",
    buildingId: "test-building",
    sourceId: "front-image",
    sourceSha256: hash("source-image"),
    candidateGlbSha256: candidateHash,
    georeferenceStatus: "calibrated-needs-human-review",
    controlPointManifestSha256: hashes["single-image-control-point-manifest"],
    smokeReportSha256: hashes["single-image-smoke-report"],
    generationArtifactReceiptSha256: hashes["single-image-generation-artifact-receipt"],
    workflowReportSha256: hashes["single-image-workflow-report"],
    verticalDatum: "EPSG:4979-ellipsoidal",
    verticalStatus: "calibrated-needs-human-review",
    verticalEvidenceSha256: hash("canonical-vertical-evidence"),
    verticalReferenceFrame: "WGS 84 (G2139)",
    verticalCoordinateEpoch: 2022.25,
    verticalHeightOffsetM: 135.5,
    verticalRmsErrorM: 0.025,
    verticalMaxResidualM: 0.041,
    verticalControlPointCount: 4,
    checkpointValidationStatus: "validated-needs-human-review",
    checkpointEvidenceSha256: hash("canonical-checkpoint-evidence"),
    checkpointReferenceFrame: "WGS 84 (G2139)",
    checkpointCoordinateEpoch: 2022.25,
    checkpointCount: 6,
    checkpointHorizontalRmsErrorM: 0.04,
    checkpointHorizontalMaxResidualM: 0.08,
    checkpointVerticalRmsErrorM: 0.03,
    checkpointVerticalMaxResidualM: 0.07,
    checkpoint3dRmsErrorM: 0.05,
    checkpoint3dMaxResidualM: 0.1,
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    files: evidenceBodies,
  };
  const result = buildBuildingReviewPackageManifest({
    buildingId: "test-building", readinessReport: readiness, artifacts,
    renderManifestViews, singleImageEvidence,
    generatedAt: "2026-10-21T12:00:00Z",
  });
  assert.equal(result.singleImageEvidence.schemaVersion, "1.2.0");
  assert.equal(result.singleImageEvidence.checkpointCount, 6);
  assert.equal(result.singleImageEvidence.checkpointValidationStatus, "validated-needs-human-review");
  assert.equal(result.singleImageEvidence.checkpointEvidenceSha256, hash("canonical-checkpoint-evidence"));
  assert.equal(result.singleImageEvidence.checkpoint3dRmsErrorM, 0.05);
  assert.equal(result.singleImageEvidence.mapReady, false);
  assert.equal(result.singleImageEvidence.publicationEligible, false);
  assert.equal(result.singleImageEvidence.automaticApproval, false);
});

test("rejects missing or under-count held-out 3D checkpoint metadata", () => {
  const { readiness, artifacts, renderManifestViews } = fixture();
  const evidence = {
    schemaVersion: "1.2.0",
    jobId: "smoke-job-checkpoints",
    buildingId: "test-building",
    sourceId: "front-image",
    sourceSha256: hash("source-image"),
    candidateGlbSha256: artifacts.find((item) => item.artifactType === "candidate-glb").sha256,
    georeferenceStatus: "calibrated-needs-human-review",
    controlPointManifestSha256: hash("manifest"),
    smokeReportSha256: hash("smoke"),
    generationArtifactReceiptSha256: hash("receipt"),
    workflowReportSha256: hash("workflow"),
    verticalDatum: "EPSG:4979-ellipsoidal",
    verticalStatus: "calibrated-needs-human-review",
    verticalEvidenceSha256: hash("vertical-evidence"),
    verticalReferenceFrame: "WGS 84 (G2139)",
    verticalCoordinateEpoch: 2022.25,
    verticalHeightOffsetM: 135.5,
    verticalRmsErrorM: 0.025,
    verticalMaxResidualM: 0.041,
    verticalControlPointCount: 4,
    checkpointValidationStatus: "validated-needs-human-review",
    checkpointEvidenceSha256: hash("checkpoint-evidence"),
    checkpointReferenceFrame: "WGS 84 (G2139)",
    checkpointCoordinateEpoch: 2022.25,
    checkpointCount: 5,
    checkpointHorizontalRmsErrorM: 0.04,
    checkpointHorizontalMaxResidualM: 0.08,
    checkpointVerticalRmsErrorM: 0.03,
    checkpointVerticalMaxResidualM: 0.07,
    checkpoint3dRmsErrorM: 0.05,
    checkpoint3dMaxResidualM: 0.1,
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
  };
  assert.throws(() => buildBuildingReviewPackageManifest({
    buildingId: "test-building", readinessReport: readiness, artifacts,
    renderManifestViews, singleImageEvidence: evidence,
  }), /single-image-evidence-metadata-invalid/);
});
