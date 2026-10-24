import assert from "node:assert/strict";
import test from "node:test";
import { buildRepeatabilityReport, quantile, summarizeLatency } from "../scripts/viewport-latency-repeatability.mjs";

const manifestSha256 = "9a5c59a08b37c3661a2c31a250c168e7f9d87d200bb0d9b316a4aa1939cd6e63";
const featureSha256 = "72c389f2e19388327f217acdb7d9063035db7819de518382e68ef57e439bb64";

function makeSample(index, coldMs = 140 + index * 5) {
  const observations = [];
  const cold = {
    sequence: 1, phase: "cold-first-valid-request", elapsedMs: coldMs, statusCode: 200,
    selectedTileCount: 4, candidateFeatureCount: 15207, matchedFeatureCount: 7107,
    returnedFeatureCount: 2500, candidatePayloadBytes: 9007328, indexReadBytes: 4442393,
    featureReadBytes: 2532626, combinedReadBytes: 6975019, combinedReadReductionRatio: 0.2256,
    fetchedFeatureCount: 2500, featureLimit: 2500, featureSha256,
  };
  observations.push(cold);
  const warmLatencies = [50 + index, 58 + index, 62 + index, 67 + index, 84 + index];
  for (let i = 0; i < warmLatencies.length; i += 1) observations.push({
    sequence: i + 2, phase: "warm-repeat", elapsedMs: warmLatencies[i], statusCode: 200,
    selectedTileCount: 4, candidateFeatureCount: 15207, matchedFeatureCount: 7107,
    returnedFeatureCount: 2500, candidatePayloadBytes: 9007328, indexReadBytes: 0,
    featureReadBytes: 2532626, combinedReadBytes: 2532626, combinedReadReductionRatio: 0.7188,
    fetchedFeatureCount: 2500, featureLimit: 2500, featureSha256,
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
      totalGeometryReadBytes: 12663130, totalCandidatePayloadBaselineBytes: 45036640,
      meanGeometryPayloadReductionRatio: 0.7188, allIndexReadsServedFromMemory: true,
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
  assert.equal(result.byteCost.coldIndexReadsVerified, true);
  assert.equal(result.byteCost.zeroWarmIndexReadsVerified, true);
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
