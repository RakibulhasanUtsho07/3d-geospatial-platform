import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
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
import { collectGenerationWorkerHostInventory } from "./generation-worker-host-inventory.mjs";

export const SINGLE_IMAGE_RUNTIME_SMOKE_SCHEMA_VERSION = "1.2.0";
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
export const SINGLE_IMAGE_MODEL_LOAD_ATTESTATION_SITE_CUSTOMIZE = String.raw`import builtins, hashlib, importlib, io, json, os, socket, stat, sys

def _deny_runtime_network(*args, **kwargs):
    raise OSError('network access is disabled by the single-image runtime smoke')

socket.socket.connect = _deny_runtime_network
socket.socket.connect_ex = _deny_runtime_network
socket.socket.send = _deny_runtime_network
socket.socket.sendall = _deny_runtime_network
socket.socket.sendto = _deny_runtime_network
socket.socket.sendmsg = _deny_runtime_network
socket.create_connection = _deny_runtime_network
socket.getaddrinfo = _deny_runtime_network
socket.gethostbyname = _deny_runtime_network
socket.gethostbyname_ex = _deny_runtime_network

_RECEIPT = os.environ.get('BUILDING_ENGINE_MODEL_LOAD_RECEIPT_PATH')
try:
    _EXPECTED = json.loads(os.environ.get('BUILDING_ENGINE_MODEL_LOAD_EXPECTED_JSON', '{}'))
except Exception:
    _EXPECTED = {}
_PATCHED = set()
_ROLE_BY_LOADER = {
    'omegaconf.OmegaConf.load': 'tripoConfig',
    'torch.load': 'tripoCheckpoint',
    'onnxruntime.InferenceSession': 'rembgWeights',
}
_MAX_ONNX_BYTES = 512 * 1024 * 1024

def _signature(item):
    return (
        item.st_dev, item.st_ino, item.st_size,
        getattr(item, 'st_mtime_ns', int(item.st_mtime * 1000000000)),
        getattr(item, 'st_ctime_ns', int(item.st_ctime * 1000000000)),
    )

def _hash_open_file(handle):
    before = os.fstat(handle.fileno())
    if not stat.S_ISREG(before.st_mode) or before.st_size <= 0:
        return None, None, False
    digest = hashlib.sha256()
    total = 0
    handle.seek(0)
    while True:
        chunk = handle.read(8 * 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        total += len(chunk)
    handle.seek(0)
    after = os.fstat(handle.fileno())
    try:
        path_after = os.stat(handle.name)
    except Exception:
        return None, None, False
    stable = (
        _signature(before) == _signature(after) == _signature(path_after)
        and total == after.st_size
    )
    return digest.hexdigest(), total, stable

def _append_receipt(loader, digest, byte_count, stable):
    role = _ROLE_BY_LOADER.get(loader)
    expected = _EXPECTED.get(role) if role else None
    if not role or not isinstance(expected, dict):
        return
    if not stable:
        raise OSError('model artifact changed while its loader was reading it')
    if digest != expected.get('sha256') or byte_count != expected.get('bytes'):
        return
    if not isinstance(_RECEIPT, str) or not _RECEIPT:
        raise OSError('model-load receipt destination is unavailable')
    event = {
        'schemaVersion': '1.0.0',
        'role': role,
        'loader': loader,
        'bytes': byte_count,
        'sha256': digest,
        'exactBytesPassed': True,
        'stable': True,
    }
    payload = (json.dumps(event, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    flags = os.O_WRONLY | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(_RECEIPT, flags)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError('model-load receipt is not a regular file')
        written = 0
        while written < len(payload):
            written += os.write(descriptor, payload[written:])
    finally:
        os.close(descriptor)

def _tracked_file_loader(loader, original, file_value, args, kwargs):
    if not isinstance(file_value, (str, bytes, os.PathLike)):
        return original(file_value, *args, **kwargs)
    if loader == 'torch.load' and kwargs.get('mmap') is True:
        raise OSError('mmap checkpoint loading is unsupported by model-load attestation')
    with open(file_value, 'rb') as handle:
        digest, byte_count, stable = _hash_open_file(handle)
        role = _ROLE_BY_LOADER[loader]
        expected = _EXPECTED.get(role, {})
        if not stable:
            raise OSError('model artifact could not be fingerprinted through a stable file descriptor')
        if digest != expected.get('sha256') or byte_count != expected.get('bytes'):
            return original(file_value, *args, **kwargs)
        if loader == 'omegaconf.OmegaConf.load':
            text_handle = io.TextIOWrapper(handle, encoding='utf-8')
            try:
                result = original(text_handle, *args, **kwargs)
            finally:
                try:
                    text_handle.detach()
                except Exception:
                    pass
        else:
            result = original(handle, *args, **kwargs)
        after_digest, after_bytes, after_stable = _hash_open_file(handle)
        stable_after_load = (
            after_stable and digest == after_digest and byte_count == after_bytes
        )
        if not stable_after_load:
            raise OSError('model artifact changed during its loader call')
        _append_receipt(loader, digest, byte_count, stable_after_load)
        return result

def _tracked_onnx_session(original, model_path_or_bytes, args, kwargs):
    if isinstance(model_path_or_bytes, (str, os.PathLike)):
        model_path = os.fspath(model_path_or_bytes)
        with open(model_path, 'rb') as handle:
            before = os.fstat(handle.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size <= 0 or before.st_size > _MAX_ONNX_BYTES:
                raise OSError('rembg ONNX model file is not a supported regular file')
            model_bytes = handle.read(_MAX_ONNX_BYTES + 1)
            after = os.fstat(handle.fileno())
            try:
                path_after = os.stat(model_path)
            except Exception:
                raise OSError('rembg ONNX model path changed during read')
            stable = (
                _signature(before) == _signature(after) == _signature(path_after)
                and len(model_bytes) == after.st_size
                and len(model_bytes) <= _MAX_ONNX_BYTES
            )
        if not stable:
            raise OSError('rembg ONNX model changed while its bytes were captured')
        digest = hashlib.sha256(model_bytes).hexdigest()
        expected = _EXPECTED.get('rembgWeights', {})
        if digest != expected.get('sha256') or len(model_bytes) != expected.get('bytes'):
            return original(model_path_or_bytes, *args, **kwargs)
        result = original(model_bytes, *args, **kwargs)
        _append_receipt(
            'onnxruntime.InferenceSession', digest, len(model_bytes), True
        )
        return result
    if isinstance(model_path_or_bytes, (bytes, bytearray, memoryview)):
        model_bytes = bytes(model_path_or_bytes)
        digest = hashlib.sha256(model_bytes).hexdigest()
        expected = _EXPECTED.get('rembgWeights', {})
        result = original(model_bytes, *args, **kwargs)
        if digest == expected.get('sha256') and len(model_bytes) == expected.get('bytes'):
            _append_receipt(
                'onnxruntime.InferenceSession', digest, len(model_bytes), True
            )
        return result
    return original(model_path_or_bytes, *args, **kwargs)

def _patch_module(name, module):
    if not _RECEIPT or module is None or name in _PATCHED:
        return
    if name == 'torch' and callable(getattr(module, 'load', None)):
        original = module.load
        def tracked_load(file_value, *args, **kwargs):
            return _tracked_file_loader('torch.load', original, file_value, args, kwargs)
        module.load = tracked_load
        _PATCHED.add(name)
    elif name == 'omegaconf' and getattr(module, 'OmegaConf', None) is not None:
        config_class = module.OmegaConf
        original = getattr(config_class, 'load', None)
        if callable(original):
            def tracked_config_load(file_value, *args, **kwargs):
                return _tracked_file_loader(
                    'omegaconf.OmegaConf.load', original, file_value, args, kwargs
                )
            config_class.load = staticmethod(tracked_config_load)
            _PATCHED.add(name)
    elif name == 'onnxruntime' and callable(getattr(module, 'InferenceSession', None)):
        original = module.InferenceSession
        def tracked_inference_session(model_path_or_bytes, *args, **kwargs):
            return _tracked_onnx_session(
                original, model_path_or_bytes, args, kwargs
            )
        module.InferenceSession = tracked_inference_session
        _PATCHED.add(name)

_original_import = builtins.__import__
_original_import_module = importlib.import_module
def _import_with_model_load_tracking(name, globals=None, locals=None, fromlist=(), level=0):
    imported = _original_import(name, globals, locals, fromlist, level)
    module_name = name.split('.', 1)[0]
    _patch_module(module_name, sys.modules.get(module_name))
    return imported

def _import_module_with_model_load_tracking(name, package=None):
    imported = _original_import_module(name, package)
    module_name = name.split('.', 1)[0]
    _patch_module(module_name, sys.modules.get(module_name))
    return imported

if _RECEIPT:
    builtins.__import__ = _import_with_model_load_tracking
    importlib.import_module = _import_module_with_model_load_tracking
`;
const OFFLINE_SITE_CUSTOMIZE = SINGLE_IMAGE_MODEL_LOAD_ATTESTATION_SITE_CUSTOMIZE;

