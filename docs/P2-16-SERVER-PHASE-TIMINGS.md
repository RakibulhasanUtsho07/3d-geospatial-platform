# P2.16 — Server-side viewport phase timings

## Goal

Identify where viewport request time is spent inside the API instead of inferring server behavior from client-observed elapsed time alone. The API adds response timing headers while preserving the same FeatureCollection body and existing byte/cache diagnostics.

## Timing contract

Successful viewport responses include `X-Building-Timing-Version: p2.16` and millisecond-valued `X-Building-Timing-*` headers:

- `Total-Server-Ms`: valid-request route processing through JSON serialization (does not include network transfer, Next.js framework overhead outside the handler, or browser/GPU rendering).
- `Tile-Query-Ms`: overall generated-tile query path.
- `Manifest-Lookup-Ms`, `Tile-Index-Read-And-Parse-Ms`, and `Candidate-Metadata-Scan-Ms`: metadata lookup and selection-candidate preparation phases.
- `Oversized-Sidecar-Read-Ms` and `Selected-Geometry-Read-Ms`: payload work for sidecar and selected tile geometry; `Geometry-Read-Ms` is their sum.
- `Feature-Selection-Ms` and `Feature-Assembly-Ms`: selecting the response budget and assembling returned features.
- `Fallback-Geo-Json-Preparation-Ms`: fallback GeoJSON read/index/intersection preparation when generated tiles cannot be used.
- `Role-Classification-Ms` and `Response-Serialization-Ms`: role counters and final JSON stringify.

Phase durations are sampled using `node:perf_hooks` and returned as diagnostic headers. The API benchmark checks all expected headers and records `serverTimingsMs` on each cold and warm observation. The P2.15 fresh-process aggregate summarizes each phase separately for cold requests and pooled warm observations, alongside the client-observed latency distribution.

## Regression behavior

Existing ordered feature hashes, feature counts, selected-tile baseline bytes, index-read counters, geometry-read counters and response feature budgets remain unchanged and remain guarded. API tests assert that repeated identical viewport requests have identical JSON bodies despite the extra timing headers. Millisecond phase timings are recorded, not hard-gated on a strict duration, since one hosted runner can be noisy.

## Interpretation and limitations

These measurements cover selected operations inside the handler, not a complete accounting of all CPU or async overhead. `Tile-Query-Ms` is an enclosing duration and must not be added to its sub-phases. Similarly, `Total-Server-Ms` encloses route phases and is not an additive phase. The phase measurements are intended to help locate hotspots, not to sum to a wall-clock browser latency. Disk byte counters remain application-reported reads and are not physical disk I/O. Browser/GPU/native Cesium work and network transfer are outside these server-side timings.
