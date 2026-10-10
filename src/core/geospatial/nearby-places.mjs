export const NEARBY_PLACE_CATEGORIES = Object.freeze({
  pharmacy: Object.freeze({ label: "Pharmacy", color: "#22c55e" }),
  hospital: Object.freeze({ label: "Hospital", color: "#ef4444" }),
  medical_center: Object.freeze({ label: "Clinic / medical centre", color: "#fb923c" }),
  supermarket: Object.freeze({ label: "Supermarket", color: "#38bdf8" }),
  market: Object.freeze({ label: "Market / bazar", color: "#c084fc" }),
});

const DEFAULT_RADIUS_METERS = 800;
const MIN_RADIUS_METERS = 100;
const MAX_RADIUS_METERS = 1500;
const DEFAULT_RESULT_LIMIT = 100;
const MAX_RESULT_LIMIT = 150;
const MAX_UPSTREAM_RESULT_LIMIT = 500;
const DEFAULT_CATEGORIES = Object.keys(NEARBY_PLACE_CATEGORIES);

const SELECTORS = Object.freeze({
  pharmacy: [
    ["amenity", "pharmacy"],
    ["shop", "chemist"],
  ],
  hospital: [
    ["amenity", "hospital"],
  ],
  medical_center: [
    ["amenity", "clinic"],
    ["amenity", "doctors"],
    ["amenity", "dentist"],
    ["healthcare", "clinic"],
    ["healthcare", "doctor"],
    ["healthcare", "dentist"],
  ],
  supermarket: [
    ["shop", "supermarket"],
  ],
  market: [
    ["amenity", "marketplace"],
    ["shop", "market"],
  ],
});

function isFiniteRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

export function parseNearbyPlacesParams(params) {
  const rawLatitude = params.get("lat");
  const rawLongitude = params.get("lon");

  if (rawLatitude === null || rawLongitude === null) {
    return {
      ok: false,
      error: "Latitude (lat) and longitude (lon) are required.",
    };
  }

  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);

  if (!isFiniteRange(latitude, -90, 90) || !isFiniteRange(longitude, -180, 180)) {
    return {
      ok: false,
      error: "Latitude must be between -90 and 90 and longitude between -180 and 180.",
    };
  }

  const rawRadius = params.get("radius");
  const radiusMeters = rawRadius === null
    ? DEFAULT_RADIUS_METERS
    : Number(rawRadius);

  if (
    !Number.isInteger(radiusMeters) ||
    !isFiniteRange(radiusMeters, MIN_RADIUS_METERS, MAX_RADIUS_METERS)
  ) {
    return {
      ok: false,
      error: "Radius must be a whole number between 100 and 1500 metres.",
    };
  }

  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? DEFAULT_RESULT_LIMIT : Number(rawLimit);
  if (
    !Number.isInteger(limit) ||
    !isFiniteRange(limit, 1, MAX_RESULT_LIMIT)
  ) {
    return {
      ok: false,
      error: "Result limit must be a whole number between 1 and 150.",
    };
  }

  const rawCategories = params.get("categories");
  const categories = rawCategories === null
    ? [...DEFAULT_CATEGORIES]
    : [...new Set(rawCategories.split(",").map((value) => value.trim()).filter(Boolean))];

  if (
    categories.length === 0 ||
    categories.some((category) => !Object.hasOwn(SELECTORS, category))
  ) {
    return {
      ok: false,
      error: "Choose at least one supported category: pharmacy, hospital, medical_center, supermarket, or market.",
    };
  }

  return {
    ok: true,
    value: {
      latitude,
      longitude,
      radiusMeters,
      categories,
      limit,
    },
  };
}

