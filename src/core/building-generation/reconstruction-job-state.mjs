import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const RECONSTRUCTION_JOB_SCHEMA_VERSION = "1.0.0";
export const RECONSTRUCTION_STAGE_ARTIFACT_SCHEMA_VERSION = "1.0.0";

export const RECONSTRUCTION_STAGE_IDS = Object.freeze([
  "ingest",
  "image-analysis",
  "tiled-analysis",
  "per-view-sketch",
  "view-registration",
  "wireframe",
  "iterative-sketch-repair",
  "volume-and-facade-model",
  "geometry-repair",
  "texture",
  "final-acceptance",
]);

const JOB_STATE_FILE = "job-state.json";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const STAGE_STATUSES = new Set(["pending", "running", "completed", "failed", "stale"]);
const JOB_STATUSES = new Set(["queued", "running", "completed", "failed"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier of at most 80 characters");
  }
  return value;
}

function normalizeJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON values must not contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("JSON values must not contain circular references");
    ancestors.add(value);
    const result = value.map((item) => normalizeJson(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects");
    }
    if (ancestors.has(value)) throw new TypeError("JSON values must not contain circular references");
    ancestors.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError("JSON values must not contain undefined fields");
      result[key] = normalizeJson(value[key], ancestors);
    }
    ancestors.delete(value);
    return result;
  }
  throw new TypeError("value is not JSON serializable");
}

function cloneJson(value, label) {
  try {
    return JSON.parse(JSON.stringify(normalizeJson(value)));
  } catch (error) {
    throw new TypeError(label + " must be valid JSON data: " + error.message);
  }
}

function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value));
}

function hashJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function fingerprintStageInput({ stageId, inputs, parameters = {} }) {
  assertStageId(stageId);
  return hashJson({
    schemaVersion: RECONSTRUCTION_STAGE_ARTIFACT_SCHEMA_VERSION,
    stageId,
    inputs: inputs ?? {},
    parameters,
  });
}

function nowIso(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date or timestamp");
  return date.toISOString();
}

function assertStageId(stageId) {
  if (!RECONSTRUCTION_STAGE_IDS.includes(stageId)) {
    throw new TypeError("unknown reconstruction stage: " + String(stageId));
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

async function ensureDirectory(root, segments, create) {
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(next);
    } catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error;
      try {
        await mkdir(next);
      } catch (createError) {
        if (createError?.code !== "EEXIST") throw createError;
      }
      entry = await lstat(next);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError("unsafe reconstruction job directory: " + next);
    }
    current = await realpath(next);
    if (!inside(root, current)) {
      throw new TypeError("reconstruction job directory resolves outside workspaceRoot");
    }
  }
  return current;
}

async function resolveJobDirectory({ workspaceRoot, buildingId, jobId, create = false }) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("workspaceRoot is required");
  }
  safeId(buildingId, "buildingId");
  safeId(jobId, "jobId");
  const root = await realpath(path.resolve(workspaceRoot));
  return ensureDirectory(root, [".building-engine", "reconstruction-jobs", buildingId, jobId], create);
}

function safeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\")) {
    throw new TypeError("artifact paths must be non-empty POSIX-relative paths");
  }
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new TypeError("artifact path must be relative");
  }
  const segments = relativePath.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("artifact path contains an unsafe segment");
  }
  return relativePath;
}

async function assertSafeFile(root, filePath, allowMissing = false) {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return false;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError("expected a regular non-symlink file: " + filePath);
  }
  const resolved = await realpath(filePath);
  if (!inside(root, resolved)) throw new TypeError("file resolves outside its expected directory");
  return true;
}

async function atomicWriteJson(filePath, value, { replace = false, containmentRoot } = {}) {
  const root = containmentRoot ?? path.dirname(filePath);
  const exists = await assertSafeFile(root, filePath, true);
  if (exists && !replace) throw new Error("refusing to overwrite an immutable artifact: " + filePath);
  const temporary = filePath + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJsonFile(root, filePath) {
  await assertSafeFile(root, filePath);
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new TypeError("could not read valid JSON from " + filePath + ": " + error.message);
  }
}

