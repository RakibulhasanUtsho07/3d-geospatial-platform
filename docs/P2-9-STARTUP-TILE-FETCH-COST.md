# P2.9 — Startup tile and feature-fetch cost

## Change

- Increase the Overture pilot spatial grid from **0.005° to 0.01°** so a startup viewport intersects fewer populated tile files.
- Emit a compact per-tile feature index containing each feature's stable identity, exact geometry bounds, and UTF-8 byte offset/length in the existing GeoJSON tile.
- Read only byte ranges for features whose indexed bounds intersect the request. Small gaps between adjacent records are coalesced into bounded reads (2 KiB gap, 64 KiB window) to avoid a read syscall per feature.
- Keep the GeoJSON collection format, response feature cap, role-aware spatial sampling, exact viewport intersection, oversized-feature sidecar, and indexed-GeoJSON fallback.

## Safety and coverage

The coarser tile grid is only a storage grouping. The query still tests each feature's bounds against the exact requested viewport before reading geometry bytes, then applies the existing bounded spatial selection. Tile copies crossing grid boundaries are deduplicated by indexed identity. The feature index is schema-checked, path-constrained, byte-range-checked against the tile size, and verified against the decoded feature bounds. Invalid/missing generated artifacts fall back to the existing source GeoJSON path.

## Diagnostics

The viewport API adds:

- `X-Building-Candidate-Bytes`: complete size of all selected tile files (the prior whole-tile read cost estimate).
- `X-Building-Feature-Read-Bytes`: bytes actually read from indexed tile payloads, including coalesced gaps.
- `X-Building-Fetched-Feature-Count`: feature records read before cross-tile deduplication.

Existing tile-count and candidate-feature headers remain available. The spatial-tile test compares the new selected tile count with a reconstructed 0.005° baseline for the representative Dhaka startup viewport; the API integration test checks that selective bytes/feature reads do not exceed the full-selected-tile baseline.

## Regeneration

Run `npm run build:geospatial-tiles` after changing the pilot GeoJSON. The generated manifest is schema version 2 and each `tiles/*.geojson` file has a sibling `*.geojson.index.json` index. The runtime rejects unsupported manifest/index schemas and uses the full GeoJSON-index fallback instead of serving an unvalidated index.
