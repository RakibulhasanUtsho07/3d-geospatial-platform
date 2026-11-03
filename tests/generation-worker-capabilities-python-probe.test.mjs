import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getClaimableGenerationStrategies,
  probeGenerationWorkerCapabilities,
} from "../src/core/building-generation/generation-worker-capabilities.mjs";

function findPython() {
  const candidates = process.platform === "win32" ? ["python"] : ["python3", "python"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

async function createFixture(t, {
  tripoFiles = ["config.yaml", "model.ckpt"],
  rembgFiles = ["bria-rmbg.onnx"],
  modelName = "bria-rmbg",
  resolver = "present",
  signature = "known",
  importFailure = null,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-python-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stubs = path.join(root, "python-stubs");
  const hfCache = path.join(root, "hf-cache");
  const rembgCache = path.join(root, "rembg-cache");
  const runnerDirectory = path.join(root, "triposr");
  await Promise.all([
    mkdir(path.join(stubs, "rembg", "sessions"), { recursive: true }),
    mkdir(hfCache, { recursive: true }),
    mkdir(rembgCache, { recursive: true }),
    mkdir(runnerDirectory, { recursive: true }),
  ]);

  for (const filename of tripoFiles) {
    await writeFile(path.join(hfCache, filename), "fixture model bytes");
  }
  for (const filename of rembgFiles) {
    await writeFile(path.join(rembgCache, filename), "fixture ONNX bytes");
  }

  await writeFile(path.join(stubs, "torch.py"), "__version__ = 'fixture'\n");
  await writeFile(
    path.join(stubs, "onnxruntime.py"),
    importFailure ? "raise ImportError(" + JSON.stringify(importFailure) + ")\n" : "__version__ = 'fixture'\n",
  );
  await writeFile(
    path.join(stubs, "huggingface_hub.py"),
    [
      "import os",
      "def try_to_load_from_cache(repo_id, filename):",
      "    candidate = os.path.join(os.environ['FAKE_HF_CACHE'], filename)",
      "    return candidate if os.path.isfile(candidate) else object()",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(stubs, "rembg", "__init__.py"), "from .session_factory import new_session\n");

  const sessionFactory = signature === "known"
    ? "def new_session(model_name=" + JSON.stringify(modelName) + "):\n    raise AssertionError('probe must not initialize a session')\n"
    : "def new_session(model):\n    raise AssertionError('probe must not initialize a session')\n";
  await writeFile(path.join(stubs, "rembg", "session_factory.py"), sessionFactory);

  const sessionModule = [
    "import os",
    "MODEL_NAME = " + JSON.stringify(modelName),
    "class FixtureSession:",
    "    @classmethod",
    "    def name(cls):",
    "        return MODEL_NAME",
  ];
  if (resolver === "present") {
    sessionModule.push(
      "    @classmethod",
      "    def resolve_existing(cls, filename):",
      "        candidate = os.path.join(os.environ['FAKE_REMBG_CACHE'], filename)",
      "        return candidate if os.path.isfile(candidate) else None",
    );
  }
  sessionModule.push("sessions_class = [FixtureSession]", "");
  await writeFile(path.join(stubs, "rembg", "sessions", "__init__.py"), sessionModule.join("\n"));

  const runnerExecutionMarker = path.join(root, "runner-executed.marker");
  await writeFile(
    path.join(runnerDirectory, "run.py"),
    [
      "from pathlib import Path",
      "Path(" + JSON.stringify(runnerExecutionMarker) + ").write_text('executed')",
      "raise RuntimeError('configured runner must never execute during capability preflight')",
      "",
    ].join("\n"),
  );

  const python = findPython();
  const spawnImpl = (executable, args, options = {}) => {
    if (executable === python && python) {
      const existingPythonPath = process.env.PYTHONPATH;
      return nodeSpawn(executable, args, {
        ...options,
        env: {
          ...process.env,
          ...options.env,
          PYTHONPATH: [stubs, existingPythonPath].filter(Boolean).join(path.delimiter),
          FAKE_HF_CACHE: hfCache,
          FAKE_REMBG_CACHE: rembgCache,
        },
      });
    }
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => child.emit("error", new Error("COLMAP is intentionally unavailable in this test.")));
    return child;
  };

  return { root, python, runner: path.join(runnerDirectory, "run.py"), runnerExecutionMarker, spawnImpl };
}

async function probe(fixture, t) {
  if (!fixture.python) {
    t.skip("Python 3 is not installed in this environment.");
    return null;
  }
  return probeGenerationWorkerCapabilities({
    env: {
      BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: fixture.runner,
      BUILDING_ENGINE_PYTHON_EXECUTABLE: fixture.python,
      BUILDING_ENGINE_DEVICE: "cpu",
    },
    spawnImpl: fixture.spawnImpl,
    commandTimeoutMs: 3000,
  });
}

test("checks cached TripoSR/rembg and runner syntax without executing configured run.py", async (t) => {
  const fixture = await createFixture(t);
  const capabilities = await probe(fixture, t);
  if (!capabilities) return;

  const singleImage = capabilities.strategies["single-image-ai"];
  assert.equal(singleImage.status, "ready");
  assert.equal(singleImage.modelWeights, "cached");
  assert.equal(singleImage.backgroundRemovalWeights, "cached");
  assert.equal(singleImage.backgroundRemovalModel, "bria-rmbg");
  assert.ok(getClaimableGenerationStrategies(capabilities).includes("single-image-ai"));
  let runnerExecuted = false;
  try { await access(fixture.runnerExecutionMarker); runnerExecuted = true; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  assert.equal(runnerExecuted, false, "preflight must syntax-compile run.py without executing its top-level code");
  assert.equal(JSON.stringify(capabilities).includes(fixture.root), false);
});

test("does not claim single-image jobs when the active rembg model file is absent", async (t) => {
  const fixture = await createFixture(t, { rembgFiles: [] });
  const capabilities = await probe(fixture, t);
  if (!capabilities) return;

  const singleImage = capabilities.strategies["single-image-ai"];
  assert.equal(singleImage.status, "configured");
  assert.equal(singleImage.modelWeights, "cached");
  assert.equal(singleImage.backgroundRemovalWeights, "missing");
  assert.deepEqual(getClaimableGenerationStrategies(capabilities), ["auto", "procedural"]);
});

test("does not claim single-image jobs when a required TripoSR file is absent", async (t) => {
  const fixture = await createFixture(t, { tripoFiles: ["config.yaml"] });
  const capabilities = await probe(fixture, t);
  if (!capabilities) return;

  const singleImage = capabilities.strategies["single-image-ai"];
  assert.equal(singleImage.status, "configured");
  assert.equal(singleImage.modelWeights, "missing");
  assert.equal(singleImage.backgroundRemovalWeights, "cached");
  assert.deepEqual(getClaimableGenerationStrategies(capabilities), ["auto", "procedural"]);
});

test("fails closed when the installed rembg session class has no cache resolver", async (t) => {
  const fixture = await createFixture(t, { resolver: "unknown" });
  const capabilities = await probe(fixture, t);
  if (!capabilities) return;

  const singleImage = capabilities.strategies["single-image-ai"];
  assert.equal(singleImage.status, "configured");
  assert.equal(singleImage.backgroundRemovalWeights, "unknown");
  assert.deepEqual(getClaimableGenerationStrategies(capabilities), ["auto", "procedural"]);
});

test("fails closed when the installed rembg API has no model_name default", async (t) => {
  const fixture = await createFixture(t, { signature: "unknown" });
  const capabilities = await probe(fixture, t);
  if (!capabilities) return;

  const singleImage = capabilities.strategies["single-image-ai"];
  assert.equal(singleImage.status, "configured");
  assert.equal(singleImage.backgroundRemovalWeights, "unknown");
  assert.equal(singleImage.backgroundRemovalModel, undefined);
  assert.deepEqual(getClaimableGenerationStrategies(capabilities), ["auto", "procedural"]);
});

test("blocks single-image readiness when ONNX Runtime cannot be imported", async (t) => {
  const fixture = await createFixture(t, { importFailure: "ONNX Runtime fixture unavailable" });
  const capabilities = await probe(fixture, t);
  if (!capabilities) return;

  const singleImage = capabilities.strategies["single-image-ai"];
  assert.equal(singleImage.status, "blocked");
  assert.match(singleImage.blockers.join(" "), /runner, rembg, ONNX Runtime, PyTorch/i);
  assert.deepEqual(getClaimableGenerationStrategies(capabilities), ["auto", "procedural"]);
});
