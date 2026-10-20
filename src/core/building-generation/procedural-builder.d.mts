import type { BuildingGenerationRequest } from "./types";

export declare function generateParametricBuildingGlb(request: BuildingGenerationRequest): {
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
};
export declare const PROCEDURAL_BUILDING_DEFAULTS: Readonly<{
  floorToFloorHeightMeters: number;
  facadeColour: string;
  roofType: string;
  windowMaterial: string;
}>;
