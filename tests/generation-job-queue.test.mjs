import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireGenerationWorkerLock,
  claimNextGenerationJob,
  completeGenerationJob,
  enqueueGenerationJob,
  failGenerationJob,
  getGenerationJob,
  listGenerationJobs,
  recoverInterruptedGenerationJobs,
  updateGenerationJob,
} from "../src/core/building-generation/generation-job-queue.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));

async function makeWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function basicInput(overrides = {}) {
  return { buildingSpec: fixture, strategy: "procedural", sources: [], ...overrides };
}

test("persists generation requests and lists only bounded, validated queue state", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const job = await enqueueGenerationJob({ workspaceRoot, input: basicInput() });
  assert.equal(job.status, "queued");
  assert.equal(job.mapReady, false);
  assert.equal(job.publicationEligible, false);
  assert.equal((await getGenerationJob({ workspaceRoot, jobId: job.jobId })).buildingId, fixture.id);
  assert.equal((await listGenerationJobs({ workspaceRoot, limit: 5 })).length, 1);
  assert.deepEqual((await listGenerationJobs({ workspaceRoot, limit: 5 }))[0], job);
  const requestPath = path.join(workspaceRoot, ".building-engine", "generation-queue", "jobs", job.jobId, "request.json");
  assert.equal(JSON.parse(await readFile(requestPath, "utf8")).buildingId, fixture.id);
  await assert.rejects(listGenerationJobs({ workspaceRoot, limit: 101 }), /between 1 and 100/);
});

test("rejects source path traversal, unknown licence, and missing rights attestation", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const source = { sourceId: "front", relativePath: "../secret.png", licence: "CC BY 4.0" };
  await assert.rejects(enqueueGenerationJob({ workspaceRoot, input: basicInput({ sources: [source], confirmRights: true }) }), /parent path segments/);
  await assert.rejects(enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({ sources: [{ ...source, relativePath: "uploads/front.png", licence: "unknown" }], confirmRights: true }),
  }), /known permission\/licence/);
  await assert.rejects(enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({ sources: [{ ...source, relativePath: "uploads/front.png" }] }),
  }), /confirmRights/);
  await assert.rejects(enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({ sources: [{ sourceId: "front", relativePath: "uploads/front.png", licence: "CC BY 4.0" }], confirmRights: true, strategy: "photogrammetry", viewSourceIds: ["front"], upAxis: "Z" }),
  }), /at least three selected/);
});

test("claims, completes and records a fail-closed review candidate", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const queued = await enqueueGenerationJob({ workspaceRoot, input: basicInput() });
  const claimed = await claimNextGenerationJob({ workspaceRoot, workerId: "test-worker" });
  assert.equal(claimed.job.jobId, queued.jobId);
  assert.equal(claimed.job.status, "running");
  assert.equal(claimed.request.jobId, queued.jobId);
  const completed = await completeGenerationJob({
    workspaceRoot,
    jobId: queued.jobId,
    result: { modelPath: ".building-engine/jobs/demo/model.glb", mapReady: false, publicationEligible: false },
  });
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.job.result.mapReady, false);
  assert.equal(completed.job.publicationEligible, false);
  await assert.rejects(completeGenerationJob({
    workspaceRoot, jobId: queued.jobId, result: {},
  }), /Only running jobs/);
});

test("recovers interrupted work into a retryable queued job and enforces the retry ceiling", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const queued = await enqueueGenerationJob({ workspaceRoot, input: basicInput() });
  await claimNextGenerationJob({ workspaceRoot, workerId: "crashed-worker" });
  assert.deepEqual(await recoverInterruptedGenerationJobs({ workspaceRoot }), [queued.jobId]);
  assert.equal((await getGenerationJob({ workspaceRoot, jobId: queued.jobId })).status, "queued");

  await updateGenerationJob({
    workspaceRoot, jobId: queued.jobId,
    update: (state) => { state.nextAttemptAt = new Date(0).toISOString(); },
  });
  const retry = await claimNextGenerationJob({ workspaceRoot, workerId: "retry-worker" });
  assert.equal(retry.job.attempt, 2);
  const failed = await failGenerationJob({
    workspaceRoot, jobId: queued.jobId, error: new Error("deterministic test failure"), retry: true,
  });
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.lastError.message, "deterministic test failure");
});

test("prevents two local workers from holding the queue lock at once", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const first = await acquireGenerationWorkerLock({ workspaceRoot });
  try {
    await assert.rejects(acquireGenerationWorkerLock({ workspaceRoot }), /already running/);
  } finally {
    await first.release();
  }
  const second = await acquireGenerationWorkerLock({ workspaceRoot });
  await second.release();
});
