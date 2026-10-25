import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_EXTRACT_BYTES = 256 * 1024 * 1024;
const MAX_ROADS = 500_000;
const ROAD_CLASSES = new Set(["arterial", "collector", "local", "path"]);
const WIDTH_SOURCES = new Set(["tagged", "lanes-estimate", "highway-class-estimate"]);
const VALIDATED = new WeakSet();
const BOUNDS_CACHE = new WeakMap();
const FILE_CACHE = new Map();

function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function number(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function validBounds(value) {
  return record(value)
    && number(value.west) !== null && value.west >= -180 && value.west <= 180
    && number(value.east) !== null && value.east >= -180 && value.east <= 180
    && number(value.south) !== null && value.south >= -90 && value.south <= 90
    && number(value.north) !== null && value.north >= -90 && value.north <= 90
    && value.west < value.east && value.south < value.north;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validCoordinate(pair) {
  return Array.isArray(pair) && pair.length >= 2
    && number(pair[0]) !== null && pair[0] >= -180 && pair[0] <= 180
    && number(pair[1]) !== null && pair[1] >= -90 && pair[1] <= 90;
}
function buildRoadBounds(roads) {
  return roads.map((road) => {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const point of road.coordinates) {
      west = Math.min(west, point[0]); south = Math.min(south, point[1]);
      east = Math.max(east, point[0]); north = Math.max(north, point[1]);
    }
    return { west, south, east, north };
  });
}
function validateRoad(road, index, ids) {
  if (!record(road)) throw new TypeError("Offline road at index " + index + " must be an object.");
  if (typeof road.id !== "string" || !road.id.trim() || road.id.length > 180) {
    throw new TypeError("Offline road at index " + index + " has an invalid id.");
  }
  if (ids.has(road.id)) throw new TypeError("Offline road extract has duplicate feature IDs.");
  ids.add(road.id);
  if (typeof road.osmWayId !== "string" || !road.osmWayId.trim() || road.osmWayId.length > 180) {
    throw new TypeError("Offline road " + road.id + " has an invalid OSM way ID.");
  }
  if (typeof road.highway !== "string" || !road.highway.trim() || road.highway.length > 60) {
    throw new TypeError("Offline road " + road.id + " has an invalid highway class.");
  }
  if (!ROAD_CLASSES.has(road.roadClass)) throw new TypeError("Offline road " + road.id + " has an unsupported road class.");
  if (number(road.widthMeters) === null || road.widthMeters < 0.8 || road.widthMeters > 60) {
    throw new TypeError("Offline road " + road.id + " has an invalid width.");
  }
  if (!WIDTH_SOURCES.has(road.widthSource)) throw new TypeError("Offline road " + road.id + " has an invalid width source.");
  if (!Array.isArray(road.coordinates) || road.coordinates.length < 2 || road.coordinates.length > 200_000
      || !road.coordinates.every(validCoordinate)) {
    throw new TypeError("Offline road " + road.id + " has invalid coordinate geometry.");
  }
  if (road.name !== null && (typeof road.name !== "string" || road.name.length > 180)) {
    throw new TypeError("Offline road " + road.id + " has an invalid name.");
  }
  return {
    ...road,
    source: "OpenStreetMap regional extract",
    license: "ODbL 1.0",
    attribution: "© OpenStreetMap contributors",
  };
}

export function validateOfflineRoadExtract(value) {
  if (!record(value) || value.schemaVersion !== 1) {
    throw new TypeError("Offline road extract must use schemaVersion 1.");
  }
  if (!validBounds(value.coverage)) throw new TypeError("Offline road extract has invalid coverage bounds.");
  if (!record(value.source)
      || typeof value.source.url !== "string"
      || typeof value.source.provider !== "string"
      || !validDate(value.source.extractDate)
      || value.source.license !== "ODbL 1.0"
      || typeof value.source.attribution !== "string"
      || !value.source.attribution.includes("OpenStreetMap contributors")) {
    throw new TypeError("Offline road extract source metadata must include HTTPS source, extract date, ODbL 1.0 and OpenStreetMap attribution.");
  }
  let sourceUrl;
  try { sourceUrl = new URL(value.source.url); }
  catch { throw new TypeError("Offline road extract source URL must be HTTPS."); }
  if (sourceUrl.protocol !== "https:") throw new TypeError("Offline road extract source URL must be HTTPS.");
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new TypeError("Offline road extract needs a generatedAt timestamp.");
  }
  if (!Array.isArray(value.roads) || value.roads.length < 1 || value.roads.length > MAX_ROADS) {
    throw new RangeError("Offline road extract must contain between 1 and " + MAX_ROADS + " roads.");
  }
  if (!Number.isSafeInteger(value.featureCount) || value.featureCount !== value.roads.length) {
    throw new TypeError("Offline road extract featureCount does not match roads.length.");
  }
  const ids = new Set();
  const roads = value.roads.map((road, index) => validateRoad(road, index, ids));
  const document = {
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    source: {
      provider: value.source.provider.slice(0, 120),
      url: sourceUrl.toString(),
      extractDate: value.source.extractDate,
      license: "ODbL 1.0",
      attribution: "© OpenStreetMap contributors",
      sourceSha256: typeof value.source.sourceSha256 === "string" && /^[a-f0-9]{64}$/i.test(value.source.sourceSha256)
        ? value.source.sourceSha256.toLowerCase() : null,
    },
    coverage: { west: value.coverage.west, south: value.coverage.south, east: value.coverage.east, north: value.coverage.north },
    featureCount: roads.length,
    roads,
  };
  VALIDATED.add(document);
  BOUNDS_CACHE.set(document, buildRoadBounds(roads));
  return document;
}

