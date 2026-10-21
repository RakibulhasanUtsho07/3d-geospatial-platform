import assert from "node:assert/strict";
import test from "node:test";

import {
  cacheViewportResponse,
  getCachedViewportResponse,
} from "../src/core/map-engine/viewport-response-cache.mjs";

test("cache miss returns undefined without changing the cache", () => {
  const cache = new Map([["a", { features: [] }]]);
  assert.equal(getCachedViewportResponse(cache, "missing"), undefined);
  assert.deepEqual([...cache.keys()], ["a"]);
});

test("cache hit marks an entry as most recently used", () => {
  const cache = new Map([
    ["a", { value: 1 }],
    ["b", { value: 2 }],
  ]);

  assert.deepEqual(getCachedViewportResponse(cache, "a"), { value: 1 });
  assert.deepEqual([...cache.keys()], ["b", "a"]);
});

test("bounded cache evicts the least recently used viewport", () => {
  const cache = new Map();
  cacheViewportResponse(cache, "a", { id: "a" }, 2);
  cacheViewportResponse(cache, "b", { id: "b" }, 2);
  getCachedViewportResponse(cache, "a");
  cacheViewportResponse(cache, "c", { id: "c" }, 2);

  assert.deepEqual([...cache.keys()], ["a", "c"]);
  assert.equal(getCachedViewportResponse(cache, "b"), undefined);
});

test("updating an existing key replaces its value and refreshes its order", () => {
  const cache = new Map([
    ["a", { revision: 1 }],
    ["b", { revision: 1 }],
  ]);

  cacheViewportResponse(cache, "a", { revision: 2 }, 2);
  assert.deepEqual([...cache.keys()], ["b", "a"]);
  assert.deepEqual(getCachedViewportResponse(cache, "a"), { revision: 2 });
});

test("cache rejects invalid keys, maps, and capacities", () => {
  assert.throws(() => getCachedViewportResponse([], "a"), /must be a Map/);
  assert.throws(() => cacheViewportResponse(new Map(), "", {}), /non-empty string/);
  assert.throws(() => cacheViewportResponse(new Map(), "a", {}, 0), /positive safe integer/);
  assert.throws(() => cacheViewportResponse(new Map(), "a", {}, 1.5), /positive safe integer/);
});
