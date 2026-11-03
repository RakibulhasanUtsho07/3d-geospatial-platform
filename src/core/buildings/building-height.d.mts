export type BuildingHeightSource =
  | "overture-height"
  | "floor-estimate"
  | "fallback-estimate";

export type BuildingBaseHeightSource =
  | "overture-min-height"
  | "min-floor-estimate"
  | "ground-zero-default";

export type BuildingHeight = {
  /** Vertical distance from the feature's lowest point to highest point, in metres. */
  meters: number;
  /** Relative above-ground offset at which the feature's bottom starts, in metres. */
  baseHeight: number;
  /** Measurement source or explicit estimate category. */
  source: BuildingHeightSource;
  /** Unclamped source or estimate value before rendering safety caps. */
  unclampedMeters: number;
  /** Whether the extrusion height was adjusted by the 3m/300m safety caps. */
  heightWasClamped: boolean;
  /** Source or estimate used to derive the base-height offset. */
  baseHeightSource: BuildingBaseHeightSource;
  /** True when the base-height offset is estimated from min_floor. */
  baseHeightEstimated: boolean;
  /** Explicit min_height value, or null when absent. */
  reportedMinHeight: number | null;
  /** Explicit integer min_floor value, or null when absent. */
  reportedMinFloor: number | null;
  /** Unclamped base-height value, in metres (zero when absent). */
  unclampedBaseHeight: number;
  /** Whether the base-height value was adjusted by the 100m safety cap. */
  baseHeightWasClamped: boolean;
};

export declare function resolveBuildingHeight(
  properties: Record<string, unknown>,
): BuildingHeight;
