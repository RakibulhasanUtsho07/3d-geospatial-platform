import { open, readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { selectViewportFeatures } from "../../../../../core/geospatial/select-viewport-features.mjs";

type JsonObject = Record<string, unknown>;

type GeoJsonFeatureCollection = JsonObject & {
  type: "FeatureCollection";
  features: unknown[];
};

type ViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type IndexedFeature = {
  feature: unknown;
  bounds: ViewportBounds | null;
};

type IndexedTileFeature = {
  feature: unknown;
  bounds: ViewportBounds | null;
  identity: string;
};

type CachedTileEntry = {
  signature: string;
  features: IndexedTileFeature[];
};

type CachedManifestEntry = {
  signature: string;
  manifest: TileManifest;
};

type TileCollectionRead = {
  features: IndexedTileFeature[];
  cacheHit: boolean;
};

type IndexedDataset = {
  collection: GeoJsonFeatureCollection;
  indexedFeatures: IndexedFeature[];
};

type TileManifestEntry = {
  id: string;
  file: string;
  indexFile: string;
  featureCount: number;
  bounds: ViewportBounds;
};

type TileFeatureIndexRecord = {
  identity: string;
  bounds: ViewportBounds;
  role: string;
  offset: number;
  length: number;
};

type ViewportFeatureCandidate = {
  identity: string;
  bounds: ViewportBounds;
  role: string;
  tileFile: string | null;
  record: TileFeatureIndexRecord | null;
  preloadedFeature?: unknown;
};

type CachedTileIndexEntry = {
  signature: string;
  dataSignature: string;
  records: TileFeatureIndexRecord[];
};

type TileIndexRead = {
  records: TileFeatureIndexRecord[];
  cacheHit: boolean;
  dataSignature: string;
  indexReadBytes: number;
};

type IndexedTileFeatureRead = {
  features: IndexedTileFeature[];
  bytesRead: number;
};

type TileManifest = {
  schemaVersion: 2;
  sourceFeatureCount: number;
  tileCount: number;
  oversizedFile: string | null;
  tiles: TileManifestEntry[];
};

type TileQueryResult = {
  features: unknown[];
  matchedFeatureCount: number;
  totalFeatureCount: number;
  tileCount: number;
  oversizedFeatureCount: number;
  candidateFeatureCount: number;
  fetchedFeatureCount: number;
  candidateBytes: number;
  indexReadBytes: number;
  featureReadBytes: number;
  tileCacheHits: number;
  geometryFeatureCacheHits: number;
  geometryFeatureCacheMisses: number;
};
type CachedSelectedGeometryFeature = {
  feature: unknown;
  byteLength: number;
};

type TileQueryTimings = {
  manifestLookupMs: number;
  tileIndexReadAndParseMs: number;
  candidateMetadataScanMs: number;
  oversizedSidecarReadMs: number;
  featureSelectionMs: number;
  selectedGeometryReadMs: number;
  geometryRangePlanningMs: number;
  geometryFileOpenMs: number;
  geometryRangeReadMs: number;
  geometryJsonParseMs: number;
  geometryIntegrityCheckMs: number;
  geometryFileCloseMs: number;
  featureAssemblyMs: number;
};

function createTileQueryTimings(): TileQueryTimings {
  return {
    manifestLookupMs: 0,
    tileIndexReadAndParseMs: 0,
    candidateMetadataScanMs: 0,
    oversizedSidecarReadMs: 0,
    featureSelectionMs: 0,
    selectedGeometryReadMs: 0,
    geometryRangePlanningMs: 0,
    geometryFileOpenMs: 0,
    geometryRangeReadMs: 0,
    geometryJsonParseMs: 0,
    geometryIntegrityCheckMs: 0,
    geometryFileCloseMs: 0,
    featureAssemblyMs: 0,
  };
}

function formatTimingMs(value: number): string {
  return Math.max(0, value).toFixed(3);
}

function getSelectedGeometryCacheKey(
  relativeFile: string,
  dataSignature: string,
  record: TileFeatureIndexRecord,
): string {
  return JSON.stringify([relativeFile, dataSignature, record.offset, record.length, record.identity]);
}

function getCachedSelectedGeometryFeature(key: string): unknown | undefined {
  const cached = selectedTileGeometryCache.get(key);
  if (!cached) return undefined;
  selectedTileGeometryCache.delete(key);
  selectedTileGeometryCache.set(key, cached);
  return cached.feature;
}

function cacheSelectedGeometryFeature(
  key: string,
  feature: unknown,
  record: TileFeatureIndexRecord,
): void {
  const byteLength = record.length;
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_SELECTED_GEOMETRY_CACHE_BYTES) {
    return;
  }
  const prior = selectedTileGeometryCache.get(key);
  if (prior) {
    selectedGeometryCacheBytes -= prior.byteLength;
    selectedTileGeometryCache.delete(key);
  }
  selectedTileGeometryCache.set(key, { feature, byteLength });
  selectedGeometryCacheBytes += byteLength;
  while (
    selectedGeometryCacheBytes > MAX_SELECTED_GEOMETRY_CACHE_BYTES ||
    selectedTileGeometryCache.size > MAX_SELECTED_GEOMETRY_CACHE_ENTRIES
  ) {
    const oldestKey = selectedTileGeometryCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    const oldest = selectedTileGeometryCache.get(oldestKey);
    if (oldest) selectedGeometryCacheBytes -= oldest.byteLength;
    selectedTileGeometryCache.delete(oldestKey);
  }
}


const DATA_FILE = resolve(
  process.cwd(),
  "data",
  "overture",
  "dhaka-buildings-3d-pilot.geojson",
);

