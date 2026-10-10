import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");
const sourcePath = path.join(
  projectRoot,
  "data",
  "overture",
  "dhaka-buildings-3d-pilot.geojson",
);
const generatedPath = path.join(
  projectRoot,
  "data",
  "overture",
  "spatial-tiles",
);
const manifestPath = path.join(generatedPath, "manifest.json");

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
      const [longitude, latitude] = value;
      if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        return;
      }

      bounds.west = Math.min(bounds.west, longitude);
      bounds.south = Math.min(bounds.south, latitude);
      bounds.east = Math.max(bounds.east, longitude);
      bounds.north = Math.max(bounds.north, latitude);
      return;
    }

    for (const child of value) visitCoordinates(child);
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

function intersects(left, right) {
  return (
    left.west <= right.east &&
    left.east >= right.west &&
    left.south <= right.north &&
    left.north >= right.south
  );
}

async function loadDataset() {
  const [sourceText, manifestText] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);

  const source = JSON.parse(sourceText);
  const manifest = JSON.parse(manifestText);

  assert.equal(source.type, "FeatureCollection");
  assert.ok(Array.isArray(source.features));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.tiles));

  return { source, manifest };
}

test("manifest matches the source dataset and generated grid", async () => {
  const { source, manifest } = await loadDataset();
  const uniqueSourceIdentities = new Set(
    source.features
      .filter((feature) => isRecord(feature) && feature.type === "Feature")
      .map(getFeatureIdentity),
  );

  assert.equal(manifest.sourceFeatureCount, source.features.length);
  assert.equal(manifest.uniqueSourceFeatureCount, uniqueSourceIdentities.size);
  assert.equal(manifest.tileCount, manifest.tiles.length);
  assert.equal(manifest.gridStepDegrees, 0.005);
  assert.ok(manifest.tileCount > 0, "expected at least one populated tile");
  assert.equal(manifest.invalidFeatureCount, 0, "source contains invalid features");
});

test("every manifest tile exists and contains valid, spatially relevant features", async () => {
  const { source, manifest } = await loadDataset();
  const sourceByIdentity = new Map(
    source.features
      .filter((feature) => isRecord(feature) && feature.type === "Feature")
      .map((feature) => [getFeatureIdentity(feature), feature]),
  );
  const tileIds = new Set();
  const featureCopies = new Map();
  let totalTileFeatureCopies = 0;

  for (const tile of manifest.tiles) {
    assert.ok(!tileIds.has(tile.id), `duplicate tile id: ${tile.id}`);
    tileIds.add(tile.id);

    for (const key of ["west", "south", "east", "north"]) {
      assert.ok(Number.isFinite(tile.bounds[key]), `${tile.id} has invalid ${key}`);
    }

    assert.ok(tile.bounds.west < tile.bounds.east);
    assert.ok(tile.bounds.south < tile.bounds.north);

    // Manifest paths are relative to the spatial-tiles root and already
    // include the "tiles/" directory segment.
    const filePath = path.resolve(generatedPath, tile.file);
    assert.ok(
      filePath.startsWith(path.resolve(generatedPath) + path.sep),
      `tile path escaped output directory: ${tile.file}`,
    );

    const fileInfo = await stat(filePath);
    assert.ok(fileInfo.isFile(), `tile file does not exist: ${tile.file}`);

    const tileCollection = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(tileCollection.type, "FeatureCollection");
    assert.equal(tileCollection.name, tile.id);
    assert.ok(Array.isArray(tileCollection.features));
    assert.equal(tileCollection.features.length, tile.featureCount);

    const localIdentities = new Set();
    totalTileFeatureCopies += tileCollection.features.length;

    for (const feature of tileCollection.features) {
      const identity = getFeatureIdentity(feature);
      assert.ok(!localIdentities.has(identity), `duplicate identity inside tile ${tile.id}`);
      localIdentities.add(identity);
      assert.ok(sourceByIdentity.has(identity), `tile contains unknown source feature ${identity}`);

      const bounds = getGeometryBounds(feature.geometry);
      assert.ok(bounds, `tile contains geometry without usable bounds: ${identity}`);
      assert.ok(
        intersects(bounds, tile.bounds),
        `tile ${tile.id} contains feature outside its grid bounds: ${identity}`,
      );

      const canonicalFeature = JSON.stringify(sourceByIdentity.get(identity));
      const previous = featureCopies.get(identity);
      if (previous !== undefined) {
        assert.equal(
          canonicalFeature,
          previous,
          `feature copy changed between tiles: ${identity}`,
        );
      } else {
        featureCopies.set(identity, canonicalFeature);
      }
    }
  }

  assert.equal(totalTileFeatureCopies, manifest.tileFeatureCopyCount);
  assert.equal(
    manifest.duplicateTileCopyCount,
    totalTileFeatureCopies - manifest.indexedFeatureCount,
  );

  // Every structurally valid source feature must be represented by a grid
  // tile or the sidecar (which holds oversized/unbounded geometries).
  const representedIdentities = new Set(featureCopies.keys());
  if (manifest.oversizedFile) {
    const sidecarPath = path.resolve(generatedPath, manifest.oversizedFile);
    assert.ok(
      sidecarPath.startsWith(path.resolve(generatedPath) + path.sep),
      "sidecar path escaped output directory",
    );
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    assert.equal(sidecar.type, "FeatureCollection");
    for (const feature of sidecar.features) {
      representedIdentities.add(getFeatureIdentity(feature));
    }
  }

  for (const feature of source.features) {
    if (
      isRecord(feature) &&
      feature.type === "Feature" &&
      isRecord(feature.geometry)
    ) {
      assert.ok(
        representedIdentities.has(getFeatureIdentity(feature)),
        `source feature was not indexed: ${getFeatureIdentity(feature)}`,
      );
    }
  }
});

test("viewport intersection uses inclusive edges for boundary-crossing footprints", () => {
  const viewport = { west: 90.38, south: 23.72, east: 90.42, north: 23.76 };

  assert.equal(
    intersects(
      { west: 90.42, south: 23.74, east: 90.421, north: 23.75 },
      viewport,
    ),
    true,
  );
  assert.equal(
    intersects(
      { west: 90.421, south: 23.74, east: 90.43, north: 23.75 },
      viewport,
    ),
    false,
  );
});
