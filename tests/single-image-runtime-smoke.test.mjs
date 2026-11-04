import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSingleImageRuntimeSmoke } from "../src/core/building-generation/single-image-runtime-smoke.mjs";
import { verifySingleImageRuntimeSmoke } from "../src/core/building-generation/verify-single-image-runtime-smoke.mjs";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeGlb() {
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  }), "utf8");
  const jsonPadding = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const binary = Buffer.alloc(44);
  const positions = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ];
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  binary.writeUInt16LE(0, 36);
  binary.writeUInt16LE(1, 38);
  binary.writeUInt16LE(2, 40);
  const total = 12 + 8 + jsonChunk.length + 8 + binary.length;
  const bytes = Buffer.alloc(total);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(total, 8);
  bytes.writeUInt32LE(jsonChunk.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(bytes, 20);
  const binaryHeader = 20 + jsonChunk.length;
  bytes.writeUInt32LE(binary.length, binaryHeader);
  bytes.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(bytes, binaryHeader + 8);
  return bytes;
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "single-image-runtime-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  return root;
}

async function writeFakeModelLoadReceipt(spawnOptions = {}) {
  const env = spawnOptions.env ?? {};
  const receiptPath = env.BUILDING_ENGINE_MODEL_LOAD_RECEIPT_PATH;
  const expected = env.BUILDING_ENGINE_MODEL_LOAD_EXPECTED_JSON
    ? JSON.parse(env.BUILDING_ENGINE_MODEL_LOAD_EXPECTED_JSON)
    : null;
  if (!receiptPath || !expected) return;
  const omittedRole = env.BUILDING_ENGINE_TEST_OMIT_MODEL_LOAD_ROLE ?? null;
  const loaders = [
    ["tripoConfig", "omegaconf.OmegaConf.load"],
    ["tripoCheckpoint", "torch.load"],
    ["rembgWeights", "onnxruntime.InferenceSession"],
  ];
  const events = loaders
    .filter(([role]) => role !== omittedRole)
    .map(([role, loader]) => JSON.stringify({
      schemaVersion: "1.0.0",
      role,
      loader,
      bytes: expected[role].bytes,
      sha256: expected[role].sha256,
      exactBytesPassed: true,
      stable: true,
    }));
  await writeFile(receiptPath, events.length ? events.join("\n") + "\n" : "");
}


async function writeFakeSourceImageLoadReceipt(spawnOptions = {}, args = []) {
  const env = spawnOptions.env ?? {};
  const receiptPath = env.BUILDING_ENGINE_SOURCE_IMAGE_RECEIPT_PATH;
  const expected = env.BUILDING_ENGINE_SOURCE_IMAGE_EXPECTED_JSON
    ? JSON.parse(env.BUILDING_ENGINE_SOURCE_IMAGE_EXPECTED_JSON)
    : null;
  if (!receiptPath || !expected || env.BUILDING_ENGINE_TEST_OMIT_SOURCE_IMAGE_RECEIPT === "1") return;
  const sourceArgument = args[1];
  if (typeof sourceArgument !== "string" ||
      path.resolve(sourceArgument) !== path.resolve(env.BUILDING_ENGINE_SOURCE_IMAGE_EXPECTED_PATH ?? "")) {
    throw new TypeError("Fake TripoSR source argument does not match the private source-image attestation path.");
  }
  await writeFile(receiptPath, JSON.stringify({
    schemaVersion: "1.0.0",
    role: "sourceImage",
    loader: "PIL.Image.open",
    bytes: expected.bytes,
    sha256: expected.sha256,
    exactBytesPassed: true,
    stable: true,
  }) + "\n");
}

