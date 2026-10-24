export type GeographicViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type GeographicViewportCenter = {
  longitude: number;
  latitude: number;
};

const METERS_PER_LATITUDE_DEGREE = 111_320;

/**
 * Intersect an existing viewport rectangle with a local square centred on the
 * camera's ground-focus point. The radius is a per-axis half-extent, not a
 * circular-distance test; actual selection still uses the viewport rectangle.
 *
 * A null result means the arguments are invalid or the rectangles do not
 * intersect. Callers can then retain their unmodified viewport rather than
 * silently requesting the wrong area.
 */
export function clampViewportBoundsToLocalWindow(
  bounds: GeographicViewportBounds,
  center: GeographicViewportCenter,
  halfExtentMeters: number,
): GeographicViewportBounds | null {
  if (
    ![bounds.west, bounds.south, bounds.east, bounds.north,
      center.longitude, center.latitude, halfExtentMeters].every(Number.isFinite) ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north ||
    center.longitude < -180 ||
    center.longitude > 180 ||
    center.latitude < -90 ||
    center.latitude > 90 ||
    halfExtentMeters <= 0
  ) {
    return null;
  }

  const latitudeHalfExtentDegrees = halfExtentMeters / METERS_PER_LATITUDE_DEGREE;
  const longitudeMetersPerDegree = METERS_PER_LATITUDE_DEGREE
    * Math.max(0.1, Math.cos(center.latitude * Math.PI / 180));
  const longitudeHalfExtentDegrees = halfExtentMeters / longitudeMetersPerDegree;

  const clipped = {
    west: Math.max(bounds.west, center.longitude - longitudeHalfExtentDegrees),
    south: Math.max(bounds.south, center.latitude - latitudeHalfExtentDegrees),
    east: Math.min(bounds.east, center.longitude + longitudeHalfExtentDegrees),
    north: Math.min(bounds.north, center.latitude + latitudeHalfExtentDegrees),
  };

  if (
    ![clipped.west, clipped.south, clipped.east, clipped.north].every(Number.isFinite) ||
    clipped.west >= clipped.east ||
    clipped.south >= clipped.north
  ) {
    return null;
  }

  return clipped;
}