function artifactRecordIsValid(record) {
  return isRecord(record) &&
    typeof record.artifactId === "string" &&
    Number.isInteger(record.revision) && record.revision > 0 &&
    typeof record.path === "string" &&
    SHA256.test(record.contentSha256) &&
    SHA256.test(record.inputFingerprint) &&
    typeof record.createdAt === "string";
}

function validateJobState(job) {
  if (!isRecord(job) ||
      job.schemaId !== "reconstruction-job-state" ||
      job.schemaVersion !== RECONSTRUCTION_JOB_SCHEMA_VERSION) {
    throw new TypeError("unsupported reconstruction job-state schema");
  }
  safeId(job.buildingId, "buildingId");
  safeId(job.jobId, "jobId");
  if (!JOB_STATUSES.has(job.status)) throw new TypeError("invalid reconstruction job status");
  if (!Array.isArray(job.stages) || job.stages.length !== RECONSTRUCTION_STAGE_IDS.length) {
    throw new TypeError("job state must contain every reconstruction stage in order");
  }
  if (!isRecord(job.sourceManifest) && !Array.isArray(job.sourceManifest)) {
    throw new TypeError("job sourceManifest must be an object or array");
  }
  if (!isRecord(job.config)) throw new TypeError("job config must be an object");
  if (hashJson(job.sourceManifest) !== job.sourceManifestSha256 ||
      hashJson(job.config) !== job.configSha256) {
    throw new TypeError("job inputs do not match their recorded SHA-256 fingerprints");
  }
  if (job.mapReady !== false || job.publicationEligible !== false) {
    throw new TypeError("reconstruction jobs must remain fail-closed until separately approved");
  }

  for (let index = 0; index < RECONSTRUCTION_STAGE_IDS.length; index += 1) {
    const stage = job.stages[index];
    if (!isRecord(stage) || stage.id !== RECONSTRUCTION_STAGE_IDS[index] ||
        stage.order !== index || !STAGE_STATUSES.has(stage.status)) {
      throw new TypeError("job stages are invalid or out of order");
    }
    if (!Number.isInteger(stage.attempts) || stage.attempts < 0 ||
        !Array.isArray(stage.artifacts)) {
      throw new TypeError("stage attempt or artifact history is invalid: " + stage.id);
    }
    for (const record of stage.artifacts) {
      if (!artifactRecordIsValid(record)) {
        throw new TypeError("invalid artifact history entry for stage " + stage.id);
      }
      safeRelativePath(record.path);
    }
    if (stage.activeArtifactId !== null &&
        !stage.artifacts.some((record) => record.artifactId === stage.activeArtifactId)) {
      throw new TypeError("active artifact is missing from stage history: " + stage.id);
    }
    if (stage.status === "completed" && stage.activeArtifactId === null) {
      throw new TypeError("completed stage has no active artifact: " + stage.id);
    }
    if (stage.status === "running" && !SHA256.test(stage.inputFingerprint)) {
      throw new TypeError("running stage has no valid input fingerprint: " + stage.id);
    }
  }
  return job;
}

export function validateStageArtifact(artifact) {
  if (!isRecord(artifact) ||
      artifact.schemaId !== "reconstruction-stage-artifact" ||
      artifact.schemaVersion !== RECONSTRUCTION_STAGE_ARTIFACT_SCHEMA_VERSION) {
    throw new TypeError("unsupported reconstruction stage-artifact schema");
  }
  safeId(artifact.buildingId, "buildingId");
  safeId(artifact.jobId, "jobId");
  assertStageId(artifact.stageId);
  if (!Number.isInteger(artifact.revision) || artifact.revision < 1) {
    throw new TypeError("stage artifact revision must be a positive integer");
  }
  if (typeof artifact.createdAt !== "string" ||
      !Number.isFinite(Date.parse(artifact.createdAt))) {
    throw new TypeError("stage artifact createdAt must be an ISO-compatible timestamp");
  }
  if (!SHA256.test(artifact.inputFingerprint)) throw new TypeError("invalid stage input fingerprint");
  if (!isRecord(artifact.outputs) || !isRecord(artifact.payload) ||
      !Array.isArray(artifact.upstreamArtifacts)) {
    throw new TypeError("stage artifact outputs, payload, or upstreamArtifacts are invalid");
  }
  if (artifact.mapReady !== false || artifact.publicationEligible !== false) {
    throw new TypeError("stage artifacts must not grant map readiness or publication eligibility");
  }
  if (!SHA256.test(artifact.sourceManifestSha256) || !SHA256.test(artifact.configSha256)) {
    throw new TypeError("stage artifact provenance hashes are invalid");
  }
  const body = { ...artifact };
  delete body.contentSha256;
  if (!SHA256.test(artifact.contentSha256) || hashJson(body) !== artifact.contentSha256) {
    throw new TypeError("stage artifact content checksum mismatch");
  }
  return artifact;
}

