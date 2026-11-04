import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { analyzeGlbQuality } from "./glb-geometry-qa.mjs";
import { canonicalJson } from "./generation-artifact-receipt.mjs";

export const SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION = "1.4.0";
const PREVIOUS_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION = "1.3.0";
const LEGACY_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION = "1.2.0";
const OLDER_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION = "1.1.0";
const OLDEST_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION = "1.0.0";
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


function canonicalTimestamp(value) {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function validateWorkerHostFingerprints(report) {
  const workerHost = report.workerHost;
  if (!workerHost || workerHost.inventorySchemaVersion !== "1.1.0" ||
      workerHost.stableAcrossInference !== true) {
    throw new TypeError("Smoke report is missing stable worker-host model artifact fingerprints.");
  }
  const validateSnapshot = (snapshot, label) => {
    if (!snapshot || !canonicalTimestamp(snapshot.checkedAt) ||
        !Number.isSafeInteger(snapshot.runner?.bytes) || snapshot.runner.bytes <= 0 ||
        !HASH.test(snapshot.runner?.sha256 ?? "") ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(snapshot.backgroundRemovalModel ?? "")) {
      throw new TypeError(label + " worker-host runner/model identity is malformed.");
    }
    const config = snapshot.modelArtifacts?.tripoConfig;
    const checkpoint = snapshot.modelArtifacts?.tripoCheckpoint;
    const rembg = snapshot.modelArtifacts?.rembgWeights;
    const validArtifact = (item) => item?.status === "cached" &&
      Number.isSafeInteger(item.bytes) && item.bytes > 0 && HASH.test(item.sha256 ?? "");
    if (!validArtifact(config) || !/^[a-f0-9]{40}$/.test(config.snapshotRevision ?? "")) {
      throw new TypeError(label + " TripoSR config fingerprint is invalid.");
    }
    if (!validArtifact(checkpoint) ||
        !/^[a-f0-9]{40}$/.test(checkpoint.snapshotRevision ?? "") ||
        checkpoint.snapshotRevision !== config.snapshotRevision) {
      throw new TypeError(label + " TripoSR checkpoint fingerprint is invalid.");
    }
    if (!validArtifact(rembg)) {
      throw new TypeError(label + " rembg model-weight fingerprint is invalid.");
    }
  };
  validateSnapshot(workerHost.before, "Pre-inference");
  validateSnapshot(workerHost.after, "Post-inference");
  const fingerprintValues = (snapshot) => JSON.stringify({
    runner: snapshot.runner,
    backgroundRemovalModel: snapshot.backgroundRemovalModel,
    modelArtifacts: snapshot.modelArtifacts,
  });
  if (fingerprintValues(workerHost.before) !== fingerprintValues(workerHost.after)) {
    throw new TypeError("Smoke report worker-host model fingerprints changed across inference.");
  }
  return true;
}


function validateModelLoadEvidence(report) {
  const evidence = report.modelLoadEvidence;
  if (!evidence || evidence.schemaVersion !== "1.0.0" || evidence.status !== "verified") {
    throw new TypeError("Smoke report is missing verified process-side model-load evidence.");
  }
  const expected = [
    ["tripoConfig", "omegaconf.OmegaConf.load"],
    ["tripoCheckpoint", "torch.load"],
    ["rembgWeights", "onnxruntime.InferenceSession"],
  ];
  const loaders = evidence.loaders;
  if (!loaders || typeof loaders !== "object" || Array.isArray(loaders) ||
      JSON.stringify(Object.keys(loaders).sort()) !== JSON.stringify(expected.map(([role]) => role).sort())) {
    throw new TypeError("Smoke report model-load evidence has an invalid loader set.");
  }
  for (const [role, loader] of expected) {
    const observed = loaders[role];
    const expectedArtifact = report.workerHost?.before?.modelArtifacts?.[role];
    if (!observed || observed.loader !== loader ||
        !Number.isSafeInteger(observed.bytes) || observed.bytes <= 0 ||
        !HASH.test(observed.sha256 ?? "") ||
        observed.bytes !== expectedArtifact?.bytes ||
        observed.sha256 !== expectedArtifact?.sha256 ||
        observed.exactBytesPassed !== true || observed.stable !== true) {
      throw new TypeError("Smoke report model-load evidence does not match the pre-inference " + role + " fingerprint.");
    }
  }
  return true;
}


function validateSourceImageLoadEvidence(report) {
  const evidence = report.sourceLoadEvidence;
  const expectedKeys = [
    "bytes", "eventCount", "exactBytesPassed", "loader", "schemaVersion",
    "sha256", "stable", "status",
  ];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
      JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(expectedKeys) ||
      evidence.schemaVersion !== "1.0.0" || evidence.status !== "verified" ||
      evidence.loader !== "PIL.Image.open" || evidence.exactBytesPassed !== true ||
      evidence.stable !== true || evidence.eventCount !== 1 ||
      evidence.bytes !== report.source?.bytes ||
      evidence.sha256 !== report.source?.sha256 ||
      !Number.isSafeInteger(evidence.bytes) || evidence.bytes <= 0 ||
      !HASH.test(evidence.sha256 ?? "")) {
    throw new TypeError("Smoke report source-image load evidence does not match the exact source image bytes.");
  }
  return true;
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

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(label + " has an invalid field set.");
  }
}