const DATA_FILE_RELATIVE =
  "data/overture/dhaka-buildings-3d-pilot.geojson";
const TILE_DIRECTORY = resolve(
  process.cwd(),
  "data",
  "overture",
  "spatial-tiles",
);
const TILE_MANIFEST_FILE = resolve(TILE_DIRECTORY, "manifest.json");
const MAX_VIEWPORT_SPAN_DEGREES = 2;
const DEFAULT_VIEWPORT_FEATURE_LIMIT = 2500;
const MAX_VIEWPORT_FEATURE_LIMIT = 5000;
const MAX_CACHED_TILE_FILES = 64;
const MAX_SELECTED_GEOMETRY_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_SELECTED_GEOMETRY_CACHE_ENTRIES = 6000;

let indexedDatasetPromise: Promise<IndexedDataset> | null = null;
let cachedTileManifest: CachedManifestEntry | null = null;

// Parsed tiles retain precomputed bounds and identities between viewport requests.
const tileFeatureCache = new Map<string, CachedTileEntry>();
// Keep compact byte-offset indexes in memory; geometry payloads are read only
// for features whose indexed bounds intersect the requested viewport.
const tileFeatureIndexCache = new Map<string, CachedTileIndexEntry>();
// Only retain selected features after their JSON, bounds and render role have
// passed the existing index-integrity checks. Signatures in each key prevent
// stale geometry from being reused when a tile file changes.
const selectedTileGeometryCache = new Map<string, CachedSelectedGeometryFeature>();
let selectedGeometryCacheBytes = 0;
const MAX_TILE_READ_GAP_BYTES = 2 * 1024;
const MAX_TILE_READ_WINDOW_BYTES = 64 * 1024;

function isRecord(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isFeatureCollection(
  value: unknown,
): value is GeoJsonFeatureCollection {
  if (!isRecord(value) || value.type !== "FeatureCollection") {
    return false;
  }

  if (!Array.isArray(value.features)) {
    return false;
  }

  return value.features.every((feature: unknown) => {
    if (!isRecord(feature) || feature.type !== "Feature") {
      return false;
    }

    if (!isRecord(feature.geometry)) {
      return false;
    }

    return typeof feature.geometry.type === "string";
  });
}

function mergeBounds(
  boundsList: Array<ViewportBounds | null>,
): ViewportBounds | null {
  const validBounds = boundsList.filter(
    (bounds): bounds is ViewportBounds => bounds !== null,
  );
  const firstBounds = validBounds[0];

  if (!firstBounds) return null;

  return validBounds.slice(1).reduce(
    (merged, bounds) => ({
      west: Math.min(merged.west, bounds.west),
      south: Math.min(merged.south, bounds.south),
      east: Math.max(merged.east, bounds.east),
      north: Math.max(merged.north, bounds.north),
    }),
    { ...firstBounds },
  );
}

function getGeometryBounds(geometry: unknown): ViewportBounds | null {
  if (!isRecord(geometry)) return null;

  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) return null;
    return mergeBounds(geometry.geometries.map(getGeometryBounds));
  }

  return getCoordinateBounds(geometry.coordinates);
}

function getFeatureBounds(feature: unknown): ViewportBounds | null {
  if (!isRecord(feature) || !isRecord(feature.geometry)) return null;
  return getGeometryBounds(feature.geometry);
}

function getCoordinateBounds(coordinates: unknown): ViewportBounds | null {
  const bounds: ViewportBounds = {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  };

  function visit(value: unknown): void {
    if (!Array.isArray(value)) {
      return;
    }

    // A GeoJSON position starts with longitude and latitude numbers.
    if (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    ) {
      const longitude = value[0];
      const latitude = value[1];

      bounds.west = Math.min(bounds.west, longitude);
      bounds.south = Math.min(bounds.south, latitude);
      bounds.east = Math.max(bounds.east, longitude);
      bounds.north = Math.max(bounds.north, latitude);
      return;
    }

    for (const child of value) {
      visit(child);
    }
  }

  visit(coordinates);

  if (
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.north)
  ) {
    return null;
  }

  return bounds;
}

async function readAndIndexDataset(): Promise<IndexedDataset> {
  const rawContents = await readFile(DATA_FILE, "utf8");
  let parsedData: unknown;

  try {
    parsedData = JSON.parse(rawContents);
  } catch {
    throw new Error("The Overture pilot dataset contains invalid JSON.");
  }

  if (!isFeatureCollection(parsedData)) {
    throw new Error(
      "The Overture pilot file is not a valid GeoJSON FeatureCollection.",
    );
  }

  const indexedFeatures = parsedData.features.map((feature) => ({
    feature,
    bounds: getFeatureBounds(feature),
  }));

  console.info("[Overture Viewport API] Spatial index ready.", {
    totalFeatures: indexedFeatures.length,
    indexedFeatures: indexedFeatures.filter((item) => item.bounds !== null).length,
  });

  return {
    collection: parsedData,
    indexedFeatures,
  };
}

function getIndexedDataset(): Promise<IndexedDataset> {
  if (!indexedDatasetPromise) {
    indexedDatasetPromise = readAndIndexDataset().catch((error: unknown) => {
      // Allow a later request to retry when a file read or validation fails.
      indexedDatasetPromise = null;
      throw error;
    });
  }

  return indexedDatasetPromise;
}

