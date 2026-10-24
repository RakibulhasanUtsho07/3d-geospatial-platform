# P2 — OGC 3D Tiles 1.1 Pilot

## P2.0 — Manifest contract gate

A deterministic, dependency-free validator checks `tileset.json` asset version, geometric errors, bounding-volume forms, relative content URIs, refinement values, hierarchy depth and tile count.

## P2.1 — Dhaka placement and integrity fixture

`scripts/build-dhaka-3d-tiles-fixture.mjs` selects a stable Polygon/MultiPolygon feature from the Dhaka Overture pilot extract and generates a small 3D Tiles 1.1 tileset with a GLB rectangular-prism fixture. The footprint dimensions come from the selected feature bounds; the root tile maps a local right-handed glTF frame (X=east, Y=up, Z=south) to WGS84 ECEF (EPSG:4978), and the root region uses radians.

The generated `build-manifest.json` records dataset attribution, source/file and feature SHA-256, source bounds, coordinate systems, transform, and SHA-256/byte counts for `tileset.json` and the GLB. The GLB is deliberately a synthetic box with an explicitly synthetic 8 m height. It is not a building reconstruction, measured height, survey deliverable or proof of visual fidelity.

## P2.2 — Opt-in Cesium runtime integration

The default map still uses the current GeoJSON building layer. The experimental tileset is loaded only when the app is built with this explicit flag:

```bash
NEXT_PUBLIC_DHAKA_3D_TILES_PILOT=true npm run build
```

The normal `prebuild` and `predev` hooks generate the fixture and then alignment evidence under `public/experimental/dhaka-3d-tiles-fixture/`. When the flag is enabled, Cesium loads `/experimental/dhaka-3d-tiles-fixture/tileset.json` via `Cesium3DTileset.fromUrl`. The dedicated controller owns attach/remove lifecycle; when the viewer is disabled or destroyed during pending loading, a late tileset is destroyed instead of being attached to an obsolete viewer. Cesium's public `fromUrl` API used here does not expose a cancellation signal for the underlying network request, so this guarantees attachment cancellation/resource cleanup, not transport-level abort.

The controller emits `map:dhaka-3d-tiles-pilot` lifecycle events. A loaded event includes the Cesium tileset's world-space bound converted to WGS84 coordinates so browser integration tests can compare runtime placement with the source anchor.

## P2.3 — Deterministic footprint-envelope alignment review

`scripts/review-dhaka-3d-tiles-alignment.mjs`:
- Re-hashes the source dataset, selected source feature, tileset and GLB and stops if these no longer match the immutable build manifest.
- Independently checks that the root matrix is finite, orthonormal and right-handed with the glTF Y-up axis convention.
- Transforms the four GLB ground-box corners through the column-major ECEF matrix and converts them back to WGS84; verifies each corner lies in the tileset region and compares it with the source feature's geographic bounding-box corners.
- Writes `alignment-review.json` with a tolerance-bound residual report and five deterministic north/east/south/west/oblique camera presets sharing the same target. The same source/model hashes and fixed camera metadata produce byte-identical evidence.

Run the review directly with:

```bash
npm run build:dhaka-3d-tiles-fixture
npm run review:dhaka-3d-tiles-alignment
npm run test:dhaka-3d-tiles-alignment-review
```

The browser CI check additionally reads the generated evidence and compares Cesium's runtime world-space center against the anchor from the loaded manifest. The five presets are repeatable review inputs; this command does not itself capture rendered screenshots.

## Verification commands

```bash
npm run test:3d-tiles-manifest
npm run test:dhaka-3d-tiles-fixture
npm run test:dhaka-3d-tiles-pilot-controller
npm run test:dhaka-3d-tiles-alignment-review
npm run test:map-browser
```

CI explicitly enables the flag for the production build so the runtime/browser path is exercised; ordinary builds remain opt-in.

## Limits and next step

P2.3 validates a rectangular GLB footprint envelope against the source feature's bounding rectangle, not its exact Polygon/MultiPolygon outline. The model height and shape remain synthetic, and visual facade accuracy is not validated. The fixed camera presets are not proof of screenshot similarity. The next stage is to capture actual Cesium frames from these views, record their SHA-256 alongside source/model hashes, and compare them against source imagery or a reference rendering. Performance comparisons must separately measure cold/warm render time and memory on the same machine.
