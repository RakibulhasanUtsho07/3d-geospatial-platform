/**
 * Resolve a building's vertical span and relative base offset while retaining provenance.
 *
 * Overture height is the vertical distance from the feature's lowest point
 * to its highest point. min_height is a separate above-ground bottom offset.
 * min_floor can be used as a proxy when min_height is absent; converting it
 * to metres assumes 3 m per floor and is therefore an estimate, not a measurement.
 * Floor-height conversion and the 9m fallback are rendering estimates, not
 * survey measurements. Safety caps are surfaced to the caller rather than
 * being silently represented as the original requested value.
 */
function getPositiveNumber(properties, keys) {
  for (const key of keys) {
    const value = properties[key];
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? (value.trim() === "" ? Number.NaN : Number(value.trim()))
          : Number.NaN;

    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }

  return null;
}

export function resolveBuildingHeight(properties) {
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    throw new TypeError("Building height properties must be an object.");
  }

  const height = getPositiveNumber(properties, [
    "height",
    "height_m",
    "heightMeters",
  ]);
  const reportedMinHeight = getPositiveNumber(properties, ["min_height", "minHeight"]);
  const rawMinFloor = getPositiveNumber(properties, ["min_floor", "minFloor"]);
  // Overture min_floor is an integer start-floor index. Do not accept fractional
  // values as floor indices; the metric conversion below is explicitly estimated.
  const reportedMinFloor = Number.isInteger(rawMinFloor) ? rawMinFloor : null;
  const baseHeightSource = reportedMinHeight !== null
    ? "overture-min-height"
    : reportedMinFloor !== null
      ? "min-floor-estimate"
      : "ground-zero-default";
  const unclampedBaseHeight = reportedMinHeight !== null
    ? reportedMinHeight
    : reportedMinFloor !== null
      ? reportedMinFloor * 3
      : 0;
  const baseHeight = Math.min(unclampedBaseHeight, 100);
  const baseHeightWasClamped = unclampedBaseHeight > 100;
  const baseHeightEstimated = baseHeightSource === "min-floor-estimate";

  function withBaseHeight(result) {
    return {
      ...result,
      baseHeight,
      baseHeightSource,
      baseHeightEstimated,
      reportedMinHeight,
      reportedMinFloor,
      unclampedBaseHeight,
      baseHeightWasClamped,
    };
  }

  if (height !== null) {
    return withBaseHeight({
      meters: Math.min(Math.max(height, 3), 300),
      source: "overture-height",
      unclampedMeters: height,
      heightWasClamped: height < 3 || height > 300,
    });
  }

  const floors = getPositiveNumber(properties, [
    "num_floors",
    "numFloors",
    "building:levels",
    "levels",
  ]);

  if (floors !== null) {
    const unclampedMeters = floors * 3;
    return withBaseHeight({
      meters: Math.min(Math.max(unclampedMeters, 3), 300),
      source: "floor-estimate",
      unclampedMeters,
      heightWasClamped: unclampedMeters < 3 || unclampedMeters > 300,
    });
  }

  return withBaseHeight({
    meters: 9,
    source: "fallback-estimate",
    unclampedMeters: 9,
    heightWasClamped: false,
  });
}