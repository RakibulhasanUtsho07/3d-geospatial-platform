import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeBuildingSpec } from "./building-spec.mjs";

export const GENERATION_QUEUE_SCHEMA_VERSION = "1.0.0";
export const GENERATION_QUEUE_STATUSES = Object.freeze(["queued", "running", "completed", "failed"]);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SAFE_SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STRATEGIES = new Set(["auto", "procedural", "photogrammetry", "single-image-ai"]);
const MAX_SOURCES = 100;
const MAX_ATTEMPTS = 2;
const MAX_SPEC_BYTES = 1024 * 1024;
const QUEUE_SEGMENTS = [".building-engine", "generation-queue"];
const JOBS_SEGMENTS = [...QUEUE_SEGMENTS, "jobs"];
const WORKER_LOCK_SEGMENTS = [...QUEUE_SEGMENTS, "worker.lock"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value, label, regex = SAFE_ID) {
  if (typeof value !== "string" || !regex.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

function isKnownLicence(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    !["unknown", "n/a", "none"].includes(value.trim().toLowerCase());
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(text, "utf8") > MAX_SPEC_BYTES) {
    throw new RangeError("Generation job request must be at most 1 MiB.");
  }
  return text;
}

function safeRelativeSourcePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a safe workspace-relative POSIX path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(label + " must not contain empty, dot or parent path segments.");
  }
  return value;
}

function normalizeSources(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCES) {
    throw new TypeError("sources must be an array with at most 100 entries.");
  }
  const seen = new Set();
  return value.map((source, index) => {
    const label = "sources[" + index + "]";
    if (!isRecord(source)) throw new TypeError(label + " must be an object.");
    const sourceId = safeId(source.sourceId, label + ".sourceId", SAFE_SOURCE_ID);
    if (seen.has(sourceId)) throw new TypeError("source IDs must be unique.");
    seen.add(sourceId);
    const relativePath = safeRelativeSourcePath(source.relativePath, label + ".relativePath");
    if (!isKnownLicence(source.licence)) {
      throw new TypeError(label + ".licence must record a known permission/licence basis.");
    }
    const result = {
      sourceId,
      relativePath,
      licence: source.licence.trim().slice(0, 300),
      kind: source.kind ?? "auto",
    };
    for (const key of ["author", "attribution", "sourceUrl", "capturedAt", "description"]) {
      if (source[key] !== undefined) {
        if (typeof source[key] !== "string" || source[key].length > 2000) {
          throw new TypeError(label + "." + key + " must be a string of at most 2000 characters.");
        }
        result[key] = source[key].trim();
      }
    }
    if (!["auto", "image", "video", "floor-plan"].includes(result.kind)) {
      throw new TypeError(label + ".kind is invalid.");
    }
    return result;
  });
}

function finiteOptional(value, label, minimum, maximum) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be a finite number in [" + minimum + ", " + maximum + "].");
  }
  return value;
}

