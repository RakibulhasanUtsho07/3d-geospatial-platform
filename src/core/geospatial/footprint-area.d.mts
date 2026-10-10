export type FootprintCoordinate = {
  longitude: number;
  latitude: number;
};

/**
 * Approximate a small building polygon's ground footprint in square metres.
 * The first ring is the exterior; subsequent rings represent holes.
 * Returns null for invalid or non-positive area.
 */
export declare function calculateFootprintAreaM2(
  rings: FootprintCoordinate[][],
): number | null;

export declare const SQUARE_METERS_TO_SQUARE_FEET: number;
