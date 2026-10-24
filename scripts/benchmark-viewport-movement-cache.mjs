import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const baseUrl = (process.env.GEOSPATIAL_API_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const endpoint = baseUrl + "/api/geospatial/overture-buildings/viewport";
const featureLimit = Number(process.env.P2_20_FEATURE_LIMIT ?? 900);
const reportPath = resolve(
  process.cwd(),
  process.env.P2_20_REPORT_PATH ?? "test-results/p2-20-viewport-movement-cache.json",
);
const MAX_CACHE_ENTRIES = 6000;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

// The path starts at a neighboring view, zooms in, pans northwest, then returns
// to the exact first bounds. All views stay inside the generated Dhaka pilot.
const movementPlan = [
  {
    phase: "initial-east-view",
    bounds: { west: 90.409, south: 23.775, east: 90.419, north: 23.785 },
  },
  {
    phase: "zoom-in",
    bounds: { west: 90.411, south: 23.777, east: 90.417, north: 23.783 },
  },
  {
    phase: "pan-northwest",
    bounds: { west: 90.402, south: 23.779, east: 90.412, north: 23.789 },
  },
  {
    phase: "return-to-initial-east-view",
    bounds: { west: 90.409, south: 23.775, east: 90.419, north: 23.785 },
  },
];

assert.ok(Number.isInteger(featureLimit) && featureLimit >= 100 && featureLimit <= 2500,
  "P2_20_FEATURE_LIMIT must be an integer between 100 and 2500");
assert.notDeepEqual(movementPlan[0].bounds, movementPlan[1].bounds);
assert.notDeepEqual(movementPlan[1].bounds, movementPlan[2].bounds);
assert.deepEqual(movementPlan[0].bounds, movementPlan.at(-1).bounds,
  "the movement path must return to its original viewport");

function readMetric(headers, name) {
  const value = headers.get(name);
  if (value === null || value.trim() === "") {
    throw new Error("Missing viewport diagnostic header: " + name);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("Invalid nonnegative numeric header " + name + ": " + value);
  }
  return number;
}

function digestFeatures(features) {
  return createHash("sha256").update(JSON.stringify(features)).digest("hex");
}

async function observeMovementStep(step, sequence) {
  const query = new URLSearchParams({
    west: step.bounds.west.toFixed(6),
    south: step.bounds.south.toFixed(6),
    east: step.bounds.east.toFixed(6),
    north: step.bounds.north.toFixed(6),
    limit: String(featureLimit),
  });
  const startedAt = performance.now();
  const response = await fetch(endpoint + "?" + query, { cache: "no-store" });
  const raw = await response.text();
  const elapsedMs = Number((performance.now() - startedAt).toFixed(2));

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("Viewport API returned invalid JSON for movement step " + step.phase);
  }

  assert.equal(response.status, 200, step.phase + " should return HTTP 200");
  assert.equal(response.headers.get("x-building-data-source"), "generated-tiles",
    step.phase + " must use generated spatial tiles");
  assert.equal(response.headers.get("x-building-timing-version"), "p2.19",
    "movement benchmark uses the P2.19 viewport diagnostics contract");
  assert.ok(Array.isArray(body.features) && body.features.length > 0,
    step.phase + " should return real Dhaka building features");

  const cacheHits = readMetric(response.headers, "x-building-geometry-feature-cache-hits");
  const cacheMisses = readMetric(response.headers, "x-building-geometry-feature-cache-misses");
  const cacheEntries = readMetric(response.headers, "x-building-geometry-feature-cache-entries");
  const cacheBytes = readMetric(response.headers, "x-building-geometry-feature-cache-bytes");
  const evictions = readMetric(response.headers, "x-building-geometry-feature-cache-evictions");
  const oversizedRejections = readMetric(response.headers, "x-building-geometry-feature-cache-oversized-rejections");
  const invalidations = readMetric(response.headers, "x-building-geometry-feature-cache-invalidations");
  const featureReadBytes = readMetric(response.headers, "x-building-feature-read-bytes");
  const indexReadBytes = readMetric(response.headers, "x-building-index-read-bytes");
  const selectedTileCount = readMetric(response.headers, "x-building-tile-count");
  const returnedFeatureCount = readMetric(response.headers, "x-building-feature-count");

  assert.ok(cacheEntries <= MAX_CACHE_ENTRIES,
    step.phase + " exceeded the selected-geometry entry cap");
  assert.ok(cacheBytes <= MAX_CACHE_BYTES,
    step.phase + " exceeded the selected-geometry accounted-byte budget");
  assert.ok(selectedTileCount > 0, step.phase + " should intersect generated tiles");
  assert.equal(returnedFeatureCount, body.features.length,
    "feature-count diagnostic must match the returned FeatureCollection");
  assert.ok(body.features.length <= featureLimit,
    "the viewport feature limit must remain enforced");

  return {
    sequence,
    phase: step.phase,
    bounds: step.bounds,
    elapsedMs,
    returnedFeatureCount,
    selectedTileCount,
    indexReadBytes,
    featureReadBytes,
    geometryFeatureCacheHits: cacheHits,
    geometryFeatureCacheMisses: cacheMisses,
    geometryFeatureCacheEntries: cacheEntries,
    geometryFeatureCacheBytes: cacheBytes,
    geometryFeatureCacheEvictions: evictions,
    geometryFeatureCacheOversizedRejections: oversizedRejections,
    geometryFeatureCacheInvalidations: invalidations,
    featureSha256: digestFeatures(body.features),
  };
}