function parseViewportBounds(
  requestUrl: URL,
): { bounds: ViewportBounds } | { error: string } {
  const keys = ["west", "south", "east", "north"] as const;
  const values = keys.map((key) => requestUrl.searchParams.get(key));

  if (values.some((value) => value === null || value.trim() === "")) {
    return {
      error:
        "Provide west, south, east, and north query parameters for the viewport.",
    };
  }

  const [westValue, southValue, eastValue, northValue] = values;
  const bounds = {
    west: Number(westValue),
    south: Number(southValue),
    east: Number(eastValue),
    north: Number(northValue),
  };

  if (Object.values(bounds).some((value) => !Number.isFinite(value))) {
    return { error: "Viewport bounds must be finite numbers." };
  }

  if (
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -85 ||
    bounds.north > 85 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north
  ) {
    return { error: "Viewport bounds are outside the supported range." };
  }

  if (
    bounds.east - bounds.west > MAX_VIEWPORT_SPAN_DEGREES ||
    bounds.north - bounds.south > MAX_VIEWPORT_SPAN_DEGREES
  ) {
    return {
      error:
        `Viewport spans cannot exceed ${MAX_VIEWPORT_SPAN_DEGREES} degrees. Use the standard Overture endpoint for a full-dataset request.`,
    };
  }

  return { bounds };
}

function parseFeatureLimit(
  requestUrl: URL,
): { limit: number } | { error: string } {
  const rawLimit = requestUrl.searchParams.get("limit");

  if (rawLimit === null) {
    return { limit: DEFAULT_VIEWPORT_FEATURE_LIMIT };
  }

  const limit = Number(rawLimit);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_VIEWPORT_FEATURE_LIMIT
  ) {
    return {
      error: `Feature limit must be an integer between 1 and ${MAX_VIEWPORT_FEATURE_LIMIT}.`,
    };
  }

  return { limit };
}

function intersects(
  featureBounds: ViewportBounds,
  viewport: ViewportBounds,
): boolean {
  return (
    featureBounds.west <= viewport.east &&
    featureBounds.east >= viewport.west &&
    featureBounds.south <= viewport.north &&
    featureBounds.north >= viewport.south
  );
}


function isValidTileManifest(value: unknown): value is TileManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    typeof value.sourceFeatureCount !== "number" ||
    !Number.isInteger(value.sourceFeatureCount) ||
    value.sourceFeatureCount < 0 ||
    typeof value.tileCount !== "number" ||
    !Number.isInteger(value.tileCount) ||
    !Array.isArray(value.tiles) ||
    value.tileCount !== value.tiles.length ||
    !(value.oversizedFile === null || value.oversizedFile === "oversized.geojson")
  ) {
    return false;
  }

  return value.tiles.every((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.bounds)) return false;

    const bounds = entry.bounds;
    const validBounds =
      ["west", "south", "east", "north"].every(
        (key) =>
          typeof bounds[key] === "number" &&
          Number.isFinite(bounds[key]),
      ) &&
      typeof bounds.west === "number" &&
      typeof bounds.south === "number" &&
      typeof bounds.east === "number" &&
      typeof bounds.north === "number" &&
      bounds.west >= -180 &&
      bounds.east <= 180 &&
      bounds.south >= -90 &&
      bounds.north <= 90 &&
      bounds.west < bounds.east &&
      bounds.south < bounds.north;

    return (
      typeof entry.id === "string" &&
      /^x\d+_y\d+$/.test(entry.id) &&
      entry.file === "tiles/" + entry.id + ".geojson" &&
      entry.indexFile === "tiles/" + entry.id + ".geojson.index.json" &&
      typeof entry.featureCount === "number" &&
      Number.isInteger(entry.featureCount) &&
      entry.featureCount >= 0 &&
      validBounds
    );
  });
}


function isValidTileFeatureIndex(
  value: unknown,
  expectedTileId: string,
  expectedFeatureCount: number,
): value is { schemaVersion: 2; tileId: string; featureCount: number; records: TileFeatureIndexRecord[] } {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.tileId !== expectedTileId ||
    value.featureCount !== expectedFeatureCount ||
    !Array.isArray(value.records) ||
    value.records.length !== expectedFeatureCount
  ) {
    return false;
  }

  let previousEnd = -1;
  for (const item of value.records) {
    if (!isRecord(item) || !isRecord(item.bounds)) return false;
    const bounds = item.bounds;
    const validBounds =
      ["west", "south", "east", "north"].every(
        (key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]),
      ) &&
      typeof bounds.west === "number" &&
      typeof bounds.south === "number" &&
      typeof bounds.east === "number" &&
      typeof bounds.north === "number" &&
      bounds.west >= -180 &&
      bounds.east <= 180 &&
      bounds.south >= -90 &&
      bounds.north <= 90 &&
      bounds.west <= bounds.east &&
      bounds.south <= bounds.north;

    if (
      typeof item.identity !== "string" ||
      item.identity.length === 0 ||
      typeof item.role !== "string" ||
      !Number.isInteger(item.offset) ||
      (item.offset as number) < 0 ||
      !Number.isInteger(item.length) ||
      (item.length as number) < 1 ||
      !validBounds ||
      (item.offset as number) < previousEnd
    ) {
      return false;
    }

    previousEnd = (item.offset as number) + (item.length as number);
  }

  return true;
}

function getSignatureSize(signature: string): number {
  const size = Number.parseInt(signature.split(":")[0] ?? "", 10);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

function getFeatureIdentity(feature: unknown): string {
  if (!isRecord(feature)) {
    return JSON.stringify(feature);
  }

  if (feature.id !== undefined && feature.id !== null) {
    return "feature-id:" + String(feature.id);
  }

  const properties = isRecord(feature.properties) ? feature.properties : {};
  for (const key of [
    "id",
    "feature_id",
    "featureId",
    "building_id",
    "overture_id",
  ]) {
    const value = properties[key];
    if (typeof value === "string" || typeof value === "number") {
      return "property-id:" + String(value);
    }
  }

  return "feature-json:" + JSON.stringify(feature);
}

function getErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}

