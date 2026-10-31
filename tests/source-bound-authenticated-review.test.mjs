import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuildingGlb } from "./fixtures/glb-geometry-fixture.mjs";
import {
  CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS,
  SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS,
  completeReconstructionStage,
  createOrResumeReconstructionJob,
  fingerprintStageInput,
  startReconstructionStage,
} from "../src/core/building-generation/reconstruction-job-state.mjs";
import {
  canonicalSourceBoundReviewSubmissionBytes,
  parseTrustedReconstructionReviewerKeys,
  prepareSourceBoundGeometryReview,
  readSourceBoundAuthenticatedReview,
  recordSourceBoundAuthenticatedReview,
  verifySourceBoundAuthenticatedReviewForIndependentValidation,
} from "../src/core/building-generation/source-bound-authenticated-review.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-bound-human-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeKeys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function makeReviewerRegistry(publicKeyPem, reviewerId = "reviewer-01") {
  return parseTrustedReconstructionReviewerKeys([{ reviewerId, publicKeyPem }]);
}

function makeChecks(overrides = {}) {
  return {
    rightsUseScope: "verified",
    sameBuildingIdentity: "verified",
    cameraCalibration: "verified",
    groundControlCorrespondence: "verified",
    metricScale: "verified",
    verticalDatum: "verified",
    geometryTopology: "accepted-for-independent-validation",
    sourceCameraComparison: "consistent",
    ...overrides,
  };
}

async function createHandoff(root, { glb = createBuildingGlb(), verticalDatumResolved = true } = {}) {
  await mkdir(path.join(root, "candidate"), { recursive: true });
  await writeFile(path.join(root, "candidate/model.glb"), glb);
  const candidateSha = sha(glb);
  const created = await createOrResumeReconstructionJob({
    workspaceRoot: root,
    buildingId: "building-a",
    jobId: "handoff-test-01",
    sourceManifest: {
      schemaVersion: "1.0.0",
      recordType: "source-bound-reconstruction-handoff-source",
      candidateGlbSha256: candidateSha,
      sourceJobId: "source-job-01",
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
    handoffId: "handoff-test-01",
    createdAt: "2026-10-30T15:00:00.000Z",
    buildingId: "building-a",
    sourceJobId: "source-job-01",
    disposition: "prepared-for-human-review",
    handoffPrepared: true,
    reviewRequired: true,
    dispatchAllowed: false,
    candidate: {
      path: "candidate/model.glb",
      sha256: candidateSha,
      bytes: glb.length,
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
      verticalDatumResolved,
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
    const fingerprint = fingerprintStageInput({
      stageId,
      inputs: { index, candidateSha },
      parameters: { testFixture: true },
    });
    await startReconstructionStage({
      workspaceRoot: root,
      buildingId: "building-a",
      jobId: "handoff-test-01",
      stageId,
      inputFingerprint: fingerprint,
      now: "2026-10-30T15:01:00.000Z",
    });
    const payload = stageId === "candidate-evidence-handoff" ? { handoff } : {
      verificationStatus: "review-ready",
      candidateGlbSha256: candidateSha,
    };
    await completeReconstructionStage({
      workspaceRoot: root,
      buildingId: "building-a",
      jobId: "handoff-test-01",
      stageId,
      payload,
      outputs: { candidateGlbSha256: candidateSha, reviewOnly: true },
      now: "2026-10-30T15:02:00.000Z",
    });
  }
  assert.equal(created.resumed, false);
  return { handoff, candidateSha, glb };
}

async function prepareSubmission(root, overrides = {}) {
  const prepared = await prepareSourceBoundGeometryReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
  });
  const submission = {
    ...prepared.submissionTemplate,
    reviewerId: "reviewer-01",
    reviewedAtUtc: "2026-10-30T15:05:00.000Z",
    decision: "continue-to-independent-validation",
    checks: makeChecks(),
    notes: "Synthetic test decision only; not a real-building review.",
    ...overrides,
  };
  return { prepared, submission };
}

function signSubmission(submission, privateKey) {
  const bytes = canonicalSourceBoundReviewSubmissionBytes(submission);
  return sign(null, bytes, privateKey).toString("base64");
}

test("prepares deterministic GLB geometry QA bound to exact hand-off and candidate bytes", async (t) => {
  const root = await workspace(t);
  const { candidateSha, glb } = await createHandoff(root);
  const first = await prepareSourceBoundGeometryReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
  });
  const second = await prepareSourceBoundGeometryReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
  });

  assert.equal(first.candidateSha256, candidateSha);
  assert.equal(first.candidateByteLength, glb.length);
  assert.equal(first.geometryReport.geometryQa.valid, true);
  assert.ok(first.geometryReport.geometryQa.counts.triangleCount > 0);
  assert.equal(first.geometryReport.policy.candidateGeometryValidated, false);
  assert.equal(first.geometryReport.policy.groundTruth, false);
  assert.equal(first.geometryReportSha256, second.geometryReportSha256);
  assert.deepEqual(first.geometryReport, second.geometryReport);
  assert.equal(first.submissionTemplate.geometryReportSha256, first.geometryReportSha256);
});

