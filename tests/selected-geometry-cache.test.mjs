import assert from "node:assert/strict";
import test from "node:test";

import {
  createSelectedGeometryCache,
  createSelectedGeometryCacheKey,
} from "../src/core/geospatial/selected-geometry-cache.mjs";

const tileRecord = (overrides = {}) => ({
  identity: "building-01",
  role: "building",
  offset: 128,
  length: 64,
  bounds: { west: 90.4, south: 23.7, east: 90.401, north: 23.701 },
  ...overrides,
});

test("LRU access refreshes recency and evicts the least-recently-used entry", () => {
  const cache = createSelectedGeometryCache({ maxBytes: 10, maxEntries: 3 });
  cache.set("a", { id: "a" }, 3);
  cache.set("b", { id: "b" }, 3);
  assert.equal(cache.get("a").id, "a");
  cache.set("c", { id: "c" }, 5);

  assert.equal(cache.get("a").id, "a");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("c").id, "c");
  assert.deepEqual(cache.getStats(), {
    entries: 2,
    bytes: 8,
    maxBytes: 10,
    maxEntries: 3,
    evictions: 1,
    oversizedRejections: 0,
  });
});

test("byte and entry caps both constrain retained cache contents under memory pressure", () => {
  const cache = createSelectedGeometryCache({ maxBytes: 9, maxEntries: 2 });
  cache.set("large-a", { id: "a" }, 4);
  cache.set("large-b", { id: "b" }, 4);
  cache.set("small-c", { id: "c" }, 3);

  assert.equal(cache.get("large-a"), undefined, "byte pressure should evict the oldest entry");
  assert.equal(cache.get("large-b").id, "b");
  assert.equal(cache.get("small-c").id, "c");
  cache.set("d", { id: "d" }, 1);

  assert.equal(cache.get("large-b"), undefined, "entry-count pressure should evict the LRU item");
  assert.equal(cache.get("small-c").id, "c");
  assert.equal(cache.get("d").id, "d");
  const stats = cache.getStats();
  assert.ok(stats.bytes <= stats.maxBytes);
  assert.ok(stats.entries <= stats.maxEntries);
  assert.equal(stats.evictions, 2);
});

test("an entry larger than the complete byte budget is rejected without evicting useful entries", () => {
  const cache = createSelectedGeometryCache({ maxBytes: 5, maxEntries: 2 });
  cache.set("keep", { id: "keep" }, 3);

  assert.equal(cache.set("too-large", { id: "too-large" }, 6), false);
  assert.equal(cache.get("keep").id, "keep");
  assert.equal(cache.get("too-large"), undefined);
  assert.deepEqual(cache.getStats(), {
    entries: 1,
    bytes: 3,
    maxBytes: 5,
    maxEntries: 2,
    evictions: 0,
    oversizedRejections: 1,
  });
});

test("updating a key replaces its prior byte accounting instead of double counting", () => {
  const cache = createSelectedGeometryCache({ maxBytes: 10, maxEntries: 2 });
  cache.set("a", { value: 1 }, 4);
  cache.set("a", { value: 2 }, 6);

  assert.equal(cache.get("a").value, 2);
  assert.equal(cache.getStats().entries, 1);
  assert.equal(cache.getStats().bytes, 6);
});

test("a changed tile file signature invalidates old geometry cache keys", () => {
  const record = tileRecord();
  const before = createSelectedGeometryCacheKey({
    relativeFile: "tiles/x1_y2.geojson",
    dataSignature: "size:4096|mtime:1000",
    record,
  });
  const after = createSelectedGeometryCacheKey({
    relativeFile: "tiles/x1_y2.geojson",
    dataSignature: "size:4096|mtime:2000",
    record,
  });
  const cache = createSelectedGeometryCache();
  cache.set(before, { id: "old-geometry" }, record.length);

  assert.notEqual(after, before);
  assert.equal(cache.get(after), undefined);
  assert.equal(cache.get(before).id, "old-geometry");
});

test("cache keys also change when indexed identity, role, offsets, or bounds change", () => {
  const relativeFile = "tiles/x1_y2.geojson";
  const dataSignature = "size:4096|mtime:1000";
  const base = createSelectedGeometryCacheKey({ relativeFile, dataSignature, record: tileRecord() });
  const changes = [
    tileRecord({ identity: "building-02" }),
    tileRecord({ role: "building_part" }),
    tileRecord({ offset: 256 }),
    tileRecord({ bounds: { west: 90.4, south: 23.7, east: 90.402, north: 23.701 } }),
  ];

  for (const record of changes) {
    assert.notEqual(
      createSelectedGeometryCacheKey({ relativeFile, dataSignature, record }),
      base,
    );
  }
});

test("clear releases retained records and resets diagnostic counters", () => {
  const cache = createSelectedGeometryCache({ maxBytes: 8, maxEntries: 2 });
  cache.set("a", { id: "a" }, 4);
  cache.set("b", { id: "b" }, 4);
  cache.get("a");
  cache.set("c", { id: "c" }, 4); // evicts b
  cache.clear();

  assert.deepEqual(cache.getStats(), {
    entries: 0,
    bytes: 0,
    maxBytes: 8,
    maxEntries: 2,
    evictions: 0,
    oversizedRejections: 0,
  });
});
