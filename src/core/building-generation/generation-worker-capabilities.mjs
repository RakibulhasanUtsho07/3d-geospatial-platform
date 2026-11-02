import { spawn as nodeSpawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export const GENERATION_WORKER_CAPABILITY_SCHEMA_VERSION = "1.0.0";
const REQUIRED_COLMAP_COMMANDS = ["automatic_reconstructor", "model_analyzer", "model_converter", "mesh_texturer"];

function runProbe(executable, args, { cwd, env, timeoutMs = 10_000, spawnImpl = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(executable, args, { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch { resolve({ ok: false, reason: "spawn-error" }); return; }
    let settled = false, stdout = "", stderr = "", killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, stdout: stdout.slice(-3000), stderr: stderr.slice(-3000) });
    };
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-3000); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-3000); });
    child.once("error", () => {
      if (settled && killTimer) clearTimeout(killTimer);
      finish({ ok: false, reason: "spawn-error" });
    });
    child.once("close", (code, signal) => {
      if (settled && killTimer) {
        clearTimeout(killTimer);
        return;
      }
      finish({ ok: code === 0, code, signal: signal ?? null, reason: code === 0 ? null : "non-zero-exit" });
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ ok: false, reason: "timeout" });
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}

function blocker(result, label) {
  if (result.reason === "spawn-error") return label + " could not be started; check configured executable and PATH.";
  if (result.reason === "timeout") return label + " did not finish the bounded readiness probe.";
  return label + " returned a non-zero exit code during readiness probing.";
}

async function runnerFile(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  try {
    const absolute = path.resolve(filePath), info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile() || !info.size) return null;
    return await realpath(absolute);
  } catch { return null; }
}

async function photogrammetryProbe({ env, spawnImpl, timeoutMs }) {
  const executable = env.BUILDING_ENGINE_COLMAP_PATH || env.COLMAP_BIN || "colmap", blockers = [];
  for (const command of REQUIRED_COLMAP_COMMANDS) {
    const result = await runProbe(executable, [command, "--help"], { timeoutMs, spawnImpl });
    if (!result.ok) { blockers.push(blocker(result, "COLMAP " + command)); break; }
  }
  return {
    status: blockers.length ? "blocked" : "ready", blockers,
    caveats: ["CLI subcommands are probed, not a real reconstruction, overlap/quality or survey registration.", "GPU acceleration is verified only by real execution."],
  };
}

