const SOURCE_KINDS = new Set(["text", "image", "video", "video-frame", "floor-plan", "cad", "bim", "survey", "map", "other"]);
const CONFIDENCE = new Set(["verified", "derived", "estimated", "ai-proposed", "unknown"]);
const ROOFS = new Set(["flat", "terrace", "pitched"]);
const EARTH_RADIUS_M = 6378137;

function obj(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(label + " must be an object");
  return value;
}
function num(value, label, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(label + " must be a finite number");
  if (value < min || value > max) throw new RangeError(label + " must be between " + min + " and " + max);
  return value;
}
function str(value, label, max = 240) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(label + " must be a non-empty string");
  if (value.trim().length > max) throw new RangeError(label + " must be at most " + max + " characters");
  return value.trim();
}
function id(value, label) {
  const result = str(value, label, 80);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(result)) throw new TypeError(label + " contains unsupported characters");
  return result;
}
function hex(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError(label + " must be a #RRGGBB colour");
  return value.toUpperCase();
}
export function coordinateToLocalMeters(point, origin) {
  const lat0 = origin.latitude * Math.PI / 180;
  return {
    x: (point[0] - origin.longitude) * Math.PI / 180 * EARTH_RADIUS_M * Math.cos(lat0),
    z: (point[1] - origin.latitude) * Math.PI / 180 * EARTH_RADIUS_M
  };
}
function sourcesOf(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("sources must be an array of at most 100 records");
  const seen = new Set();
  return value.map((raw, index) => {
    const s = obj(raw, "sources[" + index + "]");
    const sid = id(s.id === undefined ? "source-" + (index + 1) : s.id, "sources[" + index + "].id");
    if (seen.has(sid)) throw new TypeError("duplicate source id: " + sid);
    seen.add(sid);
    const kind = str(s.kind, "sources[" + index + "].kind", 40).toLowerCase();
    if (!SOURCE_KINDS.has(kind)) throw new TypeError("unsupported source kind '" + kind + "'");
    const out = { id: sid, kind, title: s.title === undefined ? kind : str(s.title, "source title"), usageStatus: s.usageStatus === undefined ? "unreviewed" : str(s.usageStatus, "usageStatus", 40) };
    if (s.url) {
      let url;
      try { url = new URL(str(s.url, "source URL", 2048)); } catch { throw new TypeError("source URL must be an absolute HTTPS URL"); }
      if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("source URL must be HTTPS without embedded credentials");
      out.url = url.toString();
    }
    if (s.assetId !== undefined) out.assetId = id(s.assetId, "assetId");
    for (const key of ["author", "licence", "attribution", "description", "capturedAt", "retrievedAt", "providerId"]) {
      if (s[key] !== undefined && s[key] !== null && s[key] !== "") out[key] = str(s[key], key, key === "description" ? 2000 : 500);
    }
    if (s.location !== undefined) {
      const location = obj(s.location, "source location");
      out.location = { longitude: num(location.longitude, "source longitude", -180, 180), latitude: num(location.latitude, "source latitude", -85, 85) };
      if (location.headingDegrees !== undefined) out.location.headingDegrees = num(location.headingDegrees, "headingDegrees", 0, 360);
    }
    return out;
  });
}
export function normalizeBuildingSpec(raw) {
  const input = obj(raw, "building spec");
  const schemaVersion = input.schemaVersion === undefined ? "1.0.0" : input.schemaVersion;
  if (schemaVersion !== "1.0.0") throw new TypeError("unsupported BuildingSpec schemaVersion '" + schemaVersion + "'");
  const buildingId = id(input.id, "id");
  const name = str(input.name, "name");
  const locRaw = input.location === undefined ? null : obj(input.location, "location");
  const requestedLoc = locRaw ? {
    longitude: num(locRaw.longitude, "location.longitude", -180, 180),
    latitude: num(locRaw.latitude, "location.latitude", -85, 85),
    heightM: locRaw.heightM === undefined ? 0 : num(locRaw.heightM, "location.heightM", -1000, 10000)
  } : null;
  const f = obj(input.footprint, "footprint");
  if (f.type !== "Polygon" || !Array.isArray(f.coordinates) || !Array.isArray(f.coordinates[0])) throw new TypeError("footprint must be a GeoJSON Polygon with an outer ring");
  if (f.coordinates.length !== 1) throw new TypeError("footprint holes are not yet supported");
  let ring = f.coordinates[0].map((p, i) => {
    if (!Array.isArray(p) || p.length < 2) throw new TypeError("footprint point " + i + " must be [longitude, latitude]");
    return [num(p[0], "footprint longitude", -180, 180), num(p[1], "footprint latitude", -85, 85)];
  });
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
  if (ring.length > 1 && same(ring[0], ring[ring.length - 1])) ring = ring.slice(0, -1);
  if (ring.length < 3 || new Set(ring.map(p => p[0].toFixed(8) + "," + p[1].toFixed(8))).size < 3) throw new RangeError("footprint needs at least three distinct points");
  const centroid = { longitude: ring.reduce((sum, p) => sum + p[0], 0) / ring.length, latitude: ring.reduce((sum, p) => sum + p[1], 0) / ring.length, heightM: 0 };
  const location = requestedLoc || centroid;
  const localFootprint = ring.map(p => coordinateToLocalMeters(p, location));
  const areaSigned = localFootprint.reduce((sum, p, i) => {
    const n = localFootprint[(i + 1) % localFootprint.length];
    return sum + p.x * n.z - n.x * p.z;
  }, 0) / 2;
  if (Math.abs(areaSigned) < 1) throw new RangeError("footprint area must be at least 1 square metre");
  const edges = localFootprint.map((p, i) => Math.hypot(localFootprint[(i + 1) % localFootprint.length].x - p.x, localFootprint[(i + 1) % localFootprint.length].z - p.z));
  if (edges.some(length => length < 0.25)) throw new RangeError("footprint contains an edge shorter than 0.25 metres");
  const dims = input.dimensions === undefined ? {} : obj(input.dimensions, "dimensions");
  const dimensions = {
    floorCount: dims.floorCount === undefined ? 1 : num(dims.floorCount, "floorCount", 1, 100),
    floorHeightM: dims.floorHeightM === undefined ? 3.1 : num(dims.floorHeightM, "floorHeightM", 2, 8),
    parapetHeightM: dims.parapetHeightM === undefined ? 0.8 : num(dims.parapetHeightM, "parapetHeightM", 0, 5),
    wallThicknessM: dims.wallThicknessM === undefined ? 0.22 : num(dims.wallThicknessM, "wallThicknessM", 0.08, 1)
  };
  if (!Number.isInteger(dimensions.floorCount)) throw new RangeError("floorCount must be an integer");
  const a = input.architecture === undefined ? {} : obj(input.architecture, "architecture");
  const roofType = (a.roofType || "flat").toLowerCase();
  if (!ROOFS.has(roofType)) throw new TypeError("unsupported roofType");
  const frontFacadeEdgeIndex = a.frontFacadeEdgeIndex === undefined
    ? undefined
    : num(a.frontFacadeEdgeIndex, "frontFacadeEdgeIndex", 0, ring.length - 1);
  if (frontFacadeEdgeIndex !== undefined && !Number.isInteger(frontFacadeEdgeIndex)) {
    throw new RangeError("frontFacadeEdgeIndex must be an integer matching an outer footprint edge index");
  }
  const balcony = a.balcony === undefined ? {} : obj(a.balcony, "balcony");
  const windows = a.windows === undefined ? {} : obj(a.windows, "windows");
  const bool = (value, fallback, label) => {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new TypeError(label + " must be boolean");
    return value;
  };
  const architecture = {
    style: a.style === undefined ? "dhaka-residential-modern" : str(a.style, "style", 80),
    roofType,
    ...(frontFacadeEdgeIndex === undefined ? {} : { frontFacadeEdgeIndex }),
    wallColor: hex(a.wallColor, "#D8D2C8", "wallColor"),
    roofColor: hex(a.roofColor, "#B5B8BC", "roofColor"),
    glassColor: hex(a.glassColor, "#536D86", "glassColor"),
    frameColor: hex(a.frameColor, "#F1F1EC", "frameColor"),
    concreteColor: hex(a.concreteColor, "#B8B7B1", "concreteColor"),
    doorColor: hex(a.doorColor, "#76533A", "doorColor"),
    includeDoor: bool(a.includeDoor, true, "includeDoor"),
    balcony: {
      enabled: bool(balcony.enabled, true, "balcony.enabled"),
      everyFloors: balcony.everyFloors === undefined ? 2 : num(balcony.everyFloors, "balcony.everyFloors", 1, 20),
      widthM: balcony.widthM === undefined ? 1.6 : num(balcony.widthM, "balcony.widthM", 0.6, 6),
      depthM: balcony.depthM === undefined ? 0.85 : num(balcony.depthM, "balcony.depthM", 0.2, 3)
    },
    windows: {
      enabled: bool(windows.enabled, true, "windows.enabled"),
      widthM: windows.widthM === undefined ? 1.15 : num(windows.widthM, "windows.widthM", 0.4, 3),
      heightM: windows.heightM === undefined ? 1.25 : num(windows.heightM, "windows.heightM", 0.4, 3)
    }
  };
  if (!Number.isInteger(architecture.balcony.everyFloors)) throw new RangeError("balcony.everyFloors must be an integer");
  const sources = sourcesOf(input.sources);
  const sourceIds = new Set(sources.map(s => s.id));
  const evidenceRaw = input.evidence === undefined ? [] : input.evidence;
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length > 300) throw new TypeError("evidence must be an array of at most 300 records");
  const evidence = evidenceRaw.map((rawEvidence, i) => {
    const e = obj(rawEvidence, "evidence[" + i + "]");
    const confidence = str(e.confidence, "evidence confidence", 40).toLowerCase();
    if (!CONFIDENCE.has(confidence)) throw new TypeError("unsupported confidence: " + confidence);
    const sourceIdsForEvidence = e.sourceIds === undefined ? [] : e.sourceIds;
    if (!Array.isArray(sourceIdsForEvidence)) throw new TypeError("evidence sourceIds must be an array");
    for (const sourceId of sourceIdsForEvidence) if (!sourceIds.has(sourceId)) throw new TypeError("evidence references unknown source '" + sourceId + "'");
    return { field: str(e.field, "evidence field", 120), value: e.value === undefined ? null : e.value, confidence, sourceIds: [...new Set(sourceIdsForEvidence)], ...(e.notes ? { notes: str(e.notes, "evidence notes", 1000) } : {}) };
  });
  const tags = input.tags === undefined ? [] : input.tags;
  if (!Array.isArray(tags)) throw new TypeError("tags must be an array");
  const xs = localFootprint.map(p => p.x), zs = localFootprint.map(p => p.z);
  const spec = {
    schemaVersion, id: buildingId, name,
    location: { longitude: location.longitude, latitude: location.latitude, heightM: location.heightM || 0 },
    footprint: {
      type: "Polygon", coordinates: [[...ring, ring[0]]],
      areaM2: Number(Math.abs(areaSigned).toFixed(2)),
      perimeterM: Number(edges.reduce((sum, length) => sum + length, 0).toFixed(2)),
      bounds: { minX: Number(Math.min(...xs).toFixed(3)), maxX: Number(Math.max(...xs).toFixed(3)), minZ: Number(Math.min(...zs).toFixed(3)), maxZ: Number(Math.max(...zs).toFixed(3)) }
    },
    dimensions, architecture, sources, evidence,
    tags: tags.slice(0, 30).map((tag, i) => str(tag, "tags[" + i + "]", 60))
  };
  return { spec, derived: { localFootprint, footprintAreaM2: Math.abs(areaSigned), perimeterM: edges.reduce((sum, length) => sum + length, 0) } };
}