function safeId(value, label, maxLength = 80) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value.length > maxLength) {
    throw new TypeError(label + " must be a safe identifier no longer than " + maxLength + " characters.");
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
    if (segment === "runtime-smokes" && process.platform !== "win32") {
      await chmod(current, 0o700);
      const directoryInfo = await stat(current);
      if ((directoryInfo.mode & 0o077) !== 0) {
        throw new TypeError("Runtime smoke evidence directory must be owner-only.");
      }
    }
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

function offlineSpawn(spawnImpl, offlinePythonDirectory, {
  pythonPath,
  runnerScript,
  onRunnerLaunchAttempt,
  onRunnerProcessStarted,
  modelLoadAttestation,
} = {}) {
  return (executable, args, options = {}) => {
    const isRunnerInvocation = executable === pythonPath &&
      Array.isArray(args) &&
      typeof args[0] === "string" &&
      path.resolve(args[0]) === runnerScript;
    if (isRunnerInvocation) onRunnerLaunchAttempt?.();

    const child = spawnImpl(executable, args, {
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
        ...(isRunnerInvocation && modelLoadAttestation?.expectedArtifacts ? {
          BUILDING_ENGINE_MODEL_LOAD_RECEIPT_PATH: modelLoadAttestation.receiptPath,
          BUILDING_ENGINE_MODEL_LOAD_EXPECTED_JSON: JSON.stringify({
            tripoConfig: {
              bytes: modelLoadAttestation.expectedArtifacts.tripoConfig.bytes,
              sha256: modelLoadAttestation.expectedArtifacts.tripoConfig.sha256,
            },
            tripoCheckpoint: {
              bytes: modelLoadAttestation.expectedArtifacts.tripoCheckpoint.bytes,
              sha256: modelLoadAttestation.expectedArtifacts.tripoCheckpoint.sha256,
            },
            rembgWeights: {
              bytes: modelLoadAttestation.expectedArtifacts.rembgWeights.bytes,
              sha256: modelLoadAttestation.expectedArtifacts.rembgWeights.sha256,
            },
          }),
        } : {}),
      },
    });
    if (isRunnerInvocation && typeof child?.once === "function") {
      child.once("spawn", () => onRunnerProcessStarted?.());
    }
    return child;
  };
}