export async function loadOfflineRoadExtract(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("A non-empty local road extract path is required.");
  const resolved = path.resolve(filePath);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new TypeError("Offline road extract path must point to a regular file.");
  if (metadata.size < 2 || metadata.size > MAX_EXTRACT_BYTES) {
    throw new RangeError("Offline road extract file must be no larger than 256 MiB.");
  }
  const cached = FILE_CACHE.get(resolved);
  if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) return cached.document;
  let parsed;
  try { parsed = JSON.parse(await readFile(resolved, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("Offline road extract file contains invalid JSON.");
    throw error;
  }
  const document = validateOfflineRoadExtract(parsed);
  FILE_CACHE.delete(resolved);
  FILE_CACHE.set(resolved, { mtimeMs: metadata.mtimeMs, size: metadata.size, document });
  while (FILE_CACHE.size > 4) FILE_CACHE.delete(FILE_CACHE.keys().next().value);
  return document;
}

export function queryOfflineRoadExtract(value, request) {
  const extract = VALIDATED.has(value) ? value : validateOfflineRoadExtract(value);
  const coverage = extract.coverage;
  const covered = request.west >= coverage.west && request.south >= coverage.south
    && request.east <= coverage.east && request.north <= coverage.north;
  if (!covered) return { covered: false, roads: [], sourceDate: extract.source.extractDate, sourceUrl: extract.source.url };
  const bboxes = BOUNDS_CACHE.get(extract);
  const roads = [];
  for (let index = 0; index < extract.roads.length; index += 1) {
    const box = bboxes[index];
    if (box.east < request.west - 0.002 || box.west > request.east + 0.002
        || box.north < request.south - 0.002 || box.south > request.north + 0.002) continue;
    roads.push(extract.roads[index]);
    if (roads.length >= request.limit) break;
  }
  return { covered: true, roads, sourceDate: extract.source.extractDate, sourceUrl: extract.source.url };
}
export const OFFLINE_ROAD_EXTRACT_LIMITS = Object.freeze({ maxBytes: MAX_EXTRACT_BYTES, maxRoads: MAX_ROADS });
