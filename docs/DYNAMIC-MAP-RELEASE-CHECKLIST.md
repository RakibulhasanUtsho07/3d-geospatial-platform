# Dynamic Map Release Checklist

A green CI run proves only that the automated checks passed on the exact commit. It does not replace real-data visual inspection or independent survey validation.

## Release gate

- [ ] **Build and code quality:** `npm run lint`, production build, and full CI pass on the candidate SHA.
- [ ] **Unit tests:** viewport cancellation/cache, bounded facade-LOD selection, road-coordinate preparation, road visual-style policy, building-generation and geospatial API tests pass.
- [ ] **Browser interaction:** Chromium map initialization, layer toggle, drag, zoom and fresh viewport requests pass.
- [ ] **Building visuals:** inspect dense/sparse, low/high-rise Dhaka areas; check footprint alignment, height source, part/parent duplicate suppression, selected-building detail, and stale-viewport behavior.
- [ ] **Road visuals:** inspect arterial/collector/local/path contrast, tagged width/surface, bridge/tunnel offsets, label density and building occlusion at wide, mid and street-level zoom.
- [ ] **Measured performance:** use at least three cold and three warm runs on the same browser/device/window size/network profile. Compare `viewport.fetch`, `viewport.stage`, `roads.fetch` and `roads.render` p50/p95 separately; keep snapshots with release notes.
- [ ] **Data and attribution:** verify Overture coverage/height provenance and keep © OpenStreetMap contributors attribution visible for road data; review ODbL obligations before redistributing derived road extracts.
- [ ] **Resilience:** test slow/failed road requests, missing viewport tiles, rapid camera movement, layer hide/show during load and browser resize. A failed refresh should not discard previously good geometry.
- [ ] **Privacy and production:** verify performance diagnostics are absent from production, telemetry remains in memory, and no URLs, exact viewport bounds, feature properties or user data are retained.
- [ ] **Release record:** note commit SHA, browser/OS/GPU, tile/data revision, benchmark samples, known defects, rollback SHA and reviewer.

## Known limitations

1. **No universal FPS or latency guarantee.** Device GPU, browser/WebGL driver, network, dataset size/topology and label count affect performance. The counters are diagnostic, not an SLA.
2. **Synthetic fixtures are not a real-Dhaka visual benchmark.** CI verifies the Cesium geometry pipeline with deterministic sample features; actual Overture/Overpass areas still need human review.
3. **Building heights and facades are data-dependent.** Heights can be sourced or estimated. Procedural roof equipment, facade patterns and colors are visual cues, not evidence of actual architectural details.
4. **Road geometry is OSM-derived.** Private/unmapped roads, stale tags, incomplete width/surface tags and Overpass availability can affect coverage. Untagged widths use lane/class estimates.
5. **Road corridors are not a routable graph.** Styling and bridge/tunnel offsets are for visual discovery, not navigation, engineering dimensions or legal right-of-way decisions.
6. **3D accuracy is not implied by extrusion.** Footprints and extruded walls are not surveyed building models; vertical datum, facade openings and structural details require independent evidence.
7. **Performance snapshots are local and bounded.** The default retains 120 recent events (configurable to at most 500), is not persisted/uploaded, and resets with the map instance.
8. **No automatic publication approval.** Automated gates support review; a release reviewer remains responsible for public-release decisions.

## Rollback

If a regression appears, redeploy the previous known-good SHA or revert the release commit. Preserve the telemetry snapshot, browser/device/network conditions, viewport and data/tile revision with the defect report before retrying.