async function readArtifactRecord(jobDirectory, stage, record) {
  const relative = safeRelativePath(record.path);
  const filePath = path.resolve(jobDirectory, ...relative.split("/"));
  if (!inside(jobDirectory, filePath)) throw new TypeError("artifact path resolves outside job directory");
  const artifact = validateStageArtifact(await readJsonFile(jobDirectory, filePath));
  if (artifact.stageId !== stage.id ||
      artifact.jobId !== path.basename(jobDirectory) ||
      artifact.buildingId !== path.basename(path.dirname(jobDirectory)) ||
      artifact.revision !== record.revision ||
      artifact.contentSha256 !== record.contentSha256 ||
      artifact.inputFingerprint !== record.inputFingerprint ||
      artifact.createdAt !== record.createdAt) {
    throw new TypeError("stage artifact does not match its state record: " + record.artifactId);
  }
  return artifact;
}

async function verifyActiveArtifacts(jobDirectory, job) {
  for (const stage of job.stages) {
    if (stage.activeArtifactId === null) continue;
    const record = stage.artifacts.find((item) => item.artifactId === stage.activeArtifactId);
    await readArtifactRecord(jobDirectory, stage, record);
  }
}

async function loadJob(jobDirectory) {
  const job = validateJobState(await readJsonFile(jobDirectory, path.join(jobDirectory, JOB_STATE_FILE)));
  if (path.basename(jobDirectory) !== job.jobId ||
      path.basename(path.dirname(jobDirectory)) !== job.buildingId) {
    throw new TypeError("job-state identity does not match its directory");
  }
  await verifyActiveArtifacts(jobDirectory, job);
  return job;
}

async function persistJob(jobDirectory, job) {
  validateJobState(job);
  await atomicWriteJson(path.join(jobDirectory, JOB_STATE_FILE), job, {
    replace: true,
    containmentRoot: jobDirectory,
  });
}

function createStageState(id, order) {
  return {
    id,
    order,
    status: "pending",
    attempts: 0,
    inputFingerprint: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    activeArtifactId: null,
    artifacts: [],
  };
}

function refreshJobStatus(job, timestamp) {
  job.updatedAt = timestamp;
  job.mapReady = false;
  job.publicationEligible = false;
  if (job.stages.some((stage) => stage.status === "running")) job.status = "running";
  else if (job.stages.some((stage) => stage.status === "failed")) job.status = "failed";
  else if (job.stages.at(-1).status === "completed") job.status = "completed";
  else job.status = "queued";
}

function recoverInterruptedStage(job, timestamp) {
  const running = job.stages.filter((stage) => stage.status === "running");
  if (running.length > 1) throw new TypeError("job state contains more than one running stage");
  if (!running.length) return false;
  const stage = running[0];
  stage.status = "failed";
  stage.finishedAt = timestamp;
  stage.error = {
    code: "STAGE_INTERRUPTED",
    name: "InterruptedStageError",
    message: "The process stopped while this stage was running; retry this stage to resume.",
  };
  refreshJobStatus(job, timestamp);
  return true;
}

function activeRecord(stage) {
  return stage.artifacts.find((record) => record.artifactId === stage.activeArtifactId) ?? null;
}

