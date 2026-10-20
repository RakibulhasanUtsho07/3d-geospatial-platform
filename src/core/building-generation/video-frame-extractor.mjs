import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

function finiteRange(value, name, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(name + " must be between " + min + " and " + max + ".");
  }
  return value;
}

function positiveInteger(value, name, min, max) {
  finiteRange(value, name, min, max);
  if (!Number.isInteger(value)) throw new TypeError(name + " must be an integer.");
  return value;
}

function normalizeOptions(options = {}) {
  const fps = options.fps === undefined ? 0.5 : finiteRange(options.fps, "fps", 0.1, 2);
  const maxFrames = options.maxFrames === undefined ? 40 : positiveInteger(options.maxFrames, "maxFrames", 2, 120);
  const maxWidth = options.maxWidth === undefined ? 1600 : positiveInteger(options.maxWidth, "maxWidth", 256, 4096);
  const jpegQuality = options.jpegQuality === undefined ? 3 : positiveInteger(options.jpegQuality, "jpegQuality", 2, 10);
  const maxInputBytes = options.maxInputBytes === undefined ? 500 * 1024 * 1024 : positiveInteger(options.maxInputBytes, "maxInputBytes", 1, 2 * 1024 * 1024 * 1024);
  const maxDurationSeconds = options.maxDurationSeconds === undefined ? 300 : finiteRange(options.maxDurationSeconds, "maxDurationSeconds", 1, 3600);
  const timeoutMs = options.timeoutMs === undefined ? 120_000 : positiveInteger(options.timeoutMs, "timeoutMs", 1000, 600_000);
  return { fps, maxFrames, maxWidth, jpegQuality, maxInputBytes, maxDurationSeconds, timeoutMs };
}

/** Build safe argument arrays; never pass user-controlled input through a shell. */
export function buildVideoProbeArgs(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new TypeError("inputPath is required.");
  return ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath];
}

/** Build the bounded FFmpeg extraction command for selected JPEG keyframes. */
export function buildVideoFrameArgs({ inputPath, outputPattern, fps = 0.5, maxFrames = 40, maxWidth = 1600, jpegQuality = 3 } = {}) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new TypeError("inputPath is required.");
  if (typeof outputPattern !== "string" || !outputPattern.trim() || !outputPattern.includes("%04d")) {
    throw new TypeError("outputPattern must include the %04d frame sequence placeholder.");
  }
  finiteRange(fps, "fps", 0.1, 2);
  positiveInteger(maxFrames, "maxFrames", 2, 120);
  positiveInteger(maxWidth, "maxWidth", 256, 4096);
  positiveInteger(jpegQuality, "jpegQuality", 2, 10);
  const videoFilter = "fps=" + fps + ",scale=w='min(" + maxWidth + ",iw)':h=-2:flags=lanczos,showinfo";
  return [
    "-hide_banner", "-loglevel", "info", "-nostdin", "-i", inputPath,
    "-an", "-vf", videoFilter, "-frames:v", String(maxFrames),
    "-q:v", String(jpegQuality), "-start_number", "0", outputPattern,
  ];
}

function runProcess(executable, args, { spawnImpl = spawn, timeoutMs, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      aborted = true;
      try { child?.kill("SIGKILL"); } catch {}
      settle(rejectPromise, Object.assign(new Error("Video processing was aborted."), { code: "ABORT_ERR" }));
    };

    if (signal?.aborted) {
      rejectPromise(Object.assign(new Error("Video processing was aborted."), { code: "ABORT_ERR" }));
      return;
    }

    try {
      child = spawnImpl(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        try { child.kill("SIGKILL"); } catch {}
        settle(rejectPromise, new Error("Video probe output exceeded the configured safety limit."));
        return;
      }
      stdout += text;
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderrBytes += Buffer.byteLength(text);
      if (stderr.length < MAX_STDERR_BYTES) stderr += text.slice(0, MAX_STDERR_BYTES - stderr.length);
      if (stderrBytes > MAX_STDERR_BYTES && !settled) {
        try { child.kill("SIGKILL"); } catch {}
        settle(rejectPromise, new Error("Video processor diagnostics exceeded the safety limit."));
      }
    });
    child.once("error", (error) => settle(rejectPromise, error));
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      if (aborted) return;
      if (timedOut) {
        settle(rejectPromise, Object.assign(new Error("Video processing timed out after " + timeoutMs + " ms."), { code: "VIDEO_TIMEOUT" }));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().slice(-1200);
        settle(rejectPromise, new Error(executable + " failed (" + (closeSignal || code) + "). " + detail));
        return;
      }
      settle(resolvePromise, { stdout: stdout.trim(), stderr });
    });

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function parseFrameTimestamps(stderr, count, fps) {
  const timestamps = [];
  const regex = /pts_time:([-+]?(?:\d+\.?\d*|\.\d+))/g;
  let match;
  while ((match = regex.exec(stderr)) !== null && timestamps.length < count) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 0) timestamps.push(value);
  }
  return Array.from({ length: count }, (_, index) => ({
    seconds: timestamps[index] ?? index / fps,
    confidence: timestamps[index] === undefined ? "estimated-from-sampling-rate" : "ffmpeg-presentation-timestamp",
  }));
}