async function startFakeRunner(options, {
  omitModelLoadRole = null,
  omitSourceImageReceipt = false,
} = {}) {
  const spawnImpl = omitModelLoadRole || omitSourceImageReceipt
    ? (executable, args, spawnOptions = {}) => options.spawnImpl(executable, args, {
      ...spawnOptions,
      env: {
        ...(spawnOptions.env ?? {}),
        ...(omitModelLoadRole ? { BUILDING_ENGINE_TEST_OMIT_MODEL_LOAD_ROLE: omitModelLoadRole } : {}),
        ...(omitSourceImageReceipt ? { BUILDING_ENGINE_TEST_OMIT_SOURCE_IMAGE_RECEIPT: "1" } : {}),
      },
    })
    : options.spawnImpl;
  const sourcePath = path.resolve(
    options.workspaceRoot,
    ...options.sources[0].relativePath.split("/"),
  );
  const child = spawnImpl(
    options.pythonPath,
    [options.runnerScript, sourcePath, "--fixture-smoke"],
    {},
  );
  if (!child || typeof child.once !== "function") {
    throw new TypeError("Fake TripoSR runner must return an EventEmitter child.");
  }
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
}

async function writeInput(root, relativePath = "uploads/front.jpg", bytes = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02])) {
  await writeFile(path.join(root, ...relativePath.split("/")), bytes);
  return { relativePath, bytes, sha256: hash(bytes) };
}

function readyCapabilities() {
  return {
    schemaVersion: "1.0.0",
    checkedAt: "2026-11-02T08:00:00.000Z",
    strategies: {
      procedural: { status: "ready", blockers: [], caveats: [] },
      photogrammetry: { status: "blocked", blockers: ["COLMAP unavailable"], caveats: [] },
      "single-image-ai": {
        status: "ready",
        blockers: [],
        caveats: [],
        modelWeights: "cached",
        backgroundRemovalWeights: "cached",
        backgroundRemovalModel: "bria-rmbg",
      },
    },
  };
}

async function fakeWorkflowResult(options, root, source, {
  omitModelLoadRole = null,
  omitSourceImageReceipt = false,
} = {}) {
  assert.equal(options.strategy, "single-image-ai");
  assert.equal(options.confirmRights, true);
  assert.equal(options.confirmSingleViewInference, true);
  assert.deepEqual(options.viewSourceIds, ["facade-photo"]);
  assert.equal(options.sources.length, 1);
  assert.equal(options.sources[0].sourceId, "facade-photo");
  assert.deepEqual(options.sources[0].permittedOperations, [
    "private-media-ingestion",
    "single-image-ai-reconstruction",
  ]);

  await startFakeRunner(options, { omitModelLoadRole, omitSourceImageReceipt });

  const glb = makeGlb();
  const relativeModelPath = ".building-engine/jobs/" + fixture.id + "/smoke-job-workflow/model.glb";
  const absoluteModelPath = path.join(root, ...relativeModelPath.split("/"));
  await mkdir(path.dirname(absoluteModelPath), { recursive: true });
  await writeFile(absoluteModelPath, glb);

  const outputHash = hash(glb);
  return {
    workflowDir: path.dirname(absoluteModelPath),
    modelPath: absoluteModelPath,
    reportPath: path.join(root, ".building-engine", "jobs", fixture.id, "smoke-job-workflow", "workflow-report.json"),
    report: {
      jobId: "smoke-job",
      buildingId: fixture.id,
      status: "completed-requires-review",
      mode: "single-image-ai",
      inputs: {
        selectedViewIds: ["facade-photo"],
        mediaRecords: [{
          id: "facade-photo",
          sha256: source.sha256,
          mimeType: "image/jpeg",
          licence: "CC BY 4.0",
          usageStatus: "approved",
        }],
      },
      output: {
        modelPath: relativeModelPath,
        modelBytes: glb.length,
        modelSha256: outputHash,
      },
      modelReport: {
        status: "ai-proposed-requires-review",
        confidence: "ai-proposed",
        durationMs: 1234,
        modelParameters: {
          modelId: "stabilityai/TripoSR",
          device: options.device,
          mcResolution: options.mcResolution,
          backgroundRemoval: true,
        },
        source: { sha256: source.sha256 },
        outputs: { glb: { sha256: outputHash, bytes: glb.length, meshCount: 1 } },
        modelQuality: analyzeGlbQuality(glb),
        scaleCalibration: { status: "not-calibrated" },
        georeference: { status: "not-solved" },
        mapReady: false,
        publicationEligible: false,
      },
      mapReady: false,
      publicationEligible: false,
    },
  };
}


