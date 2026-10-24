# P2 — OGC 3D Tiles 1.1 Pilot

## P2.0 — Manifest contract gate

A deterministic, dependency-free validator checks `tileset.json` asset version, geometric errors, bounding-volume forms, relative content URIs, refinement values, hierarchy depth and tile count.

## P2.1 — Dhaka placement and integrity fixture

`scripts/build-dhaka-3d-tiles-fixture.mjs` selects a stable Polygon/MultiPolygon feature from the Dhaka Overture pilot extract and generates a small 3D Tiles 1.1 tileset with a GLB rectangular-prism fixture. The footprint dimensions come from the selected feature bounds; the root tile maps local east/north/up coordinates to WGS84 ECEF (EPSG:4978), and the root region uses radians.

The generated `build-manifest.json` records dataset attribution, source/file and feature SHA-256, source bounds, coordinate systems, transform, and SHA-256/byte counts for `tileset.json` and the GLB. The GLB is deliberately a synthetic box with an explicitly synthetic 8 m height. It is not a building reconstruction, measured height, survey deliverable or proof of visual fidelity.

## P2.2 — Opt-in Cesium runtime integration

The default map still uses the current GeoJSON building layer. The experimental tileset is loaded only when the app is built with this explicit flag:

```bash
NEXT_PUBLIC_DHAKA_3D_TILES_PILOT=true npm run build
```

The normal `prebuild` and `predev` hooks generate the small fixture under `public/experimental/dhaka-3d-tiles-fixture/`. When the flag is enabled, Cesium loads `/experimental/dhaka-3d-tiles-fixture/tileset.json` via `Cesium3DTileset.fromUrl`; its relative GLB URI resolves to the same-origin static asset. The flag is build-time configuration rather than a run-time UI toggle. Without the flag, the controller does not request or attach a tileset, and the GeoJSON baseline remains unchanged.

The dedicated controller owns the load/attach/remove lifecycle. If the map is disabled or destroyed while `fromUrl` is pending, its revision is invalidated and a late tileset is destroyed instead of being attached to an obsolete viewer. Cesium's public `fromUrl` API used here does not expose a cancellation signal for the underlying network request; the controller guarantees attachment cancellation and cleanup of late results, not transport-level abort.

The controller emits `map:dhaka-3d-tiles-pilot` lifecycle events for diagnostics. When the feature flag is enabled, browser integration checks verify the manifest request, relative GLB request, manifest version, ECEF transform metadata and successful attachment event. The lifecycle tests cover opt-in behavior, duplicate loads, disable-during-load, viewer replacement and destroy cleanup.

## Verification commands

```bash
npm run test:3d-tiles-manifest
npm run test:dhaka-3d-tiles-fixture
npm run test:dhaka-3d-tiles-pilot-controller
npm run test:map-browser
```

CI explicitly enables the flag for its production build so the runtime/browser path is exercised; this is not the default user build configuration.

## Limits and next step

The pilot GLB is synthetic and its dimensions cannot demonstrate architectural reconstruction accuracy. The current checks establish manifest/content URL flow, ECEF placement metadata, resource lifecycle and deterministic hashes. They do not yet prove visible on-screen alignment against independently measured geometry or measure FPS/memory.

Next: use a repeatable camera view at the selected feature, record source/model hashes, verify the rendered footprint against source/reference imagery, and then compare cold/warm render and memory metrics against the GeoJSON baseline on the same machine. Do not claim performance gains until measured.
