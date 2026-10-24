# P2.6 — Real Multi-Tile Viewport Workload Benchmark

## Goal

Exercise the live Cesium map against the real Overture viewport API and generated spatial-tile manifest. The existing single-building browser fixture remains a fast deterministic interaction test; this benchmark adds a separate end-to-end workload so the synthetic fixture is not mistaken for production-like performance evidence.

## Workload

The Playwright scenario:

1. Opens `/map` and waits for the initial building stage and a subsequent Cesium `scene.postRender` frame.
2. Uses the actual `/api/geospatial/overture-buildings/viewport` endpoint. Playwright observes the API response headers rather than replacing this endpoint with a one-building fixture.
3. Records selected spatial-tile counts, tile-candidate/feature counts, endpoint response latency, and distinct viewport hashes (raw viewport coordinates are not saved in the report).
4. Delays one browser response after the endpoint has returned, then changes the camera. The stale request should be cancelled by the engine's normal request lifecycle.
5. Repeats eight pan/zoom cycles while sampling Chromium JavaScript heap, DOM nodes, event listeners, and Cesium frame counters.
6. Saves a JSON report and attaches it to the Playwright test result.

OSM imagery and the public road API are stubbed to keep the test repeatable and offline. The Overture viewport API and its spatial-tile reads are **not** stubbed. CI generates `data/overture/spatial-tiles/manifest.json` and its tile files before starting the map server.

## Run locally

From the repository root, install dependencies and generate the spatial tiles:

```bash
npm ci
npm run build:geospatial-tiles
```

Start the map app/server in one terminal. For example, after the normal preparation steps, start Next.js at `http://127.0.0.1:3000`. In another terminal run:

```bash
npm run benchmark:map-workload
```

The command uses `MAP_E2E_BASE_URL` from the existing Playwright configuration if the server is hosted at a different address. To run the complete browser integration suite, use `npm run test:map-browser`; it includes this workload test.

## Output and metrics

The test prints and attaches `multi-tile-viewport-workload.json` and writes a local copy under `test-results/`. The report includes:

- **Tile workload:** endpoint response count, selected tile counts per viewport, candidate/matched/returned feature counts, unique viewport hashes, and repeated-movement request volume.
- **Request lifecycle:** delayed stale-request cancellation, delivered/cancelled/failed request counts, and failure details.
- **Frame readiness:** actual Cesium post-render frame counts plus time from each building-stage log to the next subsequent render frame (p50/p95).
- **Memory trend:** sampled `JSHeapUsedSize`, `JSHeapTotalSize`, DOM-node counts, event-listener counts, heap growth and a simple per-sample linear trend.

The adapter's frame counter is explicitly opt-in through `window.__MAP_ENGINE_WORKLOAD_BENCHMARK__`; it is absent from normal runtime behavior. The diagnostic property is removed during adapter teardown.

## Initial acceptance gates

The test fails when any of the following cannot be demonstrated:

- The real API uses the generated spatial-tile source and at least one viewport selects multiple tiles.
- A stale in-flight viewport request is cancelled after a newer camera intent.
- Multiple viewport payloads reach the Cesium building staging path.
- A real `scene.postRender` frame follows staged building work.
- Chromium exposes enough heap samples to compute the post-movement trend.
- The broad post-run growth guard is exceeded (128 MiB heap increase or 10,000 additional DOM nodes compared with the initial sample).

These are regression guardrails, not a universal latency or memory SLA. Keep the report with the tested commit and compare runs only under equivalent browser, device, server, dataset, and warm/cold-cache conditions.

## Interpretation and limitations

- `endpointResponseMs` is elapsed time observed by the Playwright route handler around the live endpoint request. It is not a server-only CPU profile.
- The intentional response delay tests cancellation of a browser-side stale response. The server may already have finished its tile query before the browser cancels its request.
- Chromium JS heap and DOM counters do not account for GPU allocations, Cesium native resources, browser-process memory, or operating-system memory. They are trend indicators rather than proof of zero leaks.
- The tile count reports generated Overture spatial tiles selected by a viewport; it is not a count of downloaded OGC 3D Tiles payloads.
- The transparent imagery and empty road response deliberately isolate building viewport churn. Real provider latency, road refreshes, mobile GPUs, real frame rate, and visual alignment require separate measurements.
- A passing run is evidence for this defined workload only. Review its JSON metrics and any failure details before claiming that the complete dynamic map engine has a verified production performance profile.
