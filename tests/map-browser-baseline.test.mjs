import assert from "node:assert/strict";
import test from "node:test";

import { classifyResourceUrl, summarizeValues } from "../scripts/benchmark-map-browser.mjs";

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
