/**
 * Prepare [longitude, latitude, ...] for Cesium without allocating an extra
 * two-item array for every source coordinate.
 */
export function flattenRoadCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  const flattened = new Array(coordinates.length * 2);
  let offset = 0;

  for (const coordinate of coordinates) {
    if (
      !Array.isArray(coordinate)
      || typeof coordinate[0] !== "number"
      || typeof coordinate[1] !== "number"
      || !Number.isFinite(coordinate[0])
      || !Number.isFinite(coordinate[1])
      || coordinate[0] < -180
      || coordinate[0] > 180
      || coordinate[1] < -90
      || coordinate[1] > 90
    ) continue;

    flattened[offset] = coordinate[0];
    flattened[offset + 1] = coordinate[1];
    offset += 2;
  }

  flattened.length = offset;
  return flattened;
}
