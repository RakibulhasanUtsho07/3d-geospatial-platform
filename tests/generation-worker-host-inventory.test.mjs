import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPythonInventoryProgram,
  collectGenerationWorkerHostInventory,
} from "../src/core/building-generation/generation-worker-host-inventory.mjs";

const NOW = "2026-11-03T10:00:00.000Z";

function capabilities(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    checkedAt: NOW,
    strategies: {
      "single-image-ai": {
        status: "ready",
        blockers: [],
        modelWeights: "cached",
        backgroundRemovalWeights: "cached",
        backgroundRemovalModel: "isnet-general-use",
      },
    },
    ...overrides,
  };
}

function pythonResult(overrides = {}) {
  return {
    status: 0,
    stdout: JSON.stringify({
      pythonVersion: "3.11.9",
      pythonImplementation: "CPython",
      pythonPlatform: "Linux-x86_64",
      packages: {
        torch: "2.5.1",
        onnxruntime: "1.20.1",
        rembg: "2.0.60",
        "huggingface-hub": "0.27.0",
        transformers: "4.48.0",
      },
      accelerators: {
        cudaAvailable: true,
        cudaRuntime: "12.4",
        hipRuntime: null,
        cudaDevices: [{ index: 0, name: "Test GPU", totalMemoryBytes: 12 * 1024 ** 3, major: 8, minor: 6 }],
        mpsAvailable: false,
      },
      onnxProviders: ["CUDAExecutionProvider", "CPUExecutionProvider"],
      rembgDefaultModel: "isnet-general-use",
      modelArtifacts: {
        tripoConfig: { status: "cached", bytes: 512, sha256: "c".repeat(64), snapshotRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        tripoCheckpoint: { status: "cached", bytes: 480000000, sha256: "a".repeat(64), snapshotRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        rembgWeights: { status: "cached", bytes: 176000000, sha256: "b".repeat(64) },
      },
      runnerSyntaxCompiled: true,
      runnerSha256Matches: true,
      probeErrors: [],
    }),
    ...overrides,
  };
}

async function runnerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-host-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "run.py");
  await writeFile(runner, "raise RuntimeError('must be compiled, not executed')\n");
  return { root, runner };
}

function fakeHost() {
  return {
    platform: () => "linux",
    release: () => "6.8.0-test",
    arch: () => "x64",
    cpus: () => [{ model: "Fixture CPU Model" }, { model: "Fixture CPU Model" }],
    totalmem: () => 32 * 1024 ** 3,
    freemem: () => 20 * 1024 ** 3,
  };
}


test("generated Python inventory probe has valid syntax and initializes model artifact records", () => {
  const source = buildPythonInventoryProgram();
  assert.ok(source.includes("'modelArtifacts': {'tripoConfig'"));
  assert.ok(source.includes("try_to_load_from_cache('stabilityai/TripoSR'"));
  assert.ok(source.includes("resolve_existing"));
  assert.ok(source.includes("runnerSha256Matches"));
  assert.ok(source.includes("handle.read(8 * 1024 * 1024)"));
  assert.ok(source.includes("signature(before) != signature(after)"));
  const result = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
    input: source,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Python inventory hashes exact model bytes in bounded chunks and reports no cache path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-model-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const revision = "a".repeat(40);
  const revisionDirectory = path.join(root, revision);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(revisionDirectory));
  const artifact = path.join(revisionDirectory, "model.ckpt");
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 0x5a);
  await writeFile(artifact, bytes);

  const sourceLines = buildPythonInventoryProgram().split("\n");
  const start = sourceLines.findIndex((line) => line === "def file_summary(file_path, include_revision=False):");
  const end = sourceLines.findIndex((line, index) => index > start && line === "try:");
  assert.ok(start >= 0 && end > start);
  const harness = [
    "import hashlib, json, os, re, stat, sys",
    ...sourceLines.slice(start, end),
    "print(json.dumps(file_summary(sys.argv[1], include_revision=True), sort_keys=True))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", harness, artifact], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.status, "cached");
  assert.equal(summary.bytes, bytes.length);
  assert.equal(summary.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(summary.snapshotRevision, revision);
  assert.equal(JSON.stringify(summary).includes(artifact), false);
});

