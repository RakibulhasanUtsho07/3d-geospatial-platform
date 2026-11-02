import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn as nodeSpawn } from "node:child_process";

import { normalizeBuildingSpec } from "./building-spec.mjs";
import { probeGenerationWorkerCapabilities } from "./generation-worker-capabilities.mjs";
import { runMediaToModelWorkflow } from "./media-to-model-workflow.mjs";

export const SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION = "1.0.0";
const MODEL_ID = "stabilityai/TripoSR";
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_BYTES = 500 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const OFFLINE_ENV = Object.freeze({
  HF_HUB_OFFLINE: "1",
  HUGGINGFACE_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  HF_DATASETS_OFFLINE: "1",
  HF_HUB_DISABLE_TELEMETRY: "1",
});
const OFFLINE_SITE_CUSTOMIZE = [
  "import socket",
  "def _deny_runtime_network(*args, **kwargs):",
  "    raise OSError('network access is disabled by the single-image runtime smoke')",
  "socket.socket.connect = _deny_runtime_network",
  "socket.socket.connect_ex = _deny_runtime_network",
  "socket.socket.send = _deny_runtime_network",
  "socket.socket.sendall = _deny_runtime_network",
  "socket.socket.sendto = _deny_runtime_network",
  "socket.socket.sendmsg = _deny_runtime_network",
  "socket.create_connection = _deny_runtime_network",
  "socket.getaddrinfo = _deny_runtime_network",
  "socket.gethostbyname = _deny_runtime_network",
  "socket.gethostbyname_ex = _deny_runtime_network",
  "",
].join("\n");

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
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

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function detectImageMimeType(header) {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (header.length >= 8 && header.subarray(0, 8).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )) {
    return "image/png";
  }
  return null;
}

async function inspectSource(root, relativePath) {
  const segments = relativePath.split("/");
  let current = root;
  let entry = null;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new TypeError("Smoke source path must not contain symbolic links.");
    const final = index === segments.length - 1;
    if (!final && !entry.isDirectory()) throw new TypeError("Smoke source path contains a non-directory segment.");
    if (final && !entry.isFile()) throw new TypeError("Smoke source must be a regular file.");
    const actual = await realpath(current);
    if (!inside(root, actual)) throw new TypeError("Smoke source resolves outside workspaceRoot.");
    if (final) current = actual;
  }
  const info = await stat(current);
  if (!info.size || info.size > MAX_SOURCE_BYTES) {
    throw new RangeError("Smoke source must be non-empty and no larger than 20 MiB.");
  }
  const bytes = await readFile(current);
  const mimeType = detectImageMimeType(bytes.subarray(0, 12));
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
    throw new TypeError("Single-image AI smoke accepts JPEG or PNG file signatures only.");
  }
  return { bytes: info.size, mimeType, sha256: digest(bytes) };
}

async function assertArtifactPathAbsent(root, relativePath, label) {
  const safePath = safeRelativePath(relativePath, label);
  const segments = safePath.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new TypeError(label + " must not contain symlink path components.");
    }
    const final = index === segments.length - 1;
    if (final) throw new TypeError(label + " already exists; use a fresh ID so this smoke performs a new inference.");
    if (!entry.isDirectory()) throw new TypeError(label + " contains a non-directory path component.");
    const actual = await realpath(current);
    if (!inside(root, actual)) throw new TypeError(label + " resolves outside workspaceRoot.");
  }
}

function deriveSingleImageWorkerJobId(jobId) {
  return safeId(
    jobId.slice(0, 35) + "-" + digest(Buffer.from(jobId)).slice(0, 8) + "-single-image-1",
    "single-image worker job ID",
  );
}

async function requireFreshSmokeIdentities(root, buildingId, jobId, sourceId) {
  const workerJobId = deriveSingleImageWorkerJobId(jobId);
  const paths = [
    [".building-engine/media/" + buildingId + "/sources/" + sourceId + ".json", "Smoke source record"],
    [".building-engine/reconstruction-jobs/" + buildingId + "/" + jobId, "Smoke resumable reconstruction state"],
    [".building-engine/jobs/" + buildingId + "/" + jobId, "Smoke job artifact directory"],
    [".building-engine/jobs/" + buildingId + "/" + jobId + "-workflow", "Smoke workflow artifact directory"],
    [".building-engine/jobs/" + buildingId + "/" + workerJobId + "-single-view", "TripoSR single-view artifact directory"],
  ];
  for (const [relativePath, label] of paths) {
    await assertArtifactPathAbsent(root, relativePath, label);
  }
}

