const MIN_RENDERED_HEIGHT_METERS = 3;
const MAX_RENDERED_HEIGHT_METERS = 300;

function getPositiveNumber(properties, key) {
  const value = properties[key];
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function firstPositiveNumber(properties, keys) {
  for (const key of keys) {
    const value = getPositiveNumber(properties, key);
    if (value !== null) return value;
  }
  return null;
}

function clampRenderedHeight(meters) {
  return Math.min(
    MAX_RENDERED_HEIGHT_METERS,
    Math.max(MIN_RENDERED_HEIGHT_METERS, meters),
  );
}

/**
 * Resolve the height that the details panel may truthfully call "Rendered".
 * The mapper's rendered_height_m is authoritative. The source attributes and
 * reference report are fallbacks only, and use the same safe height limits as
 * the Cesium renderer. Object insertion order must never override precedence.
 */
export function resolveRenderedHeightForDisplay(properties) {
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    throw new TypeError("Building display properties must be an object.");
  }

  const renderedHeight = getPositiveNumber(properties, "rendered_height_m");
  if (renderedHeight !== null) return clampRenderedHeight(renderedHeight);

  const reportedHeight = getPositiveNumber(
    properties,
    "architecture_profile_reported_height_m",
  );
  if (
    reportedHeight !== null &&
    reportedHeight >= MIN_RENDERED_HEIGHT_METERS &&
    reportedHeight <= MAX_RENDERED_HEIGHT_METERS
  ) {
    return reportedHeight;
  }

  const reportedFloors = getPositiveNumber(
    properties,
    "architecture_profile_reported_floor_count",
  );
  if (
    reportedFloors !== null &&
    Number.isInteger(reportedFloors) &&
    reportedFloors >= 1 &&
    reportedFloors <= 100
  ) {
    return clampRenderedHeight(reportedFloors * 3);
  }

  const sourceHeight = firstPositiveNumber(properties, [
    "height",
    "height_m",
    "heightMeters",
  ]);
  if (sourceHeight !== null) return clampRenderedHeight(sourceHeight);

  const sourceFloors = firstPositiveNumber(properties, [
    "num_floors",
    "numFloors",
    "building:levels",
    "levels",
  ]);
  if (sourceFloors !== null) {
    return clampRenderedHeight(sourceFloors * 3);
  }

  return null;
}