function workerFingerprintSnapshot(inventory) {
  const artifacts = inventory?.modelArtifacts ?? {};
  const artifact = (value, includeRevision = false) => ({
    status: value?.status ?? "unknown",
    bytes: Number.isSafeInteger(value?.bytes) && value.bytes > 0 ? value.bytes : null,
    sha256: typeof value?.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
      ? value.sha256 : null,
    ...(includeRevision ? {
      snapshotRevision: typeof value?.snapshotRevision === "string" &&
        /^[a-f0-9]{40}$/.test(value.snapshotRevision) ? value.snapshotRevision : null,
    } : {}),
  });
  return {
    checkedAt: typeof inventory?.checkedAt === "string" ? inventory.checkedAt : null,
    runner: {
      bytes: Number.isSafeInteger(inventory?.runner?.bytes) && inventory.runner.bytes > 0
        ? inventory.runner.bytes : null,
      sha256: typeof inventory?.runner?.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(inventory.runner.sha256) ? inventory.runner.sha256 : null,
    },
    backgroundRemovalModel: typeof inventory?.modelReadiness?.backgroundRemovalModel === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(inventory.modelReadiness.backgroundRemovalModel)
      ? inventory.modelReadiness.backgroundRemovalModel : null,
    modelArtifacts: {
      tripoConfig: artifact(artifacts.tripoConfig, true),
      tripoCheckpoint: artifact(artifacts.tripoCheckpoint, true),
      rembgWeights: artifact(artifacts.rembgWeights),
    },
  };
}

