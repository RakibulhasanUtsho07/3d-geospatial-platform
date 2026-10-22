/**
 * Resolve a building's rendered height while retaining source/estimate provenance.
 *
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
          ? Number.parseFloat(value)
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
  const minHeight =
    getPositiveNumber(properties, ["min_height", "minHeight"]) ?? 0;
  const baseHeight = Math.min(minHeight, 100);
  const baseHeightWasClamped = minHeight > 100;

  if (height !== null) {
    return {
      meters: Math.min(Math.max(height, 3), 300),
      baseHeight,
      source: "overture-height",
      unclampedMeters: height,
      heightWasClamped: height < 3 || height > 300,
      unclampedBaseHeight: minHeight,
      baseHeightWasClamped,
    };
  }

  const floors = getPositiveNumber(properties, [
    "num_floors",
    "numFloors",
    "building:levels",
    "levels",
  ]);

  if (floors !== null) {
    const unclampedMeters = floors * 3;
    return {
      meters: Math.min(Math.max(unclampedMeters, 3), 300),
      baseHeight,
      source: "floor-estimate",
      unclampedMeters,
      heightWasClamped: unclampedMeters < 3 || unclampedMeters > 300,
      unclampedBaseHeight: minHeight,
      baseHeightWasClamped,
    };
  }

  return {
    meters: 9,
    baseHeight,
    source: "fallback-estimate",
    unclampedMeters: 9,
    heightWasClamped: false,
    unclampedBaseHeight: minHeight,
    baseHeightWasClamped,
  };
}
