import assert from "node:assert/strict";
import test from "node:test";
import { buildRepeatabilityReport, quantile, summarizeLatency } from "../scripts/viewport-latency-repeatability.mjs";

const manifestSha256 = "9a5c59a08b37c3661a2c31a250c168e7f9d87d200bb0d9b316a4aa1939cd6e63";
const featureSha256 = "72c389f2e19388327f217acdb7d9063035db7819de518382e68ef57e439bb64";

function makeServerTimings(offset = 0) {
  return {
    totalServerMs: 12 + offset,
    tileQueryMs: 8 + offset,
    manifestLookupMs: 0.2 + offset / 10,
    tileIndexReadAndParseMs: 2 + offset / 5,
    candidateMetadataScanMs: 1 + offset / 5,
    oversizedSidecarReadMs: 0,
    featureSelectionMs: 0.5 + offset / 10,
    selectedGeometryReadMs: 1 + offset / 5,
    geometryRangePlanningMs: 0.05 + offset / 100,
    geometryFileOpenMs: 0.1 + offset / 100,
    geometryRangeReadMs: 0.2 + offset / 10,
    geometryJsonParseMs: 0.3 + offset / 10,
    geometryIntegrityCheckMs: 0.2 + offset / 10,
    geometryFileCloseMs: 0.05 + offset / 100,
    geometryReadMs: 1 + offset / 5,
    featureAssemblyMs: 0.3 + offset / 10,
    fallbackGeoJsonPreparationMs: 0,
    roleClassificationMs: 0.1 + offset / 10,
    responseSerializationMs: 0.4 + offset / 10,
  };
}

function makeSample(index, coldMs = 140 + index * 5) {
  const observations = [];
  const cold = {
    sequence: 1, phase: "cold-first-valid-request", elapsedMs: coldMs, statusCode: 200,
    selectedTileCount: 4, candidateFeatureCount: 15207, matchedFeatureCount: 7107,
    returnedFeatureCount: 2500, candidatePayloadBytes: 9007328, indexReadBytes: 4442393,
    featureReadBytes: 2532626, combinedReadBytes: 6975019, combinedReadReductionRatio: 0.2256,
    fetchedFeatureCount: 2500, geometryFeatureCacheHits: 0, geometryFeatureCacheMisses: 2500,
    geometryFeatureCacheEntries: 2500, geometryFeatureCacheBytes: 2500, geometryFeatureCacheEvictions: 0,
    geometryFeatureCacheOversizedRejections: 0, geometryFeatureCacheInvalidations: 0,
    featureLimit: 2500, featureSha256,
    serverTimingsMs: makeServerTimings(index),
  };
  observations.push(cold);
  const warmLatencies = [50 + index, 58 + index, 62 + index, 67 + index, 84 + index];
  for (let i = 0; i < warmLatencies.length; i += 1) observations.push({
    sequence: i + 2, phase: "warm-repeat", elapsedMs: warmLatencies[i], statusCode: 200,
    selectedTileCount: 4, candidateFeatureCount: 15207, matchedFeatureCount: 7107,
    returnedFeatureCount: 2500, candidatePayloadBytes: 9007328, indexReadBytes: 0,
    featureReadBytes: 0, combinedReadBytes: 0, combinedReadReductionRatio: 1,
    fetchedFeatureCount: 2500, geometryFeatureCacheHits: 2500, geometryFeatureCacheMisses: 0,
    geometryFeatureCacheEntries: 2500, geometryFeatureCacheBytes: 2500, geometryFeatureCacheEvictions: 0,
    geometryFeatureCacheOversizedRejections: 0, geometryFeatureCacheInvalidations: 0,
    featureLimit: 2500, featureSha256,
    serverTimingsMs: makeServerTimings(index + i / 10),
  });
  return {
    benchmark: "p2.11-controlled-cold-warm-viewport",
    candidateSha: "test-candidate-sha",
    spatialTileManifestSha256: manifestSha256,
    viewport: {
      bounds: { west: 90.405, south: 23.775, east: 90.415, north: 23.785 },
      boundsSha256: "viewport-hash",
      featureLimit: 2500,
    },
    cold,
    warm: {
      requestCount: 5, medianResponseMs: warmLatencies[2], p95ResponseMs: warmLatencies[4],
      minResponseMs: warmLatencies[0], maxResponseMs: warmLatencies[4], totalIndexReadBytes: 0,
      totalGeometryReadBytes: 0, totalCandidatePayloadBaselineBytes: 45036640,
      meanGeometryPayloadReductionRatio: 1, allIndexReadsServedFromMemory: true,
      allFeatureHashesMatchCold: true,
    },
    runObservations: observations,
  };
}