function workerFingerprintBlockers(inventory) {
  const blockers = Array.isArray(inventory?.blockers)
    ? inventory.blockers.filter((item) => typeof item === "string").slice(0, 20)
    : [];
  if (inventory?.status !== "ready-for-operator-smoke") {
    blockers.push("worker-host-inventory-not-ready");
  }
  if (inventory?.modelReadiness?.status !== "ready" ||
      inventory?.modelReadiness?.tripoModelWeights !== "cached" ||
      inventory?.modelReadiness?.backgroundRemovalWeights !== "cached") {
    blockers.push("single-image-model-readiness-not-verified");
  }
  const snapshot = workerFingerprintSnapshot(inventory);
  if (inventory?.runner?.status !== "present" || !snapshot.runner.bytes || !snapshot.runner.sha256) {
    blockers.push("triposr-runner-fingerprint-incomplete");
  }
  const config = snapshot.modelArtifacts.tripoConfig;
  const checkpoint = snapshot.modelArtifacts.tripoCheckpoint;
  const rembg = snapshot.modelArtifacts.rembgWeights;
  if (config.status !== "cached" || !config.bytes || !config.sha256 || !config.snapshotRevision) {
    blockers.push("triposr-config-fingerprint-incomplete");
  }
  if (checkpoint.status !== "cached" || !checkpoint.bytes || !checkpoint.sha256 ||
      !checkpoint.snapshotRevision || checkpoint.snapshotRevision !== config.snapshotRevision) {
    blockers.push("triposr-checkpoint-fingerprint-incomplete");
  }
  if (rembg.status !== "cached" || !rembg.bytes || !rembg.sha256 ||
      !snapshot.backgroundRemovalModel) {
    blockers.push("rembg-weight-fingerprint-incomplete");
  }
  return [...new Set(blockers)].slice(0, 20);
}


async function readModelLoadEvidence(receiptPath, expectedSnapshot) {
  const entry = await lstat(receiptPath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size <= 0 || entry.size > 64 * 1024) {
    throw new TypeError("TripoSR/rembg model-load receipt is missing, unsafe or exceeds its size limit.");
  }
  if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) {
    throw new TypeError("TripoSR/rembg model-load receipt permissions are not private.");
  }
  const receiptText = await readFile(receiptPath, "utf8");
  const events = receiptText.split(/\r?\n/).filter((line) => line.length > 0);
  if (!events.length || events.length > 64) {
    throw new TypeError("TripoSR/rembg model-load receipt has no events or too many events.");
  }
  const expected = [
    ["tripoConfig", "omegaconf.OmegaConf.load"],
    ["tripoCheckpoint", "torch.load"],
    ["rembgWeights", "onnxruntime.InferenceSession"],
  ];
  const loaders = {};
  for (const [role, loader] of expected) {
    const artifact = expectedSnapshot?.modelArtifacts?.[role];
    if (!Number.isSafeInteger(artifact?.bytes) || artifact.bytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? "")) {
      throw new TypeError("Pre-inference worker model fingerprint is incomplete for " + role + ".");
    }
    const matchingEvents = [];
    for (const line of events) {
      let event;
      try { event = JSON.parse(line); } catch {
        throw new TypeError("TripoSR/rembg model-load receipt contains malformed JSON.");
      }
      const keys = Object.keys(event ?? {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify([
        "bytes", "exactBytesPassed", "loader", "role", "schemaVersion", "sha256", "stable",
      ].sort())) {
        throw new TypeError("TripoSR/rembg model-load receipt contains unexpected or path-bearing fields.");
      }
      if (event.schemaVersion !== "1.0.0" ||
          !["tripoConfig", "tripoCheckpoint", "rembgWeights"].includes(event.role) ||
          !["omegaconf.OmegaConf.load", "torch.load", "onnxruntime.InferenceSession"].includes(event.loader) ||
          !Number.isSafeInteger(event.bytes) || event.bytes <= 0 ||
          !/^[a-f0-9]{64}$/.test(event.sha256 ?? "") ||
          event.exactBytesPassed !== true || event.stable !== true) {
        throw new TypeError("TripoSR/rembg model-load receipt contains an invalid loader event.");
      }
      if (event.role === role) matchingEvents.push(event);
    }
    if (!matchingEvents.length || matchingEvents.some((event) =>
      event.loader !== loader ||
      event.bytes !== artifact.bytes ||
      event.sha256 !== artifact.sha256
    )) {
      throw new TypeError("TripoSR/rembg model-load receipt does not bind " + role + " to the exact pre-inference bytes.");
    }
    loaders[role] = {
      loader,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      exactBytesPassed: true,
      stable: true,
    };
  }
  return {
    schemaVersion: "1.0.0",
    status: "verified",
    loaders,
  };
}

