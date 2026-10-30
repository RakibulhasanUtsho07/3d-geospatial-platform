import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MODEL_TO_EVALUATION, createBuildingGlb, surveyGeometryDocument } from "./fixtures/glb-geometry-fixture.mjs";
import {
  CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS,
  createOrResumeReconstructionJob,
  fingerprintStageInput,
  startReconstructionStage,
  completeReconstructionStage,
} from "../src/core/building-generation/reconstruction-job-state.mjs";
import {
  canonicalSourceBoundReviewSubmissionBytes,
  parseTrustedReconstructionReviewerKeys,
  prepareSourceBoundGeometryReview,
  recordSourceBoundAuthenticatedReview,
} from "../src/core/building-generation/source-bound-authenticated-review.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runnerSource = fileURLToPath(new URL("../scripts/run-brf25-geometry-validation.mjs", import.meta.url));


async function createReviewReceipt(workspaceRoot, { decision = "continue-to-independent-validation" } = {}) {
  const buildingId = "brf25-synthetic-building-01";
  const handoffJobId = "handoff-brf25-synthetic-01";
  const candidateBytes = await readFile(path.join(workspaceRoot, "output/candidate.glb"));
  const candidateSha = hash(candidateBytes);
  await createOrResumeReconstructionJob({
    workspaceRoot,
    buildingId,
    jobId: handoffJobId,
    sourceManifest: {
      schemaVersion: "1.0.0",
      recordType: "source-bound-reconstruction-handoff-source",
      candidateGlbSha256: candidateSha,
      sourceJobId: "brf25-source-job-01",
    },
    config: {
      handoffContractVersion: "1.0.0",
      handoffPrepared: true,
      dispatchAllowed: false,
      groundTruth: false,
      acceptanceEligible: false,
      publicationEligible: false,
      publishable: false,
      mapReady: false,
      automaticApproval: false,
    },
    stageIds: CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS,
    now: "2026-10-30T15:00:00.000Z",
  });

  const handoff = {
    schemaVersion: "1.0.0",
    recordType: "source-bound-reconstruction-handoff",
    handoffId: handoffJobId,
    createdAt: "2026-10-30T15:00:00.000Z",
    buildingId,
    sourceJobId: "brf25-source-job-01",
    disposition: "prepared-for-human-review",
    handoffPrepared: true,
    reviewRequired: true,
    dispatchAllowed: false,
    candidate: {
      path: "output/candidate.glb",
      sha256: candidateSha,
      bytes: candidateBytes.length,
      geometryAccuracyEvaluated: false,
    },
    checks: {
      sourceJobCompleted: true,
      sourceJobArtifactsVerified: true,
      visualBundleHashRecomputed: true,
      reconstructionEvidenceHashRecomputed: true,
      candidateGlbHashRecomputed: true,
      candidateGlbContainerValid: true,
      qaReportHashRecomputed: true,
      qaReportMatchesImmutableSourceArtifact: true,
      visualSourceMatchesSelectedJobView: true,
      exactCandidateHashMatchesEvidenceBundle: true,
      rightsEvidenceCompleteButHumanReviewRequired: true,
      cameraEvidenceStructurallyValidButHumanReviewRequired: true,
      groundControlRegistrationRecomputedButHumanReviewRequired: true,
      verticalDatumResolved: true,
    },
    policy: {
      candidateGeometryValidated: false,
      groundTruth: false,
      acceptanceEligible: false,
      publicationEligible: false,
      publishable: false,
      mapReady: false,
      automaticApproval: false,
      dispatchAllowed: false,
    },
  };

  for (const [index, stageId] of CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS.entries()) {
    const inputFingerprint = fingerprintStageInput({
      stageId,
      inputs: { index, candidateSha },
      parameters: { fixture: "brf25-d3m01e-review-gate" },
    });
    await startReconstructionStage({
      workspaceRoot,
      buildingId,
      jobId: handoffJobId,
      stageId,
      inputFingerprint,
      now: "2026-10-30T15:01:00.000Z",
    });
    await completeReconstructionStage({
      workspaceRoot,
      buildingId,
      jobId: handoffJobId,
      stageId,
      payload: stageId === "candidate-evidence-handoff"
        ? { handoff }
        : { verificationStatus: "review-ready", candidateGlbSha256: candidateSha },
      outputs: { candidateGlbSha256: candidateSha, reviewOnly: true },
      now: "2026-10-30T15:02:00.000Z",
    });
  }

  const prepared = await prepareSourceBoundGeometryReview({ workspaceRoot, buildingId, handoffJobId });
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const registry = parseTrustedReconstructionReviewerKeys([{ reviewerId: "reviewer-brf25", publicKeyPem }]);
  const checks = {
    rightsUseScope: "verified",
    sameBuildingIdentity: "verified",
    cameraCalibration: "verified",
    groundControlCorrespondence: "verified",
    metricScale: "verified",
    verticalDatum: "verified",
    geometryTopology: "accepted-for-independent-validation",
    sourceCameraComparison: "consistent",
  };
  const submission = {
    ...prepared.submissionTemplate,
    reviewerId: "reviewer-brf25",
    reviewedAtUtc: "2026-10-30T15:05:00.000Z",
    decision,
    checks: decision === "continue-to-independent-validation" ? checks : {
      rightsUseScope: "not-reviewed",
      sameBuildingIdentity: "not-reviewed",
      cameraCalibration: "not-reviewed",
      groundControlCorrespondence: "not-reviewed",
      metricScale: "not-reviewed",
      verticalDatum: "unresolved",
      geometryTopology: "not-reviewed",
      sourceCameraComparison: "not-reviewed",
    },
    notes: "Synthetic CI receipt only; not a real-building review.",
  };
  const signatureBase64 = sign(null, canonicalSourceBoundReviewSubmissionBytes(submission), pair.privateKey).toString("base64");
  const result = await recordSourceBoundAuthenticatedReview({
    workspaceRoot,
    buildingId,
    handoffJobId,
    submission,
    signatureBase64,
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  });
  return {
    buildingId,
    reviewJobId: result.reviewJobId,
    registryJson: JSON.stringify([{ reviewerId: "reviewer-brf25", publicKeyPem }]),
    candidateSha,
  };
}