async function getFileSignature(filePath: string): Promise<string | null> {
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) return null;
    return fileInfo.size + ":" + fileInfo.mtimeMs;
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readCachedTileManifest(): Promise<TileManifest | null> {
  const signature = await getFileSignature(TILE_MANIFEST_FILE);
  if (signature === null) {
    cachedTileManifest = null;
    return null;
  }

  if (cachedTileManifest?.signature === signature) {
    return cachedTileManifest.manifest;
  }

  let contents: string;
  try {
    contents = await readFile(TILE_MANIFEST_FILE, "utf8");
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    console.warn(
      "[Overture Viewport API] Tile manifest is invalid JSON; using GeoJSON index.",
    );
    return null;
  }

  if (!isValidTileManifest(parsed)) {
    console.warn(
      "[Overture Viewport API] Tile manifest schema is invalid; using GeoJSON index.",
    );
    return null;
  }

  cachedTileManifest = { signature, manifest: parsed };
  return parsed;
}

async function readCachedTileCollection(
  relativeFile: string,
): Promise<TileCollectionRead | null> {
  // Accept only generated filenames; never use arbitrary manifest paths.
  if (
    relativeFile !== "oversized.geojson" &&
    !/^tiles\/x\d+_y\d+\.geojson$/.test(relativeFile)
  ) {
    return null;
  }

  const absolutePath = resolve(TILE_DIRECTORY, relativeFile);
  const signature = await getFileSignature(absolutePath);
  if (signature === null) {
    tileFeatureCache.delete(relativeFile);
    return null;
  }

  const cached = tileFeatureCache.get(relativeFile);
  if (cached?.signature === signature) {
    // Refresh insertion order so the Map can act as a small LRU cache.
    tileFeatureCache.delete(relativeFile);
    tileFeatureCache.set(relativeFile, cached);
    return { features: cached.features, cacheHit: true };
  }

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isFeatureCollection(parsed)) return null;

  const indexedFeatures: IndexedTileFeature[] = parsed.features.map((feature) => ({
    feature,
    bounds: getFeatureBounds(feature),
    identity: getFeatureIdentity(feature),
  }));

  tileFeatureCache.delete(relativeFile);
  tileFeatureCache.set(relativeFile, {
    signature,
    features: indexedFeatures,
  });

  while (tileFeatureCache.size > MAX_CACHED_TILE_FILES) {
    const oldestPath = tileFeatureCache.keys().next().value;
    if (typeof oldestPath !== "string") break;
    tileFeatureCache.delete(oldestPath);
  }

  return { features: indexedFeatures, cacheHit: false };
}


async function readCachedTileIndex(
  tile: TileManifestEntry,
): Promise<TileIndexRead | null> {
  // Paths are derived from validated manifest ids, never trusted as arbitrary paths.
  if (
    !/^tiles\/x\d+_y\d+\.geojson$/.test(tile.file) ||
    tile.indexFile !== "tiles/" + tile.id + ".geojson.index.json"
  ) {
    return null;
  }

  const dataPath = resolve(TILE_DIRECTORY, tile.file);
  const indexPath = resolve(TILE_DIRECTORY, tile.indexFile);
  const [dataSignature, indexSignature] = await Promise.all([
    getFileSignature(dataPath),
    getFileSignature(indexPath),
  ]);

  if (dataSignature === null || indexSignature === null) {
    tileFeatureIndexCache.delete(tile.file);
    return null;
  }

  const cached = tileFeatureIndexCache.get(tile.file);
  if (
    cached?.signature === indexSignature &&
    cached.dataSignature === dataSignature
  ) {
    tileFeatureIndexCache.delete(tile.file);
    tileFeatureIndexCache.set(tile.file, cached);
    return {
      records: cached.records,
      cacheHit: true,
      dataSignature,
      indexReadBytes: 0,
    };
  }

  let rawIndex: string;
  try {
    rawIndex = await readFile(indexPath, "utf8");
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  }

  let parsedIndex: unknown;
  try {
    parsedIndex = JSON.parse(rawIndex);
  } catch {
    return null;
  }

  if (!isValidTileFeatureIndex(parsedIndex, tile.id, tile.featureCount)) {
    return null;
  }

  const fileSize = getSignatureSize(dataSignature);
  if (
    parsedIndex.records.some(
      (record) => record.offset + record.length > fileSize,
    )
  ) {
    return null;
  }

  const cachedEntry: CachedTileIndexEntry = {
    signature: indexSignature,
    dataSignature,
    records: parsedIndex.records,
  };
  tileFeatureIndexCache.delete(tile.file);
  tileFeatureIndexCache.set(tile.file, cachedEntry);

  while (tileFeatureIndexCache.size > MAX_CACHED_TILE_FILES) {
    const oldestPath = tileFeatureIndexCache.keys().next().value;
    if (typeof oldestPath !== "string") break;
    tileFeatureIndexCache.delete(oldestPath);
  }

  return {
    records: cachedEntry.records,
    cacheHit: false,
    dataSignature,
    indexReadBytes: Buffer.byteLength(rawIndex, "utf8"),
  };
}

