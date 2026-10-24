import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const baseUrl = (process.env.GEOSPATIAL_API_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const endpoint = baseUrl + "/api/geospatial/overture-buildings/viewport";
const bounds = { west: 90.405, south: 23.775, east: 90.415, north: 23.785 };
const featureLimit = 2500;
const warmRunCount = Number(process.env.P2_11_WARM_RUNS ?? 5);
const SERVER_TIMING_FIELDS = [
  "totalServerMs",
  "tileQueryMs",
  "manifestLookupMs",
  "tileIndexReadAndParseMs",
  "candidateMetadataScanMs",
  "oversizedSidecarReadMs",
  "featureSelectionMs",
  "selectedGeometryReadMs",
  "geometryRangePlanningMs",
  "geometryFileOpenMs",
  "geometryRangeReadMs",
  "geometryJsonParseMs",
  "geometryIntegrityCheckMs",
  "geometryFileCloseMs",
  "geometryReadMs",
  "featureAssemblyMs",
  "fallbackGeoJsonPreparationMs",
  "roleClassificationMs",
  "responseSerializationMs",
];

function toTimingHeader(field) {
  return "x-building-timing-" + field.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
}

assert.ok(Number.isInteger(warmRunCount) && warmRunCount >= 3 && warmRunCount <= 10,
  "P2_11_WARM_RUNS must be an integer between 3 and 10");

const query = new URLSearchParams({
  west: bounds.west.toFixed(6),
  south: bounds.south.toFixed(6),
  east: bounds.east.toFixed(6),
  north: bounds.north.toFixed(6),
  limit: String(featureLimit),
});
const url = endpoint + "?" + query;

function readMetric(headers, name) {
  const value = headers.get(name);
  if (value === null || value.trim() === "") {
    throw new Error("Missing viewport diagnostic header: " + name);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("Invalid viewport diagnostic header " + name + ": " + value);
  }
  return number;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return Number(ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)].toFixed(2));
}

async function observeRequest(sequence, phase) {
  const startedAt = performance.now();
  const response = await fetch(url, { cache: "no-store" });
  const responseText = await response.text();
  let body;
  try {
    body = JSON.parse(responseText);
  } catch {
    throw new Error("Viewport API returned invalid JSON on " + phase + " request " + sequence);
  }
  const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
  assert.equal(response.status, 200, phase + " request " + sequence + " should return HTTP 200");
  assert.equal(response.headers.get("x-building-data-source"), "generated-tiles");
  assert.equal(response.headers.get("x-building-timing-version"), "p2.18",
    "server must advertise the P2.18 timing contract");
  assert.ok(Array.isArray(body.features) && body.features.length > 0, "expected real Dhaka building features");

  const serverTimingsMs = Object.fromEntries(SERVER_TIMING_FIELDS.map((field) => [
    field,
    readMetric(response.headers, toTimingHeader(field)),
  ]));
  assert.ok(serverTimingsMs.totalServerMs >= serverTimingsMs.responseSerializationMs,
    "server total timing must include response serialization");
  assert.ok(serverTimingsMs.totalServerMs >= serverTimingsMs.tileQueryMs,
    "server total timing must include tile query work");

  const candidatePayloadBytes = readMetric(response.headers, "x-building-candidate-bytes");
  const indexReadBytes = readMetric(response.headers, "x-building-index-read-bytes");
  const featureReadBytes = readMetric(response.headers, "x-building-feature-read-bytes");
  const fetchedFeatureCount = readMetric(response.headers, "x-building-fetched-feature-count");
  const geometryFeatureCacheHits = readMetric(response.headers, "x-building-geometry-feature-cache-hits");
  const geometryFeatureCacheMisses = readMetric(response.headers, "x-building-geometry-feature-cache-misses");
  const responseFeatureLimit = readMetric(response.headers, "x-building-feature-limit");
  const selectedTileCount = readMetric(response.headers, "x-building-tile-count");

  assert.ok(candidatePayloadBytes > 0, "the selected-tile payload baseline must be nonzero");
  assert.ok(selectedTileCount > 0, "the viewport must select at least one generated tile");
  assert.equal(responseFeatureLimit, featureLimit);
  assert.ok(fetchedFeatureCount <= responseFeatureLimit, "geometry fetches must respect the feature budget");
  assert.ok(featureReadBytes < candidatePayloadBytes, "sampled geometry bytes must be below full-tile baseline");
  assert.ok(indexReadBytes + featureReadBytes < candidatePayloadBytes,
    "index plus geometry reads should be below the full selected-tile payload baseline");

  return {
    sequence,
    phase,
    elapsedMs,
    serverTimingsMs,
    statusCode: response.status,
    selectedTileCount,
    candidateFeatureCount: readMetric(response.headers, "x-building-candidate-feature-count"),
    matchedFeatureCount: readMetric(response.headers, "x-building-matched-feature-count"),
    returnedFeatureCount: readMetric(response.headers, "x-building-feature-count"),
    candidatePayloadBytes,
    indexReadBytes,
    featureReadBytes,
    combinedReadBytes: indexReadBytes + featureReadBytes,
    combinedReadReductionRatio: Number((1 - (indexReadBytes + featureReadBytes) / candidatePayloadBytes).toFixed(4)),
    fetchedFeatureCount,
    geometryFeatureCacheHits,
    geometryFeatureCacheMisses,
    featureLimit: responseFeatureLimit,
    featureSha256: createHash("sha256").update(JSON.stringify(body.features)).digest("hex"),
  };
}