async function fakeWorkerHostInventory({ env, now, commandTimeoutMs, probeCapabilities }) {
  const capabilities = await probeCapabilities({
    env,
    now,
    commandTimeoutMs,
    strategies: ["single-image-ai"],
  });
  const entry = capabilities?.strategies?.["single-image-ai"] ?? {};
  const ready = entry.status === "ready" &&
    entry.modelWeights === "cached" &&
    entry.backgroundRemovalWeights === "cached" &&
    typeof entry.backgroundRemovalModel === "string";
  return {
    schemaVersion: "1.1.0",
    kind: "generation-worker-host-inventory",
    checkedAt: now,
    status: ready ? "ready-for-operator-smoke" : "blocked",
    runner: { status: "present", bytes: 128, sha256: hash(Buffer.from("fixture-triposr-runner")) },
    modelArtifacts: {
      tripoConfig: {
        status: "cached", bytes: 512,
        sha256: hash(Buffer.from("fixture-triposr-config")),
        snapshotRevision: "a".repeat(40),
      },
      tripoCheckpoint: {
        status: "cached", bytes: 480000000,
        sha256: hash(Buffer.from("fixture-triposr-checkpoint")),
        snapshotRevision: "a".repeat(40),
      },
      rembgWeights: {
        status: "cached", bytes: 176000000,
        sha256: hash(Buffer.from("fixture-rembg-weights")),
      },
    },
    runtimePackages: { torch: "2.5.1", onnxruntime: "1.20.1", rembg: "2.0.60" },
    acceleration: { selectedDevice: "cpu" },
    modelReadiness: {
      status: ready ? "ready" : "blocked",
      strategyStatus: entry.status ?? "unknown",
      tripoModelWeights: entry.modelWeights ?? "unknown",
      backgroundRemovalWeights: entry.backgroundRemovalWeights ?? "unknown",
      backgroundRemovalModel: entry.backgroundRemovalModel ?? null,
    },
    blockers: ready ? [] : (entry.blockers ?? ["single-image-readiness-not-ready"]),
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
  };
}

function makeOptions(root, source, overrides = {}) {
  const spawnImpl = overrides.spawnImpl ?? ((_executable, _args, spawnOptions = {}) => {
    const child = new EventEmitter();
    queueMicrotask(async () => {
      await writeFakeModelLoadReceipt(spawnOptions);
      await writeFakeSourceImageLoadReceipt(spawnOptions, _args);
      child.emit("spawn");
    });
    return child;
  });
  return {
    spawnImpl,
    workspaceRoot: root,
    buildingSpec: fixture,
    jobId: "smoke-job",
    sourceId: "facade-photo",
    sourceRelativePath: source.relativePath,
    licence: "CC BY 4.0",
    triposrLicenceReview: "TripoSR code and checkpoint terms reviewed for test",
    rembgLicenceReview: "Fixture rembg model licence terms reviewed for test",
    runnerScript: path.join(root, "triposr", "run.py"),
    pythonPath: "python-fixture",
    device: "cpu",
    mcResolution: 128,
    timeoutMs: 20_000,
    confirmSourceRights: true,
    confirmOperationScopes: true,
    confirmSingleViewInference: true,
    confirmModelLicences: true,
    collectWorkerHostInventory: fakeWorkerHostInventory,
    probeCapabilities: async ({ env, spawnImpl, strategies }) => {
      assert.deepEqual(strategies, ["single-image-ai"]);
      assert.equal(env.HF_HUB_OFFLINE, "1");
      assert.equal(env.TRANSFORMERS_OFFLINE, "1");
      assert.equal(env.HF_DATASETS_OFFLINE, "1");
      spawnImpl("python-fixture", ["--version"], {});
      return readyCapabilities();
    },
    ...overrides,
  };
}

