# P3.6 — Dhaka multi-building 3D Tiles package pilot

## Purpose

This first P3.6 implementation slice moves beyond the one-content placement fixture by producing a bounded OGC 3D Tiles 1.1 hierarchy with multiple independently addressable GLB tile contents derived from source Dhaka building footprints. The package is intentionally a format/placement pilot; it is not a production-wide converter or a building-accuracy result.

## Inputs and command

Input: a GeoJSON `FeatureCollection` from the local Overture Dhaka pilot extract. The default region is `90.40,23.77,90.42,23.79` (west,south,east,north). The builder does not download third-party data.

```bash
npm run test:dhaka-3d-tiles-package
npm run build:dhaka-3d-tiles-package -- --source data/overture/dhaka-buildings-3d-pilot.geojson --output data/overture/dhaka-3d-tiles-multibuilding-pilot --max-features 32
npm run verify:dhaka-3d-tiles-package -- --package data/overture/dhaka-3d-tiles-multibuilding-pilot
```

Supported options:
- `--source`: local GeoJSON FeatureCollection.
- `--output`: package directory. Writes are restricted to a child path under `data/overture`, `public/experimental`, or the operating-system temporary directory.
- `--max-features`: bounded integer from 1 to 128 (default 32).
- `--height-meters`: explicitly synthetic extrusion height, greater than 0 and at most 250 m (default 8 m).
- `--bbox`: WGS84 extent as `west,south,east,north`.

## Package contract

- `tileset.json`: OGC 3D Tiles 1.1 root with one child tile per emitted source feature. Child content references are relative GLB URIs; each child records a WGS84 region, an ENU-to-ECEF transform and source-feature identity in extras.
- `tiles/*.glb`: glTF 2.0 binary content. Roof triangles are created from a triangulated exterior footprint; side faces are emitted per footprint edge.
- `build-manifest.json`: stable source file SHA-256, selected feature IDs/hashes, coordinate conventions, bounds, tile URIs, asset SHA-256/byte lengths, exclusion counts, validation facts and explicit release flags.
- The package builder validates the generated manifest and then invokes the package-integrity verifier before returning success.

## Geometry selection and exclusions

Only GeoJSON Polygon/MultiPolygon building footprints with simple exterior rings are emitted. Features outside the specified pilot extent, invalid coordinates/degenerate footprints, footprints outside the bounded size range, duplicate IDs, unsupported geometries and polygons with interior rings/holes are excluded and counted. An ear-clipping/mesh-generation failure is fail-closed for that candidate rather than replaced by a bounding-box building.

The selected height is synthetic and uniform for this pilot. Source footprints are preserved as polygon outlines, but this output does not reconstruct facade details, openings, roofs, textures or surveyed elevation. The horizontal projection uses a local east/north approximation around each feature anchor and a WGS84 ECEF transform for global placement. The pilot must not be scaled city-wide without a metric projection strategy, more thorough geometry repair and independent placement review.

## Integrity gate

`verifyTilesetPackage` and `verify:dhaka-3d-tiles-package` check:
- manifest schema and OGC 3D Tiles 1.1 hierarchy limits;
- relative content URI safety, path traversal rejection and package-root containment;
- no symlinked package root, directory, manifest or content asset;
- source hash shape / optional expected-source hash;
- equality between tileset content URIs, build-manifest tile entries and integrity records;
- each listed asset's existence, regular-file status, size cap, exact byte length and SHA-256;
- total package byte limits and explicit fail-closed results for missing or modified content.

A pass proves package format/integrity, not that a GLB actually matches a real building or that Cesium rendered it correctly.

## Validation coverage

The dedicated test suite uses synthetic input footprints and covers:
- Polygon and MultiPolygon content, including a concave polygon;
- OGC manifest and binary GLB structure;
- deterministic rebuilds and source/feature/content hash linkage;
- explicit exclusions for out-of-bounds, oversized, duplicate, hole-containing and unsupported features;
- wrong source hash, parent traversal, missing/tampered content and symlink attacks;
- invalid configuration and an empty eligible-source set.

A dedicated GitHub Actions workflow also builds and verifies a bounded package from the repository's actual Dhaka Overture pilot extract. Its generated artifact is CI evidence, not a published map asset.

## Remaining production acceptance gates

This implementation does **not** complete P3.6 production acceptance. Before integrating this package into ordinary map loading, require:
1. fixed-camera browser renders and human review of several real-Dhaka tile contents;
2. tile-by-tile footprint/placement residual evidence against the original source data, including edges and vertical bounds;
3. a real Cesium viewport test proving selective child requests rather than only manifest parsing;
4. cancellation, failure/fallback, retry and resource-cleanup tests for the live multi-tile controller;
5. documented source rights/attribution review and a defensible source-height/elevation provenance strategy;
6. comparable cold/warm browser performance and memory evidence at a larger, explicitly bounded tile count.

Until those gates pass, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` remain false. Do not infer real-building accuracy or production readiness from a successful CI run.