// The first valid viewport request in this fresh production-server process is the
// cold sample. Readiness probes use invalid bounds and cannot populate tile caches.
const cold = await observeRequest(1, "cold-first-valid-request");
assert.ok(cold.indexReadBytes > 0,
  "the cold sample must read compact tile indexes from disk before the warm series begins");
assert.equal(cold.geometryFeatureCacheHits, 0,
  "a fresh process must not have selected geometry in memory before its first valid request");
assert.ok(cold.geometryFeatureCacheMisses > 0,
  "the first valid request should populate the selected-geometry cache");

const warm = [];
for (let index = 0; index < warmRunCount; index += 1) {
  warm.push(await observeRequest(index + 2, "warm-repeat"));
}

assert.ok(warm.every((sample) => sample.indexReadBytes === 0),
  "all repeated requests should reuse the parsed in-memory tile indexes");
assert.ok(warm.every((sample) => sample.geometryFeatureCacheHits > 0),
  "repeated viewport requests should reuse cached selected geometry");
assert.ok(warm.every((sample) => sample.geometryFeatureCacheMisses === 0),
  "the bounded selected-geometry cache should retain the tested viewport workload");
assert.ok(warm.every((sample) => sample.featureReadBytes === 0),
  "warm repeated requests should perform no selected geometry byte reads");
assert.ok(warm.every((sample) => sample.featureSha256 === cold.featureSha256),
  "cold and warm requests must preserve identical ordered building features");
assert.ok(warm.every((sample) => sample.returnedFeatureCount === cold.returnedFeatureCount),
  "cold and warm requests must return the same feature count");

const warmLatencies = warm.map((sample) => sample.elapsedMs);
const warmGeometryBytes = warm.reduce((total, sample) => total + sample.featureReadBytes, 0);
const warmCandidateBytes = warm.reduce((total, sample) => total + sample.candidatePayloadBytes, 0);
const manifestPath = resolve(process.cwd(), "data", "overture", "spatial-tiles", "manifest.json");
const manifestBytes = await readFile(manifestPath);
const spatialTileManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

const report = {
  benchmark: "p2.11-controlled-cold-warm-viewport",
  generatedAt: new Date().toISOString(),
  candidateSha: process.env.GITHUB_SHA ?? null,
  spatialTileManifestSha256,
  environment: {
    node: process.version,
    platform: process.platform,
    baseUrl,
    warmRunCount,
  },
  viewport: {
    bounds,
    boundsSha256: createHash("sha256").update(Object.values(bounds).join("|")).digest("hex"),
    featureLimit,
  },
  cold,
  warm: {
    requestCount: warm.length,
    medianResponseMs: percentile(warmLatencies, 0.5),
    p95ResponseMs: percentile(warmLatencies, 0.95),
    minResponseMs: Number(Math.min(...warmLatencies).toFixed(2)),
    maxResponseMs: Number(Math.max(...warmLatencies).toFixed(2)),
    totalIndexReadBytes: warm.reduce((total, sample) => total + sample.indexReadBytes, 0),
    totalGeometryReadBytes: warmGeometryBytes,
    totalCandidatePayloadBaselineBytes: warmCandidateBytes,
    meanGeometryPayloadReductionRatio: warmCandidateBytes > 0
      ? Number((1 - warmGeometryBytes / warmCandidateBytes).toFixed(4))
      : null,
    allIndexReadsServedFromMemory: warm.every((sample) => sample.indexReadBytes === 0),
    allFeatureHashesMatchCold: warm.every((sample) => sample.featureSha256 === cold.featureSha256),
  },
  runObservations: [cold, ...warm].map(({ featureSha256, ...sample }) => ({
    ...sample,
    featureSha256,
  })),
  methodology: {
    coldDefinition: "First valid bounded viewport request after a fresh Next.js production server starts; readiness probes use invalid bounds and do not query tile/index files.",
    warmDefinition: "Consecutive identical viewport requests on the same server process after the cold sample.",
    latency: "Client-observed request through response-body download; does not isolate server CPU time or claim a general speedup.",
    serverTimings: "X-Building-Timing-* headers use node:perf_hooks phase durations for tile query, manifest lookup, tile-index read/parse, candidate metadata scan, selected geometry read subphases (range planning, open, range read, JSON parse, integrity check, close), feature selection/assembly, fallback GeoJSON preparation, role classification and JSON serialization. Geometry subphases are nested within selectedGeometryReadMs and must not be added to it; timings are diagnostic, not a complete accounting of framework/network/GPU time.",
    geometryFeatureCache: "Cache hits and misses count selected tile-backed feature records. Entries are keyed by tile path, current data-file size/mtime signature, byte offset/length and feature identity, bounded to 4 MiB of source-record bytes and 6000 entries. Hits avoid geometry-file reads and JSON parsing; misses still pass the original bounds and render-role integrity checks.",
    bytes: "Candidate payload is a whole-selected-tile baseline. Index and selected geometry bytes are application-reported reads, not physical disk I/O.",
    correctness: "Ordered response feature hashes and feature counts must match across cold and warm requests.",
  },
};

const artifactPath = resolve(
  process.cwd(),
  process.env.P2_11_REPORT_PATH ?? "test-results/p2-11-cold-warm-viewport-benchmark.json",
);
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log("[P2.11 cold/warm viewport benchmark]", JSON.stringify(report));

