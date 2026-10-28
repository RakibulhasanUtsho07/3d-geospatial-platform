import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractVideoFrames } from "../src/core/building-generation/video-frame-extractor.mjs";
import { loadVerifiedSource } from "../src/core/building-generation/source-workflow.mjs";

const FRAME_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128, 23)]);
const BASE_SCOPES = ["private-media-ingestion", "video-frame-extraction", "procedural-model-derivation", "photogrammetry-reconstruction", "texture-baking"];

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf46-video-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  await writeFile(path.join(root, "uploads", "clip.mp4"), Buffer.from("synthetic video fixture"));
  return root;
}

function makeVideoRecord(scopes = BASE_SCOPES) {
  return {
    id: "clip", buildingId: "demo-building", kind: "video", mimeType: "video/mp4",
    licence: "CC BY 4.0", usageStatus: "approved", permittedOperations: [...scopes], title: "Synthetic test video",
  };
}

function mockFfmpeg(frameBytes = FRAME_BYTES) {
  let calls = 0;
  const spawnImpl = (_executable, args) => {
    calls += 1;
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(async () => {
      try {
        const outputPattern = args[args.length - 1];
        const outputPath = outputPattern.replace("%06d", "000001");
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, frameBytes);
        child.emit("close", 0, null);
      } catch (error) {
        child.stderr.write(error instanceof Error ? error.message : String(error));
        child.emit("close", 1, null);
      }
    });
    return child;
  };
  return { spawnImpl, get calls() { return calls; } };
}

function options(root, videoRecord, spawnImpl) {
  return {
    workspaceRoot: root, videoRelativePath: "uploads/clip.mp4", buildingId: "demo-building", sourceId: "clip",
    videoRecord, fps: 1, maxFrames: 2, maxWidth: 640, timeoutMs: 10000, ffmpegPath: "mock-ffmpeg", spawnImpl,
  };
}

test("video frame extraction requires a matching reviewed parent and explicit extraction scope before invoking FFmpeg", async t => {
  const root = await workspace(t);
  let calls = 0;
  const spawnImpl = () => { calls += 1; throw new Error("FFmpeg must not be invoked without scope"); };
  const record = makeVideoRecord(BASE_SCOPES.filter(scope => scope !== "video-frame-extraction"));
  await assert.rejects(extractVideoFrames(options(root, record, spawnImpl)), /lacks explicit video-frame-extraction permission/);
  assert.equal(calls, 0);
});

test("extracted frames inherit the normalized parent operation scopes and provenance", async t => {
  const root = await workspace(t);
  const mock = mockFfmpeg();
  const result = await extractVideoFrames(options(root, makeVideoRecord(), mock.spawnImpl));
  assert.equal(mock.calls, 1);
  assert.equal(result.extractedFrames, 1);
  const frame = result.frames[0];
  assert.deepEqual(frame.permittedOperations, [...BASE_SCOPES].sort());
  assert.equal(frame.operationScopesInheritedFrom, "clip");
  assert.equal(frame.parentSourceId, "clip");
  const stored = await loadVerifiedSource(root, "demo-building", frame.id);
  assert.deepEqual(stored.record.permittedOperations, [...BASE_SCOPES].sort());
  assert.equal(stored.record.operationScopesInheritedFrom, "clip");
  assert.equal(stored.record.sha256, frame.sha256);
});

test("a cached frame cannot be reused after its parent operation scopes change", async t => {
  const root = await workspace(t);
  const firstMock = mockFfmpeg();
  await extractVideoFrames(options(root, makeVideoRecord(), firstMock.spawnImpl));
  const changed = [...BASE_SCOPES, "single-image-ai-reconstruction"];
  const secondMock = mockFfmpeg();
  await assert.rejects(extractVideoFrames(options(root, makeVideoRecord(changed), secondMock.spawnImpl)), /does not match the sampled source frame/);
  assert.equal(secondMock.calls, 1);
});
