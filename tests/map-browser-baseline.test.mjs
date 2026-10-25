import assert from "node:assert/strict";
import test from "node:test";

import { classifyResourceUrl, resolveRoadReadiness, summarizeValues, validateMapReadyState } from "../scripts/benchmark-map-browser.mjs";

test("summarizes browser samples using nearest-rank p50 and p95", () => {
  assert.deepEqual(summarizeValues([10, 20, 30, 40, 50]), {
    sampleCount: 5,
    min: 10,
    median: 30,
    p95: 50,
    max: 50,
    mean: 30,
  });
});

test("ignores non-finite values and represents empty series explicitly", () => {
  assert.deepEqual(summarizeValues([Number.NaN, Infinity, null, 10, 20]), {
    sampleCount: 2,
    min: 10,
    median: 10,
    p95: 20,
    max: 20,
    mean: 15,
  });
  assert.deepEqual(summarizeValues([]), {
    sampleCount: 0,
    min: null,
    median: null,
    p95: null,
    max: null,
    mean: null,
  });
});

test("classifies resource groups without returning request paths or query values", () => {
  const origin = "http://127.0.0.1:3000";
  assert.equal(classifyResourceUrl(origin + "/api/geospatial/viewport?west=90.4&south=23.7", origin), "api");
  assert.equal(classifyResourceUrl(origin + "/cesium/Assets/approximateTerrainHeights.json", origin), "cesium-assets");
  assert.equal(classifyResourceUrl(origin + "/_next/static/chunks/app.js", origin), "static-assets");
  assert.equal(classifyResourceUrl("https://tile.openstreetmap.org/1/2/3.png", origin), "third-party");
  assert.equal(classifyResourceUrl("not a url", origin), "unknown");
});

test("classifies lookalike hosts as third-party without exposing URL details", () => {
  const origin = "https://maps.example.test";
  assert.equal(classifyResourceUrl("https://maps.example.test.evil.invalid/api/secret?token=private", origin), "third-party");
  assert.equal(classifyResourceUrl("https://maps.example.test:444/api/viewport?west=90.4", origin), "third-party");
});

test("summarizes unsorted duplicate timing samples deterministically", () => {
  assert.deepEqual(summarizeValues([40, 10, 10, 30, 20]), {
    sampleCount: 5,
    min: 10,
    median: 20,
    p95: 40,
    max: 40,
    mean: 22,
  });
});

test("does not call a canvas-only map ready without a successful viewport stage", () => {
  assert.equal(validateMapReadyState({
    hasError: false,
    telemetryAvailable: true,
    canvasCount: 1,
    viewportStageSuccessCount: 0,
    stagedFeatureCount: 120,
  }), false);
  assert.equal(validateMapReadyState({
    hasError: false,
    telemetryAvailable: true,
    canvasCount: 1,
    viewportStageSuccessCount: 1,
    stagedFeatureCount: 0,
  }), false);
});

test("accepts a map readiness record only when a viewport staged real building features", () => {
  assert.equal(validateMapReadyState({
    hasError: false,
    telemetryAvailable: true,
    canvasCount: 2,
    viewportStageSuccessCount: 1,
    stagedFeatureCount: 157,
  }), true);
});

test("rejects map readiness when initialization fails or telemetry is unavailable", () => {
  const valid = {
    hasError: false,
    telemetryAvailable: true,
    canvasCount: 1,
    viewportStageSuccessCount: 1,
    stagedFeatureCount: 12,
  };
  assert.equal(validateMapReadyState({ ...valid, hasError: true }), false);
  assert.equal(validateMapReadyState({ ...valid, telemetryAvailable: false }), false);
  assert.equal(validateMapReadyState({ ...valid, canvasCount: 0 }), false);
});

test("records road rendering only when a render event follows a successful fetch", () => {
  assert.deepEqual(resolveRoadReadiness({ recentEvents: [
    { sequence: 10, metric: "roads.fetch", outcome: "success", durationMs: 14000 },
    { sequence: 11, metric: "roads.render", outcome: "success", durationMs: 850, featureCount: 14 },
  ] }), {
    fetchSequence: 10,
    fetchOutcome: "success",
    fetchDurationMs: 14000,
    renderSequence: 11,
    renderOutcome: "success",
    renderDurationMs: 850,
    renderedFeatureCount: 14,
    status: "rendered",
  });
  assert.equal(resolveRoadReadiness({ recentEvents: [
    { sequence: 10, metric: "roads.fetch", outcome: "success", durationMs: 14000 },
  ] }), null);
});

test("separates road service errors and cancellation from successful building-stage readiness", () => {
  assert.deepEqual(resolveRoadReadiness({ recentEvents: [
    { sequence: 12, metric: "roads.fetch", outcome: "error", durationMs: 2390 },
  ] }), { fetchSequence: 12, fetchOutcome: "error", fetchDurationMs: 2390, status: "fetch-error" });
  assert.deepEqual(resolveRoadReadiness({ recentEvents: [
    { sequence: 12, metric: "roads.fetch", outcome: "cancelled", durationMs: 1200 },
  ] }), { fetchSequence: 12, fetchOutcome: "cancelled", fetchDurationMs: 1200, status: "fetch-cancelled" });
  assert.equal(resolveRoadReadiness({ recentEvents: [
    { sequence: 12, metric: "roads.fetch", outcome: "success", durationMs: 100 },
    { sequence: 11, metric: "roads.render", outcome: "success", durationMs: 10 },
  ] }), null);
});

test("a later successful retry supersedes an earlier roads fetch error", () => {
  assert.deepEqual(resolveRoadReadiness({ recentEvents: [
    { sequence: 3, metric: "roads.fetch", outcome: "error", durationMs: 18000 },
    { sequence: 4, metric: "roads.fetch", outcome: "success", durationMs: 2600 },
    { sequence: 5, metric: "roads.render", outcome: "success", durationMs: 320, featureCount: 3 },
  ] }), {
    fetchSequence: 4,
    fetchOutcome: "success",
    fetchDurationMs: 2600,
    renderSequence: 5,
    renderOutcome: "success",
    renderDurationMs: 320,
    renderedFeatureCount: 3,
    status: "rendered",
  });
});

test("a successful road fetch is not ready until a following render event completes", () => {
  assert.equal(resolveRoadReadiness({ recentEvents: [
    { sequence: 4, metric: "roads.fetch", outcome: "success", durationMs: 2600 },
    { sequence: 3, metric: "roads.render", outcome: "success", durationMs: 320 },
  ] }), null);
});

test("does not count empty or unverified road-render telemetry as road-ready", () => {
  const empty = resolveRoadReadiness({ recentEvents: [
    { sequence: 6, metric: "roads.fetch", outcome: "success", durationMs: 300 },
    { sequence: 7, metric: "roads.render", outcome: "success", durationMs: 5, featureCount: 0 },
  ] });
  assert.equal(empty.status, "render-empty");
  assert.equal(empty.renderedFeatureCount, 0);

  const unverified = resolveRoadReadiness({ recentEvents: [
    { sequence: 8, metric: "roads.fetch", outcome: "success", durationMs: 300 },
    { sequence: 9, metric: "roads.render", outcome: "success", durationMs: 5 },
  ] });
  assert.equal(unverified.status, "render-unverified");
  assert.equal(unverified.renderedFeatureCount, null);
});
