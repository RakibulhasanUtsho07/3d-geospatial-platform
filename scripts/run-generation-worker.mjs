#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  acquireGenerationWorkerLock,
  claimNextGenerationJob,
  completeGenerationJob,
  failGenerationJob,
  heartbeatGenerationJob,
  recoverInterruptedGenerationJobs,
  validateGenerationJobRequest,
} from "../src/core/building-generation/generation-job-queue.mjs";
import { runMediaToModelWorkflow } from "../src/core/building-generation/media-to-model-workflow.mjs";

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function executeClaimedJob({ workspaceRoot, claimed, workerId, heartbeatIntervalMs }) {
  const request = validateGenerationJobRequest(claimed.request);
  const jobId = claimed.job.jobId;
  let stoppingHeartbeats = false;
  let heartbeatChain = Promise.resolve();
  let heartbeatFailure = null;

  const heartbeatTimer = setInterval(() => {
    if (stoppingHeartbeats) return;
    heartbeatChain = heartbeatChain.then(async () => {
      if (stoppingHeartbeats) return;
      await heartbeatGenerationJob({ workspaceRoot, jobId, phase: "media-to-model-workflow" });
    }).catch((error) => {
      heartbeatFailure = asError(error);
    });
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  try {
    const result = await runMediaToModelWorkflow({
      workspaceRoot,
      jobId,
      buildingSpec: request.buildingSpec,
      sources: request.sources ?? [],
      strategy: request.strategy,
      ...(request.viewSourceIds === undefined ? {} : { viewSourceIds: request.viewSourceIds }),
      confirmRights: request.confirmRights,
      confirmSingleViewInference: request.confirmSingleViewInference,
      confirmSameBuilding: request.confirmSameBuilding,
      confirmOverlapReviewed: request.confirmOverlapReviewed,
      confirmUpAxisReviewed: request.confirmUpAxisReviewed,
      upAxis: request.upAxis,
      modelDistanceUnits: request.modelDistanceUnits,
      realDistanceM: request.realDistanceM,
      headingDegrees: request.headingDegrees,
      controlPoints: request.controlPoints,
      quality: process.env.BUILDING_ENGINE_QUALITY || "MEDIUM",
      colmapPath: process.env.BUILDING_ENGINE_COLMAP_PATH || undefined,
      runnerScript: process.env.BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT || undefined,
      pythonPath: process.env.BUILDING_ENGINE_PYTHON_EXECUTABLE || undefined,
      device: process.env.BUILDING_ENGINE_DEVICE || "cuda:0",
    });

    stoppingHeartbeats = true;
    clearInterval(heartbeatTimer);
    await heartbeatChain;

    const root = path.resolve(workspaceRoot);
    const jobResult = {
      status: result.report.status,
      workflowDirectory: path.relative(root, result.workflowDir).split(path.sep).join("/"),
      modelPath: path.relative(root, result.modelPath).split(path.sep).join("/"),
      reportPath: path.relative(root, result.reportPath).split(path.sep).join("/"),
      modelBytes: result.report.output?.modelBytes ?? null,
      modelSha256: result.report.output?.modelSha256 ?? null,
      georeferenceStatus: result.report.georeference?.status ?? "not-solved",
      warnings: result.report.warnings ?? [],
      mapReady: false,
      publicationEligible: false,
    };
    const completed = await completeGenerationJob({ workspaceRoot, jobId, result: jobResult });
    return { job: completed.job, workerId, heartbeatWarning: heartbeatFailure?.message ?? null };
  } catch (caught) {
    stoppingHeartbeats = true;
    clearInterval(heartbeatTimer);
    await heartbeatChain;
    const failure = asError(caught);
    const failed = await failGenerationJob({ workspaceRoot, jobId, error: failure, retry: true });
    return { job: failed.job, workerId, error: failure.message };
  }
}

export async function runGenerationWorker({
  workspaceRoot = process.env.BUILDING_ENGINE_WORKSPACE,
  once = false,
  pollIntervalMs = 1000,
  heartbeatIntervalMs = 30_000,
  signal,
} = {}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("Set BUILDING_ENGINE_WORKSPACE or pass --workspace-root.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw new RangeError("pollIntervalMs must be an integer from 100 to 60000.");
  }
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1000 || heartbeatIntervalMs > 300_000) {
    throw new RangeError("heartbeatIntervalMs must be an integer from 1000 to 300000.");
  }

  const lock = await acquireGenerationWorkerLock({ workspaceRoot });
  const summary = { workerId: lock.workerId, recoveredJobIds: [], processed: [] };
  try {
    summary.recoveredJobIds = await recoverInterruptedGenerationJobs({ workspaceRoot });
    while (!signal?.aborted) {
      const claimed = await claimNextGenerationJob({ workspaceRoot, workerId: lock.workerId });
      if (!claimed) {
        if (once) break;
        await delay(pollIntervalMs, signal);
        continue;
      }
      const outcome = await executeClaimedJob({
        workspaceRoot,
        claimed,
        workerId: lock.workerId,
        heartbeatIntervalMs,
      });
      summary.processed.push(outcome);
      console.log(JSON.stringify({
        workerId: lock.workerId,
        jobId: outcome.job.jobId,
        status: outcome.job.status,
        error: outcome.error ?? null,
      }));
      if (once) break;
    }
    return summary;
  } finally {
    await lock.release();
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "workspace-root": { type: "string" },
      once: { type: "boolean", default: false },
      "poll-interval-ms": { type: "string", default: "1000" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: node scripts/run-generation-worker.mjs [--workspace-root <directory>] [--once] [--poll-interval-ms 1000]");
    console.log("Requires BUILDING_ENGINE_WORKSPACE when --workspace-root is omitted. Ctrl+C stops polling after the active job finishes.");
    return;
  }
  if (positionals.length) throw new TypeError("Unexpected positional arguments.");
  const workspaceRoot = values["workspace-root"] ?? process.env.BUILDING_ENGINE_WORKSPACE;
  const pollIntervalMs = Number(values["poll-interval-ms"]);
  if (!Number.isInteger(pollIntervalMs)) throw new TypeError("--poll-interval-ms must be an integer.");

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await runGenerationWorker({ workspaceRoot, once: values.once, pollIntervalMs, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