const copyMap = [
  ["scripts/prepare-independent-building-truth-manifest.mjs", "../scripts/prepare-independent-building-truth-manifest.mjs"],
  ["scripts/evaluate-independent-building-truth.mjs", "../scripts/evaluate-independent-building-truth.mjs"],
  ["src/core/building-generation/glb-geometry-extraction.mjs", "../src/core/building-generation/glb-geometry-extraction.mjs"],
  ["src/core/building-generation/independent-reference-geometry-adapter.mjs", "../src/core/building-generation/independent-reference-geometry-adapter.mjs"],
  ["src/core/building-generation/geometry-extraction-provenance.mjs", "../src/core/building-generation/geometry-extraction-provenance.mjs"],
  ["src/core/building-generation/independent-building-truth-evaluator.mjs", "../src/core/building-generation/independent-building-truth-evaluator.mjs"],
];

async function setup(t, { staleConfigHash = false, reviewDecision = "continue-to-independent-validation" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf25-geometry-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of [
    "scripts", "src/core/building-generation", "evidence", "configs",
    "workspace/output", "workspace/.building-engine/authorizations/building-01",
  ]) await mkdir(path.join(root, dir), { recursive: true });
  for (const [target, source] of copyMap) {
    await writeFile(path.join(root, target), await readFile(fileURLToPath(new URL(source, import.meta.url))));
  }

  const glb = createBuildingGlb();
  const reference = Buffer.from(JSON.stringify(
    surveyGeometryDocument({ coordinateFrameId: "survey-local-frame-v1", localCoordinates: true }), null, 2) + "\n");
  await writeFile(path.join(root, "workspace/output/candidate.glb"), glb);
  await writeFile(path.join(root, "evidence/survey.json"), reference);

  const candidateHash = hash(glb);
  const config = {
    schemaVersion: "1.0.0",
    evaluationId: "brf25-synthetic-test-01",
    buildingId: "brf25-synthetic-building-01",
    generatedAt: "2026-10-27T09:00:00.000Z",
    extractorCommitSha: "1234567890abcdef1234567890abcdef12345678",
    candidate: {
      glbPath: "workspace/output/candidate.glb",
      expectedGlbSha256: staleConfigHash ? hash(Buffer.from("stale")) : candidateHash,
      coordinateFrameId: "test-building-frame-y-up-v1",
      units: "m",
      modelCoordinateFrameId: "synthetic-unit-test-frame",
      modelToEvaluationFrameMatrix4x4: MODEL_TO_EVALUATION,
      checkPointBindings: [
        { id: "survey-check-01", nodeIndex: 1, primitiveIndex: 0, vertexIndex: 0 },
        { id: "survey-check-02", nodeIndex: 1, primitiveIndex: 0, vertexIndex: 1 },
        { id: "survey-check-03", nodeIndex: 1, primitiveIndex: 0, vertexIndex: 6 },
      ],
    },
    reference: {
      sourcePath: "evidence/survey.json",
      expectedSourceSha256: hash(reference),
      sourceCoordinateFrameId: "survey-local-frame-v1",
      sourceToEvaluationFrameMatrix4x4: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 11, 1, 22, 1],
    },
    tolerances: {
      footprintAreaRelativeErrorPercent: 5, footprintBoundaryP95M: 0.1, footprintBoundaryMaxM: 0.2,
      dimensionRelativeErrorPercent: 5, checkPointRmseM: 0.1, checkPointMaxM: 0.2,
      surfaceDistanceP95M: 0.1, surfaceDistanceMaxM: 0.2,
    },
  };
  await writeFile(path.join(root, "configs/evaluation.json"), JSON.stringify(config, null, 2) + "\n");
  const authorization = {
    schemaVersion: "1.0.0",
    recordType: "brf-24-colmap-execution-authorization",
    status: "candidate-generated-requires-review",
    candidateGlbGenerated: true,
    candidateGlb: { sha256: candidateHash, relativePath: "output/candidate.glb", byteSize: glb.byteLength },
    humanDecision: {
      overallDisposition: "continue-to-reconstruction-preflight",
      reviewer: "synthetic-fixture-reviewer",
      sha256: hash(Buffer.from("synthetic-review-only")),
    },
    preflightReport: { sha256: hash(Buffer.from("synthetic-preflight-only")) },
    profile: { sha256: hash(Buffer.from("synthetic-profile-only")) },
    toolchain: { name: "COLMAP", version: "4.2.1", versionRecheckedImmediatelyBeforeRun: true },
    coordinateFrame: { policy: "local-only-unscaled-not-georeferenced", registrationToGps: false },
    scaleCalibration: { status: "not-calibrated" },
    selectedSourceImages: [{ sha256: hash(Buffer.from("view-1")) }, { sha256: hash(Buffer.from("view-2")) }, { sha256: hash(Buffer.from("view-3")) }],
    candidateGeometryValidated: false,
    independentReferenceVerified: false,
    heldOutCheckpointAccuracyVerified: false,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  };
  await writeFile(path.join(root, "workspace/.building-engine/authorizations/building-01/job-01.json"),
    JSON.stringify(authorization, null, 2) + "\n");
  const review = await createReviewReceipt(path.join(root, "workspace"), { decision: reviewDecision });
  return { root, glb, candidateHash, review };
}

