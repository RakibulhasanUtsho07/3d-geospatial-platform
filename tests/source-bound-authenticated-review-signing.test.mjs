import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS,
  completeReconstructionStage,
  createOrResumeReconstructionJob,
  fingerprintStageInput,
  startReconstructionStage,
} from "../src/core/building-generation/reconstruction-job-state.mjs";
import { createBuildingGlb } from "./fixtures/glb-geometry-fixture.mjs";
import {
  canonicalSourceBoundReviewSubmissionBytes,
  parseTrustedReconstructionReviewerKeys,
  prepareSourceBoundGeometryReview,
  recordSourceBoundAuthenticatedReview,
} from "../src/core/building-generation/source-bound-authenticated-review.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function tempWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "authenticated-review-packet-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "candidate"));
  return root;
}

async function createHandoff(root, glb = createBuildingGlb()) {
  await writeFile(path.join(root, "candidate/model.glb"), glb);
  const candidateSha = sha(glb);
  await createOrResumeReconstructionJob({
    workspaceRoot: root,
    buildingId: "building-a",
    jobId: "handoff-cli-01",
    sourceManifest: { candidateGlbSha256: candidateSha },
    config: { handoffPrepared: true, mapReady: false, publicationEligible: false },
    stageIds: CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS,
    now: "2026-10-30T15:00:00.000Z",
  });
  const handoff = {
    schemaVersion: "1.0.0",
    recordType: "source-bound-reconstruction-handoff",
    handoffId: "handoff-cli-01",
    buildingId: "building-a",
    sourceJobId: "source-job-01",
    disposition: "prepared-for-human-review",
    handoffPrepared: true,
    reviewRequired: true,
    dispatchAllowed: false,
    candidate: { path: "candidate/model.glb", sha256: candidateSha, bytes: glb.length, geometryAccuracyEvaluated: false },
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
      candidateGeometryValidated: false, groundTruth: false, acceptanceEligible: false,
      publicationEligible: false, publishable: false, mapReady: false,
      automaticApproval: false, dispatchAllowed: false,
    },
  };
  for (const [index, stageId] of CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS.entries()) {
    const inputFingerprint = fingerprintStageInput({
      stageId, inputs: { index, candidateSha }, parameters: { fixture: true },
    });
    await startReconstructionStage({
      workspaceRoot: root, buildingId: "building-a", jobId: "handoff-cli-01",
      stageId, inputFingerprint, now: "2026-10-30T15:01:00.000Z",
    });
    await completeReconstructionStage({
      workspaceRoot: root, buildingId: "building-a", jobId: "handoff-cli-01",
      stageId, payload: stageId === "candidate-evidence-handoff" ? { handoff } : { candidateSha },
      outputs: { candidateSha }, now: "2026-10-30T15:02:00.000Z",
    });
  }
}

test("geometry report and exact signed bytes are linked to the same hand-off", async (t) => {
  const root = await tempWorkspace(t);
  const glb = createBuildingGlb();
  await createHandoff(root, glb);
  const prepared = await prepareSourceBoundGeometryReview({
    workspaceRoot: root, buildingId: "building-a", handoffJobId: "handoff-cli-01",
  });
  const submission = {
    ...prepared.submissionTemplate,
    reviewerId: "reviewer-01",
    reviewedAtUtc: "2026-10-30T15:05:00.000Z",
    decision: "hold",
    checks: {
      rightsUseScope: "not-reviewed",
      sameBuildingIdentity: "not-reviewed",
      cameraCalibration: "not-reviewed",
      groundControlCorrespondence: "not-reviewed",
      metricScale: "not-reviewed",
      verticalDatum: "unresolved",
      geometryTopology: "not-reviewed",
      sourceCameraComparison: "not-reviewed",
    },
    notes: "Synthetic test only.",
  };
  const bytes = canonicalSourceBoundReviewSubmissionBytes(submission);
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signature = sign(null, bytes, pair.privateKey).toString("base64");
  const result = await recordSourceBoundAuthenticatedReview({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: "handoff-cli-01",
    submission,
    signatureBase64: signature,
    trustedReviewerKeys: parseTrustedReconstructionReviewerKeys([{ reviewerId: "reviewer-01", publicKeyPem }]),
    now: "2026-10-30T15:10:00.000Z",
  });
  assert.equal(result.signatureVerified, true);
  assert.equal(result.decisionRecord.authentication.signedPayloadSha256, sha(bytes));
  assert.equal(result.decisionRecord.geometryQa.reportSha256, prepared.geometryReportSha256);
});