/**
 * Extract bounded, uniformly sampled JPEG keyframes from a server-managed video file.
 * The caller is responsible for authorization, private source storage and deleting temp assets afterward.
 * The process is always spawned without a shell and is bounded by file size, duration, frame count and timeout.
 */
export async function extractVideoKeyframes({
  inputPath,
  outputDirectory,
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
  spawnImpl = spawn,
  io = { stat, mkdir, readdir, rm },
  signal,
  ...optionValues
} = {}) {
  const options = normalizeOptions(optionValues);
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new TypeError("inputPath is required.");
  if (typeof outputDirectory !== "string" || !outputDirectory.trim()) throw new TypeError("outputDirectory is required.");
  if (typeof ffmpegPath !== "string" || !ffmpegPath.trim() || typeof ffprobePath !== "string" || !ffprobePath.trim()) {
    throw new TypeError("FFmpeg and FFprobe executable paths must be non-empty.");
  }

  const absoluteInput = resolve(inputPath);
  const extension = extname(absoluteInput).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new TypeError("Unsupported video file extension: " + extension);
  const inputInfo = await io.stat(absoluteInput);
  if (!inputInfo.isFile()) throw new TypeError("Video input must be a regular file.");
  if (inputInfo.size <= 0 || inputInfo.size > options.maxInputBytes) {
    throw new RangeError("Video file size must be between 1 byte and " + options.maxInputBytes + " bytes.");
  }

  const probe = await runProcess(ffprobePath, buildVideoProbeArgs(absoluteInput), { spawnImpl, timeoutMs: options.timeoutMs, signal });
  const durationSeconds = Number(probe.stdout);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("FFprobe did not return a valid positive video duration.");
  if (durationSeconds > options.maxDurationSeconds) {
    throw new RangeError("Video duration " + durationSeconds.toFixed(2) + "s exceeds the configured limit of " + options.maxDurationSeconds + "s.");
  }

  const destination = resolve(outputDirectory);
  if (destination === absoluteInput || destination.startsWith(absoluteInput + sep)) {
    throw new TypeError("Output directory cannot be the input video or a child of the input file path.");
  }
  await io.mkdir(destination, { recursive: false });
  const outputPattern = resolve(destination, "frame_%04d.jpg");
  try {
    const result = await runProcess(ffmpegPath, buildVideoFrameArgs({
      inputPath: absoluteInput,
      outputPattern,
      fps: options.fps,
      maxFrames: options.maxFrames,
      maxWidth: options.maxWidth,
      jpegQuality: options.jpegQuality,
    }), { spawnImpl, timeoutMs: options.timeoutMs, signal });
    const filenames = (await io.readdir(destination, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^frame_\d{4}\.jpg$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (filenames.length < 2) throw new Error("FFmpeg produced fewer than two usable keyframes.");
    if (filenames.length > options.maxFrames) throw new Error("FFmpeg produced more frames than the configured limit.");
    const timestamps = parseFrameTimestamps(result.stderr, filenames.length, options.fps);
    const frames = filenames.map((filename, index) => ({
      index,
      filename,
      path: resolve(destination, filename),
      timestampSeconds: timestamps[index].seconds,
      timestampConfidence: timestamps[index].confidence,
      sourceVideoPath: absoluteInput,
    }));
    return {
      inputPath: absoluteInput,
      outputDirectory: destination,
      durationSeconds,
      samplingFps: options.fps,
      frames,
      notes: [
        "Extracted frames are visual references, not automatically calibrated photogrammetry inputs.",
        "Admin must confirm view labels before multiview AI submission.",
      ],
    };
  } catch (error) {
    await io.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export const VIDEO_FRAME_EXTRACTOR_DEFAULTS = Object.freeze({
  fps: 0.5,
  maxFrames: 40,
  maxWidth: 1600,
  jpegQuality: 3,
  maxInputBytes: 500 * 1024 * 1024,
  maxDurationSeconds: 300,
  timeoutMs: 120000,
});
