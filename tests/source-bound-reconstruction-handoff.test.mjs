import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS,
  MEDIA_TO_MODEL_STAGE_IDS,
  completeReconstructionStage,
  createOrResumeReconstructionJob,
  fingerprintStageInput,
  startReconstructionStage,
} from "../src/core/building-generation/reconstruction-job-state.mjs";
import {
  prepareSourceBoundReconstructionHandoff,
  readSourceBoundReconstructionHandoff,
} from "../src/core/building-generation/source-bound-reconstruction-handoff.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const FALSE_POLICY = {
  groundTruth: false,
  acceptanceEligible: false,
  publicationEligible: false,
  publishable: false,
  mapReady: false,
  automaticApproval: false,
};
const SOURCE_BYTES = Buffer.from("synthetic source photograph");
const SOURCE_SHA = sha(SOURCE_BYTES);

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-bound-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [] }], nodes: [] }));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const jsonChunk = Buffer.alloc(paddedLength, 0x20);
  json.copy(jsonChunk);
  const totalLength = 12 + 8 + jsonChunk.length;
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(jsonChunk.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(output, 20);
  return output;
}

function createVisualBundle() {
  return {
    schemaVersion: "1.0.0",
    bundleType: "source-bound-visual-evidence",
    bundleId: "visual-evidence-front-01",
    buildingId: "building-a",
    viewId: "front",
    source: { id: "front-01", sha256: SOURCE_SHA, bytes: SOURCE_BYTES.length, width: 100, height: 80 },
    maskArtifact: { assessment: { status: "reviewed", humanReviewed: true } },
    observationArtifact: { batchId: "batch-front-01" },
    policy: {
      groundTruth: false,
      acceptanceEligible: false,
      publicationEligible: false,
      publishable: false,
      mapReady: false,
      automaticApproval: false,
    },
  };
}

function createReconstructionEvidence(visualBytes, candidateBytes) {
  const visual = JSON.parse(visualBytes.toString("utf8"));
  return {
    schemaVersion: "1.0.0",
    bundleType: "source-bound-reconstruction-evidence",
    bundleId: "reconstruction-evidence-front-01",
    buildingId: "building-a",
    visualBundle: {
      bundleId: visual.bundleId,
      sha256: sha(visualBytes),
      sourceId: visual.source.id,
      sourceSha256: visual.source.sha256,
    },
    candidateGlbSha256: sha(candidateBytes),
    rightsEvidence: {
      status: "validator-report-linked-human-review-required",
      linkedToExactSource: true,
      independentlyRecomputed: false,
    },
    cameraCalibration: {
      status: "structurally-valid-evidence-linked-human-review-required",
      report: { status: "structurally-valid" },
    },
    groundControl: {
      status: "calibrated-needs-human-review",
      registration: {
        status: "calibrated-needs-human-review",
        vertical: { status: "not-solved" },
      },
    },
    checks: {
      exactSourceRightsLink: true,
      rightsValidatorReportComplete: true,
      cameraEvidenceByteBound: true,
      cameraProjectionValidationRecomputed: true,
      groundControlEvidenceByteBound: true,
      groundControlRegistrationRecomputed: true,
      candidateGlbHashBound: true,
    },
    policy: {
      groundTruth: false,
      acceptanceEligible: false,
      publicationEligible: false,
      publishable: false,
      mapReady: false,
      automaticApproval: false,
      independentlyAuthenticatedReviewer: false,
    },
  };
}

