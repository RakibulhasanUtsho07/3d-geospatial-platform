export type BuildingHeightSource =
  | "overture-height"
  | "floor-estimate"
  | "fallback-estimate";

export type BuildingHeight = {
  /** Clamped or estimated extrusion height, in metres. */
  meters: number;
  /** Base/minimum height, in metres. */
  baseHeight: number;
  /** Provenance label; only overture-height is source-provided height. */
  source: BuildingHeightSource;
};

export declare function resolveBuildingHeight(
  properties: Record<string, unknown>,
): BuildingHeight;
