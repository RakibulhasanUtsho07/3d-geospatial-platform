import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getClaimableGenerationStrategies, probeGenerationWorkerCapabilities } from "../src/core/building-generation/generation-worker-capabilities.mjs";

function fakeSuccessfulSpawn(stdoutText = "mock help output") {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      child.stdout.end(stdoutText);
      child.stderr.end("");
      child.emit("close", 0, null);
    });
    return child;
  };
}

test("probes COLMAP commands and TripoSR/PyTorch/device prerequisites", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-capability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "run.py");
  await writeFile(runner, "print('fixture runner')\n");
  const calls = [];
  const result = await probeGenerationWorkerCapabilities({
    env: {
      BUILDING_ENGINE_COLMAP_PATH: "colmap-fixture",
      BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: runner,
      BUILDING_ENGINE_PYTHON_EXECUTABLE: "python-fixture",
      BUILDING_ENGINE_DEVICE: "cuda:0",
    },
    spawnImpl: (executable, args) => {
      calls.push({ executable, args });
      return fakeSuccessfulSpawn(executable === "python-fixture"
        ? "TRIPOSR_WEIGHTS_CACHED\nREMBG_MODEL_NAME:bria-rmbg\nREMBG_MODEL_WEIGHTS_CACHED"
        : undefined)();
    },
    now: "2026-11-02T04:00:00.000Z",
  });
  assert.equal(result.strategies.procedural.status, "ready");
  assert.equal(result.strategies.photogrammetry.status, "ready");
  assert.equal(result.strategies["single-image-ai"].status, "ready");
  assert.equal(result.strategies["single-image-ai"].modelWeights, "cached");
  assert.equal(result.strategies["single-image-ai"].backgroundRemovalWeights, "cached");
  assert.equal(result.strategies["single-image-ai"].backgroundRemovalModel, "bria-rmbg");
  assert.equal(calls.filter((entry) => entry.executable === "colmap-fixture").length, 4);
  const pythonProbe = calls.find((entry) => entry.executable === "python-fixture" && entry.args[0] === "-c");
  assert.ok(pythonProbe);
  assert.equal(pythonProbe.args[1].includes("\n"), true);
  assert.equal(pythonProbe.args[1].includes("configured CUDA device unavailable"), true);
  assert.equal(pythonProbe.args[1].includes("try_to_load_from_cache"), true);
  assert.equal(pythonProbe.args[1].includes("model.ckpt"), true);
  assert.equal(pythonProbe.args[1].includes("import onnxruntime, rembg, torch"), true);
  assert.equal(pythonProbe.args[1].includes("resolve_existing"), true);
  assert.equal(pythonProbe.args[1].includes("REMBG_MODEL_WEIGHTS_CACHED"), true);
  assert.equal(pythonProbe.args[1].includes("new_session("), false);
  assert.deepEqual(getClaimableGenerationStrategies(result), ["auto", "procedural", "photogrammetry", "single-image-ai"]);
});

test("keeps single-image jobs unclaimable when TripoSR weights are not cached", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-capability-no-weights-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "run.py");
  await writeFile(runner, "print('fixture runner')\n");
  const result = await probeGenerationWorkerCapabilities({
    env: {
      BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: runner,
      BUILDING_ENGINE_PYTHON_EXECUTABLE: "python-fixture",
      BUILDING_ENGINE_DEVICE: "cpu",
    },
    spawnImpl: (executable) => fakeSuccessfulSpawn(executable === "python-fixture"
      ? "TRIPOSR_WEIGHTS_MISSING:model.ckpt\nREMBG_MODEL_NAME:u2net\nREMBG_MODEL_WEIGHTS_CACHED"
      : undefined)(),
  });
  assert.equal(result.strategies["single-image-ai"].status, "configured");
  assert.equal(result.strategies["single-image-ai"].modelWeights, "missing");
  assert.equal(result.strategies["single-image-ai"].backgroundRemovalWeights, "cached");
  assert.deepEqual(getClaimableGenerationStrategies(result), ["auto", "procedural", "photogrammetry"]);
});

