import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RECONSTRUCTION_STAGE_IDS,
  completeReconstructionStage,
  createOrResumeReconstructionJob,
  failReconstructionStage,
  fingerprintStageInput,
  readReconstructionJob,
  startReconstructionStage,
  validateStageArtifact,
} from "../src/core/building-generation/reconstruction-job-state.mjs";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reconstruction-job-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fingerprint(stageId, revision = 1) {
  return fingerprintStageInput({
    stageId,
    inputs: { inputRevision: revision, sourceId: "test-source" },
    parameters: { deterministic: true },
  });
}

async function createJob(root, overrides = {}) {
  return createOrResumeReconstructionJob({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    sourceManifest: [{ sourceId: "front", sha256: "a".repeat(64) }],
    config: { strategy: "photogrammetry", maxPasses: 4 },
    now: "2026-10-21T12:00:00.000Z",
    ...overrides,
  });
}

async function runStage(root, stageId, payload = { accepted: true }, revision = 1) {
  await startReconstructionStage({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    stageId,
    inputFingerprint: fingerprint(stageId, revision),
    now: "2026-10-21T12:01:00.000Z",
  });
  return completeReconstructionStage({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    stageId,
    payload,
    outputs: { report: "reports/" + stageId + ".json" },
    now: "2026-10-21T12:02:00.000Z",
  });
}

test("creates a versioned job state with every stage in the documented order", async (t) => {
  const root = await workspace(t);
  const result = await createJob(root);
  assert.equal(result.resumed, false);
  assert.equal(result.job.schemaId, "reconstruction-job-state");
  assert.equal(result.job.schemaVersion, "1.0.0");
  assert.deepEqual(result.job.stages.map((stage) => stage.id), RECONSTRUCTION_STAGE_IDS);
  assert.equal(result.job.status, "queued");
  assert.equal(result.job.mapReady, false);
  assert.equal(result.job.publicationEligible, false);
});

test("requires prior stage artifacts and a valid fingerprint before a stage can start", async (t) => {
  const root = await workspace(t);
  await createJob(root);
  await assert.rejects(
    startReconstructionStage({
      workspaceRoot: root,
      buildingId: "test-building",
      jobId: "job-001",
      stageId: "per-view-sketch",
      inputFingerprint: fingerprint("per-view-sketch"),
    }),
    /cannot start before ingest is completed/,
  );
  await assert.rejects(
    startReconstructionStage({
      workspaceRoot: root,
      buildingId: "test-building",
      jobId: "job-001",
      stageId: "ingest",
      inputFingerprint: "not-a-sha",
    }),
    /SHA-256 hex digest/,
  );
});

test("writes immutable checksummed artifacts and reuses a completed stage for identical inputs", async (t) => {
  const root = await workspace(t);
  await createJob(root);
  const first = await runStage(root, "ingest", { mediaCount: 1 });
  assert.equal(first.job.stages[0].status, "completed");
  assert.equal(first.artifact.schemaId, "reconstruction-stage-artifact");
  assert.equal(first.artifact.schemaVersion, "1.0.0");
  assert.equal(first.artifact.mapReady, false);
  assert.equal(first.artifact.publicationEligible, false);
  assert.equal(validateStageArtifact(first.artifact).contentSha256, first.artifactRecord.contentSha256);
  const artifactPath = path.join(first.jobDirectory, ...first.artifactRecord.path.split("/"));
  assert.ok((await readFile(artifactPath, "utf8")).includes('"mediaCount": 1'));

  const reused = await startReconstructionStage({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    stageId: "ingest",
    inputFingerprint: fingerprint("ingest"),
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.artifact.contentSha256, first.artifact.contentSha256);
  assert.equal(reused.job.stages[0].artifacts.length, 1);
});

test("records stage failures and supports explicit retry", async (t) => {
  const root = await workspace(t);
  await createJob(root);
  await startReconstructionStage({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    stageId: "ingest",
    inputFingerprint: fingerprint("ingest"),
  });
  const failed = await failReconstructionStage({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    stageId: "ingest",
    error: Object.assign(new Error("Bad image signature"), { code: "INVALID_MEDIA" }),
    now: "2026-10-21T12:03:00.000Z",
  });
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.stages[0].error.code, "INVALID_MEDIA");

  const retried = await startReconstructionStage({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    stageId: "ingest",
    inputFingerprint: fingerprint("ingest"),
  });
  assert.equal(retried.job.status, "running");
  assert.equal(retried.job.stages[0].attempts, 2);
});

