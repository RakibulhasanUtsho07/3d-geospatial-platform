# Dynamic Map Engine — Phase 4–6 Verification

This record closes the engineering work for map optimization, runtime visual-policy verification, and stabilization. It separates repeatable automated evidence from real-world visual sign-off.

## Phase 4 — Optimization / measured improvement

The reference-versus-optimized microbenchmark is documented in [MAP-PERFORMANCE-BASELINE.md](./MAP-PERFORMANCE-BASELINE.md). On the recorded GitHub Actions runner (Node v24.21.0, Linux x64, 4 reported CPUs; 5 warm-ups and 21 measured samples), the synthetic CPU results were:

| Operation | Reference median / p95 | Optimized median / p95 | Median reduction |
| --- | ---: | ---: | ---: |
| Select 48 facade LOD records from 5,000 candidates | 1.272 / 1.656 ms | 0.198 / 0.253 ms | 84.4% |
| Flatten 600 roads × 36 vertices | 1.202 / 1.245 ms | 0.126 / 0.222 ms | 89.5% |

Before timing, the benchmark verifies exact record ordering and road-coordinate parity. These numbers measure two CPU algorithms in a synthetic fixture. They are **not** end-to-end map latency, FPS, GPU time, or a guarantee for live Dhaka data.

Repeat locally with:

```bash
npm run test:map-optimization
npm run benchmark:map-optimization
```

For the browser/device comparison, capture at least three cold and three warm runs using the same viewport, browser, device, and network conditions; compare `viewport.fetch`, `viewport.stage`, `roads.fetch`, and `roads.render` p50/p95 separately.

## Phase 5 — Visual quality / runtime verification

The Cesium adapter now reports a low-cardinality style summary alongside its existing rendered-feature counts. The browser fixture test verifies that styles reach the actual map-engine staging path, not just a standalone helper:

- A source-tagged building uses the blue facade colour, ochre roof colour, and painted-balcony pattern described by the fixture tags.
- Four road classes are rendered with distinct surface colours and width ranges.
- An arterial receives centre-line detail.
- A bridge uses raised geometry and a tunnel uses lowered geometry.
- Rendered-way and rendered-extrusion counts match the deterministic fixture.

Automated checks demonstrate that source/style policies are applied consistently to the fixture. They do **not** prove that real Dhaka footprints, heights, road tags, shadows, or building occlusion are visually correct. The final real-data sign-off remains a release checklist item; inspect dense and sparse Dhaka viewports at wide, mid, and street-level zoom and retain screenshots with the candidate SHA.

Run the policy and browser checks with:

```bash
npm run test:map-optimization
npm run test:building-style
npm run test:road-network
npm run test:map-browser
```

## Phase 6 — Stabilization / release gate

A green CI workflow covers lint, the production build, map policy tests, spatial-tile/API checks, and the deterministic Chromium map interaction fixture for its candidate commit. The latest pre-change main commit recorded for this task was `1fda28f52a1087ced2b312ef954ed6d1fe376fde`, whose CI run succeeded: [GitHub Actions run #39832904681](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39832904681). The runtime visual-QA additions in this branch must be evaluated by CI again before merging.

Release decision:

- **Engineering implementation:** complete.
- **Prior main CI:** passed for the commit above.
- **Expanded runtime visual assertions:** added; pending CI on this revision.
- **Real-Dhaka human visual review:** still required before calling the map visually signed off for release.

Use [DYNAMIC-MAP-RELEASE-CHECKLIST.md](./DYNAMIC-MAP-RELEASE-CHECKLIST.md) for the final release gate and rollback procedure.

## Known limitations

1. Buildings are Overture-derived extrusions, not survey-grade BIM or photogrammetry. A height may be source-provided or estimated; procedural facade/roof details must not be presented as verified architecture.
2. Road coverage depends on OpenStreetMap tagging and Overpass availability. Untagged width values are class/lane estimates; unmapped private roads and stale/missing tags are expected.
3. The road corridor layer is for visualization, not turn-by-turn routing, engineering dimensions, cadastral boundaries, or legal right-of-way use.
4. The synthetic fixture uses a deterministic, transparent basemap tile to keep CI offline and repeatable. It cannot validate basemap provider quality, live OSM/Overpass coverage, real-world building alignment, or user-device GPU behaviour.
5. Benchmark results are machine-specific. No universal FPS/latency SLA is claimed.
6. A successful automated gate is not automatic publication approval. Record a reviewer, candidate SHA, data/tile revision, browser/OS/GPU, cold/warm benchmark snapshots, screenshots, known defects, and rollback SHA before release.
