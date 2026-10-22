/**
 * Resolve a building's rendered height while retaining a label that distinguishes
 * source-provided measurements from explicit estimates.
 *
 * The floor-height conversion and 9m fallback are rendering estimates, not
 * survey measurements. Dimensions are capped to keep invalid source values
 * from producing extreme geometry.
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

  if (height !== null) {
    return {
      meters: Math.min(Math.max(height, 3), 300),
      baseHeight: Math.min(minHeight, 100),
      source: "overture-height",
    };
  }

  const floors = getPositiveNumber(properties, [
    "num_floors",
    "numFloors",
    "building:levels",
    "levels",
  ]);

  if (floors !== null) {
    return {
      meters: Math.min(Math.max(floors * 3, 3), 300),
      baseHeight: Math.min(minHeight, 100),
      source: "floor-estimate",
    };
  }

  return {
    meters: 9,
    baseHeight: Math.min(minHeight, 100),
    source: "fallback-estimate",
  };
}