test("runs the shared media-to-model workflow and writes hash-bound private smoke evidence", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const spawnEnvironments = [];
  const spawnImpl = (_executable, _args, options) => {
    spawnEnvironments.push(options.env);
    const pythonPath = options.env.PYTHONPATH.split(path.delimiter)[0];
    const siteCustomize = readFileSync(path.join(pythonPath, "sitecustomize.py"), "utf8");
    assert.match(siteCustomize, /socket\.socket\.connect = _deny_runtime_network/);
    assert.match(siteCustomize, /socket\.socket\.connect_ex = _deny_runtime_network/);
    assert.match(siteCustomize, /socket\.socket\.send = _deny_runtime_network/);
    assert.match(siteCustomize, /socket\.socket\.sendall = _deny_runtime_network/);
    assert.match(siteCustomize, /socket\.socket\.sendto = _deny_runtime_network/);
    assert.match(siteCustomize, /socket\.socket\.sendmsg = _deny_runtime_network/);
    assert.match(siteCustomize, /socket\.create_connection = _deny_runtime_network/);
    assert.match(siteCustomize, /socket\.getaddrinfo = _deny_runtime_network/);
    assert.match(siteCustomize, /socket\.gethostbyname = _deny_runtime_network/);
    const offlineProbe = spawnSync("python3", ["-c", [
      "import socket",
      "try:",
      "    socket.socket().connect(('192.0.2.1', 443))",
      "except OSError as error:",
      "    assert 'network access is disabled by the single-image runtime smoke' in str(error)",
      "else:",
      "    raise SystemExit('Python socket connect was not blocked')",
      "try:",
      "    socket.getaddrinfo('example.invalid', 443)",
      "except OSError as error:",
      "    assert 'network access is disabled by the single-image runtime smoke' in str(error)",
      "else:",
      "    raise SystemExit('Python DNS lookup was not blocked')",
    ].join("\n")], { env: options.env, encoding: "utf8", timeout: 5000 });
    assert.equal(offlineProbe.status, 0, offlineProbe.stderr || offlineProbe.stdout);
    const child = new EventEmitter();
    queueMicrotask(async () => {
      await writeFakeModelLoadReceipt(options);
      child.emit("spawn");
    });
    return child;
  };
  let workflowCalls = 0;

  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    spawnImpl,
    runWorkflow: async (options) => {
      workflowCalls += 1;
      return fakeWorkflowResult(options, root, source);
    },
  }));

  assert.equal(workflowCalls, 1);
  assert.equal(result.exitCode, 0, JSON.stringify(result.report.failure ?? result.report));
  assert.equal(result.report.status, "passed");
  assert.equal(result.report.inference.runnerLaunchAttempted, true);
  assert.equal(result.report.inference.runnerProcessStarted, true);
  assert.equal(result.report.readiness.status, "ready");
  assert.equal(result.report.readiness.backgroundRemovalModel, "bria-rmbg");
  assert.equal(result.report.workerHost.inventorySchemaVersion, "1.1.0");
  assert.equal(result.report.workerHost.stableAcrossInference, true);
  assert.equal(result.report.modelLoadEvidence.status, "verified");
  assert.deepEqual(Object.keys(result.report.modelLoadEvidence.loaders).sort(), [
    "rembgWeights", "tripoCheckpoint", "tripoConfig",
  ]);
  assert.deepEqual(result.report.workerHost.before.modelArtifacts, result.report.workerHost.after.modelArtifacts);
  assert.equal(result.report.source.sha256, source.sha256);
  const actualModelPath = path.join(root, ...result.report.output.relativePath.split("/"));
  assert.equal(result.report.output.sha256, hash(await readFile(actualModelPath)));
  assert.equal(result.report.output.meshCount, 1);
  assert.equal(result.report.geometryQa.status, "warnings-require-review");
  assert.equal(result.report.geometryQa.sourceStatus, "review-recommended");
  assert.ok(result.report.geometryQa.warningCount > 0);
  assert.equal(result.report.geometryQa.valid, true);
  assert.equal(result.report.mapReady, false);
  assert.equal(result.report.publicationEligible, false);
  assert.equal(result.report.automaticApproval, false);
  assert.ok(spawnEnvironments.length >= 1);
  assert.ok(spawnEnvironments.every((env) =>
    env.HF_HUB_OFFLINE === "1" &&
    env.HUGGINGFACE_HUB_OFFLINE === "1" &&
    env.TRANSFORMERS_OFFLINE === "1" &&
    env.HF_DATASETS_OFFLINE === "1"
  ));

  const saved = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(saved.status, "passed");
  assert.equal(saved.output.sha256, result.report.output.sha256);
  assert.equal(saved.model.licenceReview, "operator-attested-not-independently-verified");
  assert.equal(saved.model.triposrLicenceReview, "TripoSR code and checkpoint terms reviewed for test");
  assert.equal(saved.model.rembgLicenceReview, "Fixture rembg model licence terms reviewed for test");
  assert.equal(saved.source.licence, "CC BY 4.0");
  assert.deepEqual(saved.source.permittedOperations, ["private-media-ingestion", "single-image-ai-reconstruction"]);
  assert.equal(saved.source.operationScopeAttestation, "operator-attested-not-independently-verified");
  assert.equal(saved.networkPolicy.pythonSocketConnectionsBlocked, true);
  assert.equal(saved.networkPolicy.kernelNetworkIsolation, "not-enforced-by-this-command");
  assert.equal(JSON.stringify(saved).includes(root), false);
  const fileStat = await stat(result.reportPath);
  assert.equal(fileStat.mode & 0o777, 0o600);
  const evidenceDirectoryStat = await stat(path.dirname(result.reportPath));
  if (process.platform !== "win32") assert.equal(evidenceDirectoryStat.mode & 0o777, 0o700);
  assert.equal(saved.networkPolicy.pythonSocketConnectionsBlocked, true);
  assert.equal(saved.networkPolicy.kernelNetworkIsolation, "not-enforced-by-this-command");

  const verified = await verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId: "smoke-job" });
  assert.equal(verified.verified, true);
  assert.equal(verified.source.sha256, source.sha256);
  assert.equal(verified.model.sha256, result.report.output.sha256);
  assert.equal(verified.workerHostFingerprintStatus, "stable-across-inference");
  assert.equal(verified.modelLoadEvidenceStatus, "verified-against-worker-preflight");
  assert.equal(verified.sourceImageLoadEvidenceStatus, "verified-against-source-manifest");

  const tamperedReport = JSON.parse(await readFile(result.reportPath, "utf8"));
  tamperedReport.workerHost.after.modelArtifacts.tripoCheckpoint.sha256 = "f".repeat(64);
  await writeFile(result.reportPath, JSON.stringify(tamperedReport, null, 2) + "\n");
  await assert.rejects(
    verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId: "smoke-job" }),
    /fingerprints changed across inference/i,
  );
  await writeFile(result.reportPath, JSON.stringify(result.report, null, 2) + "\n");
  const tamperedLoadEvidence = JSON.parse(await readFile(result.reportPath, "utf8"));
  tamperedLoadEvidence.modelLoadEvidence.loaders.rembgWeights.sha256 = "f".repeat(64);
  await writeFile(result.reportPath, JSON.stringify(tamperedLoadEvidence, null, 2) + "\n");
  await assert.rejects(
    verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId: "smoke-job" }),
    /model-load evidence does not match/i,
  );
  const tamperedSourceEvidence = JSON.parse(await readFile(result.reportPath, "utf8"));
  tamperedSourceEvidence.sourceLoadEvidence.sha256 = "f".repeat(64);
  await writeFile(result.reportPath, JSON.stringify(tamperedSourceEvidence, null, 2) + "\n");
  await assert.rejects(
    verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId: "smoke-job" }),
    /source-image load evidence does not match/i,
  );
  assert.equal(verified.mapReady, false);
  assert.equal(verified.publicationEligible, false);
});