async function createSourceJob(root, overrides = {}) {
  const glb = overrides.glb ?? makeGlb();
  const report = overrides.report ?? {
    schemaVersion: "1.0.0",
    status: "completed-requires-review",
    buildingId: "building-a",
    inputs: { selectedViewIds: ["front-01"] },
    selectedSourceManifest: [{ id: "front-01", sha256: SOURCE_SHA, kind: "image" }],
    output: { modelSha256: sha(glb) },
    mapReady: false,
    publicationEligible: false,
  };
  await mkdir(path.join(root, "candidate"), { recursive: true });
  await mkdir(path.join(root, "qa"), { recursive: true });
  await writeFile(path.join(root, "candidate/model.glb"), glb);
  await writeFile(path.join(root, "qa/report.json"), JSON.stringify(report, null, 2) + "\n");

  const created = await createOrResumeReconstructionJob({
    workspaceRoot: root,
    buildingId: "building-a",
    jobId: "source-job-01",
    sourceManifest: { selectedViewIds: ["front-01"], sourceSha256: SOURCE_SHA },
    config: { strategy: "photogrammetry" },
    stageIds: MEDIA_TO_MODEL_STAGE_IDS,
    now: "2026-10-30T10:00:00.000Z",
  });

  for (const [index, stageId] of MEDIA_TO_MODEL_STAGE_IDS.entries()) {
    const inputFingerprint = fingerprintStageInput({
      stageId,
      inputs: { stageIndex: index, sourceSha256: SOURCE_SHA },
      parameters: { fixture: true },
    });
    await startReconstructionStage({
      workspaceRoot: root,
      buildingId: "building-a",
      jobId: "source-job-01",
      stageId,
      inputFingerprint,
      now: "2026-10-30T10:01:00.000Z",
    });

    let payload = { stageId, completed: true };
    let outputs = { completed: true };
    if (stageId === "model-generation") {
      payload = {
        modelPath: "candidate/model.glb",
        modelSha256: sha(glb),
        modelBytes: glb.length,
      };
      outputs = { ...payload };
    }
    if (stageId === "report-finalization") {
      payload = { report };
      outputs = {
        workflowReportPath: "qa/report.json",
        modelSha256: sha(glb),
        status: "completed-requires-review",
        mapReady: false,
        publicationEligible: false,
      };
    }
    await completeReconstructionStage({
      workspaceRoot: root,
      buildingId: "building-a",
      jobId: "source-job-01",
      stageId,
      payload,
      outputs,
      now: "2026-10-30T10:02:00.000Z",
    });
  }
  assert.equal(created.job.status, "queued");
  return { glb, report };
}

async function writeEvidenceFiles(root, overrides = {}) {
  const visual = overrides.visual ?? createVisualBundle();
  const visualBytes = Buffer.from(JSON.stringify(visual, null, 2));
  const candidateBytes = overrides.candidateBytes ?? makeGlb();
  const evidence = overrides.evidence ?? createReconstructionEvidence(visualBytes, candidateBytes);
  await writeFile(path.join(root, "visual.json"), visualBytes);
  await writeFile(path.join(root, "reconstruction-evidence.json"), JSON.stringify(evidence, null, 2));
  return { visualBytes, evidence, candidateBytes };
}

function handoffArgs(root, overrides = {}) {
  return {
    workspaceRoot: root,
    buildingId: "building-a",
    sourceJobId: "source-job-01",
    visualBundlePath: "visual.json",
    reconstructionEvidencePath: "reconstruction-evidence.json",
    candidateGlbPath: "candidate/model.glb",
    qaReportPath: "qa/report.json",
    now: "2026-10-30T11:00:00.000Z",
    ...overrides,
  };
}

test("prepares an immutable review-only hand-off linked to source job artifacts", async (t) => {
  const root = await workspace(t);
  await createSourceJob(root);
  await writeEvidenceFiles(root);

  const result = await prepareSourceBoundReconstructionHandoff(handoffArgs(root));
  assert.equal(result.disposition, "prepared-for-human-review");
  assert.equal(result.handoffPrepared, true);
  assert.equal(result.handoff.dispatchAllowed, false);
  assert.equal(result.handoff.checks.candidateGlbContainerValid, true);
  assert.equal(result.handoff.candidate.geometryAccuracyEvaluated, false);
  assert.equal(result.handoff.checks.verticalDatumResolved, false);
  assert.ok(Object.values(result.handoff.policy).every((value) => value === false));
  assert.deepEqual(result.job.stageIds, CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS);
  assert.ok(result.artifact.upstreamArtifacts.some((item) => item.stageId === "candidate-evidence-verification"));

  const stored = await readSourceBoundReconstructionHandoff({
    workspaceRoot: root,
    buildingId: "building-a",
    handoffJobId: result.handoffJobId,
  });
  assert.equal(stored.handoff.handoffId, result.handoffJobId);
  assert.equal(stored.handoff.disposition, "prepared-for-human-review");
  assert.equal(stored.handoff.policy.publicationEligible, false);
});

test("reuses identical hand-off jobs without overwriting immutable artifact history", async (t) => {
  const root = await workspace(t);
  await createSourceJob(root);
  await writeEvidenceFiles(root);

  const first = await prepareSourceBoundReconstructionHandoff(handoffArgs(root));
  const second = await prepareSourceBoundReconstructionHandoff(handoffArgs(root));
  assert.equal(second.handoffJobId, first.handoffJobId);
  assert.equal(second.reused, true);
  assert.equal(second.artifact.contentSha256, first.artifact.contentSha256);
  assert.equal(second.job.stages[1].artifacts.length, 1);
});

