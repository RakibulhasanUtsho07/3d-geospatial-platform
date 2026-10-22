import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_WORKER_STATUS_STALE_AFTER_MS,
  getGenerationWorkerStatus,
  writeGenerationWorkerStatus,
} from "../src/core/building-generation/generation-worker-status.mjs";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-worker-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("returns an explicit offline result when no worker has written a heartbeat", async (t) => {
  const root = await workspace(t);
  const result = await getGenerationWorkerStatus({ workspaceRoot: root });
  assert.equal(result.availability, "offline");
  assert.equal(result.online, false);
  assert.equal(result.heartbeatAt, null);
  assert.equal(result.currentJobId, null);
});

test("writes a bounded running heartbeat and reports active job information", async (t) => {
  const root = await workspace(t);
  const now = "2026-10-22T12:00:00.000Z";
  await writeGenerationWorkerStatus({
    workspaceRoot: root,
    workerId: "worker-one",
    status: "running",
    phase: "processing",
    currentJobId: "gen-demo-01",
    startedAt: now,
    lastError: "previous non-fatal failure",
    now,
  });
  const result = await getGenerationWorkerStatus({ workspaceRoot: root, now: "2026-10-22T12:00:10.000Z" });
  assert.equal(result.availability, "online");
  assert.equal(result.online, true);
  assert.equal(result.phase, "processing");
  assert.equal(result.currentJobId, "gen-demo-01");
  assert.equal(result.lastError, "previous non-fatal failure");
  assert.ok(result.heartbeatAgeMs <= DEFAULT_WORKER_STATUS_STALE_AFTER_MS);

  const statusFile = path.join(root, ".building-engine", "generation-queue", "worker-status.json");
  const fileStat = await (await import("node:fs/promises")).stat(statusFile);
  assert.equal((fileStat.mode & 0o777), 0o600);
  const saved = JSON.parse(await readFile(statusFile, "utf8"));
  assert.equal(saved.workerId, "worker-one");
  assert.equal(saved.currentJobId, "gen-demo-01");
});

test("reports a stale heartbeat instead of treating a dead worker as online", async (t) => {
  const root = await workspace(t);
  await writeGenerationWorkerStatus({
    workspaceRoot: root,
    workerId: "worker-stale",
    status: "running",
    phase: "idle",
    startedAt: "2026-10-22T12:00:00.000Z",
    now: "2026-10-22T12:00:00.000Z",
  });
  const result = await getGenerationWorkerStatus({
    workspaceRoot: root,
    now: "2026-10-22T12:03:00.000Z",
  });
  assert.equal(result.availability, "stale");
  assert.equal(result.online, false);
});

test("a cleanly stopped worker is distinguishable from a missing heartbeat", async (t) => {
  const root = await workspace(t);
  await writeGenerationWorkerStatus({
    workspaceRoot: root,
    workerId: "worker-stop",
    status: "stopped",
    phase: "stopped",
    currentJobId: null,
  });
  const result = await getGenerationWorkerStatus({ workspaceRoot: root });
  assert.equal(result.availability, "stopped");
  assert.equal(result.workerStatus, "stopped");
  assert.equal(result.online, false);
});

test("refuses unsafe status paths, symlinked status files and malformed records", async (t) => {
  const root = await workspace(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "generation-status-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));

  await mkdir(path.join(root, ".building-engine"), { recursive: true });
  await symlink(outside, path.join(root, ".building-engine", "generation-queue"));
  await assert.rejects(
    writeGenerationWorkerStatus({ workspaceRoot: root, workerId: "unsafe-worker" }),
    /symbolic links/,
  );

  await rm(path.join(root, ".building-engine", "generation-queue"), { recursive: true, force: true });
  const queueDirectory = path.join(root, ".building-engine", "generation-queue");
  await mkdir(queueDirectory, { recursive: true });
  await symlink(path.join(outside, "worker-status.json"), path.join(queueDirectory, "worker-status.json"));
  await assert.rejects(
    writeGenerationWorkerStatus({ workspaceRoot: root, workerId: "symlink-file" }),
    /non-regular worker status file/,
  );

  await rm(path.join(queueDirectory, "worker-status.json"));
  await writeFile(path.join(queueDirectory, "worker-status.json"), "{broken");
  await assert.rejects(getGenerationWorkerStatus({ workspaceRoot: root }), /not valid JSON/);
});
