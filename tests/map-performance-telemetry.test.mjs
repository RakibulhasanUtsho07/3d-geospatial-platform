import assert from "node:assert/strict";
import test from "node:test";

import {
  createMapPerformanceTelemetry,
  MAP_PERFORMANCE_METRICS,
} from "../src/core/map-engine/performance-telemetry.mjs";

test("records latency percentiles, outcomes and cache hits by metric", () => {
  let now = 10;
  const telemetry = createMapPerformanceTelemetry({ capacity: 8, now: () => now });

  telemetry.record("viewport.fetch", "success", 40, { featureCount: 125 });
  now += 1;
  telemetry.record("viewport.fetch", "success", 80, { cacheHit: false, featureCount: 200 });
  now += 1;
  telemetry.record("viewport.fetch", "cache-hit", 0, { cacheHit: true });
  telemetry.record("roads.fetch", "error", 120, { statusCode: 502 });
  telemetry.record("roads.render", "cancelled", 5, { returnedWays: 20 });

  const snapshot = telemetry.getSnapshot();
  assert.equal(snapshot.totalEvents, 5);
  assert.equal(snapshot.metrics["viewport.fetch"].count, 3);
  assert.equal(snapshot.metrics["viewport.fetch"].successCount, 2);
  assert.equal(snapshot.metrics["viewport.fetch"].cacheHitCount, 1);
  assert.equal(snapshot.metrics["viewport.fetch"].averageMs, 60);
  assert.equal(snapshot.metrics["viewport.fetch"].p50Ms, 40);
  assert.equal(snapshot.metrics["viewport.fetch"].p95Ms, 80);
  assert.equal(snapshot.metrics["roads.fetch"].errorCount, 1);
  assert.equal(snapshot.metrics["roads.fetch"].maxMs, 120);
  assert.equal(snapshot.recentEvents[3].statusCode, 502);
  assert.equal(snapshot.metrics["roads.render"].cancelledCount, 1);
});

test("the event buffer remains bounded and preserves newest events", () => {
  let now = 0;
  const telemetry = createMapPerformanceTelemetry({ capacity: 3, now: () => now++ });

  for (let index = 0; index < 5; index += 1) {
    telemetry.record("viewport.stage", "success", index + 1, { featureCount: index });
  }

  const snapshot = telemetry.getSnapshot();
  assert.equal(snapshot.capacity, 3);
  assert.equal(snapshot.totalEvents, 3);
  assert.deepEqual(snapshot.recentEvents.map((event) => event.sequence), [3, 4, 5]);
  assert.deepEqual(snapshot.recentEvents.map((event) => event.featureCount), [2, 3, 4]);
  assert.equal(snapshot.lastSequence, 5);
});

test("events keep only allow-listed metadata and clamp invalid measurements", () => {
  const telemetry = createMapPerformanceTelemetry({ now: () => Number.NaN });
  const event = telemetry.record("roads.fetch", "success", Number.POSITIVE_INFINITY, {
    endpoint: "/api/geospatial/roads?west=90.4&south=23.7",
    name: "Private or unneeded feature attribute",
    cacheHit: true,
    returnedWays: 12,
    statusCode: 200,
  });

  assert.equal(event.durationMs, 0);
  assert.equal(event.elapsedMs, 0);
  assert.equal(event.returnedWays, 12);
  assert.equal(event.statusCode, 200);
  assert.equal("endpoint" in event, false);
  assert.equal("name" in event, false);
  assert.equal(JSON.stringify(telemetry.getSnapshot()).includes("90.4"), false);
});

test("invalid configuration, metrics and outcomes are rejected", () => {
  assert.throws(() => createMapPerformanceTelemetry({ capacity: 0 }), /capacity/);
  assert.throws(() => createMapPerformanceTelemetry({ capacity: 501 }), /capacity/);
  assert.throws(() => createMapPerformanceTelemetry({ now: 1 }), /clock/);

  const telemetry = createMapPerformanceTelemetry();
  assert.throws(() => telemetry.record("unknown.metric", "success", 1), /metric/);
  assert.throws(() => telemetry.record("viewport.fetch", "unknown", 1), /outcome/);
  assert.throws(() => telemetry.record("viewport.fetch", "success", 1, null), /details/);
  assert.deepEqual(MAP_PERFORMANCE_METRICS.length, 5);
});

test("reset clears the retained window while keeping sequence monotonic", () => {
  const telemetry = createMapPerformanceTelemetry({ now: () => 1 });
  telemetry.record("viewport.fetch", "success", 10);
  telemetry.reset();
  telemetry.record("viewport.fetch", "success", 20);

  const snapshot = telemetry.getSnapshot();
  assert.equal(snapshot.totalEvents, 1);
  assert.equal(snapshot.recentEvents[0].sequence, 2);
  assert.equal(snapshot.metrics["viewport.fetch"].averageMs, 20);
});