test("blocks hand-off readiness when rights evidence remains incomplete", async (t) => {
  const root = await workspace(t);
  await createSourceJob(root);
  const files = await writeEvidenceFiles(root);
  const blockedEvidence = {
    ...files.evidence,
    rightsEvidence: { ...files.evidence.rightsEvidence, status: "blocked-or-incomplete" },
    checks: { ...files.evidence.checks, rightsValidatorReportComplete: false },
  };
  await writeFile(path.join(root, "reconstruction-evidence.json"), JSON.stringify(blockedEvidence, null, 2));

  const result = await prepareSourceBoundReconstructionHandoff(handoffArgs(root));
  assert.equal(result.disposition, "blocked");
  assert.equal(result.handoff.handoffPrepared, true);
  assert.equal(result.handoff.dispatchAllowed, false);
  assert.equal(result.handoff.checks.rightsEvidenceCompleteButHumanReviewRequired, false);
  assert.equal(result.handoff.policy.publicationEligible, false);
});

test("rejects candidate GLB bytes that differ from model-generation and evidence hashes", async (t) => {
  const root = await workspace(t);
  const { glb } = await createSourceJob(root);
  await writeEvidenceFiles(root);
  const changedGlb = Buffer.from(glb);
  const sceneMarker = Buffer.from('"scene":0');
  const sceneOffset = changedGlb.indexOf(sceneMarker);
  assert.notEqual(sceneOffset, -1);
  changedGlb[sceneOffset + sceneMarker.length - 1] = "1".charCodeAt(0);
  await writeFile(path.join(root, "candidate/model.glb"), changedGlb);

  await assert.rejects(prepareSourceBoundReconstructionHandoff(handoffArgs(root)), /reconstruction evidence bundle does not bind the exact visual bundle, source and candidate GLB bytes/);
});

test("rejects a QA report that no longer matches report-finalization artifact bytes", async (t) => {
  const root = await workspace(t);
  await createSourceJob(root);
  await writeEvidenceFiles(root);
  const changedReport = JSON.parse(await readFile(path.join(root, "qa/report.json"), "utf8"));
  changedReport.status = "accepted";
  await writeFile(path.join(root, "qa/report.json"), JSON.stringify(changedReport));

  await assert.rejects(prepareSourceBoundReconstructionHandoff(handoffArgs(root)), /QA report does not match/);
});

test("rejects a visual source that is not the selected hash-bound view in the source job", async (t) => {
  const root = await workspace(t);
  await createSourceJob(root);
  const visual = createVisualBundle();
  visual.source.id = "different-view";
  const visualBytes = Buffer.from(JSON.stringify(visual, null, 2));
  const evidence = createReconstructionEvidence(visualBytes, makeGlb());
  await writeFile(path.join(root, "visual.json"), visualBytes);
  await writeFile(path.join(root, "reconstruction-evidence.json"), JSON.stringify(evidence, null, 2));

  await assert.rejects(prepareSourceBoundReconstructionHandoff(handoffArgs(root)), /selected view/);
});

test("rejects malformed GLB containers and workspace path traversal", async (t) => {
  const root = await workspace(t);
  await createSourceJob(root);
  const { visualBytes, candidateBytes } = await writeEvidenceFiles(root);
  const evidence = createReconstructionEvidence(visualBytes, candidateBytes);
  await writeFile(path.join(root, "reconstruction-evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(root, "candidate/model.glb"), Buffer.from("not a glb"));

  await assert.rejects(prepareSourceBoundReconstructionHandoff(handoffArgs(root)), /structurally valid GLB/);
  await assert.rejects(
    prepareSourceBoundReconstructionHandoff(handoffArgs(root, { candidateGlbPath: "../candidate/model.glb" })),
    /unsafe path segment/,
  );
});

test("rejects symlinked evidence files", async (t) => {
  const root = await workspace(t);
  await createSourceJob(root);
  await writeEvidenceFiles(root);
  await writeFile(path.join(root, "outside.json"), await readFile(path.join(root, "visual.json")));
  await rm(path.join(root, "visual.json"));
  await symlink(path.join(root, "outside.json"), path.join(root, "visual.json"));

  await assert.rejects(prepareSourceBoundReconstructionHandoff(handoffArgs(root)), /must not traverse symlink/);
});

test("rejects symlinked parent directories for workspace evidence paths", async (t) => {
  const root = await workspace(t);
  await createSourceJob(root);
  await writeEvidenceFiles(root);
  await mkdir(path.join(root, "real-evidence"));
  await writeFile(path.join(root, "real-evidence/visual.json"), await readFile(path.join(root, "visual.json")));
  await symlink(path.join(root, "real-evidence"), path.join(root, "linked-evidence"));

  await assert.rejects(
    prepareSourceBoundReconstructionHandoff(handoffArgs(root, { visualBundlePath: "linked-evidence/visual.json" })),
    /must not traverse symlink/,
  );
});
