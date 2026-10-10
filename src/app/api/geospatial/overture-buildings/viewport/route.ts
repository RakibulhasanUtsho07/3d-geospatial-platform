import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

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
  featureCount: number;
  bounds: ViewportBounds;
};

type TileManifest = {
  sourceFeatureCount: number;
  tileCount: number;
  oversizedFile: string | null;
  tiles: TileManifestEntry[];
};

type TileQueryResult = {
  features: unknown[];
  totalFeatureCount: number;
  tileCount: number;
  oversizedFeatureCount: number;
  candidateFeatureCount: number;
  tileCacheHits: number;
};

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
const MAX_CACHED_TILE_FILES = 64;

let indexedDatasetPromise: Promise<IndexedDataset> | null = null;
let cachedTileManifest: CachedManifestEntry | null = null;

// Parsed tiles retain precomputed bounds and identities between viewport requests.
const tileFeatureCache = new Map<string, CachedTileEntry>();

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
      typeof entry.featureCount === "number" &&
      Number.isInteger(entry.featureCount) &&
      entry.featureCount >= 0 &&
      validBounds
    );
  });
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

async function queryGeneratedTiles(
  viewport: ViewportBounds,
): Promise<TileQueryResult | null> {
  const manifest = await readCachedTileManifest();
  if (!manifest) return null;

  const selectedTiles = manifest.tiles.filter((tile) =>
    intersects(tile.bounds, viewport),
  );

  const featureMap = new Map<string, unknown>();
  let oversizedFeatureCount = 0;
  let candidateFeatureCount = 0;
  let tileCacheHits = 0;

  for (const tile of selectedTiles) {
    const tileCollection = await readCachedTileCollection(tile.file);
    if (!tileCollection) {
      console.warn(
        "[Overture Viewport API] Generated tile is missing or invalid; falling back to GeoJSON index.",
        { tile: tile.id },
      );
      return null;
    }

    candidateFeatureCount += tileCollection.features.length;
    if (tileCollection.cacheHit) tileCacheHits += 1;

    for (const indexedFeature of tileCollection.features) {
      // Tile bounds are intentionally coarse. Apply viewport bounds before
      // returning candidates and deduplicate copies that cross tile borders.
      if (
        !indexedFeature.bounds ||
        !intersects(indexedFeature.bounds, viewport)
      ) {
        continue;
      }

      if (!featureMap.has(indexedFeature.identity)) {
        featureMap.set(indexedFeature.identity, indexedFeature.feature);
      }
    }
  }

  if (manifest.oversizedFile) {
    const oversizedCollection = await readCachedTileCollection(
      manifest.oversizedFile,
    );
    if (!oversizedCollection) {
      console.warn(
        "[Overture Viewport API] Oversized feature sidecar is missing or invalid; falling back to GeoJSON index.",
      );
      return null;
    }

    candidateFeatureCount += oversizedCollection.features.length;
    if (oversizedCollection.cacheHit) tileCacheHits += 1;

    for (const indexedFeature of oversizedCollection.features) {
      if (
        indexedFeature.bounds &&
        intersects(indexedFeature.bounds, viewport) &&
        !featureMap.has(indexedFeature.identity)
      ) {
        featureMap.set(indexedFeature.identity, indexedFeature.feature);
        oversizedFeatureCount += 1;
      }
    }
  }

  return {
    features: [...featureMap.values()],
    totalFeatureCount: manifest.sourceFeatureCount,
    tileCount: selectedTiles.length,
    oversizedFeatureCount,
    candidateFeatureCount,
    tileCacheHits,
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

  try {
    const tileResult = await queryGeneratedTiles(viewport);
    const dataset = tileResult ? null : await getIndexedDataset();
    const matchingFeatures = tileResult
      ? tileResult.features
      : (dataset?.indexedFeatures ?? [])
          .filter(
            (entry) =>
              entry.bounds !== null && intersects(entry.bounds, viewport),
          )
          .map((entry) => entry.feature);
    const totalFeatureCount = tileResult
      ? tileResult.totalFeatureCount
      : dataset?.indexedFeatures.length ?? 0;

    let buildingCount = 0;
    let parentCount = 0;
    let partCount = 0;
    let unknownRoleCount = 0;

    for (const feature of matchingFeatures) {
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

    const viewportCollection = {
      type: "FeatureCollection",
      ...(dataset?.collection ?? {}),
      features: matchingFeatures,
    };

    console.info("[Overture Viewport API] Viewport ready.", {
      source: tileResult ? "generated-tiles" : "indexed-geojson",
      totalFeatures: totalFeatureCount,
      returnedFeatures: matchingFeatures.length,
      selectedTiles: tileResult?.tileCount ?? 0,
      candidateFeatures: tileResult?.candidateFeatureCount ?? 0,
      tileCacheHits: tileResult?.tileCacheHits ?? 0,
      oversizedFeatures: tileResult?.oversizedFeatureCount ?? 0,
      buildings: buildingCount,
      buildingParts: partCount,
      parents: parentCount,
    });

    return NextResponse.json(viewportCollection, {
      headers: {
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
        "X-Building-Dataset": "overture-3d-pilot",
        "X-Building-Feature-Count": String(matchingFeatures.length),
        "X-Building-Total-Feature-Count": String(totalFeatureCount),
        "X-Building-Data-Source": tileResult
          ? "generated-tiles"
          : "indexed-geojson",
        "X-Building-Tile-Count": String(tileResult?.tileCount ?? 0),
        "X-Building-Candidate-Feature-Count": String(
          tileResult?.candidateFeatureCount ?? 0,
        ),
        "X-Building-Tile-Cache-Hits": String(tileResult?.tileCacheHits ?? 0),
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
