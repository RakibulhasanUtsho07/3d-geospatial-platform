import type { Cartesian2, PolygonGraphics, Viewer } from "cesium";

export type FeaturePickGeometryCoordinates = {
  longitude: number;
  latitude: number;
  height: number;
};

export type FeaturePickGeometryResult = {
  coordinates: FeaturePickGeometryCoordinates | null;
  focusCoordinates: FeaturePickGeometryCoordinates | null;
  footprintAreaM2: number | null;
};

export type FeaturePickGeometryOptions = {
  viewer: Pick<Viewer, "scene" | "camera">;
  Cesium: typeof import("cesium");
  screenPosition: Cartesian2;
  polygon: Pick<PolygonGraphics, "hierarchy">;
  baseHeight: number;
  heightMeters: number;
};

/**
 * Resolve click coordinates, a building focus point, and a ground footprint
 * area without mutating adapter selection state.
 */
export function resolveFeaturePickGeometry(
  options: FeaturePickGeometryOptions,
): FeaturePickGeometryResult;