test("fails closed when the runner does not attest the rembg model loader input", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    runWorkflow: async (options) =>
      fakeWorkflowResult(options, root, source, { omitModelLoadRole: "rembgWeights" }),
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.match(result.report.failure.summary, /model generation|evidence validation/i);
  assert.equal(result.report.modelLoadEvidence, null);
  assert.equal(result.report.mapReady, false);
  assert.equal(result.report.publicationEligible, false);
  assert.equal(result.report.automaticApproval, false);
});


test("fails closed when TripoSR does not attest the exact source image opened by Pillow", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    runWorkflow: async (options) =>
      fakeWorkflowResult(options, root, source, { omitSourceImageReceipt: true }),
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.match(result.report.failure.summary, /model generation|evidence validation/i);
  assert.equal(result.report.sourceLoadEvidence, null);
  assert.equal(result.report.mapReady, false);
  assert.equal(result.report.publicationEligible, false);
  assert.equal(result.report.automaticApproval, false);
});

test("blocks before inference when a cached worker model lacks an exact SHA-256", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  let workflowCalls = 0;
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    collectWorkerHostInventory: async (options) => {
      const inventory = await fakeWorkerHostInventory(options);
      inventory.modelArtifacts.rembgWeights.sha256 = null;
      return inventory;
    },
    runWorkflow: async () => {
      workflowCalls += 1;
      throw new Error("workflow must not run without exact model-byte identity");
    },
  }));
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.status, "blocked");
  assert.ok(result.report.readiness.blockers.includes("rembg-weight-fingerprint-incomplete"));
  assert.equal(workflowCalls, 0);
  assert.equal(result.report.output, null);
  assert.equal(result.report.mapReady, false);
});