function workerFingerprintValues(snapshot) {
  return JSON.stringify({
    runner: snapshot?.runner ?? null,
    backgroundRemovalModel: snapshot?.backgroundRemovalModel ?? null,
    modelArtifacts: snapshot?.modelArtifacts ?? null,
  });
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
    throw new TypeError("confirmModelLicences must be true after checking TripoSR code/checkpoint and rembg model-weight licences.");
  }
  for (const [key, label] of [
    ["triposrLicenceReview", "TripoSR code/checkpoint licence review"],
    ["rembgLicenceReview", "rembg model-weight licence review"],
  ]) {
    if (typeof options[key] !== "string" || !options[key].trim() || options[key].trim().length > 500) {
      throw new TypeError(label + " must be a non-empty statement of at most 500 characters.");
    }
  }

  const jobId = safeId(options.jobId, "jobId", 60);
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
  const inventoryTimeoutMs = options.inventoryTimeoutMs ?? 180_000;
  if (!Number.isInteger(inventoryTimeoutMs) || inventoryTimeoutMs < 1_000 || inventoryTimeoutMs > 180_000) {
    throw new RangeError("inventoryTimeoutMs must be an integer from 1000 to 180000.");
  }
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
    workerHost: {
      inventorySchemaVersion: null,
      before: null,
      after: null,
      stableAcrossInference: null,
    },
    modelLoadEvidence: null,
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
      triposrLicenceReview: options.triposrLicenceReview.trim(),
      rembgLicenceReview: options.rembgLicenceReview.trim(),
    },
    inference: {
      status: "not-started",
      durationMs: null,
      runnerLaunchAttempted: false,
      runnerProcessStarted: false,
    },
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
  const modelLoadReceiptPath = path.join(offlinePythonDirectory, "model-load-receipt.jsonl");
  const modelLoadAttestation = { receiptPath: modelLoadReceiptPath, expectedArtifacts: null };
  try {
    await writeFile(path.join(offlinePythonDirectory, "sitecustomize.py"), OFFLINE_SITE_CUSTOMIZE, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(modelLoadReceiptPath, "", { flag: "wx", mode: 0o600 });
    await chmod(modelLoadReceiptPath, 0o600);
    await createInitialReport(reportPath, report);
  } catch (error) {
    await rm(offlinePythonDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  let workflowStarted = false;
  let runnerLaunchAttempted = false;
  let runnerProcessStarted = false;
  const spawnOffline = offlineSpawn(spawnImpl, offlinePythonDirectory, {
    pythonPath,
    runnerScript,
    modelLoadAttestation,
    onRunnerLaunchAttempt: () => {
      runnerLaunchAttempted = true;
    },
    onRunnerProcessStarted: () => {
      runnerProcessStarted = true;
    },
  });
  try {
    const collectInventory = options.collectWorkerHostInventory ?? collectGenerationWorkerHostInventory;
    const collectWorkerSnapshot = async () => collectInventory({
      env,
      pythonPath,
      runnerScript,
      device,
      now: new Date().toISOString(),
      commandTimeoutMs: inventoryTimeoutMs,
      probeCapabilities: (probeOptions) =>
        (options.probeCapabilities ?? probeGenerationWorkerCapabilities)({
          ...probeOptions,
          spawnImpl: spawnOffline,
        }),
      ...(options.inventorySpawnSyncImpl ? { spawnSyncImpl: options.inventorySpawnSyncImpl } : {}),
    });
    const inventoryBefore = await collectWorkerSnapshot();
    const beforeSnapshot = workerFingerprintSnapshot(inventoryBefore);
    const blockers = workerFingerprintBlockers(inventoryBefore);
    report.checkedAt = inventoryBefore?.checkedAt ?? checkedAt;
    report.workerHost = {
      inventorySchemaVersion: inventoryBefore?.schemaVersion ?? null,
      before: beforeSnapshot,
      after: null,
      stableAcrossInference: null,
    };
    modelLoadAttestation.expectedArtifacts = beforeSnapshot.modelArtifacts;
    report.readiness = {
      strategy: "single-image-ai",
      status: blockers.length ? "blocked" : "ready",
      tripoModelWeights: inventoryBefore?.modelReadiness?.tripoModelWeights ?? "unknown",
      backgroundRemovalWeights: inventoryBefore?.modelReadiness?.backgroundRemovalWeights ?? "unknown",
      backgroundRemovalModel: inventoryBefore?.modelReadiness?.backgroundRemovalModel ?? null,
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

    if (!runnerProcessStarted) {
      throw new TypeError("TripoSR runner did not emit a process-spawn event; runtime inference cannot be confirmed.");
    }
    report.modelLoadEvidence = await readModelLoadEvidence(modelLoadReceiptPath, beforeSnapshot);
    await replaceReportAtomically(reportPath, report);

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

    const inventoryAfter = await collectWorkerSnapshot();
    const afterSnapshot = workerFingerprintSnapshot(inventoryAfter);
    const afterBlockers = workerFingerprintBlockers(inventoryAfter);
    const fingerprintsStable = afterBlockers.length === 0 &&
      workerFingerprintValues(beforeSnapshot) === workerFingerprintValues(afterSnapshot);
    report.workerHost.after = afterSnapshot;
    report.workerHost.stableAcrossInference = fingerprintsStable;
    await replaceReportAtomically(reportPath, report);
    if (afterBlockers.length) {
      throw new TypeError("Worker host post-inference model artifact fingerprint verification is blocked.");
    }
    if (!fingerprintsStable) {
      throw new TypeError("Worker model artifacts or TripoSR runner fingerprint changed during inference.");
    }

    report.status = "passed";
    report.completedAt = new Date().toISOString();
    report.inference = {
      status: "completed",
      durationMs: Number.isFinite(modelReport.durationMs) ? modelReport.durationMs : null,
      runnerLaunchAttempted,
      runnerProcessStarted,
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
    if (!workflowStarted && !report.readiness.blockers?.length) report.readiness.blockers = ["single-image-readiness-probe-failed"];
    report.status = workflowStarted ? "failed" : "blocked";
    report.completedAt = new Date().toISOString();
    report.inference = {
      status: runnerProcessStarted ? "failed" : "not-started",
      durationMs: null,
      runnerLaunchAttempted,
      runnerProcessStarted,
    };
    report.failure = {
      code: error instanceof Error && SAFE_ID.test(error.name) ? error.name : "RuntimeSmokeError",
      summary: !workflowStarted
        ? "Readiness probe failed; no inference was started."
        : error?.message === "Worker model artifacts or TripoSR runner fingerprint changed during inference."
          ? "Worker model artifacts or TripoSR runner fingerprint changed during inference; the candidate remains failed and unpublished."
          : error?.message === "Worker host post-inference model artifact fingerprint verification is blocked."
            ? "Post-inference worker model artifact fingerprint verification was blocked; the candidate remains failed and unpublished."
            : runnerProcessStarted
          ? "The TripoSR runner process started, but model generation, GLB export or evidence validation failed; inspect the private workflow report for diagnostics."
          : runnerLaunchAttempted
            ? "The workflow attempted to launch TripoSR, but the operating-system process never started; inference was not started."
            : "The workflow failed before attempting to launch the TripoSR runner; inference was not started.",
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