async function ensurePrivateDirectory(root) {
  const segments = [".building-engine", "runtime-smokes"];
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      const entry = await lstat(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Runtime smoke evidence directory must not contain symlinks or files.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(next, { mode: 0o700 });
      const created = await lstat(next);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new TypeError("Unsafe runtime smoke evidence directory.");
      }
    }
    current = await realpath(next);
    if (!inside(root, current)) throw new TypeError("Runtime smoke evidence directory escapes workspaceRoot.");
  }
  return current;
}

async function createInitialReport(filePath, report) {
  await writeFile(filePath, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

async function replaceReportAtomically(filePath, report) {
  const current = await lstat(filePath);
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new TypeError("Refusing to replace an unsafe runtime smoke report.");
  }
  const temporary = filePath + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", {
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

function parseGlb(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 ||
      bytes.readUInt32LE(0) !== 0x46546c67 ||
      bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length) {
    throw new TypeError("Runtime smoke output is not a valid GLB 2.0 file.");
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (jsonLength < 2 || 20 + jsonLength > bytes.length ||
      bytes.readUInt32LE(16) !== 0x4e4f534a) {
    throw new TypeError("Runtime smoke GLB JSON chunk is missing or invalid.");
  }
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").trim());
  if (json.asset?.version !== "2.0" || !Array.isArray(json.meshes) || json.meshes.length < 1) {
    throw new TypeError("Runtime smoke GLB contains no mesh.");
  }
  return { meshCount: json.meshes.length };
}

function qualitySummary(modelQuality) {
  if (!modelQuality || typeof modelQuality !== "object" || Array.isArray(modelQuality) ||
      modelQuality.valid !== true ||
      !["review-recommended", "basic-geometry-check-passed"].includes(modelQuality.status)) {
    throw new TypeError("TripoSR output is missing a valid GLB geometry-QA report.");
  }
  const warnings = Array.isArray(modelQuality.warnings)
    ? modelQuality.warnings.filter((item) => typeof item === "string").slice(0, 40)
    : null;
  const counts = modelQuality.counts && typeof modelQuality.counts === "object"
    ? modelQuality.counts
    : null;
  if (!warnings || !counts ||
      !Number.isSafeInteger(counts.triangleCount) || counts.triangleCount < 1 ||
      !Number.isSafeInteger(counts.vertexCount) || counts.vertexCount < 3 ||
      !Number.isSafeInteger(counts.primitiveCount) || counts.primitiveCount < 1) {
    throw new TypeError("TripoSR geometry-QA report has missing or invalid mesh counts.");
  }
  const safeCounts = {};
  for (const key of [
    "triangleCount", "vertexCount", "primitiveCount", "degenerateTriangleCount",
    "nonManifoldEdgeCount", "openBoundaryEdgeCount",
  ]) {
    if (Number.isFinite(counts[key]) && counts[key] >= 0) safeCounts[key] = counts[key];
  }
  return {
    valid: true,
    sourceStatus: modelQuality.status,
    status: warnings.length ? "warnings-require-review" : "no-reported-warnings-require-review",
    warningCount: warnings.length,
    warnings,
    counts: safeCounts,
  };
}

function offlineSpawn(spawnImpl, offlinePythonDirectory) {
  return (executable, args, options = {}) => spawnImpl(executable, args, {
    ...options,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      PYTHONPATH: [
        offlinePythonDirectory,
        options.env?.PYTHONPATH,
        process.env.PYTHONPATH,
      ].filter(Boolean).join(path.delimiter),
      ...OFFLINE_ENV,
    },
  });
}

function readinessBlockers(capabilities) {
  const entry = capabilities?.strategies?.["single-image-ai"];
  if (entry?.status === "ready" &&
      entry.modelWeights === "cached" &&
      entry.backgroundRemovalWeights === "cached") return [];
  const blockers = Array.isArray(entry?.blockers)
    ? entry.blockers.filter((item) => typeof item === "string").slice(0, 8)
    : [];
  if (entry?.modelWeights !== "cached") {
    blockers.push("TripoSR config.yaml/model.ckpt cache is not verified as cached.");
  }
  if (entry?.backgroundRemovalWeights !== "cached") {
    blockers.push("The installed rembg default-model cache is not verified as cached.");
  }
  if (!blockers.length) blockers.push("Single-image AI strategy readiness is not ready.");
  return [...new Set(blockers)].slice(0, 8);
}

/**
 * Execute one explicitly authorized real single-image inference through the same
 * media-to-model workflow used by the durable generation worker.
 *
 * This records a private runtime smoke result only. It does not publish a model,
 * calibrate its scale, solve georeferencing, or enable any release flag.
 */
export async function runSingleImageRuntimeSmoke(options) {
  if (!options || typeof options !== "object") throw new TypeError("Smoke options are required.");
  if (options.confirmSourceRights !== true) {
    throw new TypeError("confirmSourceRights must be true after checking the source image rights.");
  }
  if (options.confirmOperationScopes !== true) {
    throw new TypeError("confirmOperationScopes must be true after authorizing private-media-ingestion and single-image-ai-reconstruction.");
  }
  if (options.confirmSingleViewInference !== true) {
    throw new TypeError("confirmSingleViewInference must be true for single-view AI inference.");
  }
  if (options.confirmModelLicences !== true) {
    throw new TypeError("confirmModelLicences must be true after checking TripoSR and rembg model-weight licences.");
  }

  const jobId = safeId(options.jobId, "jobId");
  const sourceId = safeId(options.sourceId, "sourceId");
  const relativePath = safeRelativePath(options.sourceRelativePath, "sourceRelativePath");
  if (typeof options.licence !== "string" || !options.licence.trim() ||
      ["unknown", "n/a", "none"].includes(options.licence.trim().toLowerCase())) {
    throw new TypeError("A known source licence/permission basis is required.");
  }
  if (typeof options.runnerScript !== "string" || !options.runnerScript.trim()) {
    throw new TypeError("runnerScript must point to the installed TripoSR run.py file.");
  }
  const device = options.device ?? "cuda:0";
  if (typeof device !== "string" || !/^(cpu|mps|cuda:\d+)$/.test(device)) {
    throw new TypeError("device must be cpu, mps or cuda:N.");
  }
  const mcResolution = options.mcResolution ?? 256;
  if (!Number.isInteger(mcResolution) || mcResolution < 64 || mcResolution > 512) {
    throw new RangeError("mcResolution must be an integer from 64 to 512.");
  }
  const timeoutMs = options.timeoutMs ?? 1_800_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 7_200_000) {
    throw new RangeError("timeoutMs must be an integer from 10000 to 7200000.");
  }

  const workspaceRoot = await realpath(path.resolve(options.workspaceRoot));
  const buildingSpec = normalizeBuildingSpec(options.buildingSpec).spec;
  const buildingId = safeId(buildingSpec.id, "buildingSpec.id");
  await requireFreshSmokeIdentities(workspaceRoot, buildingId, jobId, sourceId);
  const source = await inspectSource(workspaceRoot, relativePath);
  const pythonPath = options.pythonPath ||
    process.env.BUILDING_ENGINE_PYTHON_EXECUTABLE ||
    process.env.TRIPOSR_PYTHON ||
    "python";
  const runnerScript = path.resolve(options.runnerScript);
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const env = {
    ...process.env,
    BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: runnerScript,
    BUILDING_ENGINE_PYTHON_EXECUTABLE: pythonPath,
    TRIPOSR_PYTHON: pythonPath,
    BUILDING_ENGINE_DEVICE: device,
    ...OFFLINE_ENV,
  };
  const checkedAt = new Date(options.now ?? Date.now()).toISOString();
  if (!Number.isFinite(Date.parse(checkedAt))) throw new TypeError("now must be a valid timestamp.");

  const evidenceDirectory = await ensurePrivateDirectory(workspaceRoot);
  const reportPath = path.join(evidenceDirectory, jobId + ".json");
  const report = {
    schemaVersion: SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION,
    kind: "single-image-runtime-smoke",
    jobId,
    buildingId,
    status: "running",
    createdAt: checkedAt,
    checkedAt: null,
    readiness: {
      strategy: "single-image-ai",
      status: "not-checked",
      tripoModelWeights: "not-checked",
      backgroundRemovalWeights: "not-checked",
      backgroundRemovalModel: null,
    },
    source: {
      sourceId,
      relativePath: relativePath,
      mimeType: source.mimeType,
      bytes: source.bytes,
      sha256: source.sha256,
      licence: options.licence.trim().slice(0, 300),
      rights: "operator-attested-not-independently-verified",
      permittedOperations: ["private-media-ingestion", "single-image-ai-reconstruction"],
      operationScopeAttestation: "operator-attested-not-independently-verified",
    },
    model: {
      tripoModelId: MODEL_ID,
      device,
      mcResolution,
      backgroundRemoval: true,
      licenceReview: "operator-attested-not-independently-verified",
    },
    inference: { status: "not-started", durationMs: null },
    output: null,
    geometryQa: { status: "not-run" },
    candidateDisposition: "requires-human-review",
    scaleCalibration: "not-calibrated",
    georeference: "not-solved",
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    networkPolicy: {
      huggingFaceOffline: true,
      transformersOffline: true,
      datasetsOffline: true,
      pythonSocketConnectionsBlocked: true,
      kernelNetworkIsolation: "not-enforced-by-this-command",
    },
  };
  const offlinePythonDirectory = await mkdtemp(path.join(os.tmpdir(), "single-image-offline-"));
  try {
    await writeFile(path.join(offlinePythonDirectory, "sitecustomize.py"), OFFLINE_SITE_CUSTOMIZE, {
      flag: "wx",
      mode: 0o600,
    });
    await createInitialReport(reportPath, report);
  } catch (error) {
    await rm(offlinePythonDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const spawnOffline = offlineSpawn(spawnImpl, offlinePythonDirectory);

  let workflowStarted = false;
  try {
    const capabilities = await (options.probeCapabilities ?? probeGenerationWorkerCapabilities)({
      env,
      spawnImpl: spawnOffline,
      now: checkedAt,
      commandTimeoutMs: options.commandTimeoutMs ?? 10_000,
    });
    report.checkedAt = capabilities?.checkedAt ?? checkedAt;
    const blockers = readinessBlockers(capabilities);
    const singleImage = capabilities?.strategies?.["single-image-ai"];
    report.readiness = {
      strategy: "single-image-ai",
      status: blockers.length ? "blocked" : "ready",
      tripoModelWeights: singleImage?.modelWeights ?? "unknown",
      backgroundRemovalWeights: singleImage?.backgroundRemovalWeights ?? "unknown",
      backgroundRemovalModel: singleImage?.backgroundRemovalModel ?? null,
      blockers,
    };
    await replaceReportAtomically(reportPath, report);
    if (blockers.length) {
      report.status = "blocked";
      report.inference.status = "not-started";
      await replaceReportAtomically(reportPath, report);
      return { report, reportPath, exitCode: 2 };
    }

    workflowStarted = true;
    const workflow = await (options.runWorkflow ?? runMediaToModelWorkflow)({
      workspaceRoot,
      buildingSpec,
      jobId,
      strategy: "single-image-ai",
      sources: [{
        sourceId,
        relativePath,
        kind: "image",
        licence: options.licence.trim().slice(0, 300),
        permittedOperations: ["private-media-ingestion", "single-image-ai-reconstruction"],
        ...(typeof options.author === "string" && options.author.trim() ? { author: options.author.trim().slice(0, 500) } : {}),
        ...(typeof options.attribution === "string" && options.attribution.trim() ? { attribution: options.attribution.trim().slice(0, 500) } : {}),
      }],
      viewSourceIds: [sourceId],
      confirmRights: true,
      confirmSingleViewInference: true,
      runnerScript,
      pythonPath,
      device,
      mcResolution,
      pretrainedModelNameOrPath: MODEL_ID,
      singleImageTimeoutMs: timeoutMs,
      spawnImpl: spawnOffline,
    });

    const workflowReport = workflow?.report;
    if (!workflowReport || workflowReport.jobId !== jobId ||
        workflowReport.buildingId !== buildingId ||
        workflowReport.status !== "completed-requires-review" ||
        workflowReport.mode !== "single-image-ai" ||
        workflowReport.mapReady !== false ||
        workflowReport.publicationEligible !== false ||
        !workflowReport.output?.modelPath ||
        !/^[a-f0-9]{64}$/.test(workflowReport.output.modelSha256 ?? "")) {
      throw new TypeError("Media-to-model workflow did not return a complete fail-closed single-image candidate report.");
    }
    if (!Array.isArray(workflowReport.inputs?.selectedViewIds) ||
        workflowReport.inputs.selectedViewIds.length !== 1 ||
        workflowReport.inputs.selectedViewIds[0] !== sourceId) {
      throw new TypeError("Media-to-model workflow output is not bound to the requested single source.");
    }
    const ingestedSource = workflowReport.inputs.mediaRecords?.find((item) => item.id === sourceId);
    if (!ingestedSource || ingestedSource.sha256 !== source.sha256 ||
        ingestedSource.usageStatus !== "approved" ||
        ingestedSource.licence !== options.licence.trim() ||
        !["image/jpeg", "image/png"].includes(ingestedSource.mimeType)) {
      throw new TypeError("Media-to-model workflow source record does not match the requested input image.");
    }

    const modelRelativePath = safeRelativePath(workflowReport.output.modelPath, "workflow output modelPath");
    const expectedModelPrefix = ".building-engine/jobs/" + buildingId + "/" + jobId + "-workflow/";
    if (!modelRelativePath.startsWith(expectedModelPrefix)) {
      throw new TypeError("Workflow model output is not inside this smoke job's private artifact directory.");
    }
    const modelAbsolutePath = path.resolve(workspaceRoot, ...modelRelativePath.split("/"));
    if (!inside(workspaceRoot, modelAbsolutePath)) throw new TypeError("Workflow model output escapes workspaceRoot.");
    const modelEntry = await lstat(modelAbsolutePath);
    if (modelEntry.isSymbolicLink() || !modelEntry.isFile()) {
      throw new TypeError("Workflow model output must be a regular non-symlink file.");
    }
    const actualModelPath = await realpath(modelAbsolutePath);
    if (!inside(workspaceRoot, actualModelPath)) throw new TypeError("Workflow model output resolves outside workspaceRoot.");
    const modelBytes = await readFile(actualModelPath);
    if (!modelBytes.length || modelBytes.length > MAX_MODEL_BYTES) {
      throw new RangeError("Workflow GLB output is empty or exceeds 500 MiB.");
    }
    const modelSha256 = digest(modelBytes);
    if (modelSha256 !== workflowReport.output.modelSha256 ||
        workflowReport.output.modelBytes !== modelBytes.length) {
      throw new TypeError("Workflow output SHA-256/byte count does not match the actual GLB bytes.");
    }
    const glb = parseGlb(modelBytes);
    const modelReport = workflowReport.modelReport;
    if (!modelReport || modelReport.status !== "ai-proposed-requires-review" ||
        modelReport.confidence !== "ai-proposed" ||
        modelReport.modelParameters?.modelId !== MODEL_ID ||
        modelReport.modelParameters?.device !== device ||
        modelReport.modelParameters?.mcResolution !== mcResolution ||
        modelReport.modelParameters?.backgroundRemoval !== true ||
        modelReport.source?.sha256 !== source.sha256 ||
        modelReport.mapReady !== false || modelReport.publicationEligible !== false) {
      throw new TypeError("TripoSR report does not preserve the AI-proposed fail-closed status.");
    }
    if (modelReport.outputs?.glb?.sha256 !== modelSha256) {
      throw new TypeError("TripoSR and workflow GLB SHA-256 values do not match.");
    }

    report.status = "passed";
    report.completedAt = new Date().toISOString();
    report.inference = {
      status: "completed",
      durationMs: Number.isFinite(modelReport.durationMs) ? modelReport.durationMs : null,
    };
    report.output = {
      relativePath: modelRelativePath,
      bytes: modelBytes.length,
      sha256: modelSha256,
      meshCount: glb.meshCount,
    };
    report.geometryQa = qualitySummary(modelReport.modelQuality);
    report.candidateDisposition = "ai-proposed-requires-human-review";
    report.scaleCalibration = modelReport.scaleCalibration?.status ?? "not-calibrated";
    report.georeference = modelReport.georeference?.status ?? "not-solved";
    report.mapReady = false;
    report.publicationEligible = false;
    report.automaticApproval = false;
    await replaceReportAtomically(reportPath, report);
    return { report, reportPath, exitCode: 0 };
  } catch (error) {
    if (!workflowStarted) report.readiness.blockers = ["single-image-readiness-probe-failed"];
    report.status = workflowStarted ? "failed" : "blocked";
    report.completedAt = new Date().toISOString();
    report.inference = {
      status: workflowStarted ? "failed" : "not-started",
      durationMs: null,
    };
    report.failure = {
      code: error instanceof Error && SAFE_ID.test(error.name) ? error.name : "RuntimeSmokeError",
      summary: workflowStarted
        ? "Inference, GLB export or evidence integrity validation failed; inspect the private workflow report for diagnostics."
        : "Readiness probe failed; no inference was started.",
    };
    report.mapReady = false;
    report.publicationEligible = false;
    report.automaticApproval = false;
    await replaceReportAtomically(reportPath, report).catch(() => {});
    return { report, reportPath, exitCode: workflowStarted ? 1 : 2 };
  } finally {
    await rm(offlinePythonDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