test("fails the smoke if model artifact bytes drift during inference", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  let inventoryCalls = 0;
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    collectWorkerHostInventory: async (options) => {
      const inventory = await fakeWorkerHostInventory(options);
      inventoryCalls += 1;
      if (inventoryCalls === 2) {
        inventory.modelArtifacts.tripoCheckpoint.sha256 = "f".repeat(64);
      }
      return inventory;
    },
    runWorkflow: async (options) => fakeWorkflowResult(options, root, source),
  }));
  assert.equal(inventoryCalls, 2);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.workerHost.stableAcrossInference, false);
  assert.match(result.report.failure.summary, /model artifacts or TripoSR runner fingerprint changed/i);
  assert.equal(result.report.mapReady, false);
  assert.equal(result.report.publicationEligible, false);
  assert.equal(result.report.automaticApproval, false);
});

test("blocks before workflow execution when rembg cache is missing", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  let workflowCalls = 0;
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    probeCapabilities: async () => ({
      ...readyCapabilities(),
      strategies: {
        ...readyCapabilities().strategies,
        "single-image-ai": {
          status: "configured",
          blockers: [],
          caveats: ["rembg model not cached"],
          modelWeights: "cached",
          backgroundRemovalWeights: "missing",
          backgroundRemovalModel: "bria-rmbg",
        },
      },
    }),
    runWorkflow: async () => {
      workflowCalls += 1;
      throw new Error("workflow must not be called when readiness is blocked");
    },
  }));

  assert.equal(result.exitCode, 2);
  assert.equal(result.report.status, "blocked");
  assert.equal(result.report.readiness.backgroundRemovalWeights, "missing");
  assert.equal(workflowCalls, 0);
  assert.equal(result.report.output, null);
  assert.equal(result.report.mapReady, false);
  const saved = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(saved.inference.status, "not-started");
});

