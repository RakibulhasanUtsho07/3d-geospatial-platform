const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en");
}

function collectSearchValues(value, output, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const text = String(value).trim();
    if (text) output.push(text.slice(0, 240));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) {
      collectSearchValues(item, output, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value).slice(0, 80)) {
    if (key.startsWith("_")) continue;
    output.push(key.replace(/[_:]+/g, " "));
    collectSearchValues(child, output, depth + 1);
  }
}

function getGeometryCenter(geometry) {
  if (!isRecord(geometry)) return null;

  const bounds = {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  };

  function visitCoordinates(value) {
    if (!Array.isArray(value)) return;

    if (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    ) {
      const longitude = value[0];
      const latitude = value[1];
      if (
        longitude < -180 || longitude > 180 ||
        latitude < -90 || latitude > 90
      ) return;

      bounds.west = Math.min(bounds.west, longitude);
      bounds.south = Math.min(bounds.south, latitude);
      bounds.east = Math.max(bounds.east, longitude);
      bounds.north = Math.max(bounds.north, latitude);
      return;
    }

    for (const child of value) visitCoordinates(child);
  }

  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) return null;
    for (const child of geometry.geometries) {
      const center = getGeometryCenter(child);
      if (!center) continue;
      bounds.west = Math.min(bounds.west, center.west);
      bounds.south = Math.min(bounds.south, center.south);
      bounds.east = Math.max(bounds.east, center.east);
      bounds.north = Math.max(bounds.north, center.north);
    }
  } else {
    visitCoordinates(geometry.coordinates);
  }

  if (
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.north)
  ) return null;

  return {
    longitude: (bounds.west + bounds.east) / 2,
    latitude: (bounds.south + bounds.north) / 2,
    ...bounds,
  };
}

function getStringProperty(properties, keys) {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function getPositiveNumber(properties, keys) {
  for (const key of keys) {
    const value = properties[key];
    const parsed = typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function getStableId(feature, properties, center, index, role) {
  const directId = [
    feature.id,
    properties.id,
    properties.feature_id,
    properties.featureId,
    properties.building_id,
    properties.overture_id,
  ].find((value) => (
    (typeof value === "string" && value.trim()) ||
    (typeof value === "number" && Number.isFinite(value))
  ));

  if (directId !== undefined) return String(directId);

  return [
    role,
    center.longitude.toFixed(6),
    center.latitude.toFixed(6),
    index,
  ].join(":");
}

function getDisplayName(properties, id) {
  const names = isRecord(properties.names) ? properties.names : {};
  return getStringProperty(names, ["primary", "common"]) ??
    getStringProperty(properties, [
      "display_name",
      "displayName",
      "name",
      "building_name",
      "buildingName",
    ]) ??
    "Unnamed building · " + id.slice(-8);
}

function getCategory(properties) {
  return getStringProperty(properties, [
    "subtype",
    "building_use",
    "class",
    "use",
    "building",
    "category",
  ]) ?? "Building";
}

/** Build an in-memory searchable summary index from a GeoJSON feature array. */
export function createBuildingSearchIndex(features) {
  if (!Array.isArray(features)) {
    throw new TypeError("Building search features must be an array.");
  }

  const index = [];

  features.forEach((feature, sourceIndex) => {
    if (!isRecord(feature) || feature.type !== "Feature") return;
    if (!isRecord(feature.geometry) || !isRecord(feature.properties)) return;

    const properties = feature.properties;
    const role = typeof properties._renderRole === "string"
      ? properties._renderRole
      : "building";
    const partCount = getPositiveNumber(properties, ["_renderPartCount"]) ?? 0;

    // Do not offer a hidden parent as a duplicate result when its parts render.
    if (role === "building_parent" && partCount > 0) return;

    const center = getGeometryCenter(feature.geometry);
    if (!center) return;

    const id = getStableId(feature, properties, center, sourceIndex, role);
    const sourceName = getStringProperty(
      isRecord(properties.names) ? properties.names : {},
      ["primary", "common"],
    ) ?? getStringProperty(properties, [
      "display_name",
      "displayName",
      "name",
      "building_name",
      "buildingName",
    ]);
    const name = getDisplayName(properties, id);
    const category = getCategory(properties);
    const searchableParts = [];
    collectSearchValues(properties, searchableParts);
    searchableParts.push(id, role, category);
    if (sourceName) searchableParts.push(sourceName);

    index.push({
      id,
      name,
      category,
      longitude: center.longitude,
      latitude: center.latitude,
      role,
      heightMeters: getPositiveNumber(properties, [
        "rendered_height_m",
        "height_m",
        "height",
        "rendered_height",
      ]),
      floors: getPositiveNumber(properties, [
        "num_floors",
        "numFloors",
        "building:levels",
        "levels",
      ]),
      searchableText: normalize(searchableParts.join(" ")),
      normalizedName: normalize(sourceName ?? ""),
    });
  });

  return index;
}

/** Search the prebuilt index and return only safe, compact map result fields. */
export function searchBuildingIndex(index, query, limit = DEFAULT_LIMIT) {
  if (!Array.isArray(index)) {
    throw new TypeError("Building search index must be an array.");
  }
  if (typeof query !== "string") {
    throw new TypeError("Building search query must be a string.");
  }

  const normalizedQuery = normalize(query);
  if (
    normalizedQuery.length < MIN_QUERY_LENGTH ||
    normalizedQuery.length > MAX_QUERY_LENGTH
  ) {
    throw new RangeError(
      "Building search query must contain between 2 and 100 characters.",
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError("Building search limit must be an integer between 1 and 20.");
  }

  const matches = index
    .filter((entry) => entry.searchableText.includes(normalizedQuery))
    .map((entry) => ({
      entry,
      score: entry.normalizedName === normalizedQuery
        ? 0
        : entry.normalizedName.startsWith(normalizedQuery)
          ? 1
          : entry.normalizedName.includes(normalizedQuery)
            ? 2
            : 3,
    }))
    .sort((left, right) =>
      left.score - right.score ||
      left.entry.name.localeCompare(right.entry.name) ||
      left.entry.id.localeCompare(right.entry.id),
    );

  return {
    totalMatches: matches.length,
    results: matches.slice(0, limit).map(({ entry }) => ({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      longitude: entry.longitude,
      latitude: entry.latitude,
      role: entry.role,
      heightMeters: entry.heightMeters,
      floors: entry.floors,
    })),
  };
}

export const BUILDING_SEARCH_LIMITS = Object.freeze({
  minQueryLength: MIN_QUERY_LENGTH,
  maxQueryLength: MAX_QUERY_LENGTH,
  defaultLimit: DEFAULT_LIMIT,
  maxLimit: MAX_LIMIT,
});
