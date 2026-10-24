# P2.12 — Cross-process viewport benchmark regression guard

## Goal

Check whether the P2.11 cold/warm results remain deterministic across two independent Next.js production processes, while recording latency differences without fragile CI speed thresholds.

## CI execution

After building once, CI starts the production app on ports 3000 and 3001. These are independent Node processes that share the same immutable build output and generated spatial tile manifest, so their module-level tile-index caches start independently. Readiness probes use invalid viewport bounds (HTTP 400) before either benchmark, which returns before tile/index selection.

- Process A writes `test-results/p2-11-cold-warm-viewport-benchmark.json`.
- Process B writes `test-results/p2-12-run-b.json`.
- `scripts/compare-viewport-benchmark-runs.mjs` writes `test-results/p2-12-cold-warm-regression-guard.json`.

## Hard regression checks

The comparator asserts that both processes use the same viewport, feature limit, and spatial-tile manifest hash. It requires exact matches for selected tile count, candidate/matched/returned feature counts, whole-tile baseline bytes, cold index bytes, selected geometry bytes, combined-read reduction ratio, and the ordered feature SHA-256. Both cold requests must read index bytes; all repeated warm requests must read zero index bytes and preserve the same feature hash. It also verifies the response feature budget and positive geometry-payload reduction.

## Latency reporting

Cold elapsed time and warm median/p95 are reported side-by-side, including the difference between processes. They are not hard-gated: scheduled CI runner load and operating-system cache behavior can produce meaningful latency variation without a code regression. The deterministic read counts, response hash, dataset identity and cache-state expectations are the enforced regression contract.

## Limitations

This is a process-cache repeatability check against one generated build, not a clean-room repeat build. Application byte counters and the whole-selected-tile baseline do not measure physical disk I/O. The separate processes share the same filesystem and may share OS page-cache state. It does not claim visual accuracy or a guaranteed wall-clock speedup.
