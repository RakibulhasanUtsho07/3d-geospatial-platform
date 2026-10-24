# P2 — OGC 3D Tiles 1.1 Pilot

## P2.0 deliverable: manifest contract gate

This step adds a deterministic, dependency-free validator for a proposed `tileset.json`. It does not claim to convert the current Overture GeoJSON into 3D Tiles or render a real tileset.

The validator checks:
- `asset.version = "1.1"`, top-level and per-tile geometric errors.
- One valid bounding-volume form (`region`, `box`, or `sphere`) per tile.
- Relative content URIs only; absolute URLs and parent-directory traversal are rejected.
- Valid `ADD` / `REPLACE` refinement values.
- Bounded hierarchy depth and tile count to avoid unbounded manifest traversal.

## Why this precedes renderer integration

A Cesium 3D Tileset API can load a syntactically valid manifest while source geometry is incorrectly positioned, bounded, or attributed. This gate catches structural errors but cannot prove geographic accuracy, GLB validity, texture integrity, licensing, or visual fidelity.

## Next pilot steps
1. Produce a small, licensed/attributed Dhaka tile sample with an explicit WGS84-to-ECEF placement strategy.
2. Validate its manifest and every referenced content file; record SHA-256 hashes and source/build metadata.
3. Load it through Cesium's 3D Tiles API behind an opt-in feature flag, with teardown and cancellation tests.
4. Compare the same camera views against the GeoJSON baseline on the same machine; record cold/warm cache separately.
5. Expand coverage only after geometry, bounds, camera framing, and memory behavior pass review.

## Verification
Run `npm run test:3d-tiles-manifest`. This is a structural gate only; no real-data performance claim is made.