test("verifies a trusted Ed25519 reviewer and stores an immutable review-only decision job", async (t) => {
  const root = await workspace(t);
  await createHandoff(root);
  const keys = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { prepared, submission } = await prepareSubmission(root);
  const signatureBase64 = signSubmission(submission, keys.privateKey);

  const result = await recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64,
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  });

  assert.equal(result.signatureVerified, true);
  assert.equal(result.reviewerId, "reviewer-01");
  assert.equal(result.geometryReportSha256, prepared.geometryReportSha256);
  assert.equal(result.decision, "continue-to-independent-validation");
  assert.deepEqual(result.job.stageIds, SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS);
  assert.equal(result.decisionRecord.authentication.status, "signature-verified-against-server-trusted-reviewer-key");
  assert.equal(result.decisionRecord.authentication.identityAssurance, "possession-of-server-trusted-private-key-only");
  assert.equal(result.decisionRecord.independentTruth.status, "not-evaluated");
  assert.equal(result.decisionRecord.policy.candidateGeometryValidated, false);
  assert.equal(result.decisionRecord.policy.groundTruth, false);
  assert.equal(result.decisionRecord.policy.acceptanceEligible, false);
  assert.equal(result.decisionRecord.policy.publicationEligible, false);
  assert.equal(result.decisionRecord.policy.mapReady, false);
  assert.equal(result.decisionRecord.policy.automaticApproval, false);
  assert.equal(result.decisionRecord.policy.dispatchAllowed, false);

  const stored = await readSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    reviewJobId: result.reviewJobId,
  });
  assert.equal(stored.decisionRecord.reviewJobId, result.reviewJobId);
  assert.equal(stored.decisionRecord.authentication.signedPayloadSha256, sha(canonicalSourceBoundReviewSubmissionBytes(submission)));
});

test("reuses an identical signed review without overwriting immutable history", async (t) => {
  const root = await workspace(t);
  await createHandoff(root);
  const keys = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { submission } = await prepareSubmission(root);
  const signatureBase64 = signSubmission(submission, keys.privateKey);
  const input = {
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64,
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  };
  const first = await recordSourceBoundAuthenticatedReview(input);
  const second = await recordSourceBoundAuthenticatedReview({ ...input, now: "2026-10-30T15:11:00.000Z" });
  assert.equal(second.reviewJobId, first.reviewJobId);
  assert.equal(second.reused, true);
  assert.equal(second.artifact.contentSha256, first.artifact.contentSha256);
  assert.equal(second.job.stages[1].artifacts.length, 1);
});

test("rejects unknown reviewers, wrong keys and invalid signature payloads", async (t) => {
  const root = await workspace(t);
  await createHandoff(root);
  const keys = makeKeys();
  const otherKeys = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { submission } = await prepareSubmission(root);

  await assert.rejects(recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission: { ...submission, reviewerId: "untrusted-reviewer" },
    signatureBase64: signSubmission({ ...submission, reviewerId: "untrusted-reviewer" }, otherKeys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  }), /not present in the server-configured/);

  await assert.rejects(recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64: signSubmission(submission, otherKeys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  }), /signature is invalid/);

  const tampered = { ...submission, notes: "tampered after signing" };
  await assert.rejects(recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission: tampered,
    signatureBase64: signSubmission(submission, keys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  }), /signature is invalid/);
});

test("rejects private keys, duplicate reviewer IDs, duplicate fingerprints and non-Ed25519 trust keys", () => {
  const keys = makeKeys();
  const other = makeKeys();
  assert.throws(() => parseTrustedReconstructionReviewerKeys("invalid-json"), /valid JSON/);
  assert.throws(() => parseTrustedReconstructionReviewerKeys([]), /1–100 entries/);
  assert.throws(() => parseTrustedReconstructionReviewerKeys([
    { reviewerId: "reviewer-01", publicKeyPem: keys.publicKeyPem },
    { reviewerId: "reviewer-01", publicKeyPem: other.publicKeyPem },
  ]), /IDs must be unique/);
  assert.throws(() => parseTrustedReconstructionReviewerKeys([
    { reviewerId: "reviewer-01", publicKeyPem: keys.publicKeyPem },
    { reviewerId: "reviewer-02", publicKeyPem: keys.publicKeyPem },
  ]), /fingerprints must be unique/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => parseTrustedReconstructionReviewerKeys([{
    reviewerId: "reviewer-rsa",
    publicKeyPem: rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }]), /must use Ed25519/);
  assert.throws(() => parseTrustedReconstructionReviewerKeys([{
    reviewerId: "reviewer-private",
    publicKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }]), /public key PEM/);
});

