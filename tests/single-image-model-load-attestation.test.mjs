import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SINGLE_IMAGE_MODEL_LOAD_ATTESTATION_SITE_CUSTOMIZE,
} from "../src/core/building-generation/single-image-runtime-smoke.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runInstrumentedLoaders(t, { mismatchCheckpoint = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "single-image-model-loader-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const files = {
    config: Buffer.from("model: triposr\nresolution: 256\n", "utf8"),
    checkpoint: Buffer.from("synthetic-triposr-checkpoint-bytes"),
    rembg: Buffer.from("synthetic-rembg-onnx-model-bytes"),
  };
  const configPath = path.join(root, "config.yaml");
  const checkpointPath = path.join(root, "model.ckpt");
  const rembgPath = path.join(root, "bria-rmbg.onnx");
  const receiptPath = path.join(root, "model-load-receipt.jsonl");
  await writeFile(path.join(root, "sitecustomize.py"), SINGLE_IMAGE_MODEL_LOAD_ATTESTATION_SITE_CUSTOMIZE);
  await writeFile(path.join(root, "torch.py"), [
    "def load(file_value, *args, **kwargs):",
    "    if isinstance(file_value, (str, bytes)):",
    "        with open(file_value, 'rb') as handle: return handle.read()",
    "    return file_value.read()",
    "",
  ].join("\n"));
  await writeFile(path.join(root, "omegaconf.py"), [
    "class OmegaConf:",
    "    @staticmethod",
    "    def load(file_value, *args, **kwargs):",
    "        return file_value.read()",
    "",
  ].join("\n"));
  await writeFile(path.join(root, "onnxruntime.py"), [
    "def InferenceSession(model_path_or_bytes, *args, **kwargs):",
    "    if not isinstance(model_path_or_bytes, bytes):",
    "        raise TypeError('instrumented ONNX model must be immutable bytes')",
    "    return model_path_or_bytes",
    "",
  ].join("\n"));
  await writeFile(configPath, files.config);
  await writeFile(checkpointPath, files.checkpoint);
  await writeFile(rembgPath, files.rembg);
  await writeFile(receiptPath, "", { mode: 0o600 });

  const expected = {
    tripoConfig: { bytes: files.config.length, sha256: sha256(files.config) },
    tripoCheckpoint: {
      bytes: files.checkpoint.length,
      sha256: mismatchCheckpoint ? "0".repeat(64) : sha256(files.checkpoint),
    },
    rembgWeights: { bytes: files.rembg.length, sha256: sha256(files.rembg) },
  };
  const script = [
    "import sys, importlib",
    "from omegaconf import OmegaConf",
    "torch = importlib.import_module('torch')",
    "from onnxruntime import InferenceSession",
    "assert OmegaConf.load(sys.argv[1]) == 'model: triposr\\nresolution: 256\\n'",
    "assert torch.load(sys.argv[2]) == b'synthetic-triposr-checkpoint-bytes'",
    "assert InferenceSession(sys.argv[3]) == b'synthetic-rembg-onnx-model-bytes'",
  ].join("\\n");
  const result = spawnSync(process.env.PYTHON || "python3", [
    "-c", script, configPath, checkpointPath, rembgPath,
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      PYTHONPATH: root,
      BUILDING_ENGINE_MODEL_LOAD_RECEIPT_PATH: receiptPath,
      BUILDING_ENGINE_MODEL_LOAD_EXPECTED_JSON: JSON.stringify(expected),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const receiptText = await readFile(receiptPath, "utf8");
  const events = receiptText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(JSON.stringify(events).includes(root), false);
  return events;
}

test("attests the exact config, checkpoint and rembg bytes handed to the loader APIs", async (t) => {
  const events = await runInstrumentedLoaders(t);
  assert.deepEqual(events.map((event) => event.role).sort(), [
    "rembgWeights", "tripoCheckpoint", "tripoConfig",
  ]);
  const byRole = Object.fromEntries(events.map((event) => [event.role, event]));
  assert.equal(byRole.tripoConfig.loader, "omegaconf.OmegaConf.load");
  assert.equal(byRole.tripoCheckpoint.loader, "torch.load");
  assert.equal(byRole.rembgWeights.loader, "onnxruntime.InferenceSession");
  for (const event of events) {
    assert.equal(event.schemaVersion, "1.0.0");
    assert.equal(event.exactBytesPassed, true);
    assert.equal(event.stable, true);
    assert.ok(event.bytes > 0);
    assert.match(event.sha256, /^[a-f0-9]{64}$/);
  }
});

test("does not attest a checkpoint when loaded bytes differ from the preflight fingerprint", async (t) => {
  const events = await runInstrumentedLoaders(t, { mismatchCheckpoint: true });
  assert.deepEqual(events.map((event) => event.role).sort(), [
    "rembgWeights", "tripoConfig",
  ]);
  assert.equal(events.some((event) => event.role === "tripoCheckpoint"), false);
});
