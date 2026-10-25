# P0 — Real-Dhaka Map Performance & Visual Baseline

This is the repeatable first-stage baseline for measuring the live browser map before refactoring the adapter or changing its rendering path. It supplements the synthetic CPU microbenchmark; it does not replace it.

## What the runner records

- Candidate Git commit, working-tree state, Node/platform/CPU details, browser version and fixed viewport size.
- SHA-256 and byte size for the local Overture tile manifest and source GeoJSON, when those files exist on the benchmark machine.
- Navigation-to-usable-map timing and browser navigation/paint timings.
- Existing map-engine telemetry for viewport fetch/staging and road fetch/render/coverage, including p50/p95, errors and cache-hit counts.
- Resource timings grouped into API, Cesium assets, static assets, same-origin other and third-party resources. Query strings and individual feature coordinates are not written to the report.
- Long-task count/duration where Chromium exposes the Long Tasks API, JavaScript heap usage where supported, grouped response status codes, and a screenshot SHA-256 digest for every measured run.

The screenshot digest identifies the image captured with the report; it does not guarantee identical rasterization or external map tiles across machines.

## Run a real-data baseline

1. Use the same source checkout and local Overture data/tile build as the candidate being measured.
2. Install dependencies with **npm ci** and ensure Cesium assets/model build steps have completed.
3. In terminal A, start Next.js in development mode with **npm run dev**. Map telemetry is deliberately development-only.
4. In terminal B, run **npm run benchmark:map-browser**. The default URL is http://127.0.0.1:3000/map, the viewport is 1280 × 800, and the runner captures three cold-context samples followed by three warm-browser-cache samples.
5. Keep the timestamped folder under **artifacts/map-performance-baseline/**, including report.json and the PNG screenshots.

The default measures the initial camera configured by the current source. For another repeatable camera/location, set MAP_BENCHMARK_URL to a stable route and describe it with MAP_BENCHMARK_SCENARIO. URL query strings are omitted from the report to avoid persisting viewport coordinates.

## Optional environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| MAP_BENCHMARK_URL | http://127.0.0.1:3000/map | URL to benchmark |
| MAP_BENCHMARK_SCENARIO | map-initial-camera | Descriptive scenario name |
| MAP_BENCHMARK_WIDTH | 1280 | Browser viewport width |
| MAP_BENCHMARK_HEIGHT | 800 | Browser viewport height |
| MAP_BENCHMARK_COLD_RUNS | 3 | Fresh-context cold samples, 1–10 |
| MAP_BENCHMARK_WARM_RUNS | 3 | Reloads after an unmeasured warm-up, 1–10 |
| MAP_BENCHMARK_SETTLE_MS | 5000 | Wait after map readiness |
| MAP_BENCHMARK_READY_TIMEOUT_MS | 90000 | Maximum wait for map readiness |
| MAP_BENCHMARK_HEADLESS | 1 | Set to 0 to open Chromium visibly |
| MAP_BENCHMARK_OUT_DIR | Timestamped artifacts folder | Optional output folder |
| MAP_BENCHMARK_COMMIT_SHA | Current Git HEAD | Optional explicit candidate SHA |

For a quicker smoke run, set both sample counts to 1 and the settle interval to 1000 ms. Do not treat a smoke run as release baseline evidence.

## How to compare candidates

Compare cold with cold and warm with warm. Preserve browser version, device/GPU, viewport, data hashes and scenario. Use the median and p95 of load-to-map-ready and the separate telemetry p50/p95s; do not add fetch and staging durations together because browser work may overlap. Review screenshots side by side at matching dimensions, and record visual defects separately from timing changes.

Interpretation limits:
- Cold means a fresh browser context plus Chromium HTTP-cache clearing. It does not clear DNS, OS, CDN, server or provider caches.
- Warm means reuse of that context's browser HTTP cache. A full page reload resets the JavaScript app and in-memory map cache.
- Cross-origin byte sizes may be zero when browser timing policy hides them.
- The current default camera targets Ahsan Manzil. This is a repeatable landmark view, not proof of citywide 3D coverage. Dense-city and street-level scenarios should be added after capturing this initial baseline.
- The map uses Cesium request-render mode, so a plain requestAnimationFrame loop would measure browser scheduling rather than actual drawn frames. This tool makes no FPS claim.
- CI does not run against live data because browser/GPU, OSM, API availability and local data files vary. Run the benchmark on the target workstation and retain its evidence.

## P0 exit criteria

P0 is measured—not merely implemented—only after a real-data run has at least three successful cold and three successful warm samples; records the candidate SHA and relevant local data hashes or explicitly notes missing inputs; contains viewport/road telemetry where those layers are triggered; and includes six screenshots reviewed for blank canvases, gaps, alignment/occlusion and loading regressions. Record browser/OS/GPU details and known visual defects with that review.

The script and deterministic helper tests create the evidence bundle. A real-Dhaka report and human visual sign-off must still be produced from the developer's local runtime; CI alone cannot establish either.
