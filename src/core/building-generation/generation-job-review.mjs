import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { getGenerationJob, updateGenerationJob } from "./generation-job-queue.mjs";

export const GENERATION_REVIEW_SCHEMA_VERSION = "1.0.0";
export const GENERATION_REVIEW_DECISIONS = Object.freeze(["approved", "rejected", "changes_requested"]);
export const REQUIRED_GENERATION_REVIEW_CHECKS = Object.freeze([
  "rightsVerified",
  "sourceIdentityVerified",
  "architectureReviewed",
  "metricScaleVerified",
  "horizontalGeoreferenceVerified",
  "verticalDatumVerified",
  "qaReportReviewed",
]);

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const JOBS_SEGMENTS = [".building-engine", "generation-queue", "jobs"];
const MAX_MODEL_BYTES = 512 * 1024 * 1024;
const MAX_REPORT_BYTES = 5 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a safe workspace-relative path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(label + " must not contain empty, dot or parent path segments.");
  }
  return value;
}

function checkPlausibleGlb(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 ||
      bytes.toString("ascii", 0, 4) !== "glTF" ||
      bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error("Candidate must be a structurally plausible GLB 2.0 file.");
  }
  let offset = 12;
  let jsonSeen = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("Candidate GLB has a truncated chunk header.");
    const chunkLength = bytes.readUInt32LE(offset);
    const chunkType = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkLength % 4 !== 0 || chunkEnd > bytes.length) {
      throw new Error("Candidate GLB has an invalid or truncated chunk.");
    }
    if (!jsonSeen) {
      if (chunkType !== 0x4e4f534a || chunkLength === 0) {
        throw new Error("Candidate GLB must begin with a JSON chunk.");
      }
      let json;
      try {
        json = JSON.parse(bytes.toString("utf8", chunkStart, chunkEnd).trimEnd());
      } catch {
        throw new Error("Candidate GLB JSON chunk is invalid.");
      }
      if (!isRecord(json) || !isRecord(json.asset) || json.asset.version !== "2.0") {
        throw new Error("Candidate GLB must declare asset.version 2.0.");
      }
      jsonSeen = true;
    } else if (chunkType === 0x4e4f534a) {
      throw new Error("Candidate GLB must not contain multiple JSON chunks.");
    }
    offset = chunkEnd;
  }
  if (!jsonSeen || offset !== bytes.length) {
    throw new Error("Candidate GLB chunk boundaries do not match its declared length.");
  }
}

async function resolveWorkspaceFile(root, relativePath, label, maxBytes) {
  safeRelativePath(relativePath, label);
  const filePath = path.resolve(root, ...relativePath.split("/"));
  if (!inside(root, filePath)) throw new TypeError(label + " must remain inside the workspace.");
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new TypeError(label + " must be a regular non-symlink file.");
  }
  if (info.size < 1 || info.size > maxBytes) {
    throw new RangeError(label + " is empty or exceeds the " + maxBytes + " byte limit.");
  }
  const real = await realpath(filePath);
  if (!inside(root, real)) throw new TypeError(label + " resolves outside the workspace.");
  return { real, size: info.size };
}

async function ensureJobDirectory(root, jobId) {
  const segments = [...JOBS_SEGMENTS, jobId];
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new Error("Generation job not found.");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError("Unsafe generation job directory: " + next);
    }
    current = await realpath(next);
    if (!inside(root, current)) throw new TypeError("Generation job path escapes the workspace.");
  }
  return current;
}