function run(root, output = "artifacts/brf25/run-01", review = null) {
  const args = [
    runnerSource,
    "workspace/.building-engine/authorizations/building-01/job-01.json",
    "configs/evaluation.json",
    output,
    "--workspace=workspace",
    "--root=" + root,
  ];
  if (review) args.push("--building-id=" + review.buildingId, "--review-job-id=" + review.reviewJobId);
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON: review?.registryJson ?? "" },
  });
}

test("runs actual-GLB extraction then independent truth evaluation, and stays review-only (synthetic fixture)", async (t) => {
  const { root, candidateHash, review } = await setup(t);
  const result = run(root, "artifacts/brf25/run-01", review);
  assert.equal(result.status, 2, result.stderr + "\n" + result.stdout);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/brf25/run-01/brf25-geometry-validation.json"), "utf8"));
  assert.equal(report.status, "geometry-evaluated-review-required");
  assert.equal(report.binding.candidateGlbSha256, candidateHash);
  assert.equal(report.artifacts.authenticatedReview.decision, "continue-to-independent-validation");
  assert.equal(report.artifacts.authenticatedReview.candidateGlbSha256, candidateHash);
  assert.equal(report.artifacts.authenticatedReview.status, "cryptographically-reverified");
  assert.equal(report.checks.find((item) => item.id === "authenticated-review-receipt").status, "passed");
  assert.equal(report.artifacts.preparedManifest.candidateGlbSha256, candidateHash);
  assert.equal(report.evaluation.status, "benchmark-review-required");
  assert.equal(report.visualReview.status, "pending-human-review");
  assert.equal(report.policy.acceptanceEligible, false);
  assert.equal(report.policy.publicationEligible, false);
  assert.equal(report.policy.mapReady, false);
  assert.equal(report.policy.automaticApproval, false);
  assert.equal(report.artifacts.preparedManifest.extractedHeldOutCheckpointCount, 3);
  const metrics = JSON.parse(await readFile(path.join(root, "artifacts/brf25/run-01/evaluation-report.json"), "utf8"));
  assert.equal(metrics.candidate.glbSha256, candidateHash);
  assert.equal(metrics.metrics.checkPoints.matchedPointCount, 3);
  const prepared = JSON.parse(await readFile(path.join(root, "artifacts/brf25/run-01/prepared-manifest.json"), "utf8"));
  assert.match(prepared.reference.sourceDescription, /Synthetic fixture/);
});

