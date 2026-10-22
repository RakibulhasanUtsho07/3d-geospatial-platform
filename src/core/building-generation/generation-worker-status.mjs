import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const GENERATION_WORKER_STATUS_SCHEMA_VERSION = "1.0.0";
export const DEFAULT_WORKER_STATUS_STALE_AFTER_MS = 90_000;
const STATUS_SEGMENTS = [".building-engine", "generation-queue"];
const STATUS_FILE = "worker-status.json";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const WORKER_STATES = new Set(["running", "stopped"]);
const WORKER_PHASES = new Set(["starting", "idle", "processing", "stopping", "stopped"]);
const MAX_ERROR_LENGTH = 1200;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

function isoTimestamp(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(label + " must be a valid timestamp.");
  return parsed.toISOString();
}

async function resolveWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("workspaceRoot is required.");
  }
  return realpath(path.resolve(workspaceRoot));
}

async function resolveQueueDirectory(root, { create }) {
  let current = root;
  for (const segment of STATUS_SEGMENTS) {
    const next = path.join(current, segment);
    try {
      const entry = await lstat(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Worker status path must not contain symbolic links or non-directories.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!create) return null;
      await mkdir(next, { mode: 0o700 });
      const created = await lstat(next);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new TypeError("Unsafe worker status directory.");
      }
    }
    current = await realpath(next);
    if (!inside(root, current)) throw new TypeError("Worker status directory escapes workspaceRoot.");
  }
  return current;
}

function validateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schemaVersion !== GENERATION_WORKER_STATUS_SCHEMA_VERSION ||
      !SAFE_ID.test(value.workerId ?? "") ||
      !WORKER_STATES.has(value.status) ||
      !WORKER_PHASES.has(value.phase) ||
      !Number.isInteger(value.pid) || value.pid <= 0 ||
      typeof value.hostname !== "string" || !value.hostname ||
      (value.currentJobId !== null && !SAFE_ID.test(value.currentJobId ?? "")) ||
      (value.lastError !== null && typeof value.lastError !== "string")) {
    throw new TypeError("Generation worker status record is invalid.");
  }
  return {
    schemaVersion: value.schemaVersion,
    workerId: value.workerId,
    status: value.status,
    phase: value.phase,
    pid: value.pid,
    hostname: value.hostname,
    startedAt: isoTimestamp(value.startedAt, "startedAt"),
    heartbeatAt: isoTimestamp(value.heartbeatAt, "heartbeatAt"),
    currentJobId: value.currentJobId,
    lastError: value.lastError,
  };
}

async function readStoredStatus(root) {
  const queueDirectory = await resolveQueueDirectory(root, { create: false });
  if (!queueDirectory) return null;
  const filePath = path.join(queueDirectory, STATUS_FILE);
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new TypeError("Generation worker status must be a regular non-symlink file.");
  }
  const bytes = await readFile(filePath);
  if (bytes.length > 64 * 1024) throw new RangeError("Generation worker status file exceeds its limit.");
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Generation worker status file is not valid JSON.");
  }
  return validateRecord(parsed);
}

/**
 * Persist an operational heartbeat for the single file-backed generation worker.
 * This is service health information only; it does not change any job's lifecycle.
 */
export async function writeGenerationWorkerStatus({
  workspaceRoot,
  workerId,
  status = "running",
  phase = "idle",
  currentJobId = null,
  startedAt = new Date(),
  lastError = null,
  now = new Date(),
}) {
  const root = await resolveWorkspaceRoot(workspaceRoot);
  safeId(workerId, "workerId");
  if (!WORKER_STATES.has(status)) throw new TypeError("status must be running or stopped.");
  if (!WORKER_PHASES.has(phase)) throw new TypeError("phase is invalid.");
  if (currentJobId !== null) safeId(currentJobId, "currentJobId");
  if (status === "stopped" && currentJobId !== null) {
    throw new TypeError("a stopped worker cannot retain a currentJobId.");
  }
  if (lastError !== null && typeof lastError !== "string") {
    throw new TypeError("lastError must be a string or null.");
  }

  const nowIso = isoTimestamp(now, "now");
  const startedIso = isoTimestamp(startedAt, "startedAt");
  const record = validateRecord({
    schemaVersion: GENERATION_WORKER_STATUS_SCHEMA_VERSION,
    workerId,
    status,
    phase,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: startedIso,
    heartbeatAt: nowIso,
    currentJobId,
    lastError: lastError === null ? null : lastError.slice(0, MAX_ERROR_LENGTH),
  });

  const queueDirectory = await resolveQueueDirectory(root, { create: true });
  const filePath = path.join(queueDirectory, STATUS_FILE);
  try {
    const current = await lstat(filePath);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new TypeError("Refusing to replace a non-regular worker status file.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const tempPath = filePath + "." + randomUUID() + ".tmp";
  await writeFile(tempPath, JSON.stringify(record, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return record;
}

/**
 * Read sanitized worker health. Missing, stopped, and stale workers are explicit,
 * so a queued job does not falsely imply that a worker is actually consuming it.
 */
export async function getGenerationWorkerStatus({
  workspaceRoot,
  now = new Date(),
  staleAfterMs = DEFAULT_WORKER_STATUS_STALE_AFTER_MS,
} = {}) {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1000 || staleAfterMs > 24 * 60 * 60 * 1000) {
    throw new RangeError("staleAfterMs must be between 1000 and 86400000.");
  }
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid timestamp.");
  const root = await resolveWorkspaceRoot(workspaceRoot);
  const stored = await readStoredStatus(root);
  if (!stored) {
    return {
      availability: "offline",
      workerStatus: "offline",
      phase: "offline",
      online: false,
      workerId: null,
      pid: null,
      hostname: null,
      startedAt: null,
      heartbeatAt: null,
      currentJobId: null,
      lastError: null,
    };
  }

  const ageMs = Math.max(0, nowMs - Date.parse(stored.heartbeatAt));
  let availability;
  if (stored.status === "stopped") availability = "stopped";
  else availability = ageMs > staleAfterMs ? "stale" : "online";

  return {
    availability,
    workerStatus: stored.status,
    phase: stored.phase,
    online: availability === "online",
    workerId: stored.workerId,
    pid: stored.pid,
    hostname: stored.hostname,
    startedAt: stored.startedAt,
    heartbeatAt: stored.heartbeatAt,
    heartbeatAgeMs: ageMs,
    currentJobId: stored.currentJobId,
    lastError: stored.lastError,
  };
}