export async function createOrResumeReconstructionJob({
  workspaceRoot,
  buildingId,
  jobId,
  sourceManifest = [],
  config = {},
  recoverInterrupted = true,
  now,
}) {
  safeId(buildingId, "buildingId");
  safeId(jobId, "jobId");
  const normalizedManifest = cloneJson(sourceManifest, "sourceManifest");
  const normalizedConfig = cloneJson(config, "config");
  if (!Array.isArray(normalizedManifest) && !isRecord(normalizedManifest)) {
    throw new TypeError("sourceManifest must be an object or array");
  }
  if (!isRecord(normalizedConfig)) throw new TypeError("config must be an object");
  const jobDirectory = await resolveJobDirectory({ workspaceRoot, buildingId, jobId, create: true });
  const statePath = path.join(jobDirectory, JOB_STATE_FILE);
  const exists = await assertSafeFile(jobDirectory, statePath, true);
  const timestamp = nowIso(now);

  if (exists) {
    const job = await loadJob(jobDirectory);
    if (job.sourceManifestSha256 !== hashJson(normalizedManifest) ||
        job.configSha256 !== hashJson(normalizedConfig)) {
      throw new TypeError("jobId already belongs to different source/config inputs; use a new jobId");
    }
    if (recoverInterrupted && recoverInterruptedStage(job, timestamp)) {
      await persistJob(jobDirectory, job);
    }
    return { job, jobDirectory, resumed: true };
  }

  const job = {
    schemaId: "reconstruction-job-state",
    schemaVersion: RECONSTRUCTION_JOB_SCHEMA_VERSION,
    buildingId,
    jobId,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "queued",
    sourceManifest: normalizedManifest,
    sourceManifestSha256: hashJson(normalizedManifest),
    config: normalizedConfig,
    configSha256: hashJson(normalizedConfig),
    stages: RECONSTRUCTION_STAGE_IDS.map(createStageState),
    mapReady: false,
    publicationEligible: false,
  };
  await persistJob(jobDirectory, job);
  return { job, jobDirectory, resumed: false };
}

export async function readReconstructionJob({
  workspaceRoot,
  buildingId,
  jobId,
  recoverInterrupted = false,
  now,
}) {
  const jobDirectory = await resolveJobDirectory({ workspaceRoot, buildingId, jobId, create: false });
  const job = await loadJob(jobDirectory);
  if (recoverInterrupted && recoverInterruptedStage(job, nowIso(now))) {
    await persistJob(jobDirectory, job);
  }
  return { job, jobDirectory };
}

export async function startReconstructionStage({
  workspaceRoot,
  buildingId,
  jobId,
  stageId,
  inputFingerprint,
  force = false,
  now,
}) {
  assertStageId(stageId);
  if (!SHA256.test(inputFingerprint)) {
    throw new TypeError("inputFingerprint must be a SHA-256 hex digest; use fingerprintStageInput()");
  }
  const jobDirectory = await resolveJobDirectory({ workspaceRoot, buildingId, jobId, create: false });
  const job = await loadJob(jobDirectory);
  const index = RECONSTRUCTION_STAGE_IDS.indexOf(stageId);
  const stage = job.stages[index];
  if (job.stages.some((item) => item.status === "running")) {
    throw new Error("another reconstruction stage is already running");
  }
  for (const previous of job.stages.slice(0, index)) {
    if (previous.status !== "completed" || previous.activeArtifactId === null) {
      throw new Error("stage " + stageId + " cannot start before " + previous.id + " is completed");
    }
  }

  if (stage.status === "completed" && !force) {
    if (stage.inputFingerprint === inputFingerprint) {
      const record = activeRecord(stage);
      return {
        job,
        jobDirectory,
        reused: true,
        artifact: await readArtifactRecord(jobDirectory, stage, record),
      };
    }
    throw new Error("stage " + stageId + " has completed with different inputs; pass force=true to rerun it");
  }
  if (stage.status === "running") throw new Error("stage " + stageId + " is already running");

  const timestamp = nowIso(now);
  for (const downstream of job.stages.slice(index)) {
    downstream.activeArtifactId = null;
    downstream.error = null;
    downstream.finishedAt = null;
    if (downstream.id === stageId) {
      downstream.status = "running";
      downstream.inputFingerprint = inputFingerprint;
      downstream.startedAt = timestamp;
      downstream.attempts += 1;
    } else {
      downstream.status = downstream.artifacts.length ? "stale" : "pending";
      downstream.inputFingerprint = null;
      downstream.startedAt = null;
    }
  }
  refreshJobStatus(job, timestamp);
  await persistJob(jobDirectory, job);
  return { job, jobDirectory, reused: false, artifact: null };
}

