# Real-Dhaka Map Baseline — 2026-10-25

## First run and provenance

- Initial automated browser baseline: [GitHub Actions run #40157388201](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40157388201)
- Candidate code SHA: `76032ec65ab9d57069d2ce69c7e6c39fa20a0faa`
- Retained artifact: `real-dhaka-browser-baseline-76032ec65ab9d57069d2ce69c7e6c39fa20a0faa` (artifact ID 12585286968; contains `report.json`, six PNG screenshots and the development-server log).
- Environment: Node v24.21.0, Linux x64, 4 reported CPU cores, Playwright Chromium 156.0.8078.4, headless, 1280 × 800, device scale factor 1.
- Overture tile manifest: 8,250 bytes; SHA-256 `9a5c59a08b37c3661a2c31a250c168e7f9d87d200bb0d9b316a4aa1939cd6e63`.
- Dhaka pilot GeoJSON: 10,111,710 bytes; SHA-256 `f05f14b1cf983c823adf605dc3131f2cf3029afd8ac873d54017155d22fe5f90`.
- Both data files existed. The report marked the working tree dirty after setup/build steps; the exact source SHA and input hashes are the reproducibility anchors.

## Initial results (building-stage ready, not full-layer ready)

| Metric | Cold (n=3) | Warm (n=3) |
|---|---:|---:|
| Successful map/building-stage samples | 3/3 | 3/3 |
| Load to building-stage ready: median | 10,768 ms | 9,107 ms |
| Load to building-stage ready: p95 | 11,717 ms | 9,807 ms |
| Viewport fetch p50 across samples | 785–2,342 ms | 169–688 ms |
| Viewport stage p50 across samples | 5,591–8,145 ms | 5,902–7,187 ms |
| Road API behavior | successful requests completed after some screenshots | one warm attempt returned HTTP 502; failed fetch telemetry was about 2,390 ms |

The development server log shows successful road requests taking roughly 13.2–17.5 seconds. They completed after some screenshots had already been taken, so the first run's load-to-map-ready measure does not represent full layer readiness.

## Visual review of the first six screenshots

- All six PNGs are present and have SHA-256 digests in the report. The canvas is populated with 3D extruded buildings; there is no fully blank map.
- Building shapes and roofs remain simple/block-like at this scale. This run does not verify the true height or facade accuracy of individual buildings.
- Left layer and right property panels obscure substantial map area, limiting coverage inspection.
- OSM raster imagery differs between reloads. Cold-02 and cold-03 have the same pixel hash; other samples show different imagery/tile states, so basemap imagery had not settled identically at capture time.
- Road rendering is a reliability/performance risk: the log contains 13.2–17.5 second successful fetches and one HTTP 502.

## Corrective action and acceptance decision

**Status: first baseline captured; refined baseline in progress.**

The first run validates 3/3 cold and 3/3 warm building-stage checks. It does not close P3.1 because it captured images before roads reached a terminal state and did not persist the explicit readiness object. The revised harness waits for the road fetch/render outcome and saves, per sample, the staged feature count, road status, road terminal timing and screenshot digest. It records HTTP failure/timeouts instead of treating a ready canvas as a fully ready map.

The CI runner is Linux/SwiftShader and is not a proxy for every end-user GPU. No FPS, survey-grade building accuracy or production SLA is claimed.


## Follow-up finding: retry timing

- Refined baseline run: [GitHub Actions run #40159047454](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40159047454), artifact ID 12585775596.
- Building-stage readiness passed in all 6 samples (3 cold + 3 warm; 3,000 features staged per sample). The first road fetch in every sample ended in an error after about 18.0–18.5 seconds, with no road-render event in the captured telemetry.
- The server log also showed additional same-bounds road route responses with HTTP 200 roughly 2.1–2.6 seconds after some 504 responses. Those responses were not represented by the telemetry snapshot used to capture the corresponding PNG, so the previous run does **not** prove those later responses rendered roads.
- All six screenshots had the same SHA-256. The missing evidence was whether a follow-up road request was still in flight or subsequently rendered after the first failure.

**Corrective action:** the benchmark now tracks road API request lifecycle, records road-specific HTTP status counts and pending requests, waits for a configurable retry quiet period after failure, and requires a later `roads.render` success before reporting road-ready.
