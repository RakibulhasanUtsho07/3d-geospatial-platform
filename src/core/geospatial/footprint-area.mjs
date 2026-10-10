const EARTH_RADIUS_METERS = 6_371_008.8;
const DEGREES_TO_RADIANS = Math.PI / 180;

function normalizeRing(ring) {
  if (!Array.isArray(ring)) return null;

  const points = [];
  for (const point of ring) {
    if (
      typeof point !== "object" ||
      point === null ||
      !Number.isFinite(point.longitude) ||
      !Number.isFinite(point.latitude) ||
      point.longitude < -180 ||
      point.longitude > 180 ||
      point.latitude < -90 ||
      point.latitude > 90
    ) {
      return null;
    }

    points.push({
      longitude: point.longitude,
      latitude: point.latitude,
    });
  }

  if (points.length > 3) {
    const first = points[0];
    const last = points[points.length - 1];
    if (
      Math.abs(first.longitude - last.longitude) < 1e-12 &&
      Math.abs(first.latitude - last.latitude) < 1e-12
    ) {
      points.pop();
    }
  }

  return points.length >= 3 ? points : null;
}

function calculateProjectedRingArea(ring, referenceLatitude) {
  const cosLatitude = Math.cos(referenceLatitude * DEGREES_TO_RADIANS);
  const originLongitude = ring[0].longitude;
  const originLatitude = ring[0].latitude;
  const points = ring.map((point) => ({
    x:
      EARTH_RADIUS_METERS *
      (point.longitude - originLongitude) *
      DEGREES_TO_RADIANS *
      cosLatitude,
    y:
      EARTH_RADIUS_METERS *
      (point.latitude - originLatitude) *
      DEGREES_TO_RADIANS,
  }));

  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }

  return Math.abs(twiceArea) / 2;
}

/**
 * Approximate the ground footprint in square metres using a local
 * equirectangular projection. The first ring is the exterior; following
 * rings are interior holes. Suitable for small building footprints, not
 * large geographic polygons or survey/legal area certification.
 */
export function calculateFootprintAreaM2(rings) {
  if (!Array.isArray(rings)) {
    throw new TypeError("Footprint rings must be an array.");
  }

  if (rings.length === 0) return null;

  const normalizedRings = rings.map(normalizeRing);
  if (normalizedRings.some((ring) => ring === null)) return null;

  const [outerRing, ...holeRings] = normalizedRings;
  const referenceLatitude =
    outerRing.reduce((sum, point) => sum + point.latitude, 0) /
    outerRing.length;

  const outerArea = calculateProjectedRingArea(
    outerRing,
    referenceLatitude,
  );
  const holeArea = holeRings.reduce(
    (sum, ring) => sum + calculateProjectedRingArea(ring, referenceLatitude),
    0,
  );
  const area = outerArea - holeArea;

  if (!Number.isFinite(area) || area <= 0) return null;
  return area;
}

export const SQUARE_METERS_TO_SQUARE_FEET = 10.76391041671;