export function buildOverpassQuery(request) {
  const parsed = parseNearbyPlacesParams(new URLSearchParams({
    lat: String(request.latitude),
    lon: String(request.longitude),
    radius: String(request.radiusMeters),
    categories: request.categories.join(","),
    limit: String(request.limit),
  }));

  if (!parsed.ok) {
    throw new RangeError(parsed.error);
  }

  const selectors = parsed.value.categories.flatMap((category) =>
    SELECTORS[category].map(([key, value]) =>
      `nwr(around:${parsed.value.radiusMeters},${parsed.value.latitude},${parsed.value.longitude})["${key}"="${value}"];`,
    ),
  );

  // Keep the upstream result bounded; the local normalizer then keeps the nearest
  // unique results for this user's selected categories.
  const upstreamLimit = Math.min(
    MAX_UPSTREAM_RESULT_LIMIT,
    Math.max(parsed.value.limit * 3, 120),
  );

  return [
    "[out:json][timeout:20];",
    "(",
    ...selectors,
    ");",
    `out center tags ${upstreamLimit};`,
  ].join("\n");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTag(tags, key, maxLength = 180) {
  const value = tags[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function categoryFromTags(tags) {
  if (tags.amenity === "pharmacy" || tags.shop === "chemist") return "pharmacy";
  if (tags.amenity === "hospital") return "hospital";
  if (
    tags.amenity === "clinic" ||
    tags.amenity === "doctors" ||
    tags.amenity === "dentist" ||
    tags.healthcare === "clinic" ||
    tags.healthcare === "doctor" ||
    tags.healthcare === "dentist"
  ) return "medical_center";
  if (tags.shop === "supermarket") return "supermarket";
  if (tags.amenity === "marketplace" || tags.shop === "market") return "market";
  return null;
}

function haversineDistanceMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = Math.PI / 180;
  const deltaLatitude = (latitudeB - latitudeA) * radians;
  const deltaLongitude = (longitudeB - longitudeA) * radians;
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeA * radians) *
      Math.cos(latitudeB * radians) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function safeWebsite(tags) {
  for (const key of ["contact:website", "website"]) {
    const candidate = safeTag(tags, key, 240);
    if (!candidate) continue;

    try {
      // OSM tags are community-edited input. Never forward script/data schemes
      // into an href; allow bare hostnames by treating them as HTTPS URLs.
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(candidate);
      const url = new URL(hasScheme ? candidate : `https://${candidate}`);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        url.hostname
      ) {
        return url.toString();
      }
    } catch {
      // Ignore malformed link values and keep looking for a valid tag.
    }
  }

  return null;
}

function buildAddress(tags) {
  const parts = [
    safeTag(tags, "addr:street"),
    safeTag(tags, "addr:suburb") ?? safeTag(tags, "addr:place"),
    safeTag(tags, "addr:city") ?? safeTag(tags, "addr:district"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function normalizeOverpassElements(elements, request) {
  if (!Array.isArray(elements)) {
    throw new TypeError("Overpass response must contain an elements array.");
  }

  const requested = new Set(request.categories);
  const seen = new Set();
  const places = [];

  for (const element of elements) {
    if (
      !isRecord(element) ||
      !["node", "way", "relation"].includes(element.type) ||
      !Number.isSafeInteger(element.id) ||
      element.id < 1 ||
      !isRecord(element.tags)
    ) continue;

    const uniqueKey = `${element.type}/${element.id}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);

    const category = categoryFromTags(element.tags);
    if (!category || !requested.has(category)) continue;

    const latitude = typeof element.lat === "number"
      ? element.lat
      : isRecord(element.center) && typeof element.center.lat === "number"
        ? element.center.lat
        : Number.NaN;
    const longitude = typeof element.lon === "number"
      ? element.lon
      : isRecord(element.center) && typeof element.center.lon === "number"
        ? element.center.lon
        : Number.NaN;

    if (
      !isFiniteRange(latitude, -90, 90) ||
      !isFiniteRange(longitude, -180, 180)
    ) continue;

    const metadata = NEARBY_PLACE_CATEGORIES[category];
    const name =
      safeTag(element.tags, "name") ??
      safeTag(element.tags, "name:en") ??
      `Unnamed ${metadata.label.toLocaleLowerCase("en")}`;
    const osmType = element.type;
    const osmId = element.id;
    const address = buildAddress(element.tags);
    const distanceMeters = haversineDistanceMeters(
      request.latitude,
      request.longitude,
      latitude,
      longitude,
    );
    // Displayed distance is measured to the node/way centre. Keep the result
    // set consistent with the radius shown to the user.
    if (distanceMeters > request.radiusMeters) continue;

    const tags = {};

    for (const key of [
      "amenity",
      "shop",
      "healthcare",
      "operator",
      "addr:street",
      "addr:suburb",
      "addr:city",
      "opening_hours",
      "phone",
      "contact:phone",
      "website",
      "contact:website",
      "wheelchair",
    ]) {
      const value = safeTag(element.tags, key, 160);
      if (value) tags[key] = value;
    }

    places.push({
      id: `osm:${osmType}:${osmId}`,
      osmType,
      osmId,
      name,
      category,
      categoryLabel: metadata.label,
      latitude,
      longitude,
      distanceMeters: Math.round(distanceMeters),
      address,
      openingHours: safeTag(element.tags, "opening_hours"),
      phone: safeTag(element.tags, "contact:phone") ?? safeTag(element.tags, "phone"),
      website: safeWebsite(element.tags),
      operator: safeTag(element.tags, "operator"),
      tags,
      osmUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`,
    });
  }

  places.sort((left, right) =>
    left.distanceMeters - right.distanceMeters ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id),
  );

  return places.slice(0, request.limit);
}

export const NEARBY_PLACE_LIMITS = Object.freeze({
  defaultRadiusMeters: DEFAULT_RADIUS_METERS,
  minRadiusMeters: MIN_RADIUS_METERS,
  maxRadiusMeters: MAX_RADIUS_METERS,
  defaultResultLimit: DEFAULT_RESULT_LIMIT,
  maxResultLimit: MAX_RESULT_LIMIT,
});