async function verifyGenerationArtifactReceipt({
  root,
  jobId,
  report,
  sourceBytes,
  sourceHash,
  modelBytes,
  modelHash,
  glb,
  independentQa,
}) {
  const pointer = report.generationArtifactReceipt;
  exactKeys(pointer, ["bytes", "path", "payloadSha256", "schemaVersion", "sha256"], "Generation artifact receipt reference");
  const relativePath = safeRelativePath(pointer.path, "Generation artifact receipt path");
  const expectedReceiptPath = ".building-engine/runtime-smokes/" + jobId + ".artifact.json";
  if (pointer.schemaVersion !== "1.0.0" || relativePath !== expectedReceiptPath ||
      !Number.isSafeInteger(pointer.bytes) || pointer.bytes <= 0 || pointer.bytes > 256 * 1024 ||
      !HASH.test(pointer.sha256 ?? "") || !HASH.test(pointer.payloadSha256 ?? "")) {
    throw new TypeError("Generation artifact receipt reference is invalid or does not match this smoke job.");
  }
  const receiptFile = path.join(root, ...relativePath.split("/"));
  const receiptEntry = await lstat(receiptFile);
  if (receiptEntry.isSymbolicLink() || !receiptEntry.isFile()) {
    throw new TypeError("Generation artifact receipt must be a regular non-symlink file.");
  }
  if (process.platform !== "win32" && (receiptEntry.mode & 0o077) !== 0) {
    throw new TypeError("Generation artifact receipt permissions are not private.");
  }
  const receiptBytes = await readRegularWorkspaceFile(root, relativePath, "Generation artifact receipt", 256 * 1024);
  if (receiptBytes.length !== pointer.bytes || sha256(receiptBytes) !== pointer.sha256) {
    throw new Error("Generation artifact receipt byte count or SHA-256 does not match its report reference.");
  }
  const envelope = JSON.parse(receiptBytes.toString("utf8"));
  exactKeys(envelope, ["payload", "payloadSha256", "schemaVersion"], "Generation artifact receipt envelope");
  if (envelope.schemaVersion !== "1.0.0" || !HASH.test(envelope.payloadSha256 ?? "") ||
      envelope.payloadSha256 !== pointer.payloadSha256 ||
      sha256(Buffer.from(canonicalJson(envelope.payload), "utf8")) !== envelope.payloadSha256 ||
      !receiptBytes.equals(Buffer.from(JSON.stringify(envelope, null, 2) + "\n", "utf8"))) {
    throw new TypeError("Generation artifact receipt envelope is non-canonical or its payload digest is invalid.");
  }

  const payload = envelope.payload;
  exactKeys(payload, [
    "buildingId", "geometryQa", "jobId", "kind", "modelLoadEvidence",
    "output", "schemaVersion", "source", "workerHost", "workflowReport",
  ], "Generation artifact receipt payload");
  if (payload.schemaVersion !== "1.0.0" ||
      payload.kind !== "single-image-generation-artifact" ||
      payload.jobId !== jobId || payload.buildingId !== report.buildingId) {
    throw new TypeError("Generation artifact receipt payload identity is invalid.");
  }

  const expectedWorkflowPath = ".building-engine/jobs/" + report.buildingId + "/" + jobId + "-workflow/workflow-report.json";
  exactKeys(payload.workflowReport, ["bytes", "mode", "path", "sha256", "status"], "Generation workflow report binding");
  if (payload.workflowReport.path !== expectedWorkflowPath ||
      !Number.isSafeInteger(payload.workflowReport.bytes) || payload.workflowReport.bytes <= 0 ||
      payload.workflowReport.bytes > 1024 * 1024 || !HASH.test(payload.workflowReport.sha256 ?? "") ||
      payload.workflowReport.status !== "completed-requires-review" ||
      payload.workflowReport.mode !== "single-image-ai") {
    throw new TypeError("Generation artifact receipt workflow-report binding is invalid.");
  }
  const workflowBytes = await readRegularWorkspaceFile(
    root,
    expectedWorkflowPath,
    "Media-to-model generation workflow report",
    1024 * 1024,
  );
  if (workflowBytes.length !== payload.workflowReport.bytes ||
      sha256(workflowBytes) !== payload.workflowReport.sha256) {
    throw new Error("On-disk generation workflow report byte count or SHA-256 does not match the artifact receipt.");
  }
  const workflowReport = JSON.parse(workflowBytes.toString("utf8"));
  const selectedViews = workflowReport.inputs?.selectedViewIds;
  const mediaRecord = workflowReport.inputs?.mediaRecords?.find((item) => item.id === report.source.sourceId);
  if (workflowReport.jobId !== jobId || workflowReport.buildingId !== report.buildingId ||
      workflowReport.status !== "completed-requires-review" || workflowReport.mode !== "single-image-ai" ||
      workflowReport.mapReady !== false || workflowReport.publicationEligible !== false ||
      !Array.isArray(selectedViews) || selectedViews.length !== 1 || selectedViews[0] !== report.source.sourceId ||
      !mediaRecord || mediaRecord.sha256 !== sourceHash || mediaRecord.mimeType !== report.source.mimeType ||
      mediaRecord.usageStatus !== "approved" ||
      workflowReport.output?.modelPath !== report.output.relativePath ||
      workflowReport.output?.modelBytes !== modelBytes.length ||
      workflowReport.output?.modelSha256 !== modelHash ||
      workflowReport.modelReport?.source?.sha256 !== sourceHash ||
      workflowReport.modelReport?.outputs?.glb?.sha256 !== modelHash ||
      workflowReport.modelReport?.outputs?.glb?.bytes !== modelBytes.length ||
      workflowReport.modelReport?.mapReady !== false ||
      workflowReport.modelReport?.publicationEligible !== false) {
    throw new TypeError("On-disk generation workflow report does not bind this exact source and GLB candidate.");
  }

  exactKeys(payload.source, ["bytes", "loaderEvidence", "mimeType", "sha256", "sourceId"], "Generation receipt source binding");
  exactKeys(payload.workerHost, ["after", "before", "inventorySchemaVersion", "stableAcrossInference"], "Generation receipt worker binding");
  exactKeys(payload.output, ["bytes", "format", "meshCount", "path", "sha256"], "Generation receipt GLB binding");
  exactKeys(payload.geometryQa, [
    "counts", "engine", "schemaVersion", "sourceStatus", "status", "valid", "warningCount", "warnings",
  ], "Generation receipt geometry QA binding");
  const expectedPayload = {
    schemaVersion: "1.0.0",
    kind: "single-image-generation-artifact",
    buildingId: report.buildingId,
    jobId,
    workflowReport: {
      path: expectedWorkflowPath,
      bytes: workflowBytes.length,
      sha256: sha256(workflowBytes),
      status: workflowReport.status,
      mode: workflowReport.mode,
    },
    source: {
      sourceId: report.source.sourceId,
      mimeType: sourceBytes.length ? report.source.mimeType : null,
      bytes: sourceBytes.length,
      sha256: sourceHash,
      loaderEvidence: report.sourceLoadEvidence,
    },
    workerHost: {
      inventorySchemaVersion: report.workerHost.inventorySchemaVersion,
      stableAcrossInference: report.workerHost.stableAcrossInference,
      before: report.workerHost.before,
      after: report.workerHost.after,
    },
    modelLoadEvidence: report.modelLoadEvidence,
    output: {
      path: report.output.relativePath,
      format: "glb",
      bytes: modelBytes.length,
      sha256: modelHash,
      meshCount: glb.meshCount,
    },
    geometryQa: {
      schemaVersion: "1.0.0",
      engine: independentQa.engine,
      valid: independentQa.valid,
      sourceStatus: independentQa.status,
      status: report.geometryQa.status,
      warningCount: report.geometryQa.warningCount,
      warnings: report.geometryQa.warnings,
      counts: report.geometryQa.counts,
    },
  };
  if (canonicalJson(payload) !== canonicalJson(expectedPayload)) {
    throw new TypeError("Generation artifact receipt is not fully bound to the source, worker, GLB and independent geometry-QA evidence.");
  }
  return {
    verified: true,
    schemaVersion: pointer.schemaVersion,
    path: relativePath,
    bytes: receiptBytes.length,
    sha256: pointer.sha256,
    payloadSha256: pointer.payloadSha256,
    workflowReportSha256: payload.workflowReport.sha256,
  };
}

