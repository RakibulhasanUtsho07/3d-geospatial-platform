#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const sourceRelative = "data/overture/dhaka-buildings-3d-pilot.geojson";
const outputRelative = "data/overture/spatial-tiles";
const sourcePath = path.resolve(projectRoot, sourceRelative);
const outputPath = path.resolve(projectRoot, outputRelative);
const tilesPath = path.join(outputPath, "tiles");

const GRID_STEP_DEGREES = 0.005;
const MAX_TILES_PER_FEATURE = 64;
const TILE_COLUMNS = Math.ceil(360 / GRID_STEP_DEGREES);
const TILE_ROWS = Math.ceil(180 / GRID_STEP_DEGREES);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFeatureIdentity(feature) {
  if (feature.id !== undefined && feature.id !== null) {
    return `feature-id:${String(feature.id)}`;
  }

  const properties = isRecord(feature.properties) ? feature.properties : {};
  for (const key of ["id", "feature_id", "featureId", "building_id", "overture_id"]) {
    const value = properties[key];
    if (typeof value === "string" || typeof value === "number") {
      return `property-id:${String(value)}`;
    }
  }

  return `sha256:${createHash("sha256").update(JSON.stringify(feature)).digest("hex")}`;
}

function getGeometryBounds(geometry) {
  if (!isRecord(geometry)) {
    return null;
  }

  const bounds = {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  };

  function visitCoordinates(value) {
    if (!Array.isArray(value)) {
      return;
    }

    if (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    ) {
      const longitude = value[0];
      const latitude = value[1];

      if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        return;
      }

      bounds.west = Math.min(bounds.west, longitude);
      bounds.south = Math.min(bounds.south, latitude);
      bounds.east = Math.max(bounds.east, longitude);
      bounds.north = Math.max(bounds.north, latitude);
      return;
    }

    for (const child of value) {
      visitCoordinates(child);
    }
  }

  visitCoordinates(geometry.coordinates);

  if (Array.isArray(geometry.geometries)) {
    for (const child of geometry.geometries) {
      const childBounds = getGeometryBounds(child);
      if (!childBounds) continue;
      bounds.west = Math.min(bounds.west, childBounds.west);
      bounds.south = Math.min(bounds.south, childBounds.south);
      bounds.east = Math.max(bounds.east, childBounds.east);
      bounds.north = Math.max(bounds.north, childBounds.north);
    }
  }

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

function getTileRange(bounds) {
  const clamp = (value, minimum, maximum) =>
    Math.max(minimum, Math.min(maximum, value));

  const minX = clamp(
    Math.floor((bounds.west + 180) / GRID_STEP_DEGREES),
    0,
    TILE_COLUMNS - 1,
  );
  const maxX = clamp(
    Math.floor((bounds.east + 180) / GRID_STEP_DEGREES),
    0,
    TILE_COLUMNS - 1,
  );
  const minY = clamp(
    Math.floor((bounds.south + 90) / GRID_STEP_DEGREES),
    0,
    TILE_ROWS - 1,
  );
  const maxY = clamp(
    Math.floor((bounds.north + 90) / GRID_STEP_DEGREES),
    0,
    TILE_ROWS - 1,
  );

  return {
    minX: Math.min(minX, maxX),
    maxX: Math.max(minX, maxX),
    minY: Math.min(minY, maxY),
    maxY: Math.max(minY, maxY),
  };
}

function getTileId(x, y) {
  return `x${x}_y${y}`;
}

function tileFileName(x, y) {
  return `${getTileId(x, y)}.geojson`;
}