async function writeJsonAtomically(filePath, value) {
  const tempPath = filePath + "." + randomUUID() + ".tmp";
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function validateReviewInput(input) {
  if (!isRecord(input)) throw new TypeError("Review request must be a JSON object.");
  if (!GENERATION_REVIEW_DECISIONS.includes(input.decision)) {
    throw new TypeError("decision must be approved, rejected or changes_requested.");
  }
  if (typeof input.reviewer !== "string" || !input.reviewer.trim() || input.reviewer.trim().length > 200) {
    throw new TypeError("reviewer is required and must be at most 200 characters.");
  }
  if (typeof input.notes !== "string" || !input.notes.trim() || input.notes.trim().length > 4000) {
    throw new TypeError("notes are required and must be at most 4000 characters.");
  }
  if (!isRecord(input.checks)) throw new TypeError("checks must be an object.");
  const checks = {};
  for (const key of REQUIRED_GENERATION_REVIEW_CHECKS) {
    if (typeof input.checks[key] !== "boolean") {
      throw new TypeError("checks." + key + " must be an explicit boolean.");
    }
    checks[key] = input.checks[key];
  }
  if (input.decision === "approved" && REQUIRED_GENERATION_REVIEW_CHECKS.some((key) => checks[key] !== true)) {
    throw new Error("Approval requires every review check to be explicitly true.");
  }
  return {
    decision: input.decision,
    reviewer: input.reviewer.trim(),
    notes: input.notes.trim(),
    checks,
  };
}

async function verifyCandidate(root, job) {
  const result = job.result;
  if (!isRecord(result) || result.status !== "completed-requires-review" ||
      typeof result.modelPath !== "string" || typeof result.reportPath !== "string" ||
      !SHA256.test(result.modelSha256 ?? "")) {
    throw new Error("Completed job is missing a reviewable model and QA report.");
  }

  const model = await resolveWorkspaceFile(root, result.modelPath, "Generated model", MAX_MODEL_BYTES);
  const modelBytes = await readFile(model.real);
  checkPlausibleGlb(modelBytes);
  const actualModelSha256 = sha256(modelBytes);
  if (actualModelSha256 !== result.modelSha256) {
    throw new Error("Generated model SHA-256 mismatch; refusing to record a review.");
  }

  const reportFile = await resolveWorkspaceFile(root, result.reportPath, "Generation QA report", MAX_REPORT_BYTES);
  let report;
  try {
    report = JSON.parse(await readFile(reportFile.real, "utf8"));
  } catch {
    throw new Error("Generation QA report is not valid JSON.");
  }
  if (!isRecord(report) ||
      report.status !== "completed-requires-review" ||
      report.mapReady !== false ||
      report.publicationEligible !== false ||
      report.output?.modelSha256 !== actualModelSha256) {
    throw new Error("Generation QA report is incomplete or does not match the review candidate.");
  }

  return {
    modelPath: result.modelPath,
    reportPath: result.reportPath,
    modelSha256: actualModelSha256,
    reportSha256: sha256(await readFile(reportFile.real)),
    modelBytes: model.size,
  };
}

/**
 * Record an explicit operator review after verifying the generated model and QA report.
 * Review decisions do not change mapReady/publicationEligible and do not publish assets.
 */
export async function reviewGenerationJob({ workspaceRoot, jobId, input, now = new Date() }) {
  if (typeof jobId !== "string" || !SAFE_ID.test(jobId)) {
    throw new TypeError("jobId must be a safe identifier.");
  }
  const reviewInput = validateReviewInput(input);
  const reviewedAt = new Date(now);
  if (!Number.isFinite(reviewedAt.getTime())) throw new TypeError("now must be a valid timestamp.");
  const timestamp = reviewedAt.toISOString();
  const root = await realpath(path.resolve(workspaceRoot));
  if (!inside(root, path.resolve(root))) throw new TypeError("Invalid workspace root.");
  await getGenerationJob({ workspaceRoot: root, jobId });
  const jobDirectory = await ensureJobDirectory(root, jobId);
  const lockPath = path.join(jobDirectory, "review.lock");
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("A review is already being recorded for this job.");
    throw error;
  }

  try {
    const candidate = await getGenerationJob({ workspaceRoot: root, jobId });
    if (candidate.status !== "completed") {
      throw new Error("Only completed generation jobs can be reviewed.");
    }
    if (candidate.review?.decision === "approved") {
      throw new Error("An approved generation review is immutable; create a new generation job for a replacement candidate.");
    }
    const candidateEvidence = await verifyCandidate(root, candidate);
    const reviewId = "review-" + timestamp.replace(/[-:.TZ]/g, "") + "-" + randomUUID().slice(0, 8);
    const reviewsDirectory = path.join(jobDirectory, "reviews");
    await mkdir(reviewsDirectory, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    const realReviewsDirectory = await realpath(reviewsDirectory);
    if (!inside(jobDirectory, realReviewsDirectory)) throw new TypeError("Review history directory escapes the job workspace.");
    const recordPath = path.posix.join(...JOBS_SEGMENTS, jobId, "reviews", reviewId + ".json");
    const record = {
      schemaVersion: GENERATION_REVIEW_SCHEMA_VERSION,
      reviewId,
      jobId,
      buildingId: candidate.buildingId,
      decision: reviewInput.decision,
      reviewer: reviewInput.reviewer,
      reviewedAt: timestamp,
      notes: reviewInput.notes,
      checks: reviewInput.checks,
      candidate: candidateEvidence,
      mapReady: false,
      publicationEligible: false,
      publicationAction: "not-performed",
    };
    const recordFile = path.join(realReviewsDirectory, reviewId + ".json");
    await writeJsonAtomically(recordFile, record);
    const recordSha256 = sha256(await readFile(recordFile));

    const updated = await updateGenerationJob({
      workspaceRoot: root,
      jobId,
      update: (state) => {
        if (state.status !== "completed") throw new Error("Generation job changed status during review.");
        if (state.review?.decision === "approved") {
          throw new Error("An approved generation review is immutable.");
        }
        state.review = {
          reviewId,
          decision: record.decision,
          reviewer: record.reviewer,
          reviewedAt: record.reviewedAt,
          notes: record.notes,
          checks: record.checks,
          candidateSha256: record.candidate.modelSha256,
          recordPath,
          recordSha256,
          mapReady: false,
          publicationEligible: false,
        };
        state.mapReady = false;
        state.publicationEligible = false;
      },
    });
    return { job: updated.job, review: record };
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
