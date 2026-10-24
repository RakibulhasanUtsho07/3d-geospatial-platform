# P2.19 — Geometry cache eviction, invalidation and memory-pressure validation

## Goal

Make the selected-geometry cache policy directly testable, verify that its byte and entry caps hold under synthetic memory pressure, and prove that file signature changes stop stale geometry from being reused.

## Shared production policy

The route now uses `src/core/geospatial/selected-geometry-cache.mjs`, the same bounded LRU policy exercised by the unit tests. Defaults remain 4 MiB of accounted source-record bytes and 6,000 entries. Reads refresh LRU order. Inserts evict the oldest entries until both limits hold. A record larger than the entire byte budget is rejected without evicting useful cached entries. Replacing an existing key updates byte accounting rather than double-counting it.

The byte count is the indexed source-record length, not a claim about exact V8 heap memory. The entry cap adds a second bound because parsed JavaScript objects can occupy more memory than their JSON source text.

## Signature invalidation

Each selected-geometry key includes the tile path, current data-file signature, byte offset and length, feature identity, render role and all four indexed bounds. The route tracks the last signature observed for each tile. It scans and purges cached entries for that tile only when the signature changes, releasing the accounted byte budget before the changed file is queried again. Cache misses still undergo the existing JSON shape, geometry-bounds and render-role checks before they can be cached.

## Diagnostics

Viewport responses expose cache entry count, accounted bytes, cumulative LRU evictions, oversized-entry rejections and signature invalidations alongside per-request hit/miss counts. The benchmark asserts the observed entry and byte budgets on every request; the fresh-process aggregate preserves cold/warm cache evidence. The API integration test checks that repeat requests keep the same FeatureCollection and reuse geometry without reading its bytes again.

## Tests

`npm run test:selected-geometry-cache` covers recency updates and LRU eviction, byte and entry pressure, oversized-entry rejection without destructive eviction, replacement byte accounting, signature-sensitive keys, invalidation that frees old entries, and explicit clearing of retained state and diagnostics. The CI workflow runs this test alongside existing viewport API, latency-repeatability, benchmark, production build and browser checks.

## Interpretation and limitations

Cache entry/byte metrics are process-local counters. Signature identity uses the same size/mtime metadata as the existing tile index cache, not a cryptographic digest of every tile payload. A changed signature makes old keys ineligible and removes that tile's old entries from the cache. Benchmarks use a fixed CI workload and do not guarantee identical results on every machine or production dataset.
