export type ExtractedVideoFrame = {
  index: number;
  filename: string;
  path: string;
  timestampSeconds: number;
  timestampConfidence: "ffmpeg-presentation-timestamp" | "estimated-from-sampling-rate";
  sourceVideoPath: string;
};
export type VideoFrameExtractionResult = {
  inputPath: string;
  outputDirectory: string;
  durationSeconds: number;
  samplingFps: number;
  frames: ExtractedVideoFrame[];
  notes: string[];
};
export declare function buildVideoProbeArgs(inputPath: string): string[];
export declare function buildVideoFrameArgs(options: { inputPath: string; outputPattern: string; fps?: number; maxFrames?: number; maxWidth?: number; jpegQuality?: number }): string[];
export declare function extractVideoKeyframes(options: {
  inputPath: string;
  outputDirectory: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  spawnImpl?: typeof import("node:child_process").spawn;
  signal?: AbortSignal;
  fps?: number;
  maxFrames?: number;
  maxWidth?: number;
  jpegQuality?: number;
  maxInputBytes?: number;
  maxDurationSeconds?: number;
  timeoutMs?: number;
  io?: { stat: typeof import("node:fs/promises").stat; mkdir: typeof import("node:fs/promises").mkdir; readdir: typeof import("node:fs/promises").readdir; rm: typeof import("node:fs/promises").rm };
}): Promise<VideoFrameExtractionResult>;
export declare const VIDEO_FRAME_EXTRACTOR_DEFAULTS: Readonly<{ fps: number; maxFrames: number; maxWidth: number; jpegQuality: number; maxInputBytes: number; maxDurationSeconds: number; timeoutMs: number }>;
