# P2.11 — Controlled cold/warm viewport benchmark and first-building readiness

## Goal

Compare the real generated-tile viewport endpoint across a controlled first request and repeat requests, then measure the map's first populated building commit and the following Cesium render frame using one browser performance clock.

## Controlled API benchmark

CI starts a fresh Next.js production server and first checks readiness with an invalid viewport request. That request is rejected before tile/index selection and does not populate the tile caches. Before the API integration suite or browser workload begins, `scripts/benchmark-viewport-cold-warm.mjs` sends one bounded Dhaka viewport request, then five identical requests.

The JSON artifact is `test-results/p2-11-cold-warm-viewport-benchmark.json`. It records:
- client-observed end-to-end response-body latency for the first request and warm p50/p95/min/max;
- whole selected-tile payload baseline, compact-index bytes, selected geometry bytes, and combined read reduction ratio;
- returned/fetched feature counts and selected tile count;
- SHA-256 of the ordered feature response, so correctness remains comparable between cold and warm runs.

The test deliberately does not enforce a millisecond speedup threshold: hosted CI latency is noisy and this measurement does not isolate server CPU, storage latency, or OS page-cache effects. Instead it asserts that the first valid request reads compact indexes, repeated requests read zero index bytes, the response feature hash/count stay identical, geometry stays within the response budget, and reported combined reads stay below the whole-tile payload baseline.

## Browser first-building readiness

The real multi-tile Playwright workload now records viewport-fetch start and response completion inside the browser. Those timestamps share the same `performance.now()` timebase as the building-stage and `map:frame-ready` events. The report adds `readiness.firstBuilding`:
- request start to the first populated building stage for the startup viewport;
- completed browser response body to that stage;
- building stage to its next actual Cesium postRender frame;
- returned feature and rendered building counts, plus the matching hashed viewport and frame sequence.

The test requires the startup viewport to return features, commit rendered buildings, and be followed by a real postRender frame. Raw viewport bounds are not included in the saved lifecycle diagnostics; reports use the existing short SHA-256 viewport hash.

## Limitations

These results apply to the generated Overture pilot tiles and the CI production-build configuration. Client-observed latency includes transport/body download and runtime scheduling. The cold/warm comparison demonstrates the application index-cache behavior, not a general throughput promise. First-building readiness confirms that buildings were staged and a Cesium frame followed; it is not a pixel-level visual-quality or ground-truth accuracy score.
