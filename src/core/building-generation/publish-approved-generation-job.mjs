import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getGenerationJob } from "./generation-job-queue.mjs";
import { REQUIRED_GENERATION_REVIEW_CHECKS } from "./generation-job-review.mjs";
import { publishReviewedBuildingModel } from "./published-model-catalog.mjs";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const JOB_SEGMENTS = [".building-engine", "generation-queue", "jobs"];
const PREFLIGHT_SEGMENTS = [".building-engine", "publish-preflight"];
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
    relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
  );
}
function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a safe workspace-relative path.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " must not contain empty, dot or parent path segments.");
  }
  return value;
}
async function resolveWorkspaceFile(root, relativePath, label, maxBytes) {
  safeRelative(relativePath, label);
  const filePath = path.resolve(root, ...relativePath.split("/"));
  if (!inside(root, filePath)) throw new TypeError(label + " escapes the workspace.");
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError(label + " must be a regular non-symlink file.");
  if (info.size < 1 || info.size > maxBytes) throw new RangeError(label + " is empty or too large.");
  const real = await realpath(filePath);
  if (!inside(root, real)) throw new TypeError(label + " resolves outside the workspace.");
  return { real, bytes: await readFile(real) };
}
async function ensurePrivateDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      const info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Unsafe private directory: " + next);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(next, { mode: 0o700 });
      const info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Unsafe private directory: " + next);
    }
    current = await realpath(next);
    if (!inside(root, current)) throw new TypeError("Private directory escapes workspace.");
  }
  return current;
}
async function readAndVerifyQueueRequest(root, jobId) {
  const jobDirectory = await ensurePrivateDirectory(root, [...JOB_SEGMENTS, jobId]);
  const statePath = path.join(jobDirectory, "state.json");
  const requestPath = path.join(jobDirectory, "request.json");
  const [stateInfo, requestInfo] = await Promise.all([lstat(statePath), lstat(requestPath)]);
  if (stateInfo.isSymbolicLink() || !stateInfo.isFile() || requestInfo.isSymbolicLink() || !requestInfo.isFile()) {
    throw new TypeError("Generation queue state and request must be regular files.");
  }
  const [stateText, requestText] = await Promise.all([
    readFile(statePath, "utf8"),
    readFile(requestPath, "utf8"),
  ]);
  const state = JSON.parse(stateText);
  const request = JSON.parse(requestText);
  if (!isRecord(state) || !SHA256.test(state.requestSha256 ?? "") ||
      sha256(Buffer.from(requestText, "utf8")) !== state.requestSha256) {
    throw new Error("Generation request checksum mismatch.");
  }
  if (state.jobId !== jobId || request.jobId !== jobId ||
      state.buildingId !== request.buildingId || !isRecord(request.buildingSpec)) {
    throw new Error("Generation request identity does not match its queue state.");
  }
  return { request, jobDirectory };
}

/**
 * Publish only a job that has an immutable approved review record whose candidate,
 * QA report and request checksums still match. Placement remains explicit input.
 */