test("blocks stale truth-config candidate hashes before extraction (synthetic fixture)", async (t) => {
  const { root, review } = await setup(t, { staleConfigHash: true });
  const result = run(root, "artifacts/brf25/stale-run", review);
  assert.equal(result.status, 2, result.stderr + "\n" + result.stdout);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/brf25/stale-run/brf25-geometry-validation.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some((item) => item.id === "config-candidate-sha256"));
  await assert.rejects(readFile(path.join(root, "artifacts/brf25/stale-run/prepared-manifest.json")));
});


test("blocks BRF-25 before extraction when no D3M-01.D review receipt is supplied", async (t) => {
  const { root } = await setup(t);
  const result = run(root, "artifacts/brf25/missing-review", null);
  assert.equal(result.status, 2, result.stderr + "\n" + result.stdout);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/brf25/missing-review/brf25-geometry-validation.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some((item) => item.id === "authenticated-review-receipt"));
  await assert.rejects(readFile(path.join(root, "artifacts/brf25/missing-review/prepared-manifest.json")));
  await assert.rejects(readFile(path.join(root, "artifacts/brf25/missing-review/evaluation-report.json")));
});

test("blocks BRF-25 when the current trusted key no longer verifies the stored receipt", async (t) => {
  const { root, review } = await setup(t);
  const replacement = generateKeyPairSync("ed25519");
  const replacementPem = replacement.publicKey.export({ type: "spki", format: "pem" }).toString();
  const rotated = { ...review, registryJson: JSON.stringify([{ reviewerId: "reviewer-brf25", publicKeyPem: replacementPem }]) };
  const result = run(root, "artifacts/brf25/rotated-key", rotated);
  assert.equal(result.status, 2, result.stderr + "\n" + result.stdout);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/brf25/rotated-key/brf25-geometry-validation.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.match(report.blockers.find((item) => item.id === "authenticated-review-receipt").detail, /signature is invalid/);
  await assert.rejects(readFile(path.join(root, "artifacts/brf25/rotated-key/prepared-manifest.json")));
});

test("blocks BRF-25 when a signed non-continue decision is present", async (t) => {
  const { root, review } = await setup(t, { reviewDecision: "hold" });
  const result = run(root, "artifacts/brf25/hold-decision", review);
  assert.equal(result.status, 2, result.stderr + "\n" + result.stdout);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/brf25/hold-decision/brf25-geometry-validation.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.match(report.blockers.find((item) => item.id === "authenticated-review-receipt").detail, /requires a signed continue-to-independent-validation decision/);
  await assert.rejects(readFile(path.join(root, "artifacts/brf25/hold-decision/prepared-manifest.json")));
});
