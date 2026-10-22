import assert from "node:assert/strict";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { flattenRoadCoordinates } from "../src/core/geospatial/flatten-road-coordinates.mjs";
import { selectNearestLodRecords } from "../src/core/map-engine/lod-record-selection.mjs";

const WARMUP_RUNS = 5;
const SAMPLE_RUNS = 21;
const BUILDING_COUNT = 5000;
const FACADE_BUDGET = 48;
const ROAD_COUNT = 600;
const VERTICES_PER_ROAD = 36;

const records = Array.from({ length: BUILDING_COUNT }, (_, index) => ({
  id: String(index),
  isPart: index % 17 === 0,
  distance: ((index * 104729) % 999983) / 7 + (index % 11) / 100,
}));

const roads = Array.from({ length: ROAD_COUNT }, (_, roadIndex) =>
  Array.from({ length: VERTICES_PER_ROAD }, (_, vertexIndex) => [
    90.2 + ((roadIndex + vertexIndex * 0.1) % 100) / 10000,
    23.6 + ((roadIndex * 0.3 + vertexIndex) % 100) / 10000,
  ]),
);

function legacyFullSort(recordsToSelect, limit) {
  return recordsToSelect
    .filter((record) => Number.isFinite(record.distance) && record.distance >= 0)
    .map((record, index) => ({ record, index, distance: record.distance }))
    .sort((left, right) => {
      if (left.record.isPart !== right.record.isPart) return left.record.isPart ? -1 : 1;
      return left.distance - right.distance || left.index - right.index;
    })
    .slice(0, limit)
    .map((entry) => entry.record.id);
}

function optimizedBoundedSelection() {
  return selectNearestLodRecords(records, FACADE_BUDGET, (record) => record.distance)
    .map((record) => record.id);
}

function legacyFlatten(coordinates) {
  return coordinates.flatMap(([longitude, latitude]) => [longitude, latitude]);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(name, run) {
  for (let index = 0; index < WARMUP_RUNS; index += 1) run();
  const samples = [];
  let checksum = 0;
  for (let index = 0; index < SAMPLE_RUNS; index += 1) {
    const startedAt = performance.now();
    checksum += Number(run()) || 0;
    samples.push(performance.now() - startedAt);
  }
  return {
    name,
    medianMs: Number(median(samples).toFixed(3)),
    p95Ms: Number([...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1].toFixed(3)),
    checksum,
    samples: SAMPLE_RUNS,
  };
}

function relativeReduction(referenceMs, optimizedMs) {
  if (referenceMs <= 0) return null;
  return Number(((referenceMs - optimizedMs) / referenceMs * 100).toFixed(1));
}

const referenceSelection = legacyFullSort(records, FACADE_BUDGET);
const optimizedSelection = optimizedBoundedSelection();
assert.deepEqual(optimizedSelection, referenceSelection, "Bounded LOD selection must preserve the previous ordering.");

for (let index = 0; index < roads.length; index += 1) {
  assert.deepEqual(
    flattenRoadCoordinates(roads[index]),
    legacyFlatten(roads[index]),
    "Preallocated coordinate preparation must preserve every valid point.",
  );
}

const sortResult = measure("full-sort LOD selection", () => legacyFullSort(records, FACADE_BUDGET).length);
const boundedResult = measure("bounded top-K LOD selection", () => optimizedBoundedSelection().length);
const flattenReference = measure("flatMap road coordinates", () => {
  let length = 0;
  for (const road of roads) length += legacyFlatten(road).length;
  return length;
});
const flattenOptimized = measure("preallocated road coordinates", () => {
  let length = 0;
  for (const road of roads) length += flattenRoadCoordinates(road).length;
  return length;
});

console.log(JSON.stringify({
  benchmark: "dynamic-map-optimization-microbench",
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpuCount: os.cpus().length,
  },
  fixtures: {
    buildings: BUILDING_COUNT,
    facadeBudget: FACADE_BUDGET,
    roads: ROAD_COUNT,
    verticesPerRoad: VERTICES_PER_ROAD,
    warmupRuns: WARMUP_RUNS,
    samples: SAMPLE_RUNS,
  },
  measurements: {
    facadeLodSelection: {
      reference: sortResult,
      optimized: boundedResult,
      medianLatencyReductionPercent: relativeReduction(sortResult.medianMs, boundedResult.medianMs),
      retainedRecords: FACADE_BUDGET,
      referenceSortsEveryEligibleRecord: BUILDING_COUNT,
      optimizedRetainsOnlyBudgetCandidates: FACADE_BUDGET,
    },
    roadCoordinatePreparation: {
      reference: flattenReference,
      optimized: flattenOptimized,
      medianLatencyReductionPercent: relativeReduction(flattenReference.medianMs, flattenOptimized.medianMs),
      pointOrderAndValuesVerified: true,
      nestedIntermediateArraysRemoved: true,
    },
  },
  note: "Synthetic CPU microbenchmark; results compare algorithms in the same process and are not end-to-end browser/GPU/Dhaka-data latency.",
}, null, 2));
