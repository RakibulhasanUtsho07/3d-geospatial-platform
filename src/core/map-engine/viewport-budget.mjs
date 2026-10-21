/**
 * Pick a response budget for viewport buildings from the camera altitude.
 * Higher views need fewer GeoJSON entities; close views can request more.
 */
export function getViewportFeatureLimit(cameraHeightMeters) {
  const height = Number.isFinite(cameraHeightMeters)
    ? Math.max(0, cameraHeightMeters)
    : 0;

  if (height >= 25_000) return 500;
  if (height >= 12_000) return 900;
  if (height >= 6_000) return 1_400;
  if (height >= 2_500) return 2_000;

  return 3_000;
}