test("collects a ready redacted host inventory with runtime, GPU, cache and runner fingerprints", async (t) => {
  const { runner } = await runnerFixture(t);
  let spawn = null;
  let capabilityArgs = null;
  const report = await collectGenerationWorkerHostInventory({
    env: { API_TOKEN: "must-not-leak", BUILDING_ENGINE_DEVICE: "cuda:0" },
    pythonPath: "/private/python",
    runnerScript: runner,
    device: "cuda:0",
    now: NOW,
    spawnSyncImpl: (...args) => { spawn = args; return pythonResult(); },
    probeCapabilities: async (args) => { capabilityArgs = args; return capabilities(); },
    host: fakeHost(),
  });
  assert.equal(report.status, "ready-for-operator-smoke");
  assert.equal(report.host.logicalCpuCount, 2);
  assert.equal(report.host.totalMemoryBytes, 32 * 1024 ** 3);
  assert.equal(report.python.version, "3.11.9");
  assert.equal(report.runtimePackages.torch, "2.5.1");
  assert.equal(report.acceleration.cudaDevices[0].totalMemoryBytes, 12 * 1024 ** 3);
  assert.equal(report.acceleration.onnxProviders.includes("CUDAExecutionProvider"), true);
  assert.equal(report.runner.status, "present");
  assert.match(report.runner.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.modelReadiness.backgroundRemovalModel, "isnet-general-use");
  assert.equal(report.modelArtifacts.tripoCheckpoint.snapshotRevision, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(report.modelArtifacts.tripoCheckpoint.bytes, 480000000);
  assert.match(report.modelArtifacts.tripoConfig.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.modelArtifacts.tripoCheckpoint.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.modelArtifacts.rembgWeights.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.modelArtifacts.rembgWeights.status, "cached");
  assert.equal(report.schemaVersion, "1.1.0");
  assert.deepEqual(capabilityArgs.strategies, ["single-image-ai"]);
  assert.equal(spawn[1][0], "-c");
  assert.equal(spawn[1][3], report.runner.sha256);
  assert.ok(spawn[1][1].includes("hashlib.sha256(runner_bytes).hexdigest() == sys.argv[2]"));
  assert.ok(spawn[1][1].includes("compile(runner_bytes"));
  assert.equal(report.runner.syntaxCompiledInMemory, true);
  assert.equal(report.runner.sha256MatchedInProbe, true);
  assert.doesNotMatch(spawn[1][1], /exec\(runner_bytes/);
  assert.equal(report.mapReady, false);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.automaticApproval, false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("/private/python"), false);
  assert.equal(serialized.includes(runner), false);
  assert.equal(serialized.includes(os.hostname()), false);
});

test("blocks when TripoSR or rembg weights are missing or unknown", async (t) => {
  const { runner } = await runnerFixture(t);
  const report = await collectGenerationWorkerHostInventory({
    pythonPath: "python-fixture",
    runnerScript: runner,
    device: "cpu",
    now: NOW,
    spawnSyncImpl: () => pythonResult(),
    probeCapabilities: async () => capabilities({
      strategies: { "single-image-ai": {
        status: "configured", blockers: [],
        modelWeights: "cached", backgroundRemovalWeights: "missing",
        backgroundRemovalModel: "isnet-general-use",
      } },
    }),
    host: fakeHost(),
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("rembg-model-cache-not-verified-cached"));
  assert.equal(report.modelReadiness.tripoModelWeights, "cached");
  assert.equal(report.modelReadiness.backgroundRemovalWeights, "missing");
});

test("blocks if the Python probe or runner syntax compilation fails and exposes no stderr", async (t) => {
  const { runner } = await runnerFixture(t);
  const report = await collectGenerationWorkerHostInventory({
    pythonPath: "python-fixture",
    runnerScript: runner,
    device: "cpu",
    now: NOW,
    spawnSyncImpl: () => ({
      status: 1,
      stdout: "PRIVATE_CACHE=/secret/path",
      stderr: "API_TOKEN=secret",
    }),
    probeCapabilities: async () => capabilities(),
    host: fakeHost(),
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("python-runtime-inventory-incomplete"));
  assert.equal(JSON.stringify(report).includes("/secret/path"), false);
  assert.equal(JSON.stringify(report).includes("API_TOKEN"), false);
});

test("rejects symlinked runner files without launching Python", async (t) => {
  const { root, runner } = await runnerFixture(t);
  const link = path.join(root, "linked-run.py");
  await symlink(runner, link);
  let launched = false;
  let capabilityProbeCalled = false;
  const report = await collectGenerationWorkerHostInventory({
    pythonPath: "python-fixture",
    runnerScript: link,
    device: "cpu",
    now: NOW,
    spawnSyncImpl: () => { launched = true; return pythonResult(); },
    probeCapabilities: async () => { capabilityProbeCalled = true; return capabilities(); },
    host: fakeHost(),
  });
  assert.equal(launched, false);
  assert.equal(capabilityProbeCalled, false);
  assert.equal(report.status, "blocked");
  assert.equal(report.runner.status, "invalid");
  assert.ok(report.blockers.includes("configured-triposr-runner-file-not-valid"));
});

test("fails closed with a redacted blocker when the authoritative capability probe throws", async (t) => {
  const { runner } = await runnerFixture(t);
  const report = await collectGenerationWorkerHostInventory({
    pythonPath: "python-fixture",
    runnerScript: runner,
    device: "cpu",
    now: NOW,
    spawnSyncImpl: () => pythonResult(),
    probeCapabilities: async () => { throw new Error("API_TOKEN=secret /private/worker/cache"); },
    host: fakeHost(),
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("single-image-capability-probe-failed"));
  assert.equal(JSON.stringify(report).includes("API_TOKEN"), false);
  assert.equal(JSON.stringify(report).includes("/private/worker/cache"), false);
});

test("blocks cached model artifacts with missing or invalid byte lengths", async (t) => {
  const { runner } = await runnerFixture(t);
  const inventory = JSON.parse(pythonResult().stdout);
  inventory.modelArtifacts.tripoConfig.bytes = 0;
  inventory.modelArtifacts.tripoCheckpoint.bytes = null;
  inventory.modelArtifacts.rembgWeights.bytes = null;
  const report = await collectGenerationWorkerHostInventory({
    pythonPath: "python-fixture",
    runnerScript: runner,
    device: "cpu",
    now: NOW,
    spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify(inventory) }),
    probeCapabilities: async () => capabilities(),
    host: fakeHost(),
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("triposr-cache-artifact-size-invalid"));
  assert.ok(report.blockers.includes("rembg-cache-artifact-size-invalid"));
  assert.equal(report.modelArtifacts.tripoConfig.bytes, null);
  assert.equal(report.modelArtifacts.tripoCheckpoint.bytes, null);
  assert.equal(report.modelArtifacts.rembgWeights.bytes, null);
});

test("blocks cached model artifacts when any exact-byte SHA-256 is absent or malformed", async (t) => {
  const { runner } = await runnerFixture(t);
  const inventory = JSON.parse(pythonResult().stdout);
  inventory.modelArtifacts.tripoConfig.sha256 = "not-a-sha";
  inventory.modelArtifacts.tripoCheckpoint.sha256 = null;
  inventory.modelArtifacts.rembgWeights.sha256 = undefined;
  const report = await collectGenerationWorkerHostInventory({
    pythonPath: "python-fixture",
    runnerScript: runner,
    device: "cpu",
    now: NOW,
    spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify(inventory) }),
    probeCapabilities: async () => capabilities(),
    host: fakeHost(),
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("triposr-config-artifact-sha256-invalid"));
  assert.ok(report.blockers.includes("triposr-checkpoint-artifact-sha256-invalid"));
  assert.ok(report.blockers.includes("rembg-model-artifact-sha256-invalid"));
  assert.equal(report.modelArtifacts.tripoConfig.sha256, null);
  assert.equal(report.modelArtifacts.tripoCheckpoint.sha256, null);
  assert.equal(report.modelArtifacts.rembgWeights.sha256, null);
});

test("blocks malformed runtime inventory core records instead of reporting ready", async (t) => {
  const { runner } = await runnerFixture(t);
  const report = await collectGenerationWorkerHostInventory({
    pythonPath: "python-fixture",
    runnerScript: runner,
    device: "cpu",
    now: NOW,
    spawnSyncImpl: () => pythonResult({
      stdout: JSON.stringify({
        pythonVersion: "",
        pythonImplementation: "CPython",
        pythonPlatform: "Linux-x86_64",
        packages: {},
        accelerators: { cudaAvailable: false, mpsAvailable: false },
        onnxProviders: [],
        modelArtifacts: {
          tripoConfig: { status: "cached", bytes: 1, snapshotRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          tripoCheckpoint: { status: "cached", bytes: 2, snapshotRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          rembgWeights: { status: "cached", bytes: 3 },
        },
        runnerSyntaxCompiled: true,
        runnerSha256Matches: true,
        probeErrors: [],
      }),
    }),
    probeCapabilities: async () => capabilities(),
    host: fakeHost(),
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("python-runtime-inventory-incomplete"));
  assert.equal(report.python.version, null);
});

test("rejects invalid timestamps and unsupported devices", async (t) => {
  const { runner } = await runnerFixture(t);
  await assert.rejects(
    collectGenerationWorkerHostInventory({
      pythonPath: "python-fixture", runnerScript: runner, device: "cpu", now: "bad-date",
      spawnSyncImpl: () => pythonResult(), probeCapabilities: async () => capabilities(), host: fakeHost(),
    }),
    /valid timestamp/,
  );
  await assert.rejects(
    collectGenerationWorkerHostInventory({
      pythonPath: "python-fixture", runnerScript: runner, device: "gpu0", now: NOW,
      spawnSyncImpl: () => pythonResult(), probeCapabilities: async () => capabilities(), host: fakeHost(),
    }),
    /device must be cpu, mps or cuda:N/,
  );
});

test("blocks malformed and stale capability timestamps", async (t) => {
  const { runner } = await runnerFixture(t);
  const report = await collectGenerationWorkerHostInventory({
    pythonPath: "python-fixture", runnerScript: runner, device: "cpu", now: NOW,
    spawnSyncImpl: () => pythonResult(),
    probeCapabilities: async () => capabilities({ checkedAt: "2026-11-03" }),
    host: fakeHost(),
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("worker-capability-timestamp-invalid-or-stale"));
});

test("records a partial inventory when optional packages or acceleration providers are unavailable", async (t) => {
  const { runner } = await runnerFixture(t);
  const partial = pythonResult({
    stdout: JSON.stringify({
      pythonVersion: "3.11.9",
      pythonImplementation: "CPython",
      pythonPlatform: "Linux-x86_64",
      packages: { torch: "2.5.1", onnxruntime: null, rembg: null, "huggingface-hub": null, transformers: null },
      accelerators: { cudaAvailable: false, cudaRuntime: null, hipRuntime: null, cudaDevices: [], mpsAvailable: false },
      onnxProviders: [],
      rembgDefaultModel: null,
      modelArtifacts: {
        tripoConfig: { status: "cached", bytes: 512, sha256: "c".repeat(64), snapshotRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        tripoCheckpoint: { status: "cached", bytes: 480000000, sha256: "a".repeat(64), snapshotRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        rembgWeights: { status: "missing", bytes: null },
      },
      runnerSyntaxCompiled: true,
      runnerSha256Matches: true,
      probeErrors: ["onnxruntime-import-or-provider-probe-failed", "rembg-import-or-default-model-probe-failed"],
    }),
  });
  const report = await collectGenerationWorkerHostInventory({
    pythonPath: "python-fixture", runnerScript: runner, device: "cpu", now: NOW,
    spawnSyncImpl: () => partial,
    probeCapabilities: async () => capabilities(),
    host: fakeHost(),
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.python.version, "3.11.9");
  assert.equal(report.runtimePackages.onnxruntime, null);
  assert.equal(report.acceleration.cudaAvailable, false);
  assert.ok(report.blockers.includes("python-runtime-inventory-incomplete"));
});
