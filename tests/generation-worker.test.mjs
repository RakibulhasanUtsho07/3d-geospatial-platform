import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { enqueueGenerationJob, getGenerationJob } from "../src/core/building-generation/generation-job-queue.mjs";
import { runGenerationWorker } from "../scripts/run-generation-worker.mjs";
import { getGenerationWorkerStatus } from "../src/core/building-generation/generation-worker-status.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));

test("worker runs a durable procedural job and leaves the GLB gated for human review", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "generation-worker-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const queued = await enqueueGenerationJob({
    workspaceRoot,
    input: { buildingSpec: fixture, strategy: "procedural", sources: [] },
  });

  const summary = await runGenerationWorker({
    workspaceRoot, once: true, pollIntervalMs: 100, heartbeatIntervalMs: 1000,
  });
  assert.equal(summary.processed.length, 1);
  const job = await getGenerationJob({ workspaceRoot, jobId: queued.jobId });
  assert.equal(job.status, "completed", JSON.stringify(job.lastError));
  assert.equal(job.mapReady, false);
  assert.equal(job.publicationEligible, false);
  assert.equal(job.result.status, "completed-requires-review");
  assert.ok(job.result.modelSha256);
  assert.equal(job.result.modelPath.startsWith(".building-engine/jobs/"), true);
  assert.equal((await stat(path.join(workspaceRoot, job.result.modelPath))).isFile(), true);
  const report = JSON.parse(await readFile(path.join(workspaceRoot, job.result.reportPath), "utf8"));
  assert.equal(report.mapReady, false);
  assert.equal(report.publicationEligible, false);
  const workerStatus = await getGenerationWorkerStatus({ workspaceRoot });
  assert.equal(workerStatus.availability, "stopped");
  assert.equal(workerStatus.online, false);
  assert.equal(workerStatus.phase, "stopped");
  assert.equal(workerStatus.currentJobId, null);
});