test("blocks before workflow execution when the TripoSR cache is unknown", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  let workflowCalls = 0;
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    probeCapabilities: async () => ({
      ...readyCapabilities(),
      strategies: {
        ...readyCapabilities().strategies,
        "single-image-ai": {
          status: "configured",
          blockers: [],
          caveats: [],
          modelWeights: "unknown",
          backgroundRemovalWeights: "cached",
          backgroundRemovalModel: "bria-rmbg",
        },
      },
    }),
    runWorkflow: async () => {
      workflowCalls += 1;
      return null;
    },
  }));
  assert.equal(result.report.status, "blocked");
  assert.equal(result.report.readiness.tripoModelWeights, "unknown");
  assert.equal(workflowCalls, 0);
});

test("writes a sanitized failure report when actual inference or export fails", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    runWorkflow: async (workflowOptions) => {
      await startFakeRunner(workflowOptions);
      const error = new Error("private path /srv/models/weights/model.ckpt leaked from runtime");
      error.name = "InferenceFailure";
      throw error;
    },
  }));

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.inference.status, "failed");
  assert.equal(result.report.failure.code, "InferenceFailure");
  assert.equal(result.report.failure.summary.includes("/srv/models"), false);
  assert.equal(JSON.stringify(result.report).includes("/srv/models"), false);
  assert.equal(result.report.mapReady, false);
  assert.equal(result.report.publicationEligible, false);
});

test("keeps inference not-started when the workflow fails before launching TripoSR", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    runWorkflow: async () => {
      throw new Error("Source provenance validation failed before model generation.");
    },
  }));

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.inference.status, "not-started");
  assert.equal(result.report.inference.runnerLaunchAttempted, false);
  assert.equal(result.report.inference.runnerProcessStarted, false);
  assert.match(result.report.failure.summary, /before attempting to launch.*inference was not started/i);
});

test("keeps inference not-started when the TripoSR process cannot be spawned", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const runnerPath = path.join(root, "triposr", "run.py");
  const spawnImpl = (_executable, args) => {
    const child = new EventEmitter();
    if (args?.[0] === runnerPath) {
      queueMicrotask(() => child.emit("error", Object.assign(
        new Error("fixture executable could not be started"),
        { code: "ENOENT" },
      )));
    }
    return child;
  };
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    spawnImpl,
    runWorkflow: async (workflowOptions) => startFakeRunner(workflowOptions),
  }));

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.inference.status, "not-started");
  assert.equal(result.report.inference.runnerLaunchAttempted, true);
  assert.equal(result.report.inference.runnerProcessStarted, false);
  assert.match(result.report.failure.summary, /process never started; inference was not started/i);
});

test("requires four independent operator confirmations", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);

  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { confirmSourceRights: false })),
    /confirmSourceRights/,
  );
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { confirmOperationScopes: false })),
    /confirmOperationScopes/,
  );
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { confirmSingleViewInference: false })),
    /confirmSingleViewInference/,
  );
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { confirmModelLicences: false })),
    /confirmModelLicences/,
  );
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { triposrLicenceReview: "" })),
    /TripoSR code\/checkpoint licence review/,
  );
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { rembgLicenceReview: "" })),
    /rembg model-weight licence review/,
  );
});

test("rejects WebP/unknown signatures before invoking the readiness probe", async (t) => {
  const root = await workspace(t);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)]);
  const source = await writeInput(root, "uploads/front.webp", webp);
  let probeCalls = 0;
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, {
      probeCapabilities: async () => {
        probeCalls += 1;
        return readyCapabilities();
      },
    })),
    /JPEG or PNG/,
  );
  assert.equal(probeCalls, 0);
});

test("refuses to overwrite an existing smoke report with fresh workflow IDs", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const reportPath = path.join(root, ".building-engine", "runtime-smokes", "smoke-job.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, "{}\\n");
  let probeCalls = 0;

  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, {
      probeCapabilities: async () => {
        probeCalls += 1;
        return readyCapabilities();
      },
    })),
    /EEXIST|already exists/,
  );
  assert.equal(probeCalls, 0);
});