async function readSelectedTileFeatures(
  relativeFile: string,
  records: TileFeatureIndexRecord[],
  timings: TileQueryTimings,
  dataSignature: string,
  cacheStats: { hits: number; misses: number },
): Promise<IndexedTileFeatureRead | null> {
  if (!/^tiles\/x\d+_y\d+\.geojson$/.test(relativeFile)) {
    return null;
  }
  if (records.length === 0) return { features: [], bytesRead: 0 };

  const featuresByIdentity = new Map<string, IndexedTileFeature>();
  const recordsToRead: TileFeatureIndexRecord[] = [];
  for (const record of records) {
    const cachedFeature = getCachedSelectedGeometryFeature(
      getSelectedGeometryCacheKey(relativeFile, dataSignature, record),
    );
    if (cachedFeature === undefined) {
      cacheStats.misses += 1;
      recordsToRead.push(record);
    } else {
      cacheStats.hits += 1;
      featuresByIdentity.set(record.identity, {
        feature: cachedFeature,
        bounds: record.bounds,
        identity: record.identity,
      });
    }
  }

  if (recordsToRead.length === 0) {
    return {
      features: records.map((record) => featuresByIdentity.get(record.identity)!),
      bytesRead: 0,
    };
  }

  let handle: Awaited<ReturnType<typeof open>>;
  const fileOpenStartedAt = performance.now();
  try {
    handle = await open(resolve(TILE_DIRECTORY, relativeFile), "r");
  } catch (error: unknown) {
    timings.geometryFileOpenMs += performance.now() - fileOpenStartedAt;
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  timings.geometryFileOpenMs += performance.now() - fileOpenStartedAt;

  let bytesRead = 0;
  try {
    const rangePlanningStartedAt = performance.now();
    const orderedRecords = [...recordsToRead].sort((left, right) => left.offset - right.offset);
    const ranges: Array<{ start: number; end: number; records: TileFeatureIndexRecord[] }> = [];

    for (const record of orderedRecords) {
      const recordEnd = record.offset + record.length;
      const previous = ranges[ranges.length - 1];
      const gap = previous ? record.offset - previous.end : Number.POSITIVE_INFINITY;
      const combinedSize = previous ? Math.max(previous.end, recordEnd) - previous.start : 0;

      if (
        previous &&
        gap <= MAX_TILE_READ_GAP_BYTES &&
        combinedSize <= MAX_TILE_READ_WINDOW_BYTES
      ) {
        previous.end = Math.max(previous.end, recordEnd);
        previous.records.push(record);
      } else {
        ranges.push({ start: record.offset, end: recordEnd, records: [record] });
      }
    }
    timings.geometryRangePlanningMs += performance.now() - rangePlanningStartedAt;

    for (const range of ranges) {
      const rangeReadStartedAt = performance.now();
      const rangeBuffer = Buffer.alloc(range.end - range.start);
      let bytesReadForRange = 0;
      try {
        while (bytesReadForRange < rangeBuffer.length) {
          const result = await handle.read(
            rangeBuffer,
            bytesReadForRange,
            rangeBuffer.length - bytesReadForRange,
            range.start + bytesReadForRange,
          );
          if (result.bytesRead === 0) return null;
          bytesReadForRange += result.bytesRead;
        }
      } finally {
        timings.geometryRangeReadMs += performance.now() - rangeReadStartedAt;
      }
      bytesRead += rangeBuffer.length;

      for (const record of range.records) {
        const localStart = record.offset - range.start;
        const featureBytes = rangeBuffer.subarray(localStart, localStart + record.length);
        let feature: unknown;
        const jsonParseStartedAt = performance.now();
        try {
          feature = JSON.parse(featureBytes.toString("utf8"));
        } catch {
          timings.geometryJsonParseMs += performance.now() - jsonParseStartedAt;
          return null;
        }
        timings.geometryJsonParseMs += performance.now() - jsonParseStartedAt;

        const integrityCheckStartedAt = performance.now();
        if (!isRecord(feature) || feature.type !== "Feature" || !isRecord(feature.geometry)) {
          timings.geometryIntegrityCheckMs += performance.now() - integrityCheckStartedAt;
          return null;
        }

        const actualBounds = getFeatureBounds(feature);
        const properties = isRecord(feature.properties) ? feature.properties : {};
        const actualRole =
          typeof properties._renderRole === "string"
            ? properties._renderRole
            : "unknown";
        if (
          !actualBounds ||
          Math.abs(actualBounds.west - record.bounds.west) > 1e-9 ||
          Math.abs(actualBounds.south - record.bounds.south) > 1e-9 ||
          Math.abs(actualBounds.east - record.bounds.east) > 1e-9 ||
          Math.abs(actualBounds.north - record.bounds.north) > 1e-9 ||
          actualRole !== record.role
        ) {
          // A stale/mismatched index must never silently narrow bounds or change sampling priority.
          timings.geometryIntegrityCheckMs += performance.now() - integrityCheckStartedAt;
          return null;
        }
        timings.geometryIntegrityCheckMs += performance.now() - integrityCheckStartedAt;

        featuresByIdentity.set(record.identity, {
          feature,
          bounds: record.bounds,
          identity: record.identity,
        });
        cacheSelectedGeometryFeature(
          getSelectedGeometryCacheKey(relativeFile, dataSignature, record),
          feature,
          record,
        );
      }
    }

    return {
      features: records.map((record) => featuresByIdentity.get(record.identity)!),
      bytesRead,
    };
  } finally {
    const fileCloseStartedAt = performance.now();
    try {
      await handle.close();
    } finally {
      timings.geometryFileCloseMs += performance.now() - fileCloseStartedAt;
    }
  }
}

async function queryGeneratedTiles(
  viewport: ViewportBounds,
  featureLimit: number,
  timings: TileQueryTimings,
): Promise<TileQueryResult | null> {
  const manifestStartedAt = performance.now();
  const manifest = await readCachedTileManifest();
  timings.manifestLookupMs += performance.now() - manifestStartedAt;
  if (!manifest) return null;
  const tileFilterStartedAt = performance.now();
  const selectedTiles = manifest.tiles.filter((tile) => intersects(tile.bounds, viewport));
  timings.candidateMetadataScanMs += performance.now() - tileFilterStartedAt;
  const candidateMap = new Map<string, ViewportFeatureCandidate>();
  let oversizedFeatureCount = 0;
  let candidateFeatureCount = 0;
  let fetchedFeatureCount = 0;
  let candidateBytes = 0;
  let indexReadBytes = 0;
  let featureReadBytes = 0;
  let tileCacheHits = 0;

  const tileDataSignatures = new Map<string, string>();
  for (const tile of selectedTiles) {
    const tileIndexStartedAt = performance.now();
    const tileIndex = await readCachedTileIndex(tile);
    timings.tileIndexReadAndParseMs += performance.now() - tileIndexStartedAt;
    if (!tileIndex) {
      console.warn("[Overture Viewport API] Generated tile or feature index is missing or invalid; falling back to GeoJSON index.", { tile: tile.id });
      return null;
    }
    candidateFeatureCount += tileIndex.records.length;
    tileDataSignatures.set(tile.file, tileIndex.dataSignature);
    candidateBytes += getSignatureSize(tileIndex.dataSignature);
    indexReadBytes += tileIndex.indexReadBytes;
    if (tileIndex.cacheHit) tileCacheHits += 1;

    // Preserve tile and index order, but sample on metadata before deserializing payloads.
    const candidateScanStartedAt = performance.now();
    for (const record of tileIndex.records) {
      if (!intersects(record.bounds, viewport) || candidateMap.has(record.identity)) continue;
      candidateMap.set(record.identity, {
        identity: record.identity,
        bounds: record.bounds,
        role: record.role,
        tileFile: tile.file,
        record,
      });
    }
    timings.candidateMetadataScanMs += performance.now() - candidateScanStartedAt;
  }

  if (manifest.oversizedFile) {
    const oversizedReadStartedAt = performance.now();
    const oversizedCollection = await readCachedTileCollection(manifest.oversizedFile);
    if (!oversizedCollection) {
      timings.oversizedSidecarReadMs += performance.now() - oversizedReadStartedAt;
      console.warn("[Overture Viewport API] Oversized feature sidecar is missing or invalid; falling back to GeoJSON index.");
      return null;
    }
    const oversizedSignature = await getFileSignature(resolve(TILE_DIRECTORY, manifest.oversizedFile));
    timings.oversizedSidecarReadMs += performance.now() - oversizedReadStartedAt;
    const oversizedBytes = oversizedSignature ? getSignatureSize(oversizedSignature) : 0;
    candidateFeatureCount += oversizedCollection.features.length;
    fetchedFeatureCount += oversizedCollection.features.length;
    candidateBytes += oversizedBytes;
    featureReadBytes += oversizedBytes;
    if (oversizedCollection.cacheHit) tileCacheHits += 1;

    const oversizedScanStartedAt = performance.now();
    for (const indexedFeature of oversizedCollection.features) {
      if (
        !indexedFeature.bounds ||
        !intersects(indexedFeature.bounds, viewport) ||
        candidateMap.has(indexedFeature.identity)
      ) continue;
      candidateMap.set(indexedFeature.identity, {
        identity: indexedFeature.identity,
        bounds: indexedFeature.bounds,
        role: getRenderRole(indexedFeature.feature),
        tileFile: null,
        record: null,
        preloadedFeature: indexedFeature.feature,
      });
      oversizedFeatureCount += 1;
    }
    timings.candidateMetadataScanMs += performance.now() - oversizedScanStartedAt;
  }

  const matchedFeatureCount = candidateMap.size;
  const selectionStartedAt = performance.now();
  const limitedCandidates = selectViewportFeatures(
    [...candidateMap.values()],
    viewport,
    featureLimit,
    (candidate: ViewportFeatureCandidate) => candidate.bounds,
    (candidate: ViewportFeatureCandidate) => candidate.role,
  ) as ViewportFeatureCandidate[];
  timings.featureSelectionMs += performance.now() - selectionStartedAt;

  // Only fetch geometry for selected candidates; the response feature budget now
  // also bounds normal tile-backed geometry deserialization.
  const recordsByTile = new Map<string, TileFeatureIndexRecord[]>();
  const selectedFeaturesByIdentity = new Map<string, unknown>();
  const selectedGeometryCacheStats = { hits: 0, misses: 0 };
  for (const candidate of limitedCandidates) {
    if (candidate.preloadedFeature !== undefined) {
      selectedFeaturesByIdentity.set(candidate.identity, candidate.preloadedFeature);
      continue;
    }
    if (!candidate.tileFile || !candidate.record) {
      console.warn("[Overture Viewport API] Feature candidate has no validated payload location; falling back to GeoJSON index.");
      return null;
    }
    const records = recordsByTile.get(candidate.tileFile) ?? [];
    records.push(candidate.record);
    recordsByTile.set(candidate.tileFile, records);
  }

  for (const [tileFile, records] of recordsByTile) {
    const dataSignature = tileDataSignatures.get(tileFile);
    if (typeof dataSignature !== "string") {
      console.warn("[Overture Viewport API] Selected geometry has no current tile signature; falling back to GeoJSON index.", { tile: tileFile });
      return null;
    }
    const selectedGeometryStartedAt = performance.now();
    const selectedRead = await readSelectedTileFeatures(
      tileFile,
      records,
      timings,
      dataSignature,
      selectedGeometryCacheStats,
    );
    timings.selectedGeometryReadMs += performance.now() - selectedGeometryStartedAt;
    if (!selectedRead) {
      console.warn("[Overture Viewport API] Indexed feature bytes are invalid or unavailable; falling back to GeoJSON index.", { tile: tileFile });
      return null;
    }
    fetchedFeatureCount += selectedRead.features.length;
    featureReadBytes += selectedRead.bytesRead;
    const featureMapStartedAt = performance.now();
    for (const indexedFeature of selectedRead.features) {
      selectedFeaturesByIdentity.set(indexedFeature.identity, indexedFeature.feature);
    }
    timings.featureAssemblyMs += performance.now() - featureMapStartedAt;
  }

  const features: unknown[] = [];
  const finalAssemblyStartedAt = performance.now();
  for (const candidate of limitedCandidates) {
    const feature = selectedFeaturesByIdentity.get(candidate.identity);
    if (feature === undefined) {
      console.warn("[Overture Viewport API] A selected feature could not be reconstructed from its byte index; falling back to GeoJSON index.");
      return null;
    }
    features.push(feature);
  }
  timings.featureAssemblyMs += performance.now() - finalAssemblyStartedAt;

  return {
    features,
    matchedFeatureCount,
    totalFeatureCount: manifest.sourceFeatureCount,
    tileCount: selectedTiles.length,
    oversizedFeatureCount,
    candidateFeatureCount,
    fetchedFeatureCount,
    candidateBytes,
    indexReadBytes,
    featureReadBytes,
    tileCacheHits,
    geometryFeatureCacheHits: selectedGeometryCacheStats.hits,
    geometryFeatureCacheMisses: selectedGeometryCacheStats.misses,
  };
}

function getRenderRole(feature: unknown): string {
  if (!isRecord(feature) || !isRecord(feature.properties)) {
    return "unknown";
  }

  const role = feature.properties._renderRole;
  return typeof role === "string" ? role : "unknown";
}


export async function GET(request: Request): Promise<Response> {
  const parsedBounds = parseViewportBounds(new URL(request.url));

  if ("error" in parsedBounds) {
    return NextResponse.json(
      { error: parsedBounds.error },
      { status: 400 },
    );
  }

  const viewport = parsedBounds.bounds;
  const parsedLimit = parseFeatureLimit(new URL(request.url));

  if ("error" in parsedLimit) {
    return NextResponse.json(
      { error: parsedLimit.error },
      { status: 400 },
    );
  }

  const featureLimit = parsedLimit.limit;
  const requestStartedAt = performance.now();

  try {
    const tileTimings = createTileQueryTimings();
    const tileQueryStartedAt = performance.now();
    const tileResult = await queryGeneratedTiles(viewport, featureLimit, tileTimings);
    const tileQueryMs = performance.now() - tileQueryStartedAt;
    const fallbackPreparationStartedAt = performance.now();
    const dataset = tileResult ? null : await getIndexedDataset();
    const matchingFeatures = tileResult
      ? []
      : (dataset?.indexedFeatures ?? [])
          .filter(
            (entry) =>
              entry.bounds !== null && intersects(entry.bounds, viewport),
          )
          .map((entry) => entry.feature);
    const totalFeatureCount = tileResult
      ? tileResult.totalFeatureCount
      : dataset?.indexedFeatures.length ?? 0;
    const matchedFeatureCount = tileResult
      ? tileResult.matchedFeatureCount
      : matchingFeatures.length;
    const fallbackGeoJsonPreparationMs = tileResult
      ? 0
      : performance.now() - fallbackPreparationStartedAt;
    const fallbackSelectionStartedAt = performance.now();
    const limitedFeatures = tileResult
      ? tileResult.features
      : selectViewportFeatures(
          matchingFeatures,
          viewport,
          featureLimit,
          getFeatureBounds,
          getRenderRole,
        );
    const fallbackFeatureSelectionMs = tileResult
      ? 0
      : performance.now() - fallbackSelectionStartedAt;
    const samplingStrategy =
      matchedFeatureCount > limitedFeatures.length
        ? "spatial-grid-round-robin"
        : "none";

    let buildingCount = 0;
    let parentCount = 0;
    let partCount = 0;
    let unknownRoleCount = 0;
    const roleClassificationStartedAt = performance.now();

    for (const feature of limitedFeatures) {
      switch (getRenderRole(feature)) {
        case "building":
          buildingCount += 1;
          break;
        case "building_parent":
          parentCount += 1;
          break;
        case "building_part":
          partCount += 1;
          break;
        default:
          unknownRoleCount += 1;
          break;
      }
    }

    const roleClassificationMs = performance.now() - roleClassificationStartedAt;
    const viewportCollection = {
      type: "FeatureCollection",
      ...(dataset?.collection ?? {}),
      features: limitedFeatures,
    };

    console.info("[Overture Viewport API] Viewport ready.", {
      source: tileResult ? "generated-tiles" : "indexed-geojson",
      totalFeatures: totalFeatureCount,
      matchedFeatures: matchedFeatureCount,
      returnedFeatures: limitedFeatures.length,
      featureLimit,
      truncated: matchedFeatureCount > limitedFeatures.length,
      samplingStrategy,
      selectedTiles: tileResult?.tileCount ?? 0,
      candidateFeatures: tileResult?.candidateFeatureCount ?? 0,
      fetchedFeatures: tileResult?.fetchedFeatureCount ?? 0,
      candidateBytes: tileResult?.candidateBytes ?? 0,
      indexReadBytes: tileResult?.indexReadBytes ?? 0,
      featureReadBytes: tileResult?.featureReadBytes ?? 0,
      tileCacheHits: tileResult?.tileCacheHits ?? 0,
      geometryFeatureCacheHits: tileResult?.geometryFeatureCacheHits ?? 0,
      geometryFeatureCacheMisses: tileResult?.geometryFeatureCacheMisses ?? 0,
      oversizedFeatures: tileResult?.oversizedFeatureCount ?? 0,
      buildings: buildingCount,
      buildingParts: partCount,
      parents: parentCount,
    });

    const responseSerializationStartedAt = performance.now();
    const serializedBody = JSON.stringify(viewportCollection);
    const responseSerializationMs = performance.now() - responseSerializationStartedAt;
    if (typeof serializedBody !== "string") {
      throw new Error("Viewport FeatureCollection could not be serialized as JSON.");
    }
    const totalServerMs = performance.now() - requestStartedAt;
    const geometryReadMs = tileTimings.oversizedSidecarReadMs + tileTimings.selectedGeometryReadMs;
    const featureSelectionMs = tileTimings.featureSelectionMs + fallbackFeatureSelectionMs;

    return new NextResponse(serializedBody, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
        "X-Building-Timing-Version": "p2.18",
        "X-Building-Timing-Total-Server-Ms": formatTimingMs(totalServerMs),
        "X-Building-Timing-Tile-Query-Ms": formatTimingMs(tileQueryMs),
        "X-Building-Timing-Manifest-Lookup-Ms": formatTimingMs(tileTimings.manifestLookupMs),
        "X-Building-Timing-Tile-Index-Read-And-Parse-Ms": formatTimingMs(tileTimings.tileIndexReadAndParseMs),
        "X-Building-Timing-Candidate-Metadata-Scan-Ms": formatTimingMs(tileTimings.candidateMetadataScanMs),
        "X-Building-Timing-Oversized-Sidecar-Read-Ms": formatTimingMs(tileTimings.oversizedSidecarReadMs),
        "X-Building-Timing-Feature-Selection-Ms": formatTimingMs(featureSelectionMs),
        "X-Building-Timing-Selected-Geometry-Read-Ms": formatTimingMs(tileTimings.selectedGeometryReadMs),
        "X-Building-Timing-Geometry-Range-Planning-Ms": formatTimingMs(tileTimings.geometryRangePlanningMs),
        "X-Building-Timing-Geometry-File-Open-Ms": formatTimingMs(tileTimings.geometryFileOpenMs),
        "X-Building-Timing-Geometry-Range-Read-Ms": formatTimingMs(tileTimings.geometryRangeReadMs),
        "X-Building-Timing-Geometry-Json-Parse-Ms": formatTimingMs(tileTimings.geometryJsonParseMs),
        "X-Building-Timing-Geometry-Integrity-Check-Ms": formatTimingMs(tileTimings.geometryIntegrityCheckMs),
        "X-Building-Timing-Geometry-File-Close-Ms": formatTimingMs(tileTimings.geometryFileCloseMs),
        "X-Building-Timing-Geometry-Read-Ms": formatTimingMs(geometryReadMs),
        "X-Building-Timing-Feature-Assembly-Ms": formatTimingMs(tileTimings.featureAssemblyMs),
        "X-Building-Timing-Fallback-Geo-Json-Preparation-Ms": formatTimingMs(fallbackGeoJsonPreparationMs),
        "X-Building-Timing-Role-Classification-Ms": formatTimingMs(roleClassificationMs),
        "X-Building-Timing-Response-Serialization-Ms": formatTimingMs(responseSerializationMs),
        "X-Building-Dataset": "overture-3d-pilot",
        "X-Building-Feature-Count": String(limitedFeatures.length),
        "X-Building-Matched-Feature-Count": String(matchedFeatureCount),
        "X-Building-Feature-Limit": String(featureLimit),
        "X-Building-Truncated": String(
          matchedFeatureCount > limitedFeatures.length,
        ),
        "X-Building-Sampling-Strategy": samplingStrategy,
        "X-Building-Total-Feature-Count": String(totalFeatureCount),
        "X-Building-Data-Source": tileResult
          ? "generated-tiles"
          : "indexed-geojson",
        "X-Building-Tile-Count": String(tileResult?.tileCount ?? 0),
        "X-Building-Candidate-Feature-Count": String(
          tileResult?.candidateFeatureCount ?? 0,
        ),
        "X-Building-Fetched-Feature-Count": String(
          tileResult?.fetchedFeatureCount ?? 0,
        ),
        "X-Building-Candidate-Bytes": String(tileResult?.candidateBytes ?? 0),
        "X-Building-Index-Read-Bytes": String(tileResult?.indexReadBytes ?? 0),
        "X-Building-Feature-Read-Bytes": String(tileResult?.featureReadBytes ?? 0),
        "X-Building-Tile-Cache-Hits": String(tileResult?.tileCacheHits ?? 0),
        "X-Building-Geometry-Feature-Cache-Hits": String(tileResult?.geometryFeatureCacheHits ?? 0),
        "X-Building-Geometry-Feature-Cache-Misses": String(tileResult?.geometryFeatureCacheMisses ?? 0),
        "X-Building-Count": String(buildingCount),
        "X-Building-Parent-Count": String(parentCount),
        "X-Building-Part-Count": String(partCount),
        "X-Building-Unknown-Role-Count": String(unknownRoleCount),
        "X-Building-Viewport": [
          viewport.west,
          viewport.south,
          viewport.east,
          viewport.north,
        ].join(","),
      },
    });
  } catch (error: unknown) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error
        ? String(error.code)
        : "";

    if (code === "ENOENT") {
      console.error(
        `[Overture Viewport API] Dataset not found: ${DATA_FILE_RELATIVE}`,
      );

      return NextResponse.json(
        {
          error: "Overture pilot dataset not found.",
          expectedFile: DATA_FILE_RELATIVE,
          instruction:
            "Generate the pilot GeoJSON file before loading the map.",
        },
        { status: 404 },
      );
    }

    console.error(
      "[Overture Viewport API] Could not index the pilot dataset:",
      error instanceof Error ? error.message : String(error),
    );

    return NextResponse.json(
      {
        error: "Could not query the Overture pilot dataset.",
      },
      { status: 500 },
    );
  }
}
