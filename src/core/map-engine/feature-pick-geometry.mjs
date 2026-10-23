import { calculateFootprintAreaM2 } from "../geospatial/footprint-area.mjs";

/**
 * Resolve the click coordinate, building focus point, and footprint area for a
 * picked building. Cesium calls are kept here; the adapter remains responsible
 * for selection state, feature metadata, and rendering side effects.
 */
export function resolveFeaturePickGeometry({
  viewer,
  Cesium,
  screenPosition,
  polygon,
  baseHeight,
  heightMeters,
}) {
  let coordinates = null;

  try {
    const worldPosition = viewer.scene.pickPositionSupported
      ? viewer.scene.pickPosition(screenPosition)
      : undefined;

    const position =
      worldPosition ??
      viewer.camera.pickEllipsoid(
        screenPosition,
        viewer.scene.globe.ellipsoid,
      );

    if (position) {
      const cartographic = Cesium.Cartographic.fromCartesian(position);
      coordinates = {
        longitude: Cesium.Math.toDegrees(cartographic.longitude),
        latitude: Cesium.Math.toDegrees(cartographic.latitude),
        height: cartographic.height,
      };
    }
  } catch (error) {
    console.debug(
      "[Map] Could not determine click coordinates:",
      error instanceof Error ? error.message : String(error),
    );
  }

  let focusCoordinates = null;
  let footprintAreaM2 = null;

  try {
    const hierarchy = polygon.hierarchy?.getValue(Cesium.JulianDate.now());

    if (hierarchy && hierarchy.positions.length >= 3) {
      const bounds = Cesium.BoundingSphere.fromPoints(hierarchy.positions);
      const center = Cesium.Cartographic.fromCartesian(bounds.center);

      focusCoordinates = {
        longitude: Cesium.Math.toDegrees(center.longitude),
        latitude: Cesium.Math.toDegrees(center.latitude),
        height: baseHeight + heightMeters,
      };

      const toDegreesRing = (positions) =>
        positions.map((position) => {
          const cartographic = Cesium.Cartographic.fromCartesian(position);
          return {
            longitude: Cesium.Math.toDegrees(cartographic.longitude),
            latitude: Cesium.Math.toDegrees(cartographic.latitude),
          };
        });

      const rings = [
        toDegreesRing(hierarchy.positions),
        ...(hierarchy.holes ?? []).map((hole) => toDegreesRing(hole.positions)),
      ];
      footprintAreaM2 = calculateFootprintAreaM2(rings);
    }
  } catch (error) {
    console.debug(
      "[Map] Could not calculate building footprint measurements:",
      error instanceof Error ? error.message : String(error),
    );
  }

  return { coordinates, focusCoordinates, footprintAreaM2 };
}
