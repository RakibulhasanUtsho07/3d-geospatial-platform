import { createHash } from "node:crypto";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { probeGenerationWorkerCapabilities } from "./generation-worker-capabilities.mjs";

export const GENERATION_WORKER_HOST_INVENTORY_SCHEMA_VERSION = "1.0.0";
const SAFE_DEVICE = /^(cpu|mps|cuda:\d+)$/;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const OFFLINE_ENV = Object.freeze({
  PYTHONDONTWRITEBYTECODE: "1",
  HF_HUB_OFFLINE: "1",
  HUGGINGFACE_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  HF_DATASETS_OFFLINE: "1",
  HF_HUB_DISABLE_TELEMETRY: "1",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeText(value, maxLength = 120) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function validTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid timestamp.");
  return date.toISOString();
}

function summarizeCapabilityState(capabilities, checkedAt) {
  const entry = capabilities?.strategies?.["single-image-ai"];
  const timestamp = capabilities?.checkedAt;
  const timestampValid = typeof timestamp === "string" &&
    Number.isFinite(Date.parse(timestamp)) &&
    new Date(timestamp).toISOString() === timestamp &&
    timestamp === checkedAt;
  const schemaValid = capabilities?.schemaVersion === "1.0.0";
  const strategyStatus = ["ready", "configured", "blocked"].includes(entry?.status)
    ? entry.status
    : "unknown";
  const tripoCache = ["cached", "missing", "unknown"].includes(entry?.modelWeights)
    ? entry.modelWeights
    : "unknown";
  const rembgCache = ["cached", "missing", "unknown"].includes(entry?.backgroundRemovalWeights)
    ? entry.backgroundRemovalWeights
    : "unknown";
  const rembgModel = typeof entry?.backgroundRemovalModel === "string" &&
    SAFE_MODEL_ID.test(entry.backgroundRemovalModel)
    ? entry.backgroundRemovalModel
    : null;
  const blockers = [];
  if (!schemaValid) blockers.push("worker-capability-schema-invalid");
  if (!timestampValid) blockers.push("worker-capability-timestamp-invalid-or-stale");
  if (strategyStatus !== "ready") blockers.push("single-image-strategy-not-ready");
  if (tripoCache !== "cached") blockers.push("triposr-model-cache-not-verified-cached");
  if (rembgCache !== "cached") blockers.push("rembg-model-cache-not-verified-cached");
  if (rembgCache === "cached" && !rembgModel) blockers.push("rembg-model-identifier-not-verified");
  return {
    status: blockers.length ? "blocked" : "ready",
    schemaVersion: schemaValid ? capabilities.schemaVersion : "unsupported",
    checkedAt: timestampValid ? timestamp : checkedAt,
    strategyStatus,
    tripoModelWeights: tripoCache,
    backgroundRemovalWeights: rembgCache,
    ...(rembgModel ? { backgroundRemovalModel: rembgModel } : {}),
    blockers,
  };
}

export function buildPythonInventoryProgram() {
  return [
    "import hashlib, importlib.metadata, inspect, json, os, platform, re, sys",
    "out = {",
    "  'pythonVersion': platform.python_version(),",
    "  'pythonImplementation': platform.python_implementation(),",
    "  'pythonPlatform': platform.system() + '-' + platform.machine(),",
    "  'packages': {},",
    "  'accelerators': {'cudaAvailable': False, 'cudaRuntime': None, 'hipRuntime': None, 'cudaDevices': [], 'mpsAvailable': False},",
    "  'onnxProviders': [],",
    "  'rembgDefaultModel': None,",
    "  'modelArtifacts': {'tripoConfig': {'status': 'unknown', 'bytes': None, 'snapshotRevision': None}, 'tripoCheckpoint': {'status': 'unknown', 'bytes': None, 'snapshotRevision': None}, 'rembgWeights': {'status': 'unknown', 'bytes': None}},",
    "  'runnerSyntaxCompiled': False,",
    "  'runnerSha256Matches': False,",
    "  'probeErrors': [],",
    "}",
    "for package in ('torch', 'onnxruntime', 'rembg', 'huggingface-hub', 'transformers'):",
    "  try: out['packages'][package] = importlib.metadata.version(package)",
    "  except Exception: out['packages'][package] = None",
    "def file_summary(file_path, include_revision=False):",
    "  if not isinstance(file_path, str) or not os.path.isfile(file_path) or os.path.getsize(file_path) <= 0: return {'status': 'missing', 'bytes': None, 'snapshotRevision': None} if include_revision else {'status': 'missing', 'bytes': None}",
    "  result = {'status': 'cached', 'bytes': int(os.path.getsize(file_path))}",
    "  if include_revision:",
    "    revision = os.path.basename(os.path.dirname(file_path))",
    "    result['snapshotRevision'] = revision if re.fullmatch(r'[a-f0-9]{40}', revision) else None",
    "  return result",
    "try:",
    "  import torch",
    "  out['accelerators']['cudaAvailable'] = bool(torch.cuda.is_available())",
    "  out['accelerators']['cudaRuntime'] = getattr(torch.version, 'cuda', None)",
    "  out['accelerators']['hipRuntime'] = getattr(torch.version, 'hip', None)",
    "  if out['accelerators']['cudaAvailable']:",
    "    for index in range(torch.cuda.device_count()):",
    "      try:",
    "        props = torch.cuda.get_device_properties(index)",
    "        out['accelerators']['cudaDevices'].append({'index': index, 'name': str(props.name)[:120], 'totalMemoryBytes': int(props.total_memory), 'major': int(props.major), 'minor': int(props.minor)})",
    "      except Exception: out['probeErrors'].append('cuda-device-inspection-failed')",
    "  backend = getattr(getattr(torch, 'backends', None), 'mps', None)",
    "  out['accelerators']['mpsAvailable'] = bool(backend and backend.is_available())",
    "except Exception: out['probeErrors'].append('pytorch-import-or-device-probe-failed')",
    "try:",
    "  import onnxruntime",
    "  out['onnxProviders'] = [str(x)[:80] for x in onnxruntime.get_available_providers() if isinstance(x, str)]",
    "except Exception: out['probeErrors'].append('onnxruntime-import-or-provider-probe-failed')",
    "try:",
    "  import rembg",
    "  from rembg.sessions import sessions_class",
    "  parameter = inspect.signature(rembg.new_session).parameters.get('model_name')",
    "  name = parameter.default if parameter else None",
    "  if isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', name):",
    "    out['rembgDefaultModel'] = name",
    "    session_class = next((item for item in sessions_class if item.name() == name), None)",
    "    resolver = getattr(session_class, 'resolve_existing', None) if session_class is not None else None",
    "    if callable(resolver):",
    "      model_path = resolver(name + '.onnx')",
    "      out['modelArtifacts']['rembgWeights'] = file_summary(os.fspath(model_path) if model_path is not None else '')",
    "    else: out['modelArtifacts']['rembgWeights']['status'] = 'unknown'",
    "except Exception: out['probeErrors'].append('rembg-import-or-default-model-probe-failed')",
    "try:",
    "  from huggingface_hub import try_to_load_from_cache",
    "  for model_file, key in (('config.yaml', 'tripoConfig'), ('model.ckpt', 'tripoCheckpoint')):",
    "    cached_file = try_to_load_from_cache('stabilityai/TripoSR', model_file)",
    "    out['modelArtifacts'][key] = file_summary(cached_file, include_revision=True)",
    "except Exception: out['probeErrors'].append('triposr-cache-identity-probe-failed')",
    "try:",
    "  with open(sys.argv[1], 'rb') as runner_file: runner_bytes = runner_file.read()",
    "  if not runner_bytes: raise ValueError('empty runner')",
    "  out['runnerSha256Matches'] = len(sys.argv) > 2 and hashlib.sha256(runner_bytes).hexdigest() == sys.argv[2]",
    "  if not out['runnerSha256Matches']: out['probeErrors'].append('triposr-runner-hash-mismatch')",
    "  else:",
    "    compile(runner_bytes, '<configured-TripoSR-runner>', 'exec', dont_inherit=True)",
    "    out['runnerSyntaxCompiled'] = True",
    "except Exception: out['probeErrors'].append('triposr-runner-syntax-compile-failed')",
    "print(json.dumps(out, separators=(',', ':')))",
  ].join("\n");
}

async function inspectRunner(runnerScript) {
  if (typeof runnerScript !== "string" || !runnerScript.trim()) {
    return { status: "missing", bytes: null, sha256: null, filename: null };
  }
  try {
    const absolute = path.resolve(runnerScript);
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.size) {
      return { status: "invalid", bytes: null, sha256: null, filename: null };
    }
    const bytes = await readFile(absolute);
    if (bytes.length > 10 * 1024 * 1024) {
      return { status: "oversized", bytes: bytes.length, sha256: null, filename: null };
    }
    const filename = path.basename(absolute);
    return {
      status: "present",
      bytes: bytes.length,
      sha256: sha256(bytes),
      filename: /^[A-Za-z0-9._-]{1,100}$/.test(filename) ? filename : "configured-runner.py",
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", bytes: null, sha256: null, filename: null };
    return { status: "invalid", bytes: null, sha256: null, filename: null };
  }
}

function parsePythonInventory(result) {
  if (!result || result.error || result.status !== 0) {
    return {
      status: "blocked",
      pythonVersion: null,
      pythonImplementation: null,
      pythonPlatform: null,
      packages: {},
      accelerators: { cudaAvailable: false, cudaRuntime: null, hipRuntime: null, cudaDevices: [], mpsAvailable: false },
      onnxProviders: [],
      rembgDefaultModel: null,
      runnerSyntaxCompiled: false,
      runnerSha256Matches: false,
      blockers: ["python-runtime-inventory-probe-failed"],
    };
  }
  const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
  if (output.length > 64 * 1024) {
    return {
      status: "blocked",
      pythonVersion: null,
      pythonImplementation: null,
      pythonPlatform: null,
      packages: {},
      accelerators: { cudaAvailable: false, cudaRuntime: null, hipRuntime: null, cudaDevices: [], mpsAvailable: false },
      onnxProviders: [],
      rembgDefaultModel: null,
      runnerSyntaxCompiled: false,
      runnerSha256Matches: false,
      blockers: ["python-runtime-inventory-output-exceeded-limit"],
    };
  }
  try {
    const data = JSON.parse(output.trim());
    const packages = {};
    for (const name of ["torch", "onnxruntime", "rembg", "huggingface-hub", "transformers"]) {
      packages[name] = safeText(data.packages?.[name], 80);
    }
    const devices = Array.isArray(data.accelerators?.cudaDevices)
      ? data.accelerators.cudaDevices.slice(0, 16).map((device) => ({
          index: Number.isSafeInteger(device.index) && device.index >= 0 ? device.index : null,
          name: safeText(device.name, 120),
          totalMemoryBytes: Number.isSafeInteger(device.totalMemoryBytes) && device.totalMemoryBytes >= 0
            ? device.totalMemoryBytes : null,
          major: Number.isSafeInteger(device.major) ? device.major : null,
          minor: Number.isSafeInteger(device.minor) ? device.minor : null,
        }))
      : [];
    const rembgDefaultModel = typeof data.rembgDefaultModel === "string" && SAFE_MODEL_ID.test(data.rembgDefaultModel)
      ? data.rembgDefaultModel : null;
    const rawArtifacts = data.modelArtifacts && typeof data.modelArtifacts === "object" ? data.modelArtifacts : {};
    const parseArtifact = (item, includeRevision = false) => ({
      status: ["cached", "missing", "unknown"].includes(item?.status) ? item.status : "unknown",
      bytes: Number.isSafeInteger(item?.bytes) && item.bytes > 0 ? item.bytes : null,
      ...(includeRevision ? {
        snapshotRevision: typeof item?.snapshotRevision === "string" && /^[a-f0-9]{40}$/.test(item.snapshotRevision)
          ? item.snapshotRevision : null,
      } : {}),
    });
    const modelArtifacts = {
      tripoConfig: parseArtifact(rawArtifacts.tripoConfig, true),
      tripoCheckpoint: parseArtifact(rawArtifacts.tripoCheckpoint, true),
      rembgWeights: parseArtifact(rawArtifacts.rembgWeights),
    };
    const probeErrors = Array.isArray(data.probeErrors)
      ? data.probeErrors.filter((value) => typeof value === "string" && /^[a-z0-9-]{1,100}$/.test(value)).slice(0, 12)
      : ["python-runtime-inventory-result-malformed"];
    const tripoRevision = modelArtifacts.tripoConfig.snapshotRevision;
    if (modelArtifacts.tripoConfig.status !== "cached" ||
        modelArtifacts.tripoCheckpoint.status !== "cached" ||
        !tripoRevision || modelArtifacts.tripoCheckpoint.snapshotRevision !== tripoRevision) {
      probeErrors.push("triposr-cache-artifact-identity-incomplete");
    }
    if (modelArtifacts.tripoConfig.bytes === null || modelArtifacts.tripoCheckpoint.bytes === null) {
      probeErrors.push("triposr-cache-artifact-size-invalid");
    }
    if (modelArtifacts.rembgWeights.status !== "cached") {
      probeErrors.push("rembg-cache-artifact-identity-incomplete");
    }
    if (modelArtifacts.rembgWeights.bytes === null) {
      probeErrors.push("rembg-cache-artifact-size-invalid");
    }
    const coreValid = safeText(data.pythonVersion, 40) !== null &&
      safeText(data.pythonImplementation, 40) !== null &&
      safeText(data.pythonPlatform, 80) !== null &&
      data.packages !== null && typeof data.packages === "object" && !Array.isArray(data.packages) &&
      data.accelerators !== null && typeof data.accelerators === "object" &&
      typeof data.accelerators.cudaAvailable === "boolean" &&
      typeof data.accelerators.mpsAvailable === "boolean" &&
      Array.isArray(data.onnxProviders) &&
      data.modelArtifacts !== null && typeof data.modelArtifacts === "object" &&
      typeof data.runnerSyntaxCompiled === "boolean" &&
      typeof data.runnerSha256Matches === "boolean"
    if (!coreValid) throw new TypeError("malformed Python inventory core");
    return {
      status: probeErrors.length === 0 && data.runnerSyntaxCompiled && data.runnerSha256Matches ? "ready" : "partial",
      pythonVersion: safeText(data.pythonVersion, 40),
      pythonImplementation: safeText(data.pythonImplementation, 40),
      pythonPlatform: safeText(data.pythonPlatform, 80),
      packages,
      accelerators: {
        cudaAvailable: data.accelerators?.cudaAvailable === true,
        cudaRuntime: safeText(data.accelerators?.cudaRuntime, 40),
        hipRuntime: safeText(data.accelerators?.hipRuntime, 40),
        cudaDevices: devices,
        mpsAvailable: data.accelerators?.mpsAvailable === true,
      },
      onnxProviders: Array.isArray(data.onnxProviders)
        ? data.onnxProviders.filter((value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(value)).slice(0, 20)
        : [],
      rembgDefaultModel,
      modelArtifacts,
      runnerSyntaxCompiled: data.runnerSyntaxCompiled === true,
      runnerSha256Matches: data.runnerSha256Matches === true,
      blockers: probeErrors,
    };
  } catch {
    return {
      status: "blocked",
      pythonVersion: null,
      pythonImplementation: null,
      pythonPlatform: null,
      packages: {},
      accelerators: { cudaAvailable: false, cudaRuntime: null, hipRuntime: null, cudaDevices: [], mpsAvailable: false },
      onnxProviders: [],
      rembgDefaultModel: null,
      modelArtifacts: {
        tripoConfig: { status: "unknown", bytes: null, snapshotRevision: null },
        tripoCheckpoint: { status: "unknown", bytes: null, snapshotRevision: null },
        rembgWeights: { status: "unknown", bytes: null },
      },
      runnerSyntaxCompiled: false,
      runnerSha256Matches: false,
      blockers: ["python-runtime-inventory-result-malformed"],
    };
  }
}

/**
 * Captures a redacted, single-image worker host inventory. This probe only imports
 * runtime packages, checks devices/cache readiness and syntax-compiles run.py; it
 * does not execute the TripoSR runner, construct a rembg session, download weights
 * or perform inference. Package imports can still have package-specific side effects.
 */
export async function collectGenerationWorkerHostInventory({
  env = process.env,
  pythonPath = env.BUILDING_ENGINE_PYTHON_EXECUTABLE || env.TRIPOSR_PYTHON || "python",
  runnerScript = env.BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT,
  device = env.BUILDING_ENGINE_DEVICE || "cuda:0",
  now = new Date(),
  commandTimeoutMs = 15_000,
  spawnSyncImpl = nodeSpawnSync,
  probeCapabilities = probeGenerationWorkerCapabilities,
  host = os,
} = {}) {
  if (typeof pythonPath !== "string" || !pythonPath.trim()) throw new TypeError("pythonPath is required.");
  if (!SAFE_DEVICE.test(device)) throw new TypeError("device must be cpu, mps or cuda:N.");
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1000 || commandTimeoutMs > 60_000) {
    throw new RangeError("commandTimeoutMs must be an integer between 1000 and 60000.");
  }
  const checkedAt = validTimestamp(now);
  const runner = await inspectRunner(runnerScript);
  const normalizedEnv = {
    ...env,
    ...(typeof runnerScript === "string" ? { BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: runnerScript } : {}),
    BUILDING_ENGINE_PYTHON_EXECUTABLE: pythonPath,
    TRIPOSR_PYTHON: pythonPath,
    BUILDING_ENGINE_DEVICE: device,
    ...OFFLINE_ENV,
  };
  let probe = null;
  if (runner.status === "present") {
    try {
      probe = spawnSyncImpl(pythonPath, ["-c", buildPythonInventoryProgram(), path.resolve(runnerScript), runner.sha256], {
        encoding: "utf8",
        timeout: commandTimeoutMs,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: normalizedEnv,
      });
    } catch {
      probe = { error: new Error("python-runtime-inventory-probe-failed"), status: null };
    }
  }
  const python = parsePythonInventory(probe);
  let capabilityResult = null;
  let capabilityProbeFailed = false;
  if (runner.status === "present") {
    try {
      capabilityResult = await probeCapabilities({
        env: normalizedEnv,
        now: checkedAt,
        commandTimeoutMs: Math.min(commandTimeoutMs, 30_000),
        strategies: ["single-image-ai"],
      });
    } catch {
      // Never expose subprocess or environment details from the authoritative probe.
      capabilityProbeFailed = true;
    }
  }
  const capabilities = capabilityResult
    ? summarizeCapabilityState(capabilityResult, checkedAt)
    : {
        status: "blocked",
        strategyStatus: "unknown",
        tripoModelWeights: "unknown",
        backgroundRemovalWeights: "unknown",
        blockers: [capabilityProbeFailed
          ? "single-image-capability-probe-failed"
          : "configured-triposr-runner-file-not-valid"],
      };
  const blockers = [];
  if (runner.status !== "present") blockers.push("configured-triposr-runner-file-not-valid");
  if (python.status !== "ready") {
    blockers.push(...python.blockers, "python-runtime-inventory-incomplete");
  }
  if (capabilities.status !== "ready") blockers.push(...capabilities.blockers);
  const hostInfo = {
    platform: safeText(host.platform(), 40),
    release: safeText(host.release(), 100),
    architecture: safeText(host.arch(), 40),
    logicalCpuCount: Number.isSafeInteger(host.cpus()?.length) ? host.cpus().length : null,
    cpuModel: safeText(host.cpus()?.[0]?.model, 120),
    totalMemoryBytes: Number.isSafeInteger(host.totalmem()) ? host.totalmem() : null,
    freeMemoryBytes: Number.isSafeInteger(host.freemem()) ? host.freemem() : null,
  };
  return {
    schemaVersion: GENERATION_WORKER_HOST_INVENTORY_SCHEMA_VERSION,
    kind: "generation-worker-host-inventory",
    checkedAt,
    status: blockers.length ? "blocked" : "ready-for-operator-smoke",
    host: hostInfo,
    node: { version: process.version },
    python: {
      executableConfigured: true,
      version: python.pythonVersion,
      implementation: python.pythonImplementation,
      platform: python.pythonPlatform,
    },
    runtimePackages: python.packages,
    acceleration: {
      selectedDevice: device,
      cudaAvailable: python.accelerators.cudaAvailable,
      cudaRuntime: python.accelerators.cudaRuntime,
      hipRuntime: python.accelerators.hipRuntime,
      cudaDevices: python.accelerators.cudaDevices,
      mpsAvailable: python.accelerators.mpsAvailable,
      onnxProviders: python.onnxProviders,
    },
    runner: {
      ...runner,
      syntaxCompiledInMemory: python.runnerSyntaxCompiled,
      sha256MatchedInProbe: python.runnerSha256Matches,
    },
    modelArtifacts: python.modelArtifacts ?? {
      tripoConfig: { status: "unknown", bytes: null, snapshotRevision: null },
      tripoCheckpoint: { status: "unknown", bytes: null, snapshotRevision: null },
      rembgWeights: { status: "unknown", bytes: null },
    },
    modelReadiness: {
      status: capabilities.status,
      strategyStatus: capabilities.strategyStatus,
      tripoModelWeights: capabilities.tripoModelWeights,
      backgroundRemovalWeights: capabilities.backgroundRemovalWeights,
      ...(capabilities.backgroundRemovalModel
        ? { backgroundRemovalModel: capabilities.backgroundRemovalModel } : {}),
    },
    blockers: [...new Set(blockers)],
    caveats: [
      "This inventory is a preflight snapshot, not proof that a real inference process completed.",
      "The configured TripoSR runner is syntax-compiled in memory but is never executed; a successful preflight does not prove runner behavior.",
      "Model cache state is read-only metadata readiness; model-weight licensing is a separate operator/legal review.",
      "The Python probe imports installed packages. Package initialization may have package-specific side effects; offline flags are not an OS firewall or hermetic sandbox.",
      "No hostname, username, absolute path, environment value, credential, raw subprocess output or private cache path is stored in this report.",
    ],
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
  };
}
