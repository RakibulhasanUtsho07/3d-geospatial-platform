import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SINGLE_IMAGE_MODEL_LOAD_ATTESTATION_SITE_CUSTOMIZE,
} from "../src/core/building-generation/single-image-runtime-smoke.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runInstrumentedLoaders(t, {
  mismatchCheckpoint = false,
  mismatchRembg = false,
  expectFailure = false,
} = {}) {
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
    "class InferenceSession:",
    "    def __init__(self, model_path_or_bytes, *args, **kwargs):",
    "        if not isinstance(model_path_or_bytes, bytes):",
    "            raise TypeError('instrumented ONNX model must be immutable bytes')",
    "        self.model_bytes = model_path_or_bytes",
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
    rembgWeights: {
      bytes: files.rembg.length,
      sha256: mismatchRembg ? "f".repeat(64) : sha256(files.rembg),
    },
  };
  const script = [
    "import sys, importlib",
    "from omegaconf import OmegaConf",
    "torch = importlib.import_module('torch')",
    "from onnxruntime import InferenceSession",
    "assert OmegaConf.load(sys.argv[1]) == 'model: triposr\\nresolution: 256\\n'",
    "assert torch.load(sys.argv[2]) == b'synthetic-triposr-checkpoint-bytes'",
    "session = InferenceSession(sys.argv[3])",
    "assert isinstance(session, InferenceSession)",
    "assert session.model_bytes == b'synthetic-rembg-onnx-model-bytes'",
  ].join("\n");
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
  if (expectFailure) {
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
  } else {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  const receiptText = await readFile(receiptPath, "utf8");
  const events = receiptText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(JSON.stringify(events).includes(root), false);
  return { events, result };
}

test("attests the exact config, checkpoint and rembg bytes handed to the loader APIs", async (t) => {
  const { events } = await runInstrumentedLoaders(t);
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
  const { events, result } = await runInstrumentedLoaders(t, {
    mismatchCheckpoint: true,
    expectFailure: true,
  });
  assert.match(result.stderr, /model loader input bytes do not match/i);
  assert.deepEqual(events.map((event) => event.role).sort(), [
    "tripoConfig",
  ]);
  assert.equal(events.some((event) => event.role === "tripoCheckpoint"), false);
});

test("aborts rembg loading when ONNX bytes differ from the preflight fingerprint", async (t) => {
  const { events, result } = await runInstrumentedLoaders(t, {
    mismatchRembg: true,
    expectFailure: true,
  });
  assert.match(result.stderr, /rembg model-loader bytes do not match/i);
  assert.deepEqual(events.map((event) => event.role).sort(), [
    "tripoCheckpoint", "tripoConfig",
  ]);
  assert.equal(events.some((event) => event.role === "rembgWeights"), false);
});


async function runInstrumentedSourceImage(t, {
  mismatchSource = false,
  mismatchPath = false,
  importStyle = "from",
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "single-image-source-loader-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourceBytes = Buffer.from([0xff, 0xd8, 0xff, 0x10, 0x20, 0x30, 0x40]);
  const sourcePath = path.join(root, "source.jpg");
  const alternatePath = path.join(root, "alternate-source.jpg");
  const receiptPath = path.join(root, "source-load-receipt.jsonl");
  const pilDirectory = path.join(root, "PIL");
  await mkdir(pilDirectory);
  await writeFile(sourcePath, sourceBytes);
  await writeFile(alternatePath, sourceBytes);
  await writeFile(path.join(root, "sitecustomize.py"), SINGLE_IMAGE_MODEL_LOAD_ATTESTATION_SITE_CUSTOMIZE);
  await writeFile(path.join(pilDirectory, "__init__.py"), "from . import Image\n");
  await writeFile(path.join(pilDirectory, "Image.py"), [
    "import io",
    "class DecodedImage:",
    "    def __init__(self, fp):",
    "        if not isinstance(fp, io.BytesIO):",
    "            raise TypeError('decoder must receive in-memory bytes, not a path')",
    "        self.payload = fp.read()",
    "        self.filename = None",
    "def open(fp, *args, **kwargs):",
    "    return DecodedImage(fp)",
    "",
  ].join("\n"));
  await writeFile(receiptPath, "", { mode: 0o600 });

  const expected = {
    bytes: sourceBytes.length,
    sha256: mismatchSource ? "0".repeat(64) : sha256(sourceBytes),
  };
  const importLines = importStyle === "dynamic"
    ? [
      "import importlib",
      "Image = importlib.import_module('PIL.Image')",
    ]
    : importStyle === "module"
      ? [
        "import PIL.Image",
        "Image = PIL.Image",
      ]
      : [
        "from PIL import Image",
      ];
  const sourceArgument = mismatchPath ? alternatePath : sourcePath;
  const script = [
    "import os, sys",
    ...importLines,
    "first = Image.open(sys.argv[1])",
    "assert first.payload == bytes([255, 216, 255, 16, 32, 48, 64])",
    "assert first.filename == os.path.realpath(sys.argv[1])",
    "second = Image.open(sys.argv[1])",
    "assert second.payload == first.payload",
  ].join("\n");
  const result = spawnSync(process.env.PYTHON || "python3", [
    "-c", script, sourceArgument,
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      PYTHONPATH: root,
      BUILDING_ENGINE_SOURCE_IMAGE_RECEIPT_PATH: receiptPath,
      BUILDING_ENGINE_SOURCE_IMAGE_EXPECTED_PATH: sourcePath,
      BUILDING_ENGINE_SOURCE_IMAGE_EXPECTED_JSON: JSON.stringify(expected),
    },
  });
  if (mismatchSource) {
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /source image decoder input does not match/i);
  } else {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const receiptText = await readFile(receiptPath, "utf8");
  const events = receiptText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(receiptText.includes(root), false);
  return { events, result, sourceBytes };
}

test("attests the exact source-image bytes handed to PIL.Image.open and reuses one immutable buffer", async (t) => {
  const { events } = await runInstrumentedSourceImage(t);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    bytes: 7,
    exactBytesPassed: true,
    loader: "PIL.Image.open",
    role: "sourceImage",
    schemaVersion: "1.0.0",
    sha256: sha256(Buffer.from([0xff, 0xd8, 0xff, 0x10, 0x20, 0x30, 0x40])),
    stable: true,
  });
});

test("supports PIL.Image dynamic import without weakening source-image byte identity", async (t) => {
  const { events } = await runInstrumentedSourceImage(t, { importStyle: "dynamic" });
  assert.equal(events.length, 1);
  assert.equal(events[0].loader, "PIL.Image.open");
  assert.equal(events[0].exactBytesPassed, true);
});

test("supports the PIL.Image module import form", async (t) => {
  const { events } = await runInstrumentedSourceImage(t, { importStyle: "module" });
  assert.equal(events.length, 1);
  assert.equal(events[0].loader, "PIL.Image.open");
});

test("rejects source-image digest mismatch before the original Pillow decoder runs", async (t) => {
  const { events, result } = await runInstrumentedSourceImage(t, { mismatchSource: true });
  assert.notEqual(result.status, 0);
  assert.deepEqual(events, []);
});

test("rejects a different source-image path before the original Pillow decoder runs", async (t) => {
  const { events, result } = await runInstrumentedSourceImage(t, { mismatchPath: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /other than the attested source path/i);
  assert.deepEqual(events, []);
});
