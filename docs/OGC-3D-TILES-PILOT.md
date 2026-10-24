# P2 — OGC 3D Tiles 1.1 Pilot

## P2.0 — Manifest contract gate

A deterministic, dependency-free validator checks `tileset.json` asset version, geometric errors, bounding-volume forms, relative content URIs, refinement values, hierarchy depth and tile count.

## P2.1 — Dhaka placement and integrity fixture

`scripts/build-dhaka-3d-tiles-fixture.mjs` selects a stable Polygon/MultiPolygon feature from the Dhaka Overture pilot extract and generates a small 3D Tiles 1.1 tileset with a GLB rectangular-prism fixture. The footprint dimensions come from the selected feature bounds; the root tile maps local east/north/up coordinates to WGS84 ECEF (EPSG:4978), and the root region uses radians.

The generated `build-manifest.json` records dataset attribution, source/file and feature SHA-256, source bounds, coordinate systems, transform, and SHA-256/byte counts for `tileset.json` and the GLB. The GLB is deliberately a synthetic box with an explicitly synthetic 8 m height. It is not a building reconstruction, measured height, survey deliverable or proof of visual fidelity.

## P2.2 — Opt-in Cesium runtime integration

The default map still uses the current GeoJSON building layer. The experimental tileset is loaded only when the app is built with:

```bash
NEXT_PUBLIC_DHAKA_3D_TILES_PILOT=true npm run build
```

The existing `prebuild` and `predev` hooks create the small fixture under `public/experimental/dhaka-3d-tiles-fixture/`. Cesium loads `/experimental/dhaka-3d-tiles-fixture/tileset.json` using `Cesium3DTileset.fromUrl`; tile content is resolved from the same-origin static asset directory. This is an explicit build-time public environment flag, not a runtime toggle.

The dedicated controller owns the load/attach/remove lifecycle. If the map is disabled or destroyed while `fromUrl` is pending, its revision is invalidated and a late tileset is destroyed instead of being attached to the stale viewer. Cesium's public `fromUrl` API used here does not expose a cancellation signal for the underlying network request; the controller guarantees attachment cancellation and resource cleanup for late results, not guaranteed transport-level abort.

The controller emits `map:dhaka-3d-tiles-pilot` lifecycle events for diagnostics. When the feature flag is enabled, browser integration checks verify the manifest and GLB requests, manifest contract, ECEF transform metadata, and successful attachment event. These are integration checks, not a visual survey-accuracy claim.

## Verification commands

```bash
npm run test:3d-tiles-manifest
npm run test:dhaka-3d-tiles-fixture
npm run test:dhaka-3d-tiles-pilot-controller
npm run test:map-browser
```

## Limits and next step

The pilot GLB is synthetic and its dimensions cannot demonstrate architectural reconstruction accuracy. The current checks establish the manifest/content URL flow, ECEF placement metadata, resource lifecycle and deterministic hashes. They do not yet measure FPS/memory, prove view-to-view visual accuracy or replace the GeoJSON layer.

Next: run a repeatable camera-view comparison near the selected fixture, record the exact model/source hashes and confirm that the tileset's loaded content aligns with the source footprint. Only then compare cold/warm render and memory metrics against the GeoJSON baseline on the same machine.