test("blocks continue decisions until every human check and hand-off evidence blocker is verified", async (t) => {
  const root = await workspace(t);
  await createHandoff(root, { verticalDatumResolved: false });
  const keys = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { submission } = await prepareSubmission(root);
  await assert.rejects(recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission: { ...submission, checks: makeChecks({ verticalDatum: "unresolved" }) },
    signatureBase64: signSubmission({ ...submission, checks: makeChecks({ verticalDatum: "unresolved" }) }, keys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  }), /requires verified decisions/);

  await assert.rejects(recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64: signSubmission(submission, keys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  }), /vertical-datum evidence/);
});

test("allows a signed hold when geometry QA rejects mesh content but never marks it validated", async (t) => {
  const root = await workspace(t);
  const geometryInvalidGlb = createBuildingGlb((gltf) => { gltf.meshes = []; });
  await createHandoff(root, { glb: geometryInvalidGlb });
  const keys = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { prepared, submission } = await prepareSubmission(root, {
    decision: "hold",
    checks: makeChecks({
      rightsUseScope: "not-reviewed",
      sameBuildingIdentity: "not-reviewed",
      cameraCalibration: "not-reviewed",
      groundControlCorrespondence: "not-reviewed",
      metricScale: "not-reviewed",
      verticalDatum: "unresolved",
      geometryTopology: "not-reviewed",
      sourceCameraComparison: "not-reviewed",
    }),
  });
  assert.equal(prepared.geometryReport.geometryStatus, "geometry-qa-failed");
  assert.equal(prepared.geometryReport.geometryQa, null);
  const result = await recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64: signSubmission(submission, keys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  });
  assert.equal(result.decision, "hold");
  assert.equal(result.decisionRecord.geometryQa.valid, false);
  assert.equal(result.decisionRecord.policy.candidateGeometryValidated, false);
});

test("rejects stale candidate bytes and mismatched decision hand-off identities", async (t) => {
  const root = await workspace(t);
  const { glb } = await createHandoff(root);
  const changed = Buffer.from(glb);
  changed[20] ^= 1;
  await writeFile(path.join(root, "candidate/model.glb"), changed);
  await assert.rejects(prepareSourceBoundGeometryReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
  }), /Candidate GLB bytes no longer match/);

  await writeFile(path.join(root, "candidate/model.glb"), glb);
  const keys = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { submission } = await prepareSubmission(root);
  const wrong = { ...submission, handoffArtifactSha256: "0".repeat(64) };
  await assert.rejects(recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission: wrong,
    signatureBase64: signSubmission(wrong, keys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  }), /exact building, hand-off, candidate and geometry report bytes/);
});

test("records changes-requested and reject decisions without release-gate promotion", async (t) => {
  const root = await workspace(t);
  await createHandoff(root);
  const keys = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { submission } = await prepareSubmission(root, {
    decision: "changes-requested",
    checks: makeChecks({
      rightsUseScope: "uncertain",
      sameBuildingIdentity: "uncertain",
      geometryTopology: "changes-required",
      sourceCameraComparison: "mismatched",
    }),
  });
  const result = await recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64: signSubmission(submission, keys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  });
  assert.equal(result.decision, "changes-requested");
  assert.equal(result.decisionRecord.policy.candidateGeometryValidated, false);
  assert.equal(result.decisionRecord.policy.publicationEligible, false);
  assert.equal(result.decisionRecord.policy.mapReady, false);
});


test("re-verifies the immutable signed continue receipt against current trusted keys and exact candidate bytes", async (t) => {
  const root = await workspace(t);
  const { candidateSha } = await createHandoff(root);
  const keys = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { submission } = await prepareSubmission(root);
  const signatureBase64 = signSubmission(submission, keys.privateKey);
  const recorded = await recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64,
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  });

  const verified = await verifySourceBoundAuthenticatedReviewForIndependentValidation({
    workspaceRoot: root,
    buildingId: "building-a",
    reviewJobId: recorded.reviewJobId,
    expectedCandidateGlbSha256: candidateSha,
    trustedReviewerKeys: registry,
  });
  assert.equal(verified.receipt.status, "cryptographically-reverified");
  assert.equal(verified.receipt.decision, "continue-to-independent-validation");
  assert.equal(verified.receipt.candidateGlbSha256, candidateSha);
  assert.equal(verified.receipt.handoffArtifactSha256, recorded.decisionRecord.handoffArtifactSha256);
  assert.equal(verified.receipt.geometryReportSha256, recorded.geometryReportSha256);
  assert.equal(verified.receipt.reviewDecisionArtifactSha256, recorded.artifact.contentSha256);
  assert.equal(verified.receipt.reviewerPublicKeyFingerprintSha256, recorded.decisionRecord.authentication.reviewerPublicKeyFingerprintSha256);
  assert.equal(verified.receipt.acceptanceEligible, false);
  assert.equal(verified.receipt.publicationEligible, false);
  assert.equal(verified.receipt.mapReady, false);
  assert.equal(verified.receipt.automaticApproval, false);
});

