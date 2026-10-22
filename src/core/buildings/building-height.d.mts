export type BuildingHeightSource =
  | "overture-height"
  | "floor-estimate"
  | "fallback-estimate";

export type BuildingHeight = {
  /** Extrusion height actually used by the renderer, in metres. */
  meters: number;
  /** Base/minimum height actually used by the renderer, in metres. */
  baseHeight: number;
  /** Measurement source or explicit estimate category. */
  source: BuildingHeightSource;
  /** Unclamped source or estimate value before rendering safety caps. */
  unclampedMeters: number;
  /** Whether the extrusion height was adjusted by the 3m/300m safety caps. */
  heightWasClamped: boolean;
  /** Unclamped min-height value, in metres (zero when absent). */
  unclampedBaseHeight: number;
  /** Whether min-height was adjusted by the 100m safety cap. */
  baseHeightWasClamped: boolean;
};

export declare function resolveBuildingHeight(
  properties: Record<string, unknown>,
): BuildingHeight;
