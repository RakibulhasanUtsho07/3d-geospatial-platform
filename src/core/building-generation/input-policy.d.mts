import type { BuildingGenerationRequest, BuildingGenerationPlan } from "./types";
export declare function normalizeBuildingGenerationRequest(value: unknown): BuildingGenerationRequest;
export declare function planBuildingGeneration(request: unknown): BuildingGenerationPlan;
export declare const BUILDING_GENERATION_POLICY: Readonly<{ maxReferences: number; maxFootprintPoints: number; maxDimensionsMeters: number; supportedQuality: readonly string[] }>;