async function main() {
  const normalizedOutput = path.resolve(outputPath);
  const allowedOutputRoot = path.resolve(projectRoot, "data", "overture");
  if (!normalizedOutput.startsWith(allowedOutputRoot + path.sep)) {
    throw new Error("Refusing to write spatial tile output outside data/overture.");
  }

  let source;
  try {
    source = JSON.parse(await readFile(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read/parse ${sourceRelative}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(source) || source.type !== "FeatureCollection" || !Array.isArray(source.features)) {
    throw new Error(`${sourceRelative} must be a GeoJSON FeatureCollection.`);
  }

  const tileBuckets = new Map();
  const oversizedFeatures = [];
  const identities = new Set();
  let invalidFeatureCount = 0;
  let unboundedFeatureCount = 0;
  let oversizedFeatureCount = 0;
  let uniqueSourceFeatures = 0;

  for (const feature of source.features) {
    if (!isRecord(feature) || feature.type !== "Feature" || !isRecord(feature.geometry)) {
      invalidFeatureCount += 1;
      continue;
    }

    const identity = getFeatureIdentity(feature);
    if (identities.has(identity)) continue;
    identities.add(identity);
    uniqueSourceFeatures += 1;

    const bounds = getGeometryBounds(feature.geometry);
    if (!bounds) {
      // Keep geometries with unsupported/missing coordinates queryable as a small global sidecar.
      oversizedFeatures.push(feature);
      unboundedFeatureCount += 1;
      continue;
    }

    const range = getTileRange(bounds);
    const tileColumns = range.maxX - range.minX + 1;
    const tileRows = range.maxY - range.minY + 1;
    const tilesTouched = tileColumns * tileRows;

    if (tilesTouched > MAX_TILES_PER_FEATURE) {
      oversizedFeatures.push(feature);
      oversizedFeatureCount += 1;
      continue;
    }

    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const id = getTileId(x, y);
        let bucket = tileBuckets.get(id);
        if (!bucket) {
          bucket = { x, y, features: [] };
          tileBuckets.set(id, bucket);
        }
        bucket.features.push(feature);
      }
    }
  }

  await rm(outputPath, { recursive: true, force: true });
  await mkdir(tilesPath, { recursive: true });

  const tileManifest = [];
  let tileFeatureCopies = 0;

  for (const bucket of [...tileBuckets.values()].sort((left, right) =>
    left.x === right.x ? left.y - right.y : left.x - right.x
  )) {
    const filename = tileFileName(bucket.x, bucket.y);
    const tileCollection = {
      type: "FeatureCollection",
      name: getTileId(bucket.x, bucket.y),
      features: bucket.features,
    };

    await writeFile(
      path.join(tilesPath, filename),
      JSON.stringify(tileCollection),
      "utf8",
    );

    const west = -180 + bucket.x * GRID_STEP_DEGREES;
    const south = -90 + bucket.y * GRID_STEP_DEGREES;
    tileManifest.push({
      id: getTileId(bucket.x, bucket.y),
      x: bucket.x,
      y: bucket.y,
      file: `tiles/${filename}`,
      featureCount: bucket.features.length,
      bounds: {
        west,
        south,
        east: Math.min(180, west + GRID_STEP_DEGREES),
        north: Math.min(90, south + GRID_STEP_DEGREES),
      },
    });
    tileFeatureCopies += bucket.features.length;
  }

  if (oversizedFeatures.length > 0) {
    await writeFile(
      path.join(outputPath, "oversized.geojson"),
      JSON.stringify({
        type: "FeatureCollection",
        name: "oversized-and-unbounded",
        features: oversizedFeatures,
      }),
      "utf8",
    );
  }

  const manifest = {
    schemaVersion: 1,
    sourceFile: sourceRelative,
    gridStepDegrees: GRID_STEP_DEGREES,
    maxTilesPerFeature: MAX_TILES_PER_FEATURE,
    sourceFeatureCount: source.features.length,
    uniqueSourceFeatureCount: uniqueSourceFeatures,
    indexedFeatureCount: uniqueSourceFeatures - unboundedFeatureCount - oversizedFeatureCount,
    invalidFeatureCount,
    oversizedFeatureCount,
    unboundedFeatureCount,
    tileFeatureCopyCount: tileFeatureCopies,
    duplicateTileCopyCount: Math.max(0, tileFeatureCopies - (
      uniqueSourceFeatures - unboundedFeatureCount - oversizedFeatureCount
    )),
    oversizedFile: oversizedFeatures.length > 0 ? "oversized.geojson" : null,
    tileCount: tileManifest.length,
    tiles: tileManifest,
  };

  await writeFile(
    path.join(outputPath, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  console.log("[Overture Tiles] Spatial tiles generated.", {
    sourceFeatures: manifest.sourceFeatureCount,
    uniqueFeatures: manifest.uniqueSourceFeatureCount,
    tiles: manifest.tileCount,
    tileFeatureCopies: manifest.tileFeatureCopyCount,
    duplicateTileCopies: manifest.duplicateTileCopyCount,
    oversizedFeatures: manifest.oversizedFeatureCount,
    unboundedFeatures: manifest.unboundedFeatureCount,
    invalidFeatures: manifest.invalidFeatureCount,
    output: path.relative(projectRoot, outputPath),
  });
}

main().catch((error) => {
  console.error(
    "[Overture Tiles] Generation failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
