import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
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
    input: basicInput({ sources: [{ sourceId: "front", relativePath: "uploads/front.png", licence: "CC BY 4.0" }], confirmRights: true, strategy: "photogrammetry", viewSourceIds: ["front"], upAxis: "Z", confirmSameBuilding: true, confirmOverlapReviewed: true, confirmUpAxisReviewed: true }),
  }), /at least three selected/);
});

test("rejects missing source media before creating a queue job", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  const source = { sourceId: "front", relativePath: "uploads/front.png", licence: "CC BY 4.0", kind: "image" };
  await assert.rejects(
    enqueueGenerationJob({ workspaceRoot, input: basicInput({ sources: [source], confirmRights: true }) }),
    /does not exist in workspaceRoot/,
  );
  assert.deepEqual(await listGenerationJobs({ workspaceRoot, limit: 5 }), []);
});

test("rejects symlinked sources and sources that are not regular files", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  await mkdir(path.join(workspaceRoot, "uploads"), { recursive: true });
  const outside = path.join(workspaceRoot, "outside.png");
  await writeFile(outside, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  await symlink(outside, path.join(workspaceRoot, "uploads", "front.png"));
  const source = { sourceId: "front", relativePath: "uploads/front.png", licence: "CC BY 4.0", kind: "image" };
  await assert.rejects(
    enqueueGenerationJob({ workspaceRoot, input: basicInput({ sources: [source], confirmRights: true }) }),
    /symbolic links/,
  );
  await rm(path.join(workspaceRoot, "uploads", "front.png"));
  await assert.rejects(
    enqueueGenerationJob({
      workspaceRoot,
      input: basicInput({
        sources: [{ ...source, relativePath: "uploads" }],
        confirmRights: true,
      }),
    }),
    /regular file/,
  );
  assert.deepEqual(await listGenerationJobs({ workspaceRoot, limit: 5 }), []);
});

test("accepts existing media files and rejects empty or oversized sources", async (t) => {
  const workspaceRoot = await makeWorkspace(t);
  await mkdir(path.join(workspaceRoot, "uploads"), { recursive: true });
  const filePath = path.join(workspaceRoot, "uploads", "front.png");
  await writeFile(filePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const source = { sourceId: "front", relativePath: "uploads/front.png", licence: "CC BY 4.0", kind: "image" };
  const job = await enqueueGenerationJob({
    workspaceRoot,
    input: basicInput({ sources: [source], confirmRights: true }),
  });
  assert.equal(job.status, "queued");

  const emptyPath = path.join(workspaceRoot, "uploads", "empty.png");
  await writeFile(emptyPath, Buffer.alloc(0));
  await assert.rejects(
    enqueueGenerationJob({
      workspaceRoot,
      input: basicInput({
        sources: [{ ...source, sourceId: "empty", relativePath: "uploads/empty.png" }],
        confirmRights: true,
      }),
    }),
    /is empty/,
  );

  await truncate(filePath, 20 * 1024 * 1024 + 1);
  await assert.rejects(
    enqueueGenerationJob({ workspaceRoot, input: basicInput({ sources: [source], confirmRights: true }) }),
    /exceeds the 20971520-byte image intake limit/,
  );
  assert.equal((await listGenerationJobs({ workspaceRoot, limit: 5 })).length, 1);
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
