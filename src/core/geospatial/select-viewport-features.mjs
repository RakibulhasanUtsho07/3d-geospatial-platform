/**
 * Select a bounded set of features while retaining coverage across a viewport.
 *
 * Features are grouped by the cell containing each geometry's bounds center.
 * The selector then takes one candidate per cell per pass, preferring building
 * parts and buildings within each cell. Callers remain responsible for
 * providing the already viewport-matched candidate set.
 */
function isFiniteBounds(bounds) {
  return (
    bounds !== null &&
    typeof bounds === "object" &&
    Number.isFinite(bounds.west) &&
    Number.isFinite(bounds.south) &&
    Number.isFinite(bounds.east) &&
    Number.isFinite(bounds.north) &&
    bounds.west <= bounds.east &&
    bounds.south <= bounds.north
  );
}

export function selectViewportFeatures(
  features,
  viewport,
  limit,
  getFeatureBounds,
  getFeatureRole,
) {
  if (!Array.isArray(features)) {
    throw new TypeError("Features must be an array.");
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Feature limit must be a positive integer.");
  }

  if (
    !isFiniteBounds(viewport) ||
    viewport.west >= viewport.east ||
    viewport.south >= viewport.north
  ) {
    throw new RangeError("Viewport bounds must describe a finite area.");
  }

  if (typeof getFeatureBounds !== "function") {
    throw new TypeError("A feature-bounds accessor is required.");
  }

  if (typeof getFeatureRole !== "function") {
    throw new TypeError("A feature-role accessor is required.");
  }

  if (features.length <= limit) {
    return features;
  }

  const columns = Math.ceil(Math.sqrt(limit));
  const rows = Math.ceil(limit / columns);
  const cellWidth = (viewport.east - viewport.west) / columns;
  const cellHeight = (viewport.north - viewport.south) / rows;

  const buckets = new Map();

  for (const feature of features) {
    const bounds = getFeatureBounds(feature);

    if (!isFiniteBounds(bounds)) {
      continue;
    }

    const longitude = (bounds.west + bounds.east) / 2;
    const latitude = (bounds.south + bounds.north) / 2;

    // Intersecting footprints can have centers beyond the viewport edge.
    // Clamp those centers to the nearest edge cell instead of discarding them.
    const column = Math.max(
      0,
      Math.min(
        columns - 1,
        Math.floor((longitude - viewport.west) / cellWidth),
      ),
    );
    const row = Math.max(
      0,
      Math.min(
        rows - 1,
        Math.floor((latitude - viewport.south) / cellHeight),
      ),
    );

    const cellKey = row * columns + column;
    const cellCenterLongitude =
      viewport.west + (column + 0.5) * cellWidth;
    const cellCenterLatitude =
      viewport.south + (row + 0.5) * cellHeight;

    const role = getFeatureRole(feature);
    const priority =
      role === "building_part" ? 0 :
      role === "building" ? 1 :
      2;

    const longitudeDistance =
      (longitude - cellCenterLongitude) *
      Math.cos((cellCenterLatitude * Math.PI) / 180);
    const latitudeDistance = latitude - cellCenterLatitude;

    const candidate = {
      feature,
      priority,
      distance:
        longitudeDistance * longitudeDistance +
        latitudeDistance * latitudeDistance,
    };

    const bucket = buckets.get(cellKey);
    if (bucket) {
      bucket.push(candidate);
    } else {
      buckets.set(cellKey, [candidate]);
    }
  }

  const orderedBuckets = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bucket]) =>
      bucket.sort(
        (left, right) =>
          left.priority - right.priority ||
          left.distance - right.distance,
      ),
    );

  const selected = [];
  let depth = 0;

  while (selected.length < limit) {
    let foundCandidate = false;

    for (const bucket of orderedBuckets) {
      const candidate = bucket[depth];
      if (!candidate) continue;

      selected.push(candidate.feature);
      foundCandidate = true;

      if (selected.length >= limit) break;
    }

    if (!foundCandidate) break;
    depth += 1;
  }

  return selected;
}