function normalizeRequest(raw) {
  if (!isRecord(raw)) throw new TypeError("Request body must be a JSON object.");
  const normalizedBuilding = normalizeBuildingSpec(raw.buildingSpec).spec;
  const buildingId = safeId(normalizedBuilding.id, "buildingSpec.id");
  const strategy = raw.strategy ?? "procedural";
  if (typeof strategy !== "string" || !STRATEGIES.has(strategy)) {
    throw new TypeError("strategy must be auto, procedural, photogrammetry or single-image-ai.");
  }
  const sources = normalizeSources(raw.sources);
  const confirmRights = raw.confirmRights === true;
  if (sources.length && !confirmRights) {
    throw new Error("confirmRights must be true after the operator has checked source rights.");
  }
  const viewSourceIds = raw.viewSourceIds === undefined ? undefined : raw.viewSourceIds;
  if (viewSourceIds !== undefined) {
    if (!Array.isArray(viewSourceIds) || viewSourceIds.length > MAX_SOURCES) {
      throw new TypeError("viewSourceIds must be an array of at most 100 source IDs.");
    }
    const seenViews = new Set();
    for (const viewId of viewSourceIds) {
      safeId(viewId, "viewSourceIds[]", SAFE_SOURCE_ID);
      if (seenViews.has(viewId)) throw new TypeError("viewSourceIds must be unique.");
      seenViews.add(viewId);
      if (!sources.some((source) => source.sourceId === viewId)) {
        throw new TypeError("viewSourceIds can select only sources included in this request.");
      }
    }
  }
  if (strategy === "single-image-ai" &&
      (raw.confirmSingleViewInference !== true || !Array.isArray(viewSourceIds) || viewSourceIds.length !== 1)) {
    throw new Error("single-image-ai requires confirmSingleViewInference=true and exactly one selected source.");
  }
  if (strategy === "photogrammetry") {
    if (raw.confirmSameBuilding !== true || raw.confirmOverlapReviewed !== true ||
        raw.confirmUpAxisReviewed !== true || !["X", "Y", "Z"].includes(raw.upAxis)) {
      throw new Error("photogrammetry requires explicit same-building, overlap and up-axis confirmations.");
    }
    if (!Array.isArray(viewSourceIds) || viewSourceIds.length < 3) {
      throw new Error("photogrammetry requires at least three selected source IDs.");
    }
  }
  if (viewSourceIds && sources.length && !viewSourceIds.every((id) => sources.some((source) => source.sourceId === id))) {
    throw new Error("Every selected view must be included in sources.");
  }
  const modelDistanceUnits = finiteOptional(raw.modelDistanceUnits, "modelDistanceUnits", Number.MIN_VALUE, 1e12);
  const realDistanceM = finiteOptional(raw.realDistanceM, "realDistanceM", Number.MIN_VALUE, 1e12);
  if ((modelDistanceUnits === undefined) !== (realDistanceM === undefined)) {
    throw new Error("modelDistanceUnits and realDistanceM must be supplied together.");
  }
  const headingDegrees = finiteOptional(raw.headingDegrees, "headingDegrees", -360, 360);
  return {
    schemaVersion: GENERATION_QUEUE_SCHEMA_VERSION,
    buildingId,
    buildingSpec: normalizedBuilding,
    strategy,
    sources,
    ...(viewSourceIds === undefined ? {} : { viewSourceIds: [...viewSourceIds] }),
    confirmRights,
    confirmSingleViewInference: raw.confirmSingleViewInference === true,
    confirmSameBuilding: raw.confirmSameBuilding === true,
    confirmOverlapReviewed: raw.confirmOverlapReviewed === true,
    confirmUpAxisReviewed: raw.confirmUpAxisReviewed === true,
    ...(raw.upAxis === undefined ? {} : { upAxis: raw.upAxis }),
    ...(modelDistanceUnits === undefined ? {} : { modelDistanceUnits, realDistanceM }),
    ...(headingDegrees === undefined ? {} : { headingDegrees }),
    ...(raw.controlPoints === undefined ? {} : { controlPoints: raw.controlPoints }),
  };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
  );
}

async function ensureDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      const entry = await lstat(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Unsafe generation queue path: " + next);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (createError) {
        if (createError?.code !== "EEXIST") throw createError;
      }
      const entry = await lstat(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Unsafe generation queue path: " + next);
      }
    }
    current = await realpath(next);
    if (!inside(root, current)) throw new TypeError("Generation queue directory escapes workspaceRoot.");
  }
  return current;
}

async function workspaceRootPath(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("workspaceRoot is required.");
  }
  return realpath(path.resolve(workspaceRoot));
}