test("computes interpolated quantiles and robust descriptive spread", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  const summary = summarizeLatency([10, 20, 30, 40]);
  assert.equal(summary.medianMs, 25);
  assert.equal(summary.iqrMs, 15);
  assert.equal(summary.minMs, 10);
  assert.equal(summary.maxMs, 40);
  assert.equal(summary.sampleCount, 4);
});

test("aggregates repeated fresh-process cold/warm samples with deterministic data checks", () => {
  const result = buildRepeatabilityReport([0, 1, 2, 3].map((index) => makeSample(index)), {
    generatedAt: "2026-10-24T00:00:00.000Z",
    nodeVersion: "v24.21.0",
  });
  assert.equal(result.benchmark, "p2.15-fresh-process-viewport-latency-repeatability");
  assert.equal(result.environment.independentFreshProcessCount, 4);
  assert.equal(result.latency.coldFirstValidRequestMs.sampleCount, 4);
  assert.equal(result.latency.perProcessWarmMedianMs.sampleCount, 4);
  assert.equal(result.latency.pooledWarmRequestMs.sampleCount, 20);
  assert.equal(result.serverPhaseTiming.coldFirstRequestMsByPhase.tileQueryMs.sampleCount, 4);
  assert.equal(result.serverPhaseTiming.pooledWarmRequestMsByPhase.totalServerMs.sampleCount, 20);
  assert.equal(result.serverPhaseTiming.pooledWarmRequestMsByPhase.geometryJsonParseMs.sampleCount, 20);
  assert.equal(result.samples[0].cold.serverTimingsMs.tileQueryMs, 8);
  assert.equal(result.samples[0].cold.serverTimingsMs.geometryIntegrityCheckMs, 0.2);
  assert.equal(result.samples[0].warm.serverTimingMsByPhase.totalServerMs.sampleCount, 5);
  assert.equal(result.byteCost.coldIndexReadsVerified, true);
  assert.equal(result.byteCost.zeroWarmIndexReadsVerified, true);
  assert.equal(result.samples[0].cold.geometryFeatureCacheMisses, 2500);
  assert.equal(result.samples[0].cold.geometryFeatureCacheEntries, 2500);
  assert.deepEqual(result.samples[0].warm.geometryFeatureCacheMissCounts, [0, 0, 0, 0, 0]);
  assert.deepEqual(result.samples[0].warm.geometryFeatureCacheEvictionCounts, [0, 0, 0, 0, 0]);
  assert.deepEqual(result.samples[0].warm.geometryFeatureCacheInvalidationCounts, [0, 0, 0, 0, 0]);
  assert.equal(result.dataset.sameOrderedFeatureHashAcrossProcesses, true);
});

test("rejects samples collected from different spatial-tile manifests", () => {
  const samples = [0, 1, 2].map((index) => makeSample(index));
  samples[2].spatialTileManifestSha256 = "0".repeat(64);
  assert.throws(() => buildRepeatabilityReport(samples), /manifest changed across fresh-process samples/);
});

test("rejects a repeated sample that no longer has cold index reads", () => {
  const samples = [0, 1, 2].map((index) => makeSample(index));
  samples[1].cold.indexReadBytes = 0;
  assert.throws(() => buildRepeatabilityReport(samples), /must read the tile index/);
});

test("rejects response hash changes between repeated process cold samples", () => {
  const samples = [0, 1, 2].map((index) => makeSample(index));
  samples[1].cold.featureSha256 = "a".repeat(64);
  samples[1].runObservations[0].featureSha256 = "a".repeat(64);
  assert.throws(() => buildRepeatabilityReport(samples), /cold.featureSha256 changed/);
});
