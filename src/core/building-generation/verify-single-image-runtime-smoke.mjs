import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { analyzeGlbQuality } from "./glb-geometry-qa.mjs";

export const SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION = "1.0.0";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_BYTES = 500 * 1024 * 1024;

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a workspace-relative POSIX path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(label + " must not contain empty, dot or parent path segments.");
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularWorkspaceFile(root, relativePath, label, maximumBytes) {
  const safePath = safeRelativePath(relativePath, label);
  let current = root;
  const segments = safePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new TypeError(label + " must not contain symlink path components.");
    const final = index === segments.length - 1;
    if (!final && !entry.isDirectory()) throw new TypeError(label + " contains a non-directory path component.");
    if (final && !entry.isFile()) throw new TypeError(label + " must be a regular file.");
    const actual = await realpath(current);
    if (!inside(root, actual)) throw new TypeError(label + " resolves outside workspaceRoot.");
    if (final) current = actual;
  }
  const info = await stat(current);
  if (!info.size || info.size > maximumBytes) {
    throw new RangeError(label + " is empty or exceeds its maximum byte limit.");
  }
  return readFile(current);
}

function detectImageMimeType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )) {
    return "image/png";
  }
  return null;
}

function parseGlb(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 ||
      bytes.readUInt32LE(0) !== 0x46546c67 ||
      bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length) {
    throw new TypeError("Smoke GLB is not a valid GLB 2.0 binary.");
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (jsonLength < 2 || 20 + jsonLength > bytes.length ||
      bytes.readUInt32LE(16) !== 0x4e4f534a) {
    throw new TypeError("Smoke GLB JSON chunk is invalid.");
  }
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").trim());
  if (json.asset?.version !== "2.0" || !Array.isArray(json.meshes) || json.meshes.length < 1) {
    throw new TypeError("Smoke GLB has no mesh.");
  }
  return { meshCount: json.meshes.length };
}

/**
 * Independently re-checks the on-disk source and GLB hashes recorded by a successful
 * runtime smoke report. It never changes the report or publication/release flags.
 */