const observations = [];
for (let index = 0; index < movementPlan.length; index += 1) {
  observations.push(await observeMovementStep(movementPlan[index], index + 1));
}

const firstView = observations[0];
const returnView = observations.at(-1);
assert.equal(returnView.featureSha256, firstView.featureSha256,
  "returning to identical bounds must reproduce the same ordered feature payload");
assert.equal(returnView.returnedFeatureCount, firstView.returnedFeatureCount,
  "returning to identical bounds must reproduce the same feature count");
assert.ok(returnView.geometryFeatureCacheHits > 0,
  "returning to a previously visited viewport should reuse selected geometry");
assert.ok(
  observations.slice(1, -1).some((sample) => sample.geometryFeatureCacheMisses > 0),
  "the pan/zoom path should fetch at least some previously uncached geometry",
);
assert.ok(
  observations.some((sample) => sample.geometryFeatureCacheHits > 0),
  "the movement workload should demonstrate selected-geometry cache reuse",
);

for (let index = 1; index < observations.length; index += 1) {
  for (const counter of [
    "geometryFeatureCacheEvictions",
    "geometryFeatureCacheOversizedRejections",
    "geometryFeatureCacheInvalidations",
  ]) {
    assert.ok(observations[index][counter] >= observations[index - 1][counter],
      counter + " must be a cumulative nondecreasing process counter");
  }
}

const report = {
  benchmark: "p2.20-viewport-movement-cache-reuse",
  generatedAt: new Date().toISOString(),
  candidateSha: process.env.GITHUB_SHA ?? null,
  environment: {
    node: process.version,
    platform: process.platform,
    baseUrl,
    featureLimit,
  },
  cacheBudget: {
    maxEntries: MAX_CACHE_ENTRIES,
    maxAccountedSourceRecordBytes: MAX_CACHE_BYTES,
    note: "The byte cap counts indexed source-record lengths, not exact V8 heap usage.",
  },
  observations,
  summary: {
    uniqueViewportCount: new Set(observations.map((item) =>
      JSON.stringify(item.bounds),
    )).size,
    movementSteps: observations.length,
    totalGeometryReadBytes: observations.reduce((sum, item) => sum + item.featureReadBytes, 0),
    totalIndexReadBytes: observations.reduce((sum, item) => sum + item.indexReadBytes, 0),
    cacheHitObservations: observations.filter((item) => item.geometryFeatureCacheHits > 0).length,
    cacheMissObservations: observations.filter((item) => item.geometryFeatureCacheMisses > 0).length,
    returnPayloadHashMatches: returnView.featureSha256 === firstView.featureSha256,
    returnRequestCacheHits: returnView.geometryFeatureCacheHits,
    maxObservedCacheEntries: Math.max(...observations.map((item) => item.geometryFeatureCacheEntries)),
    maxObservedCacheBytes: Math.max(...observations.map((item) => item.geometryFeatureCacheBytes)),
    finalEvictions: returnView.geometryFeatureCacheEvictions,
    finalInvalidations: returnView.geometryFeatureCacheInvalidations,
  },
  methodology: {
    workload: "One same-process sequence through three distinct Dhaka viewport bounds (initial view, narrower zoom, northwest pan), then back to the exact initial bounds.",
    correctness: "The ordered serialized feature list is SHA-256 hashed on every step; the return to identical bounds must match its first hash and feature count.",
    cachePolicy: "Every response must remain within the selected-geometry cache entry and accounted-source-byte caps. Process-wide counters must not decrease during the sequence.",
    interpretation: "The benchmark runs against the same production process as the surrounding CI viewport tests, so the initial view may find cache entries retained by earlier requests. It validates movement-path reuse and correctness, not a clean-process cold-start number or universal latency guarantee.",
  },
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log("[P2.20 viewport movement cache benchmark]", JSON.stringify(report));