test("rejects current-key rotation, wrong candidate, and wrong building when consuming a review receipt", async (t) => {
  const root = await workspace(t);
  const { candidateSha } = await createHandoff(root);
  const keys = makeKeys();
  const replacement = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { submission } = await prepareSubmission(root);
  const recorded = await recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64: signSubmission(submission, keys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  });

  await assert.rejects(verifySourceBoundAuthenticatedReviewForIndependentValidation({
    workspaceRoot: root,
    buildingId: "building-a",
    reviewJobId: recorded.reviewJobId,
    expectedCandidateGlbSha256: candidateSha,
    trustedReviewerKeys: makeReviewerRegistry(replacement.publicKeyPem),
  }), /signature is invalid/);
  await assert.rejects(verifySourceBoundAuthenticatedReviewForIndependentValidation({
    workspaceRoot: root,
    buildingId: "building-a",
    reviewJobId: recorded.reviewJobId,
    expectedCandidateGlbSha256: "f".repeat(64),
    trustedReviewerKeys: registry,
  }), /does not bind the exact BRF-25/);
  await assert.rejects(verifySourceBoundAuthenticatedReviewForIndependentValidation({
    workspaceRoot: root,
    buildingId: "building-b",
    reviewJobId: recorded.reviewJobId,
    expectedCandidateGlbSha256: candidateSha,
    trustedReviewerKeys: registry,
  }), /ENOENT|not a completed authenticated-review decision job|does not bind the exact BRF-25/);
});

test("does not allow hold or changes-requested receipts to authorize BRF-25", async (t) => {
  const root = await workspace(t);
  const { candidateSha } = await createHandoff(root);
  const keys = makeKeys();
  const registry = makeReviewerRegistry(keys.publicKeyPem);
  const { submission } = await prepareSubmission(root, {
    decision: "hold",
    checks: makeChecks({
      rightsUseScope: "not-reviewed",
      sameBuildingIdentity: "not-reviewed",
      cameraCalibration: "not-reviewed",
      groundControlCorrespondence: "not-reviewed",
      metricScale: "not-reviewed",
      verticalDatum: "unresolved",
      geometryTopology: "not-reviewed",
      sourceCameraComparison: "not-reviewed",
    }),
  });
  const recorded = await recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64: signSubmission(submission, keys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-30T15:10:00.000Z",
  });
  await assert.rejects(verifySourceBoundAuthenticatedReviewForIndependentValidation({
    workspaceRoot: root,
    buildingId: "building-a",
    reviewJobId: recorded.reviewJobId,
    expectedCandidateGlbSha256: candidateSha,
    trustedReviewerKeys: registry,
  }), /requires a signed continue-to-independent-validation decision/);
});


test("rejects a reviewer signature timestamp outside the configured key validity window", async (t) => {
  const root = await workspace(t);
  await createHandoff(root);
  const keys = makeKeys();
  const { submission } = await prepareSubmission(root, {
    reviewedAtUtc: "2026-10-30T15:05:00.000Z",
  });
  const registry = parseTrustedReconstructionReviewerKeys({
    schemaVersion: "1.0.0",
    recordType: "reconstruction-trusted-reviewer-key-registry",
    registryId: "production-reviewers-test",
    issuedAtUtc: "2026-10-31T03:00:00.000Z",
    expiresAtUtc: "2026-11-30T03:00:00.000Z",
    entries: [{
      reviewerId: "reviewer-01",
      keyId: "key-valid-after-review",
      status: "active",
      publicKeyPem: keys.publicKeyPem,
      validFromUtc: "2026-10-31T03:00:00.000Z",
      validUntilUtc: "2026-11-30T03:00:00.000Z",
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  }, { now: "2026-10-31T03:01:00.000Z", allowLegacy: false });

  await assert.rejects(recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-test-01",
    submission,
    signatureBase64: signSubmission(submission, keys.privateKey),
    trustedReviewerKeys: registry,
    now: "2026-10-31T03:02:00.000Z",
  }), /outside the trusted reviewer key validity window/i);
});