/**
 * Independently re-checks the on-disk source, generation report, receipt and GLB hashes.
 * It never changes the report or publication/release flags.
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
      ![
        SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
        PREVIOUS_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
        LEGACY_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
        OLDER_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
        OLDEST_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
      ].includes(report.schemaVersion) ||
      report.kind !== "single-image-runtime-smoke" ||
      report.jobId !== jobId ||
      !SAFE_ID.test(report.buildingId ?? "") ||
      report.status !== "passed") {
    throw new TypeError("Smoke evidence report schema, identity or status is invalid.");
  }
  const hasWorkerFingerprintEvidence = [
    SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
    PREVIOUS_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
    LEGACY_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
    OLDER_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
  ].includes(report.schemaVersion);
  const hasProcessLoadEvidence = [
    SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
    PREVIOUS_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
    LEGACY_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
  ].includes(report.schemaVersion);
  const hasSourceImageLoadEvidence = [
    SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
    PREVIOUS_SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
  ].includes(report.schemaVersion);
  const hasGenerationArtifactReceipt = report.schemaVersion === SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION;
  if (hasWorkerFingerprintEvidence) validateWorkerHostFingerprints(report);
  if (hasProcessLoadEvidence) validateModelLoadEvidence(report);
  if (hasSourceImageLoadEvidence) validateSourceImageLoadEvidence(report);

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
      !Number.isFinite(report.inference.durationMs) || report.inference.durationMs < 0 ||
      report.inference.runnerLaunchAttempted !== true ||
      report.inference.runnerProcessStarted !== true) {
    throw new TypeError("Smoke report does not contain a completed TripoSR runner launch and inference record.");
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
  const generationArtifactReceipt = hasGenerationArtifactReceipt
    ? await verifyGenerationArtifactReceipt({
      root, jobId, report, sourceBytes, sourceHash, modelBytes, modelHash, glb, independentQa,
    })
    : null;

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
    workerHostFingerprintStatus: hasWorkerFingerprintEvidence
      ? "stable-across-inference" : "not-recorded-legacy-schema",
    modelLoadEvidenceStatus: hasProcessLoadEvidence
      ? "verified-against-worker-preflight" : "not-recorded-legacy-schema",
    sourceImageLoadEvidenceStatus: hasSourceImageLoadEvidence
      ? "verified-against-source-manifest" : "not-recorded-legacy-schema",
    generationArtifactReceiptStatus: hasGenerationArtifactReceipt
      ? "verified" : "not-recorded-legacy-schema",
    ...(generationArtifactReceipt ? { generationArtifactReceipt } : {}),
    ...(hasWorkerFingerprintEvidence ? { workerHost: report.workerHost } : {}),
    ...(hasProcessLoadEvidence ? { modelLoadEvidence: report.modelLoadEvidence } : {}),
    ...(hasSourceImageLoadEvidence ? { sourceLoadEvidence: report.sourceLoadEvidence } : {}),
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    reportPath: reportRelativePath,
  };
}
