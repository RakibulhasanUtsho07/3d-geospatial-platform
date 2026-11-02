import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSingleImageRuntimeSmoke } from "../src/core/building-generation/single-image-runtime-smoke.mjs";
import { verifySingleImageRuntimeSmoke } from "../src/core/building-generation/verify-single-image-runtime-smoke.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeGlb() {
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0" },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  }), "utf8");
  const padding = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(padding, 0x20)]);
  const total = 12 + 8 + jsonChunk.length;
  const bytes = Buffer.alloc(total);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(total, 8);
  bytes.writeUInt32LE(jsonChunk.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(bytes, 20);
  return bytes;
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "single-image-runtime-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  return root;
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

async function fakeWorkflowResult(options, root, source) {
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

  options.spawnImpl("python-fixture", ["--version"], {});
  // The wrapper is tested in its injected spawn implementation below; this fake
  // workflow validates that the same offline-wrapped spawn reaches model execution.
  assert.equal(typeof options.spawnImpl, "function");

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
        modelQuality: {
          warnings: ["synthetic geometry fixture requires human review"],
          counts: { triangleCount: 1, vertexCount: 3, primitiveCount: 1 },
        },
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

function makeOptions(root, source, overrides = {}) {
  const spawnImpl = overrides.spawnImpl ?? ((_executable, _args, options) => ({ fake: true, options }));
  return {
    spawnImpl,
    workspaceRoot: root,
    buildingSpec: fixture,
    jobId: "smoke-job",
    sourceId: "facade-photo",
    sourceRelativePath: source.relativePath,
    licence: "CC BY 4.0",
    runnerScript: path.join(root, "triposr", "run.py"),
    pythonPath: "python-fixture",
    device: "cpu",
    mcResolution: 128,
    timeoutMs: 20_000,
    confirmSourceRights: true,
    confirmSingleViewInference: true,
    confirmModelLicences: true,
    probeCapabilities: async ({ env, spawnImpl }) => {
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
    return { fake: true };
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
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, "passed");
  assert.equal(result.report.readiness.status, "ready");
  assert.equal(result.report.readiness.backgroundRemovalModel, "bria-rmbg");
  assert.equal(result.report.source.sha256, source.sha256);
  const actualModelPath = path.join(root, ...result.report.output.relativePath.split("/"));
  assert.equal(result.report.output.sha256, hash(await readFile(actualModelPath)));
  assert.equal(result.report.output.meshCount, 1);
  assert.equal(result.report.geometryQa.status, "warnings-require-review");
  assert.equal(result.report.geometryQa.warningCount, 1);
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
  assert.equal(JSON.stringify(saved).includes(root), false);
  const fileStat = await stat(result.reportPath);
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.equal(saved.networkPolicy.pythonSocketConnectionsBlocked, true);
  assert.equal(saved.networkPolicy.kernelNetworkIsolation, "not-enforced-by-this-command");

  const verified = await verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId: "smoke-job" });
  assert.equal(verified.verified, true);
  assert.equal(verified.source.sha256, source.sha256);
  assert.equal(verified.model.sha256, result.report.output.sha256);
  assert.equal(verified.mapReady, false);
  assert.equal(verified.publicationEligible, false);
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
    runWorkflow: async () => {
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

test("requires the three separate operator confirmations", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);

  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { confirmSourceRights: false })),
    /confirmSourceRights/,
  );
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { confirmSingleViewInference: false })),
    /confirmSingleViewInference/,
  );
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, { confirmModelLicences: false })),
    /confirmModelLicences/,
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

test("refuses to overwrite an existing smoke evidence record", async (t) => {
  const root = await workspace(t);
  const source = await writeInput(root);
  const first = await runSingleImageRuntimeSmoke(makeOptions(root, source, {
    runWorkflow: async (options) => fakeWorkflowResult(options, root, source),
  }));
  assert.equal(first.report.status, "passed");
  await assert.rejects(
    runSingleImageRuntimeSmoke(makeOptions(root, source, {
      runWorkflow: async (options) => fakeWorkflowResult(options, root, source),
    })),
    /already exists|EEXIST/,
  );
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
