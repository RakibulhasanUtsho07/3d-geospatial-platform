import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assessBuildingCandidateEvidenceManifest,
  normalizeBuildingCandidateEvidenceManifest,
} from "../src/core/building-generation/building-candidate-evidence-manifest.mjs";
import { REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";

const buildingId = "building-a";
const generatedAt = "2026-10-26T12:00:00.000Z";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const modelSha = digest("candidate-glb-bytes");

function artifact(id, type, options = {}) {
  const {
    status = "present",
    purpose,
    side,
    rightsStatus,
    subjectBuildingId = buildingId,
    viewId,
    expectedSha256,
  } = options;
  const value = {
    id,
    type,
    status,
    ...(subjectBuildingId ? { subjectBuildingId } : {}),
    ...(purpose ? { purpose } : {}),
    ...(side ? { side } : {}),
    ...(rightsStatus ? { rightsStatus } : {}),
    ...(viewId ? { viewId } : {}),
  };
  if (status === "present") {
    value.relativePath = "evidence/" + id + (type === "source-image" || type === "reference-image" || type === "render-image" ? ".png" : ".json");
    value.sha256 = id === "candidate-glb" ? modelSha : digest("bytes:" + id);
    value.bytes = 100 + id.length;
    if (expectedSha256) value.expectedSha256 = expectedSha256;
  } else {
    value.reason = "Not supplied in this candidate";
  }
  return value;
}

function fixture() {
  const artifacts = [
    artifact("candidate-glb", "candidate-glb"),
    artifact("building-spec", "building-spec"),
    artifact("generation-report", "generation-report"),
    artifact("generation-config", "generation-config"),
    artifact("capture-manifest", "capture-manifest"),
    artifact("dimensions-survey", "measurement-evidence"),
    artifact("ground-controls", "ground-control-evidence"),
    artifact("render-manifest", "render-manifest"),
    artifact("geometry-qa", "geometry-qa"),
    artifact("texture-qa", "texture-qa"),
    artifact("reference-comparison", "reference-comparison"),
    artifact("accuracy-report", "accuracy-report"),
    artifact("release-readiness-report", "release-readiness-report"),
  ];
  const sides = ["front", "back", "left", "right"];
  const captures = [];
  const references = [];
  const cameras = [];
  for (const side of sides) {
    const captureId = "capture-" + side;
    const referenceId = "reference-" + side;
    const cameraId = "camera-" + side;
    const calibrationId = "calibration-" + side;
    const alignmentId = "alignment-" + side;
    captures.push(captureId);
    references.push(referenceId);
    artifacts.push(artifact(captureId, "source-image", { purpose: "capture", side, rightsStatus: "verified" }));
    artifacts.push(artifact(referenceId, "reference-image", { purpose: "reference", side, rightsStatus: "verified" }));
    artifacts.push(artifact(cameraId, "camera-evidence"));
    artifacts.push(artifact(calibrationId, "camera-calibration"));
    artifacts.push(artifact(alignmentId, "frame-alignment-evidence"));
    cameras.push({
      id: "camera-record-" + side,
      sourceImageArtifactId: captureId,
      cameraArtifactId: cameraId,
      calibrationArtifactId: calibrationId,
      frameAlignmentArtifactId: alignmentId,
      poseStatus: "calibrated",
      calibrationStatus: "verified",
      frameAlignmentStatus: "verified",
    });
  }
  const rendered = REQUIRED_REVIEW_VIEWS.map((viewId) => {
    const id = "render-" + viewId;
    artifacts.push(artifact(id, "render-image", { viewId }));
    return id;
  });
  const input = {
    schemaVersion: "1.0.0",
    manifestId: "candidate-evidence-manifest-a",
    candidateId: "candidate-a-v1",
    buildingId,
    generatedAt,
    candidateCommit: "5ec16ed677019c28c8380362b56de4062c683e4a",
    candidate: {
      glbArtifactId: "candidate-glb",
      buildingSpecArtifactId: "building-spec",
      generationReportArtifactId: "generation-report",
      generator: {
        name: "procedural-glb",
        version: "1.0.0",
        strategy: "procedural-from-building-spec",
        configurationArtifactId: "generation-config",
      },
    },
    artifacts,
    evidence: {
      captureManifest: { status: "verified", artifactId: "capture-manifest" },
      captureArtifactIds: captures,
      referenceArtifactIds: references,
      cameraEvidence: cameras,
      independentDimensions: {
        status: "verified",
        basis: "surveyed",
        artifactId: "dimensions-survey",
        valuesM: { x: 20, y: 12, z: 30 },
        uncertaintyM: { x: 0.1, y: 0.1, z: 0.2 },
      },
      groundControl: {
        status: "verified",
        artifactId: "ground-controls",
        coordinateFrame: "WGS84",
      },
    },
    outputs: {
      renderManifest: {
        status: "ready",
        artifactId: "render-manifest",
        candidateSha256: modelSha,
        requiredViewIds: [...REQUIRED_REVIEW_VIEWS],
        renderViewArtifactIds: rendered,
      },
      geometryQa: { status: "passed", artifactId: "geometry-qa", candidateSha256: modelSha },
      textureQa: { status: "passed", artifactId: "texture-qa", candidateSha256: modelSha },
      referenceComparison: {
        status: "comparable",
        artifactId: "reference-comparison",
        candidateSha256: modelSha,
        comparableViewCount: 4,
        referenceArtifactIds: references,
      },
      accuracyReport: { status: "verified", artifactId: "accuracy-report", candidateSha256: modelSha },
      releaseReadiness: {
        status: "ready-for-final-human-review",
        artifactId: "release-readiness-report",
        candidateSha256: modelSha,
        publicationEligible: false,
      },
    },
    confidence: {
      identity: { status: "observed", evidenceArtifactIds: ["capture-manifest"] },
      dimensions: { status: "measured", evidenceArtifactIds: ["dimensions-survey"] },
      geometry: { status: "observed", evidenceArtifactIds: ["geometry-qa"] },
      facadeLayout: { status: "observed", evidenceArtifactIds: ["capture-front"] },
      appearance: { status: "observed", evidenceArtifactIds: ["reference-front"] },
      georeference: { status: "measured", evidenceArtifactIds: ["ground-controls"] },
    },
  };
  const actualArtifacts = input.artifacts.filter((item) => item.status === "present").map((item) => ({
    id: item.id,
    relativePath: item.relativePath,
    sha256: item.sha256,
    bytes: item.bytes,
  }));
  return { input, actualArtifacts };
}

test("normalizes a shared per-candidate manifest and validates all exact artifact bindings", () => {
  const { input, actualArtifacts } = fixture();
  const manifest = normalizeBuildingCandidateEvidenceManifest(input);
  assert.equal(manifest.engine, "building-candidate-evidence-manifest-v1");
  assert.equal(manifest.candidate.glbArtifactId, "candidate-glb");
  assert.equal(manifest.outputs.renderManifest.renderViewArtifactIds.length, 13);
  assert.equal(manifest.outputs.releaseReadiness.publicationEligible, false);

  const report = assessBuildingCandidateEvidenceManifest(input, { actualArtifacts });
  assert.equal(report.status, "ready-for-review");
  assert.equal(report.evidenceTier, "A");
  assert.equal(report.publicationEligible, false);
  assert.equal(report.counts.failedChecks, 0);
  assert.ok(report.checks.every((check) => check.status === "passed"));
});

test("missing actual-file hashes keep the evidence incomplete rather than verified", () => {
  const { input } = fixture();
  const report = assessBuildingCandidateEvidenceManifest(input);
  assert.equal(report.status, "incomplete");
  assert.notEqual(report.evidenceTier, "A");
  assert.equal(report.publicationEligible, false);
  assert.ok(report.warnings.some((warning) => warning.id === "actual-artifact-bytes-verified"));
});

test("fails closed when a render manifest is bound to a different GLB hash", () => {
  const { input, actualArtifacts } = fixture();
  input.outputs.renderManifest.candidateSha256 = digest("stale-glb");
  const report = assessBuildingCandidateEvidenceManifest(input, { actualArtifacts });
  assert.equal(report.status, "failed");
  assert.ok(report.failures.some((failure) => failure.id === "render-manifest-candidate-binding"));
});

test("fails closed when actual file bytes or actual path differ from the declared artifact", () => {
  const hashMismatch = fixture();
  hashMismatch.actualArtifacts[0].sha256 = digest("changed-file");
  const mismatchReport = assessBuildingCandidateEvidenceManifest(hashMismatch.input, {
    actualArtifacts: hashMismatch.actualArtifacts,
  });
  assert.equal(mismatchReport.status, "failed");
  assert.ok(mismatchReport.failures.some((failure) => failure.id === "artifact-hash-matches:candidate-glb"));

  const pathMismatch = fixture();
  pathMismatch.actualArtifacts[0].relativePath = "stale/candidate.glb";
  const pathReport = assessBuildingCandidateEvidenceManifest(pathMismatch.input, {
    actualArtifacts: pathMismatch.actualArtifacts,
  });
  assert.equal(pathReport.status, "failed");
  assert.ok(pathReport.failures.some((failure) => failure.id === "actual-artifact-list-valid"));
});

test("rejects a verified capture manifest or source image bound to another building", () => {
  const captureMismatch = fixture();
  captureMismatch.input.artifacts.find((item) => item.id === "capture-manifest").subjectBuildingId = "building-b";
  assert.throws(() => normalizeBuildingCandidateEvidenceManifest(captureMismatch.input), /same building/);

  const sourceMismatch = fixture();
  sourceMismatch.input.artifacts.find((item) => item.id === "capture-front").subjectBuildingId = "building-b";
  assert.throws(() => normalizeBuildingCandidateEvidenceManifest(sourceMismatch.input), /for this building/);
});

test("rejects calibrated/verified camera claims when supporting artifacts are missing", () => {
  const cameraMissing = fixture();
  const camera = cameraMissing.input.evidence.cameraEvidence[0];
  cameraMissing.input.artifacts.find((item) => item.id === camera.cameraArtifactId).status = "missing";
  delete cameraMissing.input.artifacts.find((item) => item.id === camera.cameraArtifactId).sha256;
  delete cameraMissing.input.artifacts.find((item) => item.id === camera.cameraArtifactId).bytes;
  delete cameraMissing.input.artifacts.find((item) => item.id === camera.cameraArtifactId).relativePath;
  assert.throws(() => normalizeBuildingCandidateEvidenceManifest(cameraMissing.input), /present camera artifact/);

  const calibrationMissing = fixture();
  const calibration = calibrationMissing.input.evidence.cameraEvidence[0];
  const item = calibrationMissing.input.artifacts.find((artifact) => artifact.id === calibration.calibrationArtifactId);
  item.status = "missing";
  delete item.sha256;
  delete item.bytes;
  delete item.relativePath;
  assert.throws(() => normalizeBuildingCandidateEvidenceManifest(calibrationMissing.input), /present calibration artifact/);
});

test("does not label an evidence tier A when any capture lacks a camera record or frame alignment is only estimated", () => {
  const uncovered = fixture();
  uncovered.input.evidence.cameraEvidence.pop();
  const uncoveredReport = assessBuildingCandidateEvidenceManifest(uncovered.input, { actualArtifacts: uncovered.actualArtifacts });
  assert.notEqual(uncoveredReport.evidenceTier, "A");
  assert.equal(uncoveredReport.status, "incomplete");

  const estimatedAlignment = fixture();
  estimatedAlignment.input.evidence.cameraEvidence[0].frameAlignmentStatus = "estimated";
  const estimatedReport = assessBuildingCandidateEvidenceManifest(estimatedAlignment.input, { actualArtifacts: estimatedAlignment.actualArtifacts });
  assert.equal(estimatedReport.evidenceTier, "B");
  assert.equal(estimatedReport.publicationEligible, false);
});

test("a capture manifest or accuracy report explicitly marked failed blocks the candidate", () => {
  const captureFailed = fixture();
  captureFailed.input.evidence.captureManifest.status = "failed";
  const captureReport = assessBuildingCandidateEvidenceManifest(captureFailed.input, { actualArtifacts: captureFailed.actualArtifacts });
  assert.equal(captureReport.status, "failed");
  assert.ok(captureReport.failures.some((failure) => failure.id === "capture-manifest-declared-not-failed"));

  const accuracyFailed = fixture();
  accuracyFailed.input.outputs.accuracyReport.status = "failed";
  const accuracyReport = assessBuildingCandidateEvidenceManifest(accuracyFailed.input, { actualArtifacts: accuracyFailed.actualArtifacts });
  assert.equal(accuracyReport.status, "failed");
  assert.ok(accuracyReport.failures.some((failure) => failure.id === "accuracy-report-not-failed"));
});

test("rejects unsafe paths, duplicate artifacts, unknown confidence references and unpinned dimensions", () => {
  const unsafe = fixture();
  unsafe.input.artifacts.find((item) => item.id === "candidate-glb").relativePath = "../outside.glb";
  assert.throws(() => normalizeBuildingCandidateEvidenceManifest(unsafe.input), /safe project-relative path/);

  const duplicate = fixture();
  duplicate.input.artifacts.push({ ...duplicate.input.artifacts[0], id: "candidate-glb-copy" });
  assert.throws(() => normalizeBuildingCandidateEvidenceManifest(duplicate.input), /duplicate IDs/);

  const unknownConfidence = fixture();
  unknownConfidence.input.confidence.appearance.evidenceArtifactIds = ["unknown-artifact"];
  assert.throws(() => normalizeBuildingCandidateEvidenceManifest(unknownConfidence.input), /unknown artifact/);

  const unmeasured = fixture();
  unmeasured.input.evidence.independentDimensions.status = "estimated";
  unmeasured.input.evidence.independentDimensions.basis = "operator-estimate";
  unmeasured.input.confidence.dimensions.status = "inferred";
  const report = assessBuildingCandidateEvidenceManifest(unmeasured.input, { actualArtifacts: unmeasured.actualArtifacts });
  assert.equal(report.status, "incomplete");
  assert.ok(report.warnings.some((warning) => warning.id === "independent-dimensions"));
});

test("publication eligibility cannot be enabled by the candidate evidence manifest", () => {
  const { input, actualArtifacts } = fixture();
  input.outputs.releaseReadiness.publicationEligible = true;
  const report = assessBuildingCandidateEvidenceManifest(input, { actualArtifacts });
  assert.equal(report.status, "failed");
  assert.equal(report.publicationEligible, false);
  assert.ok(report.failures.some((failure) => failure.id === "publication-disabled"));
});

test("rejects a measured-dimensions confidence label when only estimated dimensions are supplied", () => {
  const inconsistent = fixture();
  inconsistent.input.evidence.independentDimensions.status = "estimated";
  inconsistent.input.evidence.independentDimensions.basis = "operator-estimate";
  const report = assessBuildingCandidateEvidenceManifest(inconsistent.input, { actualArtifacts: inconsistent.actualArtifacts });
  assert.equal(report.status, "failed");
  assert.ok(report.failures.some((failure) => failure.id === "measured-dimensions-not-overstated"));
});