async function singleImageProbe({ env, spawnImpl, timeoutMs }) {
  const blockers = [], runner = await runnerFile(env.BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT);
  if (!runner) blockers.push("Set BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT to an existing, non-empty TripoSR run.py file.");
  const python = env.BUILDING_ENGINE_PYTHON_EXECUTABLE || env.TRIPOSR_PYTHON || "python";
  const device = env.BUILDING_ENGINE_DEVICE || "cuda:0";
  if (!["cpu", "mps"].includes(device) && !/^cuda:\d+$/.test(device)) blockers.push("BUILDING_ENGINE_DEVICE must be cpu, mps or cuda:N.");
  let probeResult = null;
  if (runner && !blockers.length) {
    const script = [
      "import inspect, os, re",
      "import onnxruntime, rembg, torch",
      "from huggingface_hub import try_to_load_from_cache",
      "from rembg.sessions import sessions_class",
      "device = " + JSON.stringify(device),
      "if device.startswith('cuda:'):",
      "    index = int(device.split(':', 1)[1])",
      "    if not torch.cuda.is_available() or index >= torch.cuda.device_count(): raise SystemExit('configured CUDA device unavailable')",
      "elif device == 'mps':",
      "    if not (hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()): raise SystemExit('configured MPS device unavailable')",
      "elif device != 'cpu': raise SystemExit('unsupported compute device')",
      "missing_weights = []",
      "for model_file in ('config.yaml', 'model.ckpt'):",
      "    cached_file = try_to_load_from_cache('stabilityai/TripoSR', model_file)",
      "    if not isinstance(cached_file, str) or not os.path.isfile(cached_file) or os.path.getsize(cached_file) <= 0: missing_weights.append(model_file)",
      "tripo_cache_state = 'TRIPOSR_WEIGHTS_CACHED' if not missing_weights else 'TRIPOSR_WEIGHTS_MISSING:' + ','.join(missing_weights)",
      "model_parameter = inspect.signature(rembg.new_session).parameters.get('model_name')",
      "model_name = model_parameter.default if model_parameter else None",
      "rembg_model_name = model_name if isinstance(model_name, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', model_name) else None",
      "rembg_cache_state = 'REMBG_MODEL_WEIGHTS_UNKNOWN'",
      "if rembg_model_name is not None:",
      "    session_class = next((item for item in sessions_class if item.name() == rembg_model_name), None)",
      "    resolver = getattr(session_class, 'resolve_existing', None) if session_class is not None else None",
      "    if callable(resolver):",
      "        model_path = resolver(rembg_model_name + '.onnx')",
      "        model_path = os.fspath(model_path) if model_path is not None else ''",
      "        model_cached = bool(model_path) and os.path.isfile(model_path) and os.path.getsize(model_path) > 0",
      "        rembg_cache_state = 'REMBG_MODEL_WEIGHTS_CACHED' if model_cached else 'REMBG_MODEL_WEIGHTS_MISSING'",
      "runner_path = " + JSON.stringify(runner),
      "with open(runner_path, 'rb') as runner_file:",
      "    runner_source = runner_file.read()",
      "compile(runner_source, runner_path, 'exec', dont_inherit=True)",
      "print(tripo_cache_state, flush=True)",
      "if rembg_model_name is not None: print('REMBG_MODEL_NAME:' + rembg_model_name, flush=True)",
      "print(rembg_cache_state, flush=True)",
    ].join("\n");
    probeResult = await runProbe(python, ["-c", script], {
      cwd: path.dirname(runner),
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        HF_HUB_OFFLINE: "1",
        HUGGINGFACE_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        HF_DATASETS_OFFLINE: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
      },
      timeoutMs: Math.max(timeoutMs, 15_000),
      spawnImpl,
    });
    if (!probeResult.ok) {
      blockers.push(probeResult.reason === "spawn-error"
        ? "Configured Python executable could not be started; check BUILDING_ENGINE_PYTHON_EXECUTABLE."
        : probeResult.reason === "timeout"
          ? "TripoSR/rembg/ONNX Runtime/PyTorch/device readiness probe timed out."
          : "TripoSR runner, rembg, ONNX Runtime, PyTorch or configured compute device failed its readiness probe.");
    }
  }
  const output = probeResult?.ok ? probeResult.stdout : "";
  const modelWeights = !probeResult?.ok
    ? "unknown"
    : output.includes("TRIPOSR_WEIGHTS_CACHED") ? "cached"
      : output.includes("TRIPOSR_WEIGHTS_MISSING") ? "missing" : "unknown";
  const backgroundRemovalWeights = !probeResult?.ok
    ? "unknown"
    : output.includes("REMBG_MODEL_WEIGHTS_CACHED") ? "cached"
      : output.includes("REMBG_MODEL_WEIGHTS_MISSING") ? "missing" : "unknown";
  const modelMatch = output.match(/(?:^|\n)REMBG_MODEL_NAME:([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\r?\n|$)/);
  const backgroundRemovalModel = modelMatch?.[1] ?? null;
  const allModelsCached = modelWeights === "cached" && backgroundRemovalWeights === "cached";
  return {
    status: blockers.length ? "blocked" : allModelsCached ? "ready" : "configured",
    blockers,
    caveats: [
      "The Python process imports PyTorch, ONNX Runtime and rembg and checks the configured device. The configured TripoSR runner is syntax-compiled in memory but is never executed.",
      "The preflight deliberately does not invoke the runner's --help handler because a configured script could perform arbitrary side effects. Actual runner behavior is checked only by the D3M-05 smoke.",
      modelWeights === "cached"
        ? "The configured TripoSR config.yaml and model.ckpt files are present in the local Hugging Face cache."
        : modelWeights === "missing"
          ? "The configured TripoSR config.yaml and/or model.ckpt is not cached; this worker will not claim single-image jobs until both files are cached."
          : "TripoSR model cache state could not be verified.",
      backgroundRemovalWeights === "cached"
        ? "The installed rembg default model (" + (backgroundRemovalModel ?? "identified model") + ") is present in the local cache."
        : backgroundRemovalWeights === "missing"
          ? "The installed rembg default model (" + (backgroundRemovalModel ?? "identified model") + ") is missing from the local cache; this worker will not claim single-image jobs."
          : "The installed rembg default model or its local cache state could not be identified; single-image jobs remain unclaimable.",
      "The probe uses the installed rembg session class' read-only cache resolver. It does not construct a session, download weights, verify model licensing or run ONNX inference.",
      "Actual end-to-end inference, GPU kernels, available memory and GLB quality are checked only by a real job. Single-image output remains an AI proposal and requires independent review.",
    ],
    modelWeights,
    backgroundRemovalWeights,
    ...(backgroundRemovalModel ? { backgroundRemovalModel } : {}),
  };
}
export async function probeGenerationWorkerCapabilities({ env = process.env, spawnImpl = nodeSpawn, now = new Date(), commandTimeoutMs = 10_000 } = {}) {
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1000 || commandTimeoutMs > 30_000) throw new RangeError("commandTimeoutMs must be an integer from 1000 to 30000.");
  const checkedAt = new Date(now).toISOString();
  if (!Number.isFinite(Date.parse(checkedAt))) throw new TypeError("now must be a valid timestamp.");
  const [photogrammetry, singleImage] = await Promise.all([
    photogrammetryProbe({ env, spawnImpl, timeoutMs: commandTimeoutMs }),
    singleImageProbe({ env, spawnImpl, timeoutMs: commandTimeoutMs }),
  ]);
  return {
    schemaVersion: GENERATION_WORKER_CAPABILITY_SCHEMA_VERSION,
    checkedAt,
    strategies: {
      procedural: { status: "ready", blockers: [], caveats: ["In-process parametric generator; not image-derived facade reconstruction."] },
      photogrammetry,
      "single-image-ai": singleImage,
    },
  };
}

export function getClaimableGenerationStrategies(capabilities) {
  if (!capabilities || typeof capabilities !== "object" || !capabilities.strategies) return ["auto", "procedural"];
  const allowed = ["auto", "procedural"];
  if (capabilities.strategies.photogrammetry?.status === "ready") allowed.push("photogrammetry");
  if (capabilities.strategies["single-image-ai"]?.status === "ready" &&
      capabilities.strategies["single-image-ai"]?.modelWeights === "cached" &&
      capabilities.strategies["single-image-ai"]?.backgroundRemovalWeights === "cached") allowed.push("single-image-ai");
  return allowed;
}