export async function completeReconstructionStage({
  workspaceRoot,
  buildingId,
  jobId,
  stageId,
  payload = {},
  outputs = {},
  now,
}) {
  assertStageId(stageId);
  const normalizedPayload = cloneJson(payload, "payload");
  const normalizedOutputs = cloneJson(outputs, "outputs");
  if (!isRecord(normalizedPayload)) throw new TypeError("stage payload must be an object");
  if (!isRecord(normalizedOutputs)) throw new TypeError("stage outputs must be an object");
  const jobDirectory = await resolveJobDirectory({ workspaceRoot, buildingId, jobId, create: false });
  const job = await loadJob(jobDirectory);
  const stage = job.stages[RECONSTRUCTION_STAGE_IDS.indexOf(stageId)];
  if (stage.status !== "running") throw new Error("stage " + stageId + " is not running");

  const revision = stage.artifacts.reduce((maximum, record) => Math.max(maximum, record.revision), 0) + 1;
  const timestamp = nowIso(now);
  const upstreamArtifacts = job.stages.slice(0, stage.order).map((previous) => {
    const record = activeRecord(previous);
    if (!record) throw new Error("required upstream artifact is missing: " + previous.id);
    return {
      stageId: previous.id,
      artifactId: record.artifactId,
      contentSha256: record.contentSha256,
    };
  });
  const body = {
    schemaId: "reconstruction-stage-artifact",
    schemaVersion: RECONSTRUCTION_STAGE_ARTIFACT_SCHEMA_VERSION,
    buildingId,
    jobId,
    stageId,
    revision,
    createdAt: timestamp,
    inputFingerprint: stage.inputFingerprint,
    sourceManifestSha256: job.sourceManifestSha256,
    configSha256: job.configSha256,
    upstreamArtifacts,
    outputs: normalizedOutputs,
    payload: normalizedPayload,
    mapReady: false,
    publicationEligible: false,
  };
  const artifact = validateStageArtifact({
    ...body,
    contentSha256: hashJson(body),
  });
  const paddedRevision = String(revision).padStart(4, "0");
  const artifactDirectory = await ensureDirectory(
    jobDirectory,
    ["artifacts", stageId, "v" + paddedRevision],
    true,
  );
  const filePath = path.join(artifactDirectory, "artifact-" + randomUUID() + ".json");
  await atomicWriteJson(filePath, artifact, { replace: false, containmentRoot: jobDirectory });
  const relativePath = path.relative(jobDirectory, filePath).split(path.sep).join("/");
  const record = {
    artifactId: stageId + "-v" + paddedRevision + "-" + randomUUID(),
    revision,
    path: relativePath,
    contentSha256: artifact.contentSha256,
    inputFingerprint: artifact.inputFingerprint,
    createdAt: artifact.createdAt,
  };
  stage.artifacts.push(record);
  stage.activeArtifactId = record.artifactId;
  stage.status = "completed";
  stage.finishedAt = timestamp;
  stage.error = null;
  refreshJobStatus(job, timestamp);
  await persistJob(jobDirectory, job);
  return { job, jobDirectory, artifact, artifactRecord: record };
}

export async function failReconstructionStage({
  workspaceRoot,
  buildingId,
  jobId,
  stageId,
  error,
  now,
}) {
  assertStageId(stageId);
  const jobDirectory = await resolveJobDirectory({ workspaceRoot, buildingId, jobId, create: false });
  const job = await loadJob(jobDirectory);
  const stage = job.stages[RECONSTRUCTION_STAGE_IDS.indexOf(stageId)];
  if (stage.status !== "running") throw new Error("stage " + stageId + " is not running");
  const timestamp = nowIso(now);
  const normalizedError = error instanceof Error
    ? { name: error.name || "Error", message: error.message || "Stage failed", code: error.code ?? "STAGE_FAILED" }
    : {
        name: isRecord(error) && typeof error.name === "string" ? error.name : "StageError",
        message: isRecord(error) && typeof error.message === "string" ? error.message : String(error ?? "Stage failed"),
        code: isRecord(error) && typeof error.code === "string" ? error.code : "STAGE_FAILED",
      };
  stage.status = "failed";
  stage.finishedAt = timestamp;
  stage.activeArtifactId = null;
  stage.error = normalizedError;
  refreshJobStatus(job, timestamp);
  await persistJob(jobDirectory, job);
  return { job, jobDirectory };
}
