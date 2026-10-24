# P2 — OGC 3D Tiles 1.1 Pilot

## P2.0 deliverable: manifest contract gate

A deterministic, dependency-free validator checks `tileset.json` asset version, geometric errors, bounding-volume forms, relative content URIs, refinement values, hierarchy depth and tile count.

## P2.1 deliverable: Dhaka placement and integrity fixture

`scripts/build-dhaka-3d-tiles-fixture.mjs` selects a stable Polygon/MultiPolygon feature from the Dhaka Overture pilot extract and generates a small 3D Tiles 1.1 tileset with a GLB rectangular-prism fixture. The footprint dimensions are based on the selected source feature's geographic bounds, and the root tile transform maps a local east/north/up frame into WGS84 ECEF (EPSG:4978). The tileset region uses radians and ellipsoid-height bounds (EPSG:4979).

The generated `build-manifest.json` records:
- Source dataset/file attribution, source SHA-256 and source-feature SHA-256.
- Selected feature identity and source footprint bounds.
- Geographic coordinates, transform convention and the complete root transform.
- SHA-256 and byte count for `tileset.json` and the referenced GLB.
- The manifest-validator result and tile count.

The fixture GLB is deliberately a synthetic box. Its height is an explicit test placeholder, not inferred building height; it is not a reconstruction, survey deliverable, or proof of visual fidelity. Source attribution is preserved as `© OpenStreetMap contributors, Overture Maps Foundation`.

Run:
- `npm run test:3d-tiles-manifest`
- `npm run test:dhaka-3d-tiles-fixture`

These tests verify manifest structure, resolvable relative content, GLB chunk/accessor layout, independent ECEF translation math, bounding region coverage, attribution, hashes and deterministic rebuilds.

## Why this precedes renderer integration

A structurally valid tileset can still render incorrectly or use unsuitable geometry. The current validator and fixture do not prove real-building geometry accuracy, correct source height, texture integrity, live Cesium loading, memory behavior or performance.

## Next pilot steps

1. Load the fixture via Cesium's 3D Tiles API behind an opt-in feature flag, with explicit teardown and cancellation tests.
2. Capture repeatable camera views and verify that the georeferenced fixture aligns with the GeoJSON viewport.
3. Compare the same views against the GeoJSON baseline on the same machine; record cold/warm cache separately.
4. Expand from the test fixture only after bounds, camera framing, memory behavior, source evidence and visual fidelity pass review.