export async function verifySingleImageRuntimeSmoke({ workspaceRoot, jobId }) {
  safeId(jobId, "jobId");
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("workspaceRoot is required.");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const reportRelativePath = ".building-engine/runtime-smokes/" + jobId + ".json";
  const reportBytes = await readRegularWorkspaceFile(
    root,
    reportRelativePath,
    "Smoke evidence report",
    1024 * 1024,
  );
  const report = JSON.parse(reportBytes.toString("utf8"));

  if (!report || typeof report !== "object" ||
      report.schemaVersion !== SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION ||
      report.kind !== "single-image-runtime-smoke" ||
      report.jobId !== jobId ||
      !SAFE_ID.test(report.buildingId ?? "") ||
      report.status !== "passed") {
    throw new TypeError("Smoke evidence report schema, identity or status is invalid.");
  }
  if (report.readiness?.status !== "ready" ||
      report.readiness.tripoModelWeights !== "cached" ||
      report.readiness.backgroundRemovalWeights !== "cached" ||
      typeof report.readiness.backgroundRemovalModel !== "string") {
    throw new TypeError("Smoke report does not contain complete D3M-04 model readiness evidence.");
  }
  if (report.model?.tripoModelId !== "stabilityai/TripoSR" ||
      !["cpu", "mps"].includes(report.model.device) && !/^cuda:\d+$/.test(report.model.device ?? "") ||
      !Number.isInteger(report.model.mcResolution) ||
      report.model.mcResolution < 64 || report.model.mcResolution > 512 ||
      report.model.backgroundRemoval !== true) {
    throw new TypeError("Smoke report model configuration is invalid.");
  }
  if (report.mapReady !== false || report.publicationEligible !== false ||
      report.automaticApproval !== false ||
      report.candidateDisposition !== "ai-proposed-requires-human-review") {
    throw new TypeError("Smoke report violates the fail-closed publication contract.");
  }
  if (report.inference?.status !== "completed" ||
      !Number.isFinite(report.inference.durationMs) || report.inference.durationMs < 0) {
    throw new TypeError("Smoke report does not contain a completed inference record.");
  }
  if (report.networkPolicy?.huggingFaceOffline !== true ||
      report.networkPolicy?.transformersOffline !== true ||
      report.networkPolicy?.datasetsOffline !== true ||
      report.networkPolicy?.pythonSocketConnectionsBlocked !== true ||
      report.networkPolicy?.kernelNetworkIsolation !== "not-enforced-by-this-command") {
    throw new TypeError("Smoke report does not record the declared offline network policy.");
  }
  if (!report.source || !SAFE_ID.test(report.source.sourceId ?? "") ||
      report.source.rights !== "operator-attested-not-independently-verified" ||
      typeof report.source.licence !== "string" || !report.source.licence.trim() ||
      report.source.operationScopeAttestation !== "operator-attested-not-independently-verified" ||
      JSON.stringify(report.source.permittedOperations) !== JSON.stringify([
        "private-media-ingestion",
        "single-image-ai-reconstruction",
      ]) ||
      !HASH.test(report.source.sha256 ?? "")) {
    throw new TypeError("Smoke report source evidence is invalid.");
  }
  if (report.model?.licenceReview !== "operator-attested-not-independently-verified" ||
      typeof report.model.triposrLicenceReview !== "string" || !report.model.triposrLicenceReview.trim() ||
      typeof report.model.rembgLicenceReview !== "string" || !report.model.rembgLicenceReview.trim()) {
    throw new TypeError("Smoke report is missing the separate TripoSR/rembg model-licence review basis.");
  }
  if (!report.output || !HASH.test(report.output.sha256 ?? "") ||
      !Number.isSafeInteger(report.output.bytes) || report.output.bytes <= 0) {
    throw new TypeError("Smoke report model output evidence is invalid.");
  }
  if (report.geometryQa?.valid !== true ||
      !["review-recommended", "basic-geometry-check-passed"].includes(report.geometryQa.sourceStatus) ||
      !["warnings-require-review", "no-reported-warnings-require-review"].includes(report.geometryQa.status) ||
      !Number.isSafeInteger(report.geometryQa.counts?.triangleCount) || report.geometryQa.counts.triangleCount < 1 ||
      !Number.isSafeInteger(report.geometryQa.counts?.vertexCount) || report.geometryQa.counts.vertexCount < 3 ||
      !Number.isSafeInteger(report.geometryQa.counts?.primitiveCount) || report.geometryQa.counts.primitiveCount < 1) {
    throw new TypeError("Smoke report geometry-QA evidence is missing or invalid.");
  }

  const sourceBytes = await readRegularWorkspaceFile(
    root,
    report.source.relativePath,
    "Smoke source image",
    MAX_SOURCE_BYTES,
  );
  const sourceMimeType = detectImageMimeType(sourceBytes);
  const sourceHash = sha256(sourceBytes);
  if (!sourceMimeType || sourceMimeType !== report.source.mimeType ||
      sourceBytes.length !== report.source.bytes ||
      sourceHash !== report.source.sha256) {
    throw new Error("Smoke source image signature, byte count or SHA-256 does not match its report.");
  }

  const modelRelativePath = safeRelativePath(report.output.relativePath, "Smoke model output path");
  const expectedPrefix = ".building-engine/jobs/" + report.buildingId + "/" + jobId + "-workflow/";
  if (!modelRelativePath.startsWith(expectedPrefix)) {
    throw new TypeError("Smoke model output is not inside the expected private workflow directory.");
  }
  const modelBytes = await readRegularWorkspaceFile(
    root,
    modelRelativePath,
    "Smoke GLB output",
    MAX_MODEL_BYTES,
  );
  const modelHash = sha256(modelBytes);
  const glb = parseGlb(modelBytes);
  const independentQa = analyzeGlbQuality(modelBytes);
  const reportedQa = report.geometryQa;
  const expectedWarnings = independentQa.warnings
    .filter((item) => typeof item === "string")
    .slice(0, 40);
  const reportedCounts = reportedQa.counts;
  const independentCountKeys = [
    "triangleCount", "vertexCount", "primitiveCount", "degenerateTriangleCount",
    "nonManifoldEdgeCount", "openBoundaryEdgeCount",
  ];
  const countsMatch = independentCountKeys.every((key) =>
    reportedCounts[key] === undefined || reportedCounts[key] === independentQa.counts[key]
  );
  const expectedQaStatus = expectedWarnings.length
    ? "warnings-require-review"
    : "no-reported-warnings-require-review";
  if (modelBytes.length !== report.output.bytes ||
      modelHash !== report.output.sha256 ||
      glb.meshCount !== report.output.meshCount ||
      independentQa.valid !== true ||
      independentQa.status !== reportedQa.sourceStatus ||
      independentQa.counts.meshCount !== report.output.meshCount ||
      !countsMatch ||
      reportedQa.warningCount !== expectedWarnings.length ||
      JSON.stringify(reportedQa.warnings) !== JSON.stringify(expectedWarnings) ||
      reportedQa.status !== expectedQaStatus) {
    throw new Error("Smoke GLB byte/hash/geometry-QA evidence does not match an independent disk analysis.");
  }

  return {
    verified: true,
    status: "integrity-verified-runtime-smoke",
    jobId,
    buildingId: report.buildingId,
    source: {
      sourceId: report.source.sourceId,
      bytes: sourceBytes.length,
      sha256: sourceHash,
      mimeType: sourceMimeType,
    },
    model: {
      tripoModelId: report.model.tripoModelId,
      backgroundRemovalModel: report.readiness.backgroundRemovalModel,
      device: report.model.device,
      mcResolution: report.model.mcResolution,
      bytes: modelBytes.length,
      sha256: modelHash,
      meshCount: glb.meshCount,
    },
    geometryQa: report.geometryQa,
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    reportPath: reportRelativePath,
  };
}
