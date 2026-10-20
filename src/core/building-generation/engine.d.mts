import type { BuildingGenerationPlan, BuildingGenerationRequest } from "./types";
import type { TripoTaskResult } from "./providers/tripo-client.mjs";

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
export declare function createBuildingGenerationEngine(options?: {
  tripoClient?: {
    submitImage(options: { input: string; texture?: boolean; pbr?: boolean; signal?: AbortSignal }): Promise<{ taskId: string }>;
    submitMultiview(options: { views: Partial<Record<"front" | "left" | "back" | "right", string>>; texture?: boolean; pbr?: boolean; signal?: AbortSignal }): Promise<{ taskId: string }>;
    getTask(taskId: string, options?: { signal?: AbortSignal }): Promise<TripoTaskResult>;
  } | null;
}): {
  analyze(request: unknown): BuildingGenerationAnalysis;
  generateProceduralCandidate(request: unknown): ProceduralBuildingCandidate;
  submitReferenceCandidate(request: unknown, options?: { selectedVideoFrameIds?: string[] }): Promise<{ strategy: string; taskId: string; plan: BuildingGenerationPlan }>;
};
