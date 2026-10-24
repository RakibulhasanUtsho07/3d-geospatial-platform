# Dynamic Map Performance Baseline

## What is measured

The client-side map engine records a bounded rolling window of stage timings:

| Metric | Measurement |
| --- | --- |
| `viewport.fetch` | Building viewport payload lookup, HTTP response and JSON parsing |
| `viewport.stage` | GeoJSON-to-Cesium conversion, batched feature preparation and datasource commit |
| `roads.fetch` | Road viewport HTTP request, response and JSON validation |
| `roads.render` | Road feature-to-Cesium geometry creation and datasource update |
| `roads.coverage` | Reuse of already-rendered road geometry for a covered viewport |

The snapshot reports count, success/cache-hit/error/cancelled counts, average, p50, p95 and maximum latency. Synthetic cache-coverage events are excluded from latency percentiles. The default buffer retains the last 120 events and can never exceed 500 when configured.

## Inspecting the live baseline

Run the app in development mode, open `/map`, and use the browser console:

```js
window.__MAP_ENGINE_PERFORMANCE__?.snapshot()
```

Clear the measurement window before a repeatable manual run:

```js
window.__MAP_ENGINE_PERFORMANCE__?.reset()
```

The interface is development-only. The telemetry schema intentionally excludes request URLs, viewport coordinates, feature properties and user data. No metrics are sent to a third-party service.

## Establishing a comparable baseline

1. Start a fresh development server and open the same map viewport.
2. Reset telemetry, then wait for the building and road layers to finish loading.
3. Record the snapshot, including the browser, device class, viewport size and network profile separately in your benchmark notes.
4. Repeat the same zoom/pan sequence three times; compare p50/p95 for fetch and staging separately.
5. After a performance change, repeat the same setup. Do not compare a warm-cache run against a cold-cache run.

The automated browser suite uses deterministic empty building/road responses to validate lifecycle telemetry, not to claim real Dhaka-data rendering timings. Capture a real-data baseline from the development environment before making performance optimizations based on these numbers.

## Optimization benchmark

The camera-aware facade selector now keeps only the nearest configured detail budget (while preserving part-before-shell priority) instead of sorting every eligible building. Road refreshes group Cesium collection changes into one suspend/resume event batch, and road-coordinate preparation uses a preallocated numeric buffer rather than allocating a temporary pair for each point.

Run the repeatable synthetic comparison:

```bash
npm run test:map-optimization
npm run benchmark:map-optimization
```

The benchmark prints reference/optimized median and p95 timings for 5,000 building candidates with a 48-record facade budget, and for 600 road ways with 36 vertices each. It verifies output parity before timing. These are same-process CPU microbenchmarks; they do not represent total GPU render time or production Dhaka dataset performance. Keep the printed environment and output with any optimization report, and use the browser telemetry above for end-to-end measurements.

## Real multi-tile viewport workload (P2.6)

The browser workload benchmark complements these CPU microbenchmarks with repeated pan/zoom against the live Overture viewport API and generated spatial-tile manifest. It measures selected tile counts, request cancellation, building-stage-to-Cesium-frame readiness, and Chromium heap/DOM trends. The dedicated runbook, metric definitions, commands, acceptance gates, and limitations are in [MULTI-TILE-VIEWPORT-WORKLOAD-BENCHMARK.md](./MULTI-TILE-VIEWPORT-WORKLOAD-BENCHMARK.md).

Run it against a running map server with generated Overture spatial tiles:

```bash
npm run benchmark:map-workload
```

The report is saved and attached by Playwright as `multi-tile-viewport-workload.json`. This is a defined browser workload, not a universal FPS SLA or a substitute for device-specific GPU/native-memory profiling.

## Initial benchmark results recorded in CI

GitHub Actions run [#39831935488](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39831935488), on Node v24.21.0 / Linux x64 / 4 CPUs (5 warm-ups and 21 samples), reported:

| Synthetic operation | Reference median / p95 | Optimized median / p95 | Median reduction |
| --- | ---: | ---: | ---: |
| LOD selection: sort 5,000 candidates for a 48-record facade budget | 1.272 / 1.656 ms | 0.198 / 0.253 ms | 84.4% |
| Coordinate flattening: 600 roads × 36 vertices | 1.202 / 1.245 ms | 0.126 / 0.222 ms | 89.5% |

Both comparisons verified exact selected-record ordering / coordinate values before timing. Treat these as synthetic CPU algorithm measurements from one CI runner, not as an estimate of overall map load time or GPU rendering performance. Re-run the benchmark on the target machine, then use the development diagnostics snapshot with real Dhaka data to establish the local end-to-end change.