test("blocks missing/symlinked runner files and never serializes their paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-capability-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "run.py");
  const linkedRunner = path.join(root, "linked-run.py");
  await writeFile(runner, "print('fixture runner')\n");
  await symlink(runner, linkedRunner);
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => child.emit("error", new Error("missing executable")));
    return child;
  };
  const result = await probeGenerationWorkerCapabilities({
    env: {
      BUILDING_ENGINE_COLMAP_PATH: "missing-colmap",
      BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: linkedRunner,
      BUILDING_ENGINE_PYTHON_EXECUTABLE: "python-fixture",
      BUILDING_ENGINE_DEVICE: "cpu",
    },
    spawnImpl,
  });
  assert.equal(result.strategies.photogrammetry.status, "blocked");
  assert.equal(result.strategies["single-image-ai"].status, "blocked");
  assert.match(result.strategies["single-image-ai"].blockers[0], /BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT/);
  assert.equal(JSON.stringify(result).includes(linkedRunner), false);
  assert.deepEqual(getClaimableGenerationStrategies(result), ["auto", "procedural"]);
});

test("blocks single-image runtime when its configured compute device probe fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-capability-device-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "run.py");
  await writeFile(runner, "print('fixture runner')\n");
  const result = await probeGenerationWorkerCapabilities({
    env: {
      BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: runner,
      BUILDING_ENGINE_PYTHON_EXECUTABLE: "python-fixture",
      BUILDING_ENGINE_DEVICE: "cuda:0",
    },
    spawnImpl: (executable) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        if (executable === "colmap") child.emit("error", new Error("missing"));
        else { child.stderr.end("device unavailable"); child.emit("close", 1, null); }
      });
      return child;
    },
  });
  assert.equal(result.strategies["single-image-ai"].status, "blocked");
  assert.match(result.strategies["single-image-ai"].blockers[0], /runner imports|compute device/i);
});


test("keeps single-image jobs unclaimable when the effective rembg model is not cached", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-capability-no-rembg-weights-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "run.py");
  await writeFile(runner, "print('fixture runner')\n");
  const result = await probeGenerationWorkerCapabilities({
    env: {
      BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: runner,
      BUILDING_ENGINE_PYTHON_EXECUTABLE: "python-fixture",
      BUILDING_ENGINE_DEVICE: "cpu",
    },
    spawnImpl: (executable) => fakeSuccessfulSpawn(executable === "python-fixture"
      ? "TRIPOSR_WEIGHTS_CACHED\nREMBG_MODEL_NAME:bria-rmbg\nREMBG_MODEL_WEIGHTS_MISSING"
      : undefined)(),
  });
  assert.equal(result.strategies["single-image-ai"].status, "configured");
  assert.equal(result.strategies["single-image-ai"].modelWeights, "cached");
  assert.equal(result.strategies["single-image-ai"].backgroundRemovalWeights, "missing");
  assert.equal(result.strategies["single-image-ai"].backgroundRemovalModel, "bria-rmbg");
  assert.deepEqual(getClaimableGenerationStrategies(result), ["auto", "procedural", "photogrammetry"]);
});

test("fails closed when the rembg model or cache layout cannot be identified", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-capability-unknown-rembg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "run.py");
  await writeFile(runner, "print('fixture runner')\n");
  const result = await probeGenerationWorkerCapabilities({
    env: {
      BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: runner,
      BUILDING_ENGINE_PYTHON_EXECUTABLE: "python-fixture",
      BUILDING_ENGINE_DEVICE: "cpu",
    },
    spawnImpl: (executable) => fakeSuccessfulSpawn(executable === "python-fixture"
      ? "TRIPOSR_WEIGHTS_CACHED\nREMBG_MODEL_WEIGHTS_UNKNOWN"
      : undefined)(),
  });
  assert.equal(result.strategies["single-image-ai"].status, "configured");
  assert.equal(result.strategies["single-image-ai"].backgroundRemovalWeights, "unknown");
  assert.deepEqual(getClaimableGenerationStrategies(result), ["auto", "procedural", "photogrammetry"]);
});
