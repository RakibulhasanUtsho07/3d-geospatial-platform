import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { buildVideoFrameArgs, buildVideoProbeArgs, extractVideoKeyframes } from "../src/core/building-generation/video-frame-extractor.mjs";

test("builds FFmpeg arguments without shell parsing and with bounded sampling", () => {
  const args = buildVideoFrameArgs({ inputPath: "/private/building walk.mp4", outputPattern: "/tmp/frames/frame_%04d.jpg", fps: 0.5, maxFrames: 20, maxWidth: 1200 });
  assert.equal(args.includes("/private/building walk.mp4"), true);
  assert.equal(args.includes("20"), true);
  assert.ok(args.some((arg) => arg.includes("fps=0.5")));
  assert.equal(args.at(-1), "/tmp/frames/frame_%04d.jpg");
  assert.deepEqual(buildVideoProbeArgs("/tmp/test.mp4").slice(-1), ["/tmp/test.mp4"]);
});

test("rejects unsupported values and extension before spawning processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "building-video-test-"));
  const input = join(dir, "movie.exe");
  await writeFile(input, "not a video");
  let spawned = false;
  await assert.rejects(extractVideoKeyframes({ inputPath: input, outputDirectory: join(dir, "frames"), spawnImpl: () => { spawned = true; throw new Error("should not spawn"); } }), /Unsupported video file extension/);
  assert.equal(spawned, false);
  assert.throws(() => buildVideoFrameArgs({ inputPath: "a.mp4", outputPattern: "/tmp/frame_%04d.jpg", fps: 0 }), RangeError);
  assert.throws(() => buildVideoFrameArgs({ inputPath: "a.mp4", outputPattern: "/tmp/frames.jpg" }), TypeError);
  await rm(dir, { recursive: true, force: true });
});

test("extracts bounded frames and returns FFmpeg presentation timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "building-video-test-"));
  const input = join(root, "tour.mp4");
  const output = join(root, "frames");
  await writeFile(input, Buffer.alloc(128, 1));
  const spawnImpl = (executable, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(async () => {
      if (executable === "ffprobe") {
        child.stdout.emit("data", "12.0\n");
      } else {
        const pattern = args.at(-1);
        const directory = dirname(pattern);
        await writeFile(join(directory, "frame_0000.jpg"), Buffer.from([1, 2, 3]));
        await writeFile(join(directory, "frame_0001.jpg"), Buffer.from([4, 5, 6]));
        child.stderr.emit("data", "pts_time:0.000000\npts_time:2.000000\n");
      }
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await extractVideoKeyframes({ inputPath: input, outputDirectory: output, spawnImpl });
  assert.equal(result.durationSeconds, 12);
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[1].timestampSeconds, 2);
  assert.equal(result.frames[1].timestampConfidence, "ffmpeg-presentation-timestamp");
  assert.equal(await readFile(result.frames[0].path).then((b) => b.length), 3);
  await rm(root, { recursive: true, force: true });
});

test("cleans the output directory when ffmpeg fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "building-video-test-"));
  const input = join(root, "tour.mp4");
  const output = join(root, "frames");
  await writeFile(input, Buffer.alloc(128, 1));
  const spawnImpl = (executable) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      if (executable === "ffprobe") child.stdout.emit("data", "10");
      else child.stderr.emit("data", "bad input");
      child.emit("close", executable === "ffprobe" ? 0 : 1, null);
    });
    return child;
  };
  await assert.rejects(extractVideoKeyframes({ inputPath: input, outputDirectory: output, spawnImpl }), /failed/);
  await assert.rejects(stat(output), { code: "ENOENT" });
  await rm(root, { recursive: true, force: true });
});

test("rejects too long videos before frame extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "building-video-test-"));
  const input = join(root, "long.mov");
  await writeFile(input, Buffer.alloc(128, 1));
  let callCount = 0;
  const spawnImpl = (_executable) => {
    callCount += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => { child.stdout.emit("data", "800"); child.emit("close", 0, null); });
    return child;
  };
  await assert.rejects(extractVideoKeyframes({ inputPath: input, outputDirectory: join(root, "frames"), spawnImpl, maxDurationSeconds: 300 }), /exceeds the configured limit/);
  assert.equal(callCount, 1);
  await rm(root, { recursive: true, force: true });
});
