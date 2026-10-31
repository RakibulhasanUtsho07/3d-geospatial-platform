import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS,
  createOrResumeReconstructionJob,
  fingerprintStageInput,
  startReconstructionStage,
  completeReconstructionStage,
} from "../../src/core/building-generation/reconstruction-job-state.mjs";
import {
  canonicalSourceBoundReviewSubmissionBytes,
  parseTrustedReconstructionReviewerKeys,
  prepareSourceBoundGeometryReview,
  recordSourceBoundAuthenticatedReview,
} from "../../src/core/building-generation/source-bound-authenticated-review.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function createD3m01dSignedReviewFixture({
  workspaceRoot,
  buildingId,
  candidatePath,
  decision = "continue-to-independent-validation",
}) {
  await mkdir(workspaceRoot, { recursive: true });
  const candidate = await readFile(path.resolve(workspaceRoot, candidatePath));
  const candidateSha = hash(candidate);
  const handoffJobId = "handoff-" + buildingId;
  await createOrResumeReconstructionJob({
    workspaceRoot,
    buildingId,
    jobId: handoffJobId,
    sourceManifest: {
      schemaVersion: "1.0.0",
      recordType: "source-bound-reconstruction-handoff-source",
      candidateGlbSha256: candidateSha,
      sourceJobId: "source-" + buildingId,
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
    sourceJobId: "source-" + buildingId,
    disposition: "prepared-for-human-review",
    handoffPrepared: true,
    reviewRequired: true,
    dispatchAllowed: false,
    candidate: {
      path: candidatePath,
      sha256: candidateSha,
      bytes: candidate.length,
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
      parameters: { fixture: "d3m01d-signed-review" },
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
  const registry = parseTrustedReconstructionReviewerKeys([{ reviewerId: "reviewer-fixture", publicKeyPem }]);
  const acceptedChecks = {
    rightsUseScope: "verified",
    sameBuildingIdentity: "verified",
    cameraCalibration: "verified",
    groundControlCorrespondence: "verified",
    metricScale: "verified",
    verticalDatum: "verified",
    geometryTopology: "accepted-for-independent-validation",
    sourceCameraComparison: "consistent",
  };
  const nonContinueChecks = {
    rightsUseScope: "not-reviewed",
    sameBuildingIdentity: "not-reviewed",
    cameraCalibration: "not-reviewed",
    groundControlCorrespondence: "not-reviewed",
    metricScale: "not-reviewed",
    verticalDatum: "unresolved",
    geometryTopology: "not-reviewed",
    sourceCameraComparison: "not-reviewed",
  };
  const submission = {
    ...prepared.submissionTemplate,
    reviewerId: "reviewer-fixture",
    reviewedAtUtc: "2026-10-30T15:05:00.000Z",
    decision,
    checks: decision === "continue-to-independent-validation" ? acceptedChecks : nonContinueChecks,
    notes: "Synthetic automated-test fixture only; not a real building review.",
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
    handoffJobId,
    reviewJobId: result.reviewJobId,
    candidateGlbSha256: candidateSha,
    registryJson: JSON.stringify([{ reviewerId: "reviewer-fixture", publicKeyPem }]),
    reviewerPublicKeyFingerprintSha256: result.decisionRecord.authentication.reviewerPublicKeyFingerprintSha256,
  };
}
