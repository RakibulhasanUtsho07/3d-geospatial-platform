/**
 * Detail budget for procedural facade geometry, based on camera height.
 * Highest views remain lightweight; close views spend detail only on a bounded
 * set of nearby buildings.
 */
export function getDetailedFacadeBudget(cameraHeightMeters) {
  const height = Number.isFinite(cameraHeightMeters)
    ? Math.max(0, cameraHeightMeters)
    : 0;

  if (height >= 25_000) return 0;
  if (height >= 12_000) return 80;
  if (height >= 6_000) return 220;
  if (height >= 2_500) return 420;

  return 650;
}
