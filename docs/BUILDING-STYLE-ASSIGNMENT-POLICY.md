# Building Style Assignment Policy

## Scope

Pure policy for saved building style assignments and selected-building previews. Cesium graphics creation remains in `BuildingLodRenderer`; selection/material lifecycle stays in `CesiumAdapter`.

## Decisions covered

- Validate required feature IDs and the three core hexadecimal palette colors.
- Index assignments by exact feature ID with later valid duplicate entries replacing earlier valid entries.
- Resolve the assigned or source-derived baseline.
- Detect baseline/preview/height changes that require graphics to be reapplied.
- Only let preview-supplied height/floor values override geometry height selection; pattern-only previews keep baseline geometry.
- Preserve detailed rendering for selected or already-detailed records during baseline changes.

## Verification

Run `npm run test:building-style-assignment-policy`. The CI step exercises these pure decisions and the adapter-to-policy boundary. This extraction does not claim a rendering-performance gain.
