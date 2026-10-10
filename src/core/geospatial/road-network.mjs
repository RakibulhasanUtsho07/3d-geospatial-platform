const MIN_SPAN_DEGREES = 0.0005;
const MAX_SPAN_DEGREES = 0.05;
const MAX_ROAD_FEATURES = 1200;
const DEFAULT_ROAD_FEATURES = 900;
const EARTH_RADIUS_METERS = 6_371_008.8;

const ROAD_WIDTHS = Object.freeze({
  motorway: 11,
  trunk: 9,
  primary: 7.5,
  secondary: 6,
  tertiary: 4.8,
  unclassified: 3.8,
  residential: 3.5,
  living_street: 3,
  service: 2.6,
  pedestrian: 2.2,
  road: 3.5,
  footway: 1.3,
  cycleway: 1.6,
  path: 1.2,
  track: 2,
});

const INCLUDED_HIGHWAYS = Object.keys(ROAD_WIDTHS);
const SAFE_HIGHWAY = new Set(INCLUDED_HIGHWAYS);

function parseBound(params, name, min, max) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") {
    return { ok: false, error: name + " is required." };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    return { ok: false, error: name + " must be between " + min + " and " + max + "." };
  }
  return { ok: true, value };
}

function parseLimit(params) {
  const raw = params.get("limit");
  if (raw === null) return { ok: true, value: DEFAULT_ROAD_FEATURES };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 50 || value > MAX_ROAD_FEATURES) {
    return { ok: false, error: "limit must be a whole number between 50 and " + MAX_ROAD_FEATURES + "." };
  }
  return { ok: true, value };
}

export function parseRoadNetworkParams(params) {
  const west = parseBound(params, "west", 89, 92);
  if (!west.ok) return west;
  const south = parseBound(params, "south", 20, 27);
  if (!south.ok) return south;
  const east = parseBound(params, "east", 89, 92);
  if (!east.ok) return east;
  const north = parseBound(params, "north", 20, 27);
  if (!north.ok) return north;
  const limit = parseLimit(params);
  if (!limit.ok) return limit;

  if (west.value >= east.value || south.value >= north.value) {
    return { ok: false, error: "Bounds must satisfy west < east and south < north." };
  }
  const longitudeSpan = east.value - west.value;
  const latitudeSpan = north.value - south.value;
  if (longitudeSpan < MIN_SPAN_DEGREES || latitudeSpan < MIN_SPAN_DEGREES) {
    return { ok: false, error: "Viewport bounds are too small for a road query." };
  }
  if (longitudeSpan > MAX_SPAN_DEGREES || latitudeSpan > MAX_SPAN_DEGREES) {
    return { ok: false, error: "Road queries are limited to a viewport span of " + MAX_SPAN_DEGREES + " degrees. Zoom in to load detailed roads." };
  }
  return {
    ok: true,
    value: {
      west: west.value,
      south: south.value,
      east: east.value,
      north: north.value,
      limit: limit.value,
    },
  };
}

export function buildOverpassRoadQuery(request) {
  const highwayPattern = INCLUDED_HIGHWAYS.join("|");
  return [
    "[out:json][timeout:20][bbox:" + request.south + "," + request.west + "," + request.north + "," + request.east + "];",
    'way["highway"~"^(' + highwayPattern + ')$"];',
    "out body geom(" + request.south + "," + request.west + "," + request.north + "," + request.east + ") " + Math.min(request.limit ?? DEFAULT_ROAD_FEATURES, MAX_ROAD_FEATURES) + ";",
  ].join("\n");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function safeText(value, max = 180) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return normalized ? normalized.slice(0, max) : null;
}

function parseWidth(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(?:m|meter|meters)?$/i);
  if (!match) return null;
  const width = Number(match[1]);
  return Number.isFinite(width) && width >= 0.8 && width <= 60 ? width : null;
}

function parseLanes(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 1 && parsed <= 20 ? parsed : null;
}

