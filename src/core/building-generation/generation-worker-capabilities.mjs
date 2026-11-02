import { spawn as nodeSpawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export const GENERATION_WORKER_CAPABILITY_SCHEMA_VERSION = "1.0.0";
const REQUIRED_COLMAP_COMMANDS = ["automatic_reconstructor", "model_analyzer", "model_converter", "mesh_texturer"];

function runProbe(executable, args, { cwd, timeoutMs = 10_000, spawnImpl = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(executable, args, { ...(cwd ? { cwd } : {}), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch { resolve({ ok: false, reason: "spawn-error" }); return; }
    let settled = false, stdout = "", stderr = "", killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, stdout: stdout.slice(-3000), stderr: stderr.slice(-3000) });
    };
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-3000); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-3000); });
    child.once("error", () => finish({ ok: false, reason: "spawn-error" }));
    child.once("close", (code, signal) => finish({ ok: code === 0, code, signal: signal ?? null, reason: code === 0 ? null : "non-zero-exit" }));
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1000);
      killTimer.unref?.(); finish({ ok: false, reason: "timeout" });
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
  if (runner && !blockers.length) {
    const script = [
      "import runpy, sys", "import torch", "device = " + JSON.stringify(device),
      "if device.startswith('cuda:'):", "    index = int(device.split(':', 1)[1])",
      "    if not torch.cuda.is_available() or index >= torch.cuda.device_count(): raise SystemExit('configured CUDA device unavailable')",
      "elif device == 'mps':",
      "    if not (hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()): raise SystemExit('configured MPS device unavailable')",
      "elif device != 'cpu': raise SystemExit('unsupported compute device')",
      "sys.argv = [" + JSON.stringify(runner) + ", '--help']",
      "try:", "    runpy.run_path(" + JSON.stringify(runner) + ", run_name='__main__')",
      "except SystemExit as error:", "    if error.code not in (None, 0): raise",
    ].join("\n");
    const result = await runProbe(python, ["-c", script], { cwd: path.dirname(runner), timeoutMs: Math.max(timeoutMs, 15_000), spawnImpl });
    if (!result.ok) {
      blockers.push(result.reason === "spawn-error"
        ? "Configured Python executable could not be started; check BUILDING_ENGINE_PYTHON_EXECUTABLE."
        : result.reason === "timeout"
          ? "TripoSR runner/PyTorch/device readiness probe timed out."
          : "TripoSR runner imports, PyTorch, or configured compute device failed its readiness probe.");
    }
  }
  return {
    status: blockers.length ? "blocked" : "configured", blockers,
    caveats: [
      "Runner imports, PyTorch and configured device are checked without generating a model.",
      "Pretrained model weights/cache and remote availability are not checked until a real job starts.",
      "Single-image output remains an AI proposal and requires independent review.",
    ],
    modelWeights: "not-checked",
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
  if (capabilities.strategies["single-image-ai"]?.status === "configured") allowed.push("single-image-ai");
  return allowed;
}