async function writeJsonAtomically(filePath, value, { exclusive = false } = {}) {
  const tempPath = filePath + "." + randomUUID() + ".tmp";
  await writeFile(tempPath, jsonBytes(value), { flag: "wx", mode: 0o600 });
  try {
    if (exclusive) {
      await rename(tempPath, filePath);
      return;
    }
    try {
      const existing = await lstat(filePath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new TypeError("Refusing to replace a non-regular queue file.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJobState(jobDirectory) {
  const statePath = path.join(jobDirectory, "state.json");
  const stateStat = await lstat(statePath);
  if (stateStat.isSymbolicLink() || !stateStat.isFile()) throw new TypeError("Queue job state must be a regular file.");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (!isRecord(state) || state.schemaVersion !== GENERATION_QUEUE_SCHEMA_VERSION ||
      !SAFE_ID.test(state.jobId ?? "") || !SAFE_ID.test(state.buildingId ?? "") ||
      !GENERATION_QUEUE_STATUSES.includes(state.status) || !HASH.test(state.requestSha256 ?? "")) {
    throw new TypeError("Generation queue state is invalid.");
  }
  if (path.basename(jobDirectory) !== state.jobId) throw new TypeError("Queue job ID does not match its directory.");
  return state;
}

async function writeState(jobDirectory, state) {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomically(path.join(jobDirectory, "state.json"), state);
}

async function readRequest(jobDirectory, state) {
  const requestPath = path.join(jobDirectory, "request.json");
  const requestStat = await lstat(requestPath);
  if (requestStat.isSymbolicLink() || !requestStat.isFile()) throw new TypeError("Queue request must be a regular file.");
  const text = await readFile(requestPath, "utf8");
  if (hashText(text) !== state.requestSha256) throw new Error("Generation job request checksum mismatch.");
  const request = JSON.parse(text);
  if (request.jobId !== state.jobId || request.buildingId !== state.buildingId) {
    throw new Error("Generation queue request identity mismatch.");
  }
  return request;
}

export function getGenerationJobView(state) {
  return {
    jobId: state.jobId,
    buildingId: state.buildingId,
    strategy: state.strategy,
    status: state.status,
    phase: state.phase,
    attempt: state.attempt,
    maxAttempts: state.maxAttempts,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    heartbeatAt: state.heartbeatAt,
    nextAttemptAt: state.nextAttemptAt,
    lastError: state.lastError,
    result: state.result,
    ...(state.review === undefined ? {} : { review: state.review }),
    mapReady: false,
    publicationEligible: false,
  };
}

export async function enqueueGenerationJob({ workspaceRoot, input, now = new Date() }) {
  const root = await workspaceRootPath(workspaceRoot);
  const normalized = normalizeRequest(input);
  const timestamp = new Date(now).toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError("now must be a valid timestamp.");
  const jobId = "gen-" + randomUUID();
  const request = { ...normalized, jobId, createdAt: timestamp };
  const requestText = JSON.stringify(request, null, 2) + "\n";
  if (Buffer.byteLength(requestText, "utf8") > MAX_SPEC_BYTES) {
    throw new RangeError("Generation job request must be at most 1 MiB.");
  }
  const jobsDirectory = await ensureDirectory(root, JOBS_SEGMENTS);
  const jobDirectory = path.join(jobsDirectory, jobId);
  await mkdir(jobDirectory, { recursive: false, mode: 0o700 });
  const state = {
    schemaVersion: GENERATION_QUEUE_SCHEMA_VERSION,
    jobId,
    buildingId: normalized.buildingId,
    strategy: normalized.strategy,
    status: "queued",
    phase: "queued",
    attempt: 0,
    maxAttempts: MAX_ATTEMPTS,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
    nextAttemptAt: timestamp,
    lastError: null,
    result: null,
    requestSha256: hashText(requestText),
    mapReady: false,
    publicationEligible: false,
  };
  await writeFile(path.join(jobDirectory, "request.json"), requestText, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(jobDirectory, "state.json"), jsonBytes(state), { flag: "wx", mode: 0o600 });
  return getGenerationJobView(state);
}

export async function getGenerationJob({ workspaceRoot, jobId }) {
  safeId(jobId, "jobId");
  const root = await workspaceRootPath(workspaceRoot);
  const jobsDirectory = await ensureDirectory(root, JOBS_SEGMENTS);
  const jobDirectory = path.join(jobsDirectory, jobId);
  const state = await readJobState(jobDirectory);
  await readRequest(jobDirectory, state);
  return getGenerationJobView(state);
}

export async function listGenerationJobs({ workspaceRoot, limit = 20 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100.");
  }
  const root = await workspaceRootPath(workspaceRoot);
  const jobsDirectory = await ensureDirectory(root, JOBS_SEGMENTS);
  const entries = await readdir(jobsDirectory, { withFileTypes: true });
  const states = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    const directory = path.join(jobsDirectory, entry.name);
    try {
      const state = await readJobState(directory);
      await readRequest(directory, state);
      states.push(getGenerationJobView(state));
    } catch {
      // Corrupt or incomplete records fail closed and are not exposed by listing.
    }
  }
  return states.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export async function updateGenerationJob({ workspaceRoot, jobId, update }) {
  safeId(jobId, "jobId");
  if (typeof update !== "function") throw new TypeError("update must be a function.");
  const root = await workspaceRootPath(workspaceRoot);
  const jobsDirectory = await ensureDirectory(root, JOBS_SEGMENTS);
  const jobDirectory = path.join(jobsDirectory, jobId);
  const state = await readJobState(jobDirectory);
  const request = await readRequest(jobDirectory, state);
  const result = await update(state, request);
  await writeState(jobDirectory, state);
  return { job: getGenerationJobView(state), request, result };
}

export async function claimNextGenerationJob({ workspaceRoot, workerId = "worker" }) {
  safeId(workerId, "workerId");
  const root = await workspaceRootPath(workspaceRoot);
  const jobsDirectory = await ensureDirectory(root, JOBS_SEGMENTS);
  const entries = await readdir(jobsDirectory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    const directory = path.join(jobsDirectory, entry.name);
    try {
      const state = await readJobState(directory);
      if (state.status === "queued" && Date.parse(state.nextAttemptAt ?? state.createdAt) <= Date.now()) {
        candidates.push({ directory, state });
      }
    } catch {
      // Ignore invalid queue records; never execute untrusted or partial metadata.
    }
  }
  candidates.sort((a, b) => a.state.createdAt.localeCompare(b.state.createdAt));
  for (const candidate of candidates) {
    const state = candidate.state;
    const request = await readRequest(candidate.directory, state);
    state.status = "running";
    state.phase = "processing";
    state.attempt += 1;
    state.workerId = workerId;
    state.startedAt = state.startedAt ?? new Date().toISOString();
    state.finishedAt = null;
    state.heartbeatAt = new Date().toISOString();
    state.nextAttemptAt = null;
    await writeState(candidate.directory, state);
    return { job: getGenerationJobView(state), request };
  }
  return null;
}

export async function heartbeatGenerationJob({ workspaceRoot, jobId, phase = "processing" }) {
  return updateGenerationJob({
    workspaceRoot, jobId,
    update: (state) => {
      if (state.status !== "running") throw new Error("Only running jobs can receive a heartbeat.");
      state.phase = phase;
      state.heartbeatAt = new Date().toISOString();
    },
  });
}

export async function completeGenerationJob({ workspaceRoot, jobId, result }) {
  if (!isRecord(result)) throw new TypeError("result must be a JSON object.");
  return updateGenerationJob({
    workspaceRoot, jobId,
    update: (state) => {
      if (state.status !== "running") throw new Error("Only running jobs can be completed.");
      state.status = "completed";
      state.phase = "completed";
      state.finishedAt = new Date().toISOString();
      state.heartbeatAt = state.finishedAt;
      state.lastError = null;
      state.result = result;
      state.mapReady = false;
      state.publicationEligible = false;
    },
  });
}

export async function failGenerationJob({ workspaceRoot, jobId, error, retry = true }) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1200);
  return updateGenerationJob({
    workspaceRoot, jobId,
    update: (state) => {
      if (state.status !== "running") throw new Error("Only running jobs can be failed.");
      state.lastError = { name: error instanceof Error ? error.name : "Error", message };
      state.heartbeatAt = new Date().toISOString();
      if (retry && state.attempt < state.maxAttempts) {
        state.status = "queued";
        state.phase = "retry-wait";
        state.nextAttemptAt = new Date(Date.now() + Math.min(state.attempt * 5000, 30000)).toISOString();
        state.finishedAt = null;
      } else {
        state.status = "failed";
        state.phase = "failed";
        state.finishedAt = new Date().toISOString();
        state.nextAttemptAt = null;
      }
    },
  });
}

export async function recoverInterruptedGenerationJobs({ workspaceRoot }) {
  const root = await workspaceRootPath(workspaceRoot);
  const jobsDirectory = await ensureDirectory(root, JOBS_SEGMENTS);
  const entries = await readdir(jobsDirectory, { withFileTypes: true });
  const recovered = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    const directory = path.join(jobsDirectory, entry.name);
    let state;
    try {
      state = await readJobState(directory);
    } catch {
      continue;
    }
    if (state.status !== "running") continue;
    state.lastError = {
      name: "WorkerInterruptedError",
      message: "Worker stopped before recording completion; the job was recovered from durable queue state.",
    };
    state.heartbeatAt = new Date().toISOString();
    if (state.attempt < state.maxAttempts) {
      state.status = "queued";
      state.phase = "recovered";
      state.nextAttemptAt = new Date().toISOString();
      state.finishedAt = null;
    } else {
      state.status = "failed";
      state.phase = "failed";
      state.finishedAt = new Date().toISOString();
      state.nextAttemptAt = null;
    }
    await writeState(directory, state);
    recovered.push(state.jobId);
  }
  return recovered;
}

export async function acquireGenerationWorkerLock({ workspaceRoot }) {
  const root = await workspaceRootPath(workspaceRoot);
  const queueRoot = await ensureDirectory(root, QUEUE_SEGMENTS);
  const lockPath = path.join(queueRoot, "worker.lock");
  const token = randomUUID();
  const owner = { token, pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existing = null;
    try {
      existing = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    } catch {
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 5 * 60 * 1000) {
        await rm(lockPath, { recursive: true, force: true });
        return acquireGenerationWorkerLock({ workspaceRoot });
      }
      throw new Error("A generation worker lock exists; refusing to start a second worker.");
    }
    if (existing.hostname === os.hostname() && Number.isInteger(existing.pid)) {
      try {
        process.kill(existing.pid, 0);
        throw new Error("Generation worker is already running with PID " + existing.pid + ".");
      } catch (signalError) {
        if (signalError instanceof Error && signalError.message.startsWith("Generation worker is already running")) throw signalError;
        if (signalError?.code !== "ESRCH") throw signalError;
      }
      await rm(lockPath, { recursive: true, force: true });
      return acquireGenerationWorkerLock({ workspaceRoot });
    }
    throw new Error("A generation worker lock from another host exists; clear it only after verifying that host is stopped.");
  }
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return {
    workerId: os.hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 30) + "-" + process.pid,
    async release() {
      try {
        const current = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
        if (current.token === token && current.pid === process.pid) await rm(lockPath, { recursive: true, force: true });
      } catch {
        // The lock may already have been removed during shutdown recovery.
      }
    },
  };
}

/** Internal for focused tests; validate the queued request before it can reach a worker. */
export function validateGenerationJobRequest(raw) {
  const normalized = normalizeRequest(raw);
  return {
    ...normalized,
    jobId: safeId(raw.jobId, "jobId"),
    buildingId: normalized.buildingId,
  };
}
