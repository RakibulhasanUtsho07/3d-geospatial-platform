# P2.13 — Viewport performance trend snapshot

## Goal

Join the P2.12 two-process cold/warm API regression evidence with the P2.6 real multi-tile browser workload, so one artifact records data-fetch cost, process cache behavior, first-building readiness, camera-request cancellation, and memory/DOM observations for the same candidate and spatial-tile dataset.

## CI output

After the browser integration suite, `scripts/build-viewport-performance-trend.mjs` reads:

- `test-results/p2-12-cold-warm-regression-guard.json`
- `test-results/multi-tile-viewport-workload.json`

It writes `test-results/p2-13-viewport-performance-trend.json`, which is uploaded with the rest of `test-results/` as the `multi-tile-viewport-workload` Actions artifact.

## Integrity and regression checks

The report builder checks the P2.12 guard flags, both process manifest hashes, browser-versus-API manifest identity, and candidate SHA when available. It requires valid cold/warm byte measurements, nonzero and valid first-building timing values, a following Cesium postRender frame for each committed stage, final viewport staging, cancellation of the stale delayed request, and a passing existing memory guard. A dedicated node:test suite checks successful aggregation and rejects manifest mismatches or an unstaged final viewport.

## Interpreting the snapshot

Cold/warm API latency and first-building readiness timings are preserved for comparison across CI run artifacts; they are intentionally not hard-gated on milliseconds, because hosted-runner load and OS cache conditions vary. Deterministic hashes, read counters, manifest identity, response budget, stage/cancellation checks, and the existing broad memory guard remain correctness gates.

This is a per-run evidence snapshot, not a database of historical measurements and not an automatic cross-commit trend detector. Compare the generated artifact across commits to inspect real regressions. Application byte counters are not physical disk I/O, and the browser memory sampling omits GPU/native Cesium allocations and process memory.