export async function publishApprovedGenerationJob({ workspaceRoot, jobId, placement }) {
  if (typeof jobId !== "string" || !SAFE_ID.test(jobId)) throw new TypeError("jobId must be a safe identifier.");
  if (!isRecord(placement) || !isRecord(placement.position)) {
    throw new TypeError("Explicit model placement is required, including longitude, latitude and height.");
  }
  for (const key of ["longitude", "latitude", "height"]) {
    if (typeof placement.position[key] !== "number" || !Number.isFinite(placement.position[key])) {
      throw new TypeError("placement.position." + key + " must be a finite number.");
    }
  }

  const root = await realpath(path.resolve(workspaceRoot));
  const job = await getGenerationJob({ workspaceRoot: root, jobId });
  if (job.status !== "completed") throw new Error("Only completed generation jobs can be published.");
  if (job.review?.decision !== "approved") throw new Error("A matching approved review is required before publication.");
  if (job.mapReady !== false || job.publicationEligible !== false) {
    throw new Error("Generation job unexpectedly violates the fail-closed publication state.");
  }
  const { request } = await readAndVerifyQueueRequest(root, jobId);
  if (request.buildingId !== job.buildingId || request.buildingSpec.id !== job.buildingId) {
    throw new Error("Building identity in the generation request does not match the job.");
  }

  const reviewPath = safeRelative(job.review.recordPath, "review.recordPath");
  const reviewFile = await resolveWorkspaceFile(root, reviewPath, "Approved review record", 1024 * 1024);
  const recordSha256 = sha256(reviewFile.bytes);
  if (recordSha256 !== job.review.recordSha256) throw new Error("Approved review record checksum mismatch.");
  const record = JSON.parse(reviewFile.bytes.toString("utf8"));
  if (!isRecord(record) || record.schemaVersion !== "1.0.0" ||
      record.jobId !== jobId || record.reviewId !== job.review.reviewId ||
      record.decision !== "approved" || record.mapReady !== false ||
      record.publicationEligible !== false || record.publicationAction !== "not-performed") {
    throw new Error("Approved review record is invalid or does not match this job.");
  }
  if (!isRecord(record.checks) || REQUIRED_GENERATION_REVIEW_CHECKS.some((key) => record.checks[key] !== true)) {
    throw new Error("Approved review must retain every required review check.");
  }
  if (!isRecord(record.candidate) || record.candidate.modelSha256 !== job.result?.modelSha256 ||
      record.candidate.reportPath !== job.result?.reportPath ||
      !SHA256.test(record.candidate.reportSha256 ?? "")) {
    throw new Error("Approved review candidate does not match the completed job.");
  }

  const candidate = await resolveWorkspaceFile(root, job.result.modelPath, "Generated model", MAX_MODEL_BYTES);
  const modelHash = sha256(candidate.bytes);
  if (modelHash !== record.candidate.modelSha256 || modelHash !== job.result.modelSha256) {
    throw new Error("Generated model changed after approval; refusing publication.");
  }
  const report = await resolveWorkspaceFile(root, job.result.reportPath, "Generation QA report", MAX_REPORT_BYTES);
  const reportHash = sha256(report.bytes);
  if (reportHash !== record.candidate.reportSha256) throw new Error("Generation QA report changed after approval.");
  const reportJson = JSON.parse(report.bytes.toString("utf8"));
  if (!isRecord(reportJson) || reportJson.status !== "completed-requires-review" ||
      reportJson.mapReady !== false || reportJson.publicationEligible !== false ||
      reportJson.output?.modelSha256 !== modelHash) {
    throw new Error("Generation QA report is incomplete or does not match the approved candidate.");
  }

  const reviewChecks = {
    rightsVerified: record.checks.rightsVerified,
    sourceIdentityVerified: record.checks.sourceIdentityVerified,
    architectureReviewed: record.checks.architectureReviewed,
    metricScaleVerified: record.checks.metricScaleVerified,
    horizontalGeoreferenceVerified: record.checks.horizontalGeoreferenceVerified,
    verticalDatumVerified: record.checks.verticalDatumVerified,
  };
  const preflightDirectory = await ensurePrivateDirectory(root, PREFLIGHT_SEGMENTS);
  const attestationPath = path.join(preflightDirectory, jobId + "-" + randomUUID() + ".json");
  const attestation = {
    schemaVersion: "1.0.0",
    candidateSha256: modelHash,
    model: {
      id: job.buildingId,
      name: request.buildingSpec.name,
      position: {
        longitude: placement.position.longitude,
        latitude: placement.position.latitude,
        height: placement.position.height,
      },
      headingDegrees: placement.headingDegrees ?? 0,
      pitchDegrees: placement.pitchDegrees ?? 0,
      rollDegrees: placement.rollDegrees ?? 0,
      scale: placement.scale ?? 1,
      upAxis: placement.upAxis ?? "Y",
      forwardAxis: placement.forwardAxis ?? "Z",
    },
    review: {
      reviewer: record.reviewer,
      reviewedAt: record.reviewedAt,
      evidencePath: reviewPath,
      evidenceSha256: recordSha256,
      checks: reviewChecks,
      notes: record.notes + "\nGeneration QA report SHA-256: " + reportHash,
    },
  };

  try {
    await writeFile(attestationPath, JSON.stringify(attestation, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const published = await publishReviewedBuildingModel({
      workspaceRoot: root,
      candidatePath: job.result.modelPath,
      attestationPath,
    });
    return {
      ...published,
      jobId,
      reviewId: record.reviewId,
      modelSha256: modelHash,
      reportSha256: reportHash,
      placement: attestation.model.position,
      mapReady: false,
      publicationEligible: false,
      note: "Catalog version was explicitly published; review history remains immutable. Job state remains a review candidate.",
    };
  } finally {
    await rm(attestationPath, { force: true }).catch(() => {});
  }
}
