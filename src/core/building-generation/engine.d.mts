import type { BuildingGenerationPlan, BuildingGenerationRequest } from "./types";
import type { TripoTaskResult } from "./providers/tripo-client.mjs";
import type { VideoFrameExtractionOptions, VideoFrameExtractionResult } from "./video-frame-extractor.mjs";
import type { GlbAlignmentMode, GlbAlignmentResult, GlbValidationResult } from "./glb-validation.mjs";

export type BuildingGenerationAnalysis = {
  request: BuildingGenerationRequest;
  plan: BuildingGenerationPlan;
};
export type ProceduralBuildingCandidate = {
  strategy: "parametric-only";
  contentType: "model/gltf-binary";
  extension: ".glb";
  glb: Buffer;
  metadata: {
    name: string;
    buildingType: string;
    floorCount: number;
    totalHeightMeters: number;
    footprintWidthMeters: number;
    footprintDepthMeters: number;
    footprintAreaSquareMeters: number;
    materialCount: number;
    primitiveCount: number;
    warnings: string[];
  };
  plan: BuildingGenerationPlan;
};
export type PreparedVideoFrames = {
  request: BuildingGenerationRequest;
  videoReferenceId: string;
  frameReferences: BuildingGenerationRequest["references"];
  extraction: Pick<VideoFrameExtractionResult, "durationSeconds" | "samplingFps" | "notes">;
  reviewRequired: true;
  nextStep: string;
};
export type StoredGeneratedCandidate = {
  status: "needs-admin-review";
  taskId: string;
  assetId: string;
  validation: GlbValidationResult;
  alignment: GlbAlignmentResult | null;
  warnings: string[];
  strategy?: string;
  plan?: BuildingGenerationPlan;
  uploadedReferences?: Array<{ referenceId: string; providerFileToken: string }>;
};

export declare function createBuildingGenerationEngine(options?: {
  tripoClient?: {
    uploadImage(options: { bytes: Uint8Array; filename?: string; contentType?: "image/jpeg" | "image/png"; signal?: AbortSignal }): Promise<{ fileToken: string }>;
    submitImage(options: { input: string; texture?: boolean; pbr?: boolean; signal?: AbortSignal }): Promise<{ taskId: string }>;
    submitMultiview(options: { views: Partial<Record<"front" | "left" | "back" | "right", string>>; texture?: boolean; pbr?: boolean; signal?: AbortSignal }): Promise<{ taskId: string }>;
    getTask(taskId: string, options?: { signal?: AbortSignal }): Promise<TripoTaskResult>;
  } | null;
  loadAsset?: (assetId: string) => Promise<{ bytes: Uint8Array; filename?: string; contentType: "image/jpeg" | "image/png" }>;
  resolveVideoAssetPath?: (assetId: string) => Promise<string>;
  storeFrameAsset?: (input: { path: string; filename: string; contentType: "image/jpeg"; sourceVideoAssetId: string; sourceVideoReferenceId: string; timestampSeconds: number }) => Promise<{ assetId: string }>;
  storeGeneratedCandidate?: (input: {
    taskId: string;
    bytes: Buffer;
    contentType: "model/gltf-binary";
    metadata: {
      taskId: string;
      provider: "tripo";
      outputValidation: GlbValidationResult;
      provenance: "external-ai-candidate";
      inputSummary?: { requestId: string; quality: string; building: unknown; referenceIds: string[]; strategy: string };
      alignment?: GlbAlignmentResult;
    };
  }) => Promise<{ assetId: string }>;
  fetchImpl?: typeof fetch;
  allowedModelHosts?: readonly string[];
  extractVideo?: (options: { inputPath: string; outputDirectory: string; signal?: AbortSignal } & VideoFrameExtractionOptions) => Promise<VideoFrameExtractionResult>;
  createVideoWorkDirectory?: () => Promise<string>;
  removeVideoWorkDirectory?: (directory: string) => Promise<void>;
  sleepImpl?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): {
  analyze(request: unknown): BuildingGenerationAnalysis;
  generateProceduralCandidate(request: unknown): ProceduralBuildingCandidate;
  prepareVideoFrames(request: unknown, options: { videoReferenceId: string; signal?: AbortSignal; extractionOptions?: VideoFrameExtractionOptions }): Promise<PreparedVideoFrames>;
  submitReferenceCandidate(request: unknown, options?: { selectedVideoFrameIds?: string[]; signal?: AbortSignal }): Promise<{ strategy: string; taskId: string; plan: BuildingGenerationPlan; uploadedReferences?: Array<{ referenceId: string; providerFileToken: string }> }>;
  waitForProviderTask(taskId: string, options?: { signal?: AbortSignal; timeoutMs?: number; pollIntervalMs?: number; maxAttempts?: number; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void> }): Promise<TripoTaskResult>;
  validateAndStoreProviderOutput(task: TripoTaskResult, options?: { signal?: AbortSignal; maxBytes?: number; downloadTimeoutMs?: number; alignmentTarget?: { footprintWidthMeters: number; footprintDepthMeters: number; totalHeightMeters: number } | null; alignmentMode?: GlbAlignmentMode; generationContext?: { requestId: string; quality: string; building: unknown; referenceIds: string[]; strategy: string } }): Promise<StoredGeneratedCandidate>;
  generateAndStoreReferenceCandidate(request: unknown, options?: {
    selectedVideoFrameIds?: string[];
    signal?: AbortSignal;
    pollOptions?: { timeoutMs?: number; pollIntervalMs?: number; maxAttempts?: number; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void> };
    downloadOptions?: { maxBytes?: number; downloadTimeoutMs?: number; alignmentMode?: GlbAlignmentMode };
  }): Promise<StoredGeneratedCandidate>;
};