test("independent verifier detects a source file changed after the smoke report was written", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    runWorkflow: async (options) => fakeWorkflowResult(options, root, source),
  }));
  assert.equal(result.report.status, "passed");

  await writeFile(path.join(root, ...source.relativePath.split("/")), Buffer.from("changed source"));
  await assert.rejects(
    verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId: "smoke-job" }),
    /source image signature, byte count or SHA-256/i,
  );
});

test("independent verifier detects a GLB changed after the smoke report was written", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    runWorkflow: async (options) => fakeWorkflowResult(options, root, source),
  }));
  const outputPath = path.join(root, ...result.report.output.relativePath.split("/"));
  await writeFile(outputPath, Buffer.from("not the original GLB"));
  await assert.rejects(
    verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId: "smoke-job" }),
    /Smoke GLB is not a valid GLB 2.0 binary|GLB byte count/i,
  );
});

test("independent verifier requires evidence that the TripoSR child process actually spawned", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    runWorkflow: async (options) => fakeWorkflowResult(options, root, source),
  }));
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  report.inference.runnerProcessStarted = false;
  await writeFile(result.reportPath, JSON.stringify(report, null, 2) + "\n");

  await assert.rejects(
    verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId: "smoke-job" }),
    /completed TripoSR runner launch and inference record/i,
  );
});

test("independent verifier refuses a report that enables a release flag", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const result = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    runWorkflow: async (options) => fakeWorkflowResult(options, root, source),
  }));
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  report.mapReady = true;
  await writeFile(result.reportPath, JSON.stringify(report, null, 2) + "\n");
  await assert.rejects(
    verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId: "smoke-job" }),
    /fail-closed publication contract/i,
  );
});


test("refuses to reuse a prior workflow artifact directory instead of treating a cached stage as new inference", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const previousWorkflow = path.join(root, ".building-engine", "jobs", fixture.id, "smoke-job-workflow");
  await mkdir(previousWorkflow, { recursive: true });
  let probeCalls = 0;
  let workflowCalls = 0;

  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, {
      probeCapabilities: async () => {
        probeCalls += 1;
        return readyCapabilities();
      },
      runWorkflow: async () => {
        workflowCalls += 1;
        return null;
      },
    })),
    /Smoke workflow artifact directory already exists/,
  );
  assert.equal(probeCalls, 0);
  assert.equal(workflowCalls, 0);
  await assert.rejects(stat(path.join(root, ".building-engine", "runtime-smokes", "smoke-job.json")), /ENOENT/);
});

test("refuses to reuse an existing source record under the same source ID", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const record = path.join(root, ".building-engine", "media", fixture.id, "sources", "facade-photo.json");
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, "{}\n");
  let probeCalls = 0;

  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, {
      probeCapabilities: async () => {
        probeCalls += 1;
        return readyCapabilities();
      },
    })),
    /Smoke source record already exists/,
  );
  assert.equal(probeCalls, 0);
});


test("refuses to resume an existing reconstruction-job state directory", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const previousState = path.join(root, ".building-engine", "reconstruction-jobs", fixture.id, "smoke-job");
  await mkdir(previousState, { recursive: true });
  let probeCalls = 0;

  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, {
      probeCapabilities: async () => {
        probeCalls += 1;
        return readyCapabilities();
      },
    })),
    /Smoke resumable reconstruction state already exists/,
  );
  assert.equal(probeCalls, 0);
});


test("enforces the media-to-model workflow's 60-character job ID limit before creating evidence", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const longJobId = "a".repeat(61);
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { jobId: longJobId })),
    /jobId must be a safe identifier no longer than 60 characters/,
  );
  await assert.rejects(
    stat(path.join(root, ".building-engine", "runtime-smokes")),
    /ENOENT/,
  );
});