function getRoadVisualWidth(tags) {
  const explicitWidth = parseWidth(tags.width);
  if (explicitWidth !== null) {
    return { widthMeters: Math.max(1, Math.min(explicitWidth, 24)), widthSource: "tagged" };
  }
  const highway = tags.highway;
  const lanes = parseLanes(tags.lanes);
  if (lanes !== null && lanes <= 8) {
    const inferred = lanes * (highway === "motorway" || highway === "trunk" ? 3.5 : 3);
    return { widthMeters: Math.max(1.2, Math.min(inferred, 24)), widthSource: "lanes-estimate" };
  }
  return {
    widthMeters: ROAD_WIDTHS[highway] ?? ROAD_WIDTHS.road,
    widthSource: "highway-class-estimate",
  };
}

function isValidCoordinate(point) {
  return isRecord(point)
    && finiteNumber(point.lon) !== null
    && finiteNumber(point.lat) !== null
    && point.lon >= -180 && point.lon <= 180
    && point.lat >= -90 && point.lat <= 90;
}

function roadClass(highway) {
  if (["motorway", "trunk", "primary"].includes(highway)) return "arterial";
  if (["secondary", "tertiary", "unclassified"].includes(highway)) return "collector";
  if (["residential", "living_street", "service", "road"].includes(highway)) return "local";
  return "path";
}

export function normalizeOverpassRoadElements(elements, request) {
  if (!Array.isArray(elements)) return [];
  const seen = new Set();
  const roads = [];

  for (const item of elements) {
    if (!isRecord(item) || item.type !== "way") continue;
    const id = finiteNumber(item.id);
    if (id === null || id < 1 || seen.has(String(id))) continue;
    seen.add(String(id));
    if (!isRecord(item.tags) || !SAFE_HIGHWAY.has(item.tags.highway)) continue;
    if (!Array.isArray(item.geometry) || item.geometry.length < 2) continue;

    const coordinates = [];
    for (const point of item.geometry) {
      if (!isValidCoordinate(point)) continue;
      coordinates.push([Number(point.lon), Number(point.lat)]);
    }
    if (coordinates.length < 2) continue;
    const hasViewportPoint = coordinates.some(([longitude, latitude]) =>
      longitude >= request.west - 0.002
      && longitude <= request.east + 0.002
      && latitude >= request.south - 0.002
      && latitude <= request.north + 0.002,
    );
    if (!hasViewportPoint) continue;

    const highway = item.tags.highway;
    const name = safeText(item.tags.name ?? item.tags["name:en"] ?? item.tags.ref, 140);
    const widthInfo = getRoadVisualWidth(item.tags);
    const layerValue = finiteNumber(item.tags.layer);
    roads.push({
      id: "osm-road-" + String(id),
      osmWayId: String(id),
      name,
      highway,
      roadClass: roadClass(highway),
      surface: safeText(item.tags.surface, 60),
      lanes: parseLanes(item.tags.lanes),
      maxSpeed: safeText(item.tags.maxspeed, 32),
      widthMeters: widthInfo.widthMeters,
      widthSource: widthInfo.widthSource,
      layer: layerValue !== null && layerValue >= -5 && layerValue <= 5 ? layerValue : null,
      bridge: item.tags.bridge === "yes",
      tunnel: item.tags.tunnel === "yes",
      oneway: item.tags.oneway === "yes" || item.tags.oneway === "1",
      coordinates,
      source: "OpenStreetMap via Overpass",
      license: "ODbL 1.0",
      attribution: "© OpenStreetMap contributors",
    });
    if (roads.length >= request.limit) break;
  }

  roads.sort((left, right) => {
    const rank = (road) => ({ arterial: 0, collector: 1, local: 2, path: 3 })[road.roadClass] ?? 4;
    return rank(left) - rank(right) || (left.name ?? "").localeCompare(right.name ?? "");
  });
  return roads;
}

export const ROAD_NETWORK_LIMITS = Object.freeze({
  minSpanDegrees: MIN_SPAN_DEGREES,
  maxSpanDegrees: MAX_SPAN_DEGREES,
  defaultLimit: DEFAULT_ROAD_FEATURES,
  maxLimit: MAX_ROAD_FEATURES,
});