test("rerunning an upstream stage preserves history and invalidates descendants", async (t) => {
  const root = await workspace(t);
  await createJob(root);
  const ingest = await runStage(root, "ingest", { mediaCount: 1 });
  const analysis = await runStage(root, "image-analysis", { usableViews: 1 });
  assert.equal(analysis.job.stages[1].status, "completed");

  await startReconstructionStage({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    stageId: "ingest",
    inputFingerprint: fingerprint("ingest", 2),
    force: true,
  });
  const running = await readReconstructionJob({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
  });
  assert.equal(running.job.stages[0].status, "running");
  assert.equal(running.job.stages[0].artifacts.length, 1);
  assert.equal(running.job.stages[1].status, "stale");
  assert.equal(running.job.stages[1].activeArtifactId, null);
  assert.equal(ingest.artifactRecord.artifactId, running.job.stages[0].artifacts[0].artifactId);

  await assert.rejects(
    startReconstructionStage({
      workspaceRoot: root,
      buildingId: "test-building",
      jobId: "job-001",
      stageId: "image-analysis",
      inputFingerprint: fingerprint("image-analysis"),
    }),
    /another reconstruction stage is already running/,
  );
});

test("resumes only when the source manifest and configuration fingerprints match", async (t) => {
  const root = await workspace(t);
  await createJob(root);
  await runStage(root, "ingest");
  const resumed = await createJob(root);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.job.stages[0].status, "completed");

  await assert.rejects(
    createJob(root, { config: { strategy: "procedural" } }),
    /different source\/config inputs/,
  );
});

test("marks an interrupted running stage as failed on resume without deleting prior artifacts", async (t) => {
  const root = await workspace(t);
  await createJob(root);
  const completed = await runStage(root, "ingest");
  await startReconstructionStage({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    stageId: "image-analysis",
    inputFingerprint: fingerprint("image-analysis"),
  });
  const resumed = await createJob(root);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.job.status, "failed");
  assert.equal(resumed.job.stages[1].status, "failed");
  assert.equal(resumed.job.stages[1].error.code, "STAGE_INTERRUPTED");
  assert.equal(resumed.job.stages[0].activeArtifactId, completed.artifactRecord.artifactId);
});

test("validates active artifact checksums and refuses tampered files", async (t) => {
  const root = await workspace(t);
  await createJob(root);
  const result = await runStage(root, "ingest");
  const artifactPath = path.join(result.jobDirectory, ...result.artifactRecord.path.split("/"));
  await writeFile(artifactPath, JSON.stringify({ ...result.artifact, payload: { accepted: false } }));
  await assert.rejects(
    readReconstructionJob({
      workspaceRoot: root,
      buildingId: "test-building",
      jobId: "job-001",
    }),
    /checksum mismatch/,
  );
});

test("completes stages in order while keeping publication gates closed", async (t) => {
  const root = await workspace(t);
  await createJob(root);
  let latest;
  for (const stageId of RECONSTRUCTION_STAGE_IDS) {
    latest = await runStage(root, stageId, { stageAcceptedForNextStage: true });
  }
  assert.equal(latest.job.status, "completed");
  assert.equal(latest.job.stages.length, RECONSTRUCTION_STAGE_IDS.length);
  assert.ok(latest.job.stages.every((stage) => stage.status === "completed"));
  assert.equal(latest.job.mapReady, false);
  assert.equal(latest.job.publicationEligible, false);
});

test("rejects unsafe identifiers and invalid stage payloads", async (t) => {
  const root = await workspace(t);
  await assert.rejects(
    createOrResumeReconstructionJob({
      workspaceRoot: root,
      buildingId: "../outside",
      jobId: "job-001",
      sourceManifest: [],
      config: {},
    }),
    /safe identifier/,
  );
  await createJob(root);
  await startReconstructionStage({
    workspaceRoot: root,
    buildingId: "test-building",
    jobId: "job-001",
    stageId: "ingest",
    inputFingerprint: fingerprint("ingest"),
  });
  await assert.rejects(
    completeReconstructionStage({
      workspaceRoot: root,
      buildingId: "test-building",
      jobId: "job-001",
      stageId: "ingest",
      payload: ["not", "an", "object"],
    }),
    /payload must be an object/,
  );
});
