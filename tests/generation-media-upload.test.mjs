import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ingestUploadedGenerationMedia,
  MAX_GENERATION_MEDIA_UPLOAD_BYTES,
} from "../src/core/building-generation/generation-media-upload.mjs";

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(32, 9),
]);

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-upload-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("stores uploaded bytes through signature validation and content-addressed media intake", async (t) => {
  const root = await workspace(t);
  const result = await ingestUploadedGenerationMedia({
    workspaceRoot: root,
    buildingId: "dhaka-demo",
    sourceId: "front-photo",
    bytes: png,
    title: "front.png",
    licence: "CC BY 4.0",
  });

  assert.equal(result.record.id, "front-photo");
  assert.equal(result.record.buildingId, "dhaka-demo");
  assert.equal(result.record.kind, "image");
  assert.equal(result.record.mimeType, "image/png");
  assert.equal(result.record.licence, "CC BY 4.0");
  assert.equal(result.record.usageStatus, "unreviewed");
  assert.equal(result.record.byteSize, png.length);
  assert.match(result.record.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.record.assetId, result.record.sha256);
  const stored = await readFile(path.join(root, ...result.record.relativePath.split("/")));
  assert.deepEqual(stored, png);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".generation-upload-")), []);
});

test("rejects spoofed media signatures and kind mismatches without leaving staging files", async (t) => {
  const root = await workspace(t);
  await assert.rejects(
    ingestUploadedGenerationMedia({
      workspaceRoot: root,
      buildingId: "b1",
      sourceId: "fake-image",
      bytes: Buffer.from("this is not a png"),
      title: "fake.png",
    }),
    /unsupported file signature/,
  );
  await assert.rejects(
    ingestUploadedGenerationMedia({
      workspaceRoot: root,
      buildingId: "b1",
      sourceId: "wrong-kind",
      bytes: png,
      kind: "video",
    }),
    /does not match media kind/,
  );
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".generation-upload-")), []);
});

test("validates identifiers, byte limits and duplicate source IDs", async (t) => {
  const root = await workspace(t);
  await assert.rejects(
    ingestUploadedGenerationMedia({ workspaceRoot: root, buildingId: "../outside", sourceId: "x", bytes: png }),
    /buildingId must be a safe identifier/,
  );
  await assert.rejects(
    ingestUploadedGenerationMedia({
      workspaceRoot: root,
      buildingId: "b1",
      sourceId: "too-large",
      bytes: Buffer.alloc(MAX_GENERATION_MEDIA_UPLOAD_BYTES + 1),
    }),
    /50 MiB API upload limit/,
  );
  await ingestUploadedGenerationMedia({ workspaceRoot: root, buildingId: "b1", sourceId: "same", bytes: png });
  await assert.rejects(
    ingestUploadedGenerationMedia({ workspaceRoot: root, buildingId: "b1", sourceId: "same", bytes: png }),
    /already exists/,
  );
});
