# P2.20 — Viewport movement cache-reuse benchmark

## Goal

Validate selected-geometry cache behavior under a small, deterministic camera-navigation path rather than only repeating one fixed viewport. The benchmark runs against the production viewport API in a single process and captures pan/zoom observations.

## Workload

The request path is:
1. A Dhaka viewport shifted east from the standard cold/warm benchmark bounds.
2. A narrower view inside that viewport to represent zooming in.
3. A northwest pan into a partially different area.
4. A return to the exact first bounds.

The feature limit is fixed at 900 by default (P2_20_FEATURE_LIMIT may be set from 100 to 2500). Every request must use generated tiles, return nonempty features, preserve the response limit, and expose the P2.19 cache diagnostics.

## Assertions and evidence

- Each response's selected-geometry cache stays within 6,000 entries and 4 MiB of accounted source-record bytes.
- Movement visits at least one viewport that causes cache misses and demonstrates cache hits.
- Evictions, oversized-entry rejections and invalidations remain cumulative nondecreasing counters.
- Returning to the exact first bounds reproduces the same feature count and SHA-256 of the ordered serialized feature list, while producing selected-geometry cache hits.
- Per-step latency, bounds, cache counters, index/geometry bytes read and feature hashes are saved to test-results/p2-20-viewport-movement-cache.json.

## CI integration

The script runs after the existing viewport benchmark and API checks against the already-running production server. It therefore intentionally does not claim to be a cold-start experiment: earlier CI requests may already have warmed some cache entries. The purpose is to verify same-process reuse, bounds-safe cache accounting and response stability through navigation.

## Limits

The byte budget counts indexed source-record byte lengths, not exact V8 heap memory. Viewport selection and feature limit can change which features are returned at different bounds; the equality assertion applies only to the repeated exact bounds. The benchmark records a controlled CI workload and is not a guarantee of production latency.
