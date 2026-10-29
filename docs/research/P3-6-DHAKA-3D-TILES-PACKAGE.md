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

## Live Cesium multi-tile viewport harness (new)

The focused browser page `/experimental/dhaka-3d-tiles-multibuilding-review.html` is generated with the same local package used by the production build. The dedicated P3.6 workflow now builds the production application, starts the real Next.js production server, and runs Playwright against the Cesium viewer.

The browser harness:
- validates the live OGC manifest/build-manifest relationship and keeps the four release flags false;
- picks the two most geographically separated emitted building footprints;
- moves the real Cesium camera to each target and waits for the target child content to load and become visible;
- records requested GLB content URIs from browser resource timing, Cesium tile-load/visible/failure events, viewport dimensions, Cesium/browser versions, exact source/tileset/build-manifest hashes and a screenshot hash;
- passes only if the first viewport fetches a strict subset of package contents, the second viewport loads at least one new child GLB, and the two views together do not fetch every GLB.

The browser test is an integration/selection check, not a city-scale benchmark. A successful run will establish that this bounded package is fetched lazily by viewport rather than eagerly downloaded as a whole. It still does not prove that all source geometry matches the real buildings.

**Verified browser result (commit `22305fee43effff4f4438252cfa6fa552c4adc44`):**
- [Dedicated P3.6 run #40805652011](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40805652011) — success, including production build/server startup and the live Cesium Playwright check.
- [Full CI push #40805652007](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40805652007) and [full CI PR run #40805656734](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40805656734) — success on the same code commit.
- The run selected two footprint targets approximately **2,055.65 m apart** from a package with 32 child contents. The initial viewport fetched **1 GLB**; after moving the camera, a different GLB was fetched. The cumulative resource-timing list contained **2 of 32 GLBs**, not the full package.
- Cesium reported **2 tileLoad events, 4 tileVisible events and 0 tileFailed events**; the target tile was ready at capture. Runtime was Cesium 1.146.0 with Chromium 156.0.8078.4 at a 1600×950 viewport.
- Evidence artifact: [P3.6 browser evidence and screenshot](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40805652011). Screenshot SHA-256: `e20716377a55ec5ab70cc6ad134ab98eb1562941c1d97d27ae4c41420eac69d1`; report SHA-256: `e33b3d351e9e7bfa241b3b2595dae88f47fc0401dafabbdc95033bb6ad11d832`.
- These results prove only bounded package integrity and lazy child-content loading in this CI viewport pair. They do not prove surveyed height, facade/roof fidelity, source rights or city-scale performance. Keep the release flags false.

## Multi-tile controller lifecycle hardening (new)

The opt-in `Dhaka3DTilesPilotController` now has explicit and bounded loading policy:

- Same-source concurrent `enable()` calls share one in-flight promise. Repeated enable after attach returns `already-loaded` instead of duplicating primitives.
- `maxAttemptsPerUrl` is constrained to 1–3 (default 2); `retryDelayMs` is constrained to 0–5000 ms (default 250). The retry loop re-checks lifecycle generation after each wait, so disable/destroy does not start another retry.
- An optional `fallbackUrl` is opt-in and runs only after all retries against the primary fail. The loaded URL, fallback flag and failed attempts are emitted in status/result metadata. No fixture fallback is silently configured for another source.
- Changing the requested URL tears down the previously attached tile set before loading the new one.
- Disabling, destroying or replacing the viewer invalidates stale loads; a late-resolved tile set is destroyed instead of attached, and a late rejection does not produce an error status for an obsolete request.
- If Cesium refuses primitive attachment, insertion partially mutates and then throws, or collection removal fails, the controller attempts removal and still destroys owned tile resources. Telemetry callback exceptions are isolated from load/teardown.
- Permanent failure is emitted once as an error and leaves no controller-owned attached resource; it remains visible to the caller as a rejected promise.

The controller still uses Cesium's public `fromUrl()` loader, which is not abortable here. Generation invalidation prevents stale attachment but cannot guarantee that an underlying network request stops immediately. These lifecycle tests use injected loaders and mock primitive collections; they prove controller policy, not a deployed browser's network cancellation behavior.

The dedicated P3.6 workflow explicitly runs `npm run test:dhaka-3d-tiles-pilot-controller` alongside package-integrity checks and live Cesium browser validation. The focused suite now has 23 lifecycle scenarios. Recent regression coverage verifies runtime feature-flag shutdown while another source is in flight; explicit destruction when `PrimitiveCollection.remove()` succeeds with `destroyPrimitives=false`; partial insertion cleanup under that same configuration; and non-fatal `requestRender()` errors during viewer teardown. The live Cesium lifecycle browser scenario passed in dedicated push and PR workflows on candidate commit `a62053d5e9d8bcfef1f848543530fab8b4b76875`; see the run links in the following section. Newer heads require fresh full CI.

## Live Cesium controller lifecycle browser validation (new)

The dedicated workflow now exercises the authoritative `Dhaka3DTilesPilotController` in a real Chromium/Cesium browser, separately from mock-only unit tests.

- `scripts/build-dhaka-3d-tiles-pilot-browser-module.mjs` creates a byte-for-byte browser-served copy from the authoritative source module during `predev` and `prebuild`. The output is ignored by Git to avoid a second hand-maintained implementation; the copy test checks hashes and rejects source/output symlinks.
- The browser harness validates that source, tileset and build-manifest hashes are available, that the source hash binds across package manifests, and that all four release flags remain false.
- Fallback scenario: the primary URL intentionally returns a missing-resource error; the controller must report fallback and load the real bounded Dhaka package. A repeated enable must return `already-loaded`; disabling must remove the primitive, destroy the tileset and return the primitive count to baseline. A subsequent call after the runtime flag turns off must return `disabled`.
- Terminal failure scenario: both primary and fallback URLs intentionally fail. The caller must receive a rejection and exactly one terminal `error` event, with no attached primitive or stuck loading state.
- Late-result scenario: start a real Cesium `Cesium3DTileset.fromUrl()` operation, disable the controller before the loader result is delivered to it, then release the actual loaded tileset. The controller must return `cancelled`, destroy the late tileset, and leave the scene unchanged without publishing a stale error.
- The Playwright test writes a JSON report, evidence manifest, and screenshot with SHA-256 hashes. The dedicated workflow uploads these separately from the review-only tile package.

**Validated on candidate commit `a62053d5e9d8bcfef1f848543530fab8b4b76875`:** dedicated push [run #40810011610](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40810011610) and PR [run #40810017273](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40810017273) passed the real-Cesium lifecycle scenario and uploaded browser evidence. The report verified explicit fallback loading, duplicate-enable coalescing, disable cleanup to baseline primitive count, a single terminal error when both URLs fail, and late-result cancellation/destruction with no stale error. These runs predate the later per-tile alignment slice; changed heads still require fresh CI.

**Limitations:** the late-result test validates stale-result cleanup after a real loader completes; it does not prove Cesium's underlying network request is immediately abortable. It still does not establish real-building height, architectural accuracy, source rights, or production readiness.
## Fixed-camera multi-viewport evidence integrity (current)

The live-browser review captures a separate PNG after the first target is visible and before panning, then captures the second target after the camera move. The browser evidence manifest stores both stages, byte lengths and SHA-256 values. The Playwright test reopens the written manifest, re-reads both PNGs and report from disk, recomputes their hashes, checks stage order and safe basename paths, and asserts that all release flags remain false.

The GitHub workflow explicitly passes `P3_6_SOURCE_HEAD_SHA` from the pull-request source branch (or the pushed commit). The report retains `workflowSha` independently because GitHub pull-request runs can execute against a synthetic merge commit. In CI, the test fails if the source-head SHA or workflow event is missing/malformed or the manifest does not match the expected source head.

This makes the uploaded PNG/JSON package self-consistent and traceable; it does not turn the visual review into an accuracy claim. The current geometry is still a synthetic-height extrusion without facade/roof reconstruction. Human architectural acceptance, rights, surveyed elevations and production eligibility remain blocked.

## Per-tile GLB footprint and placement residual review (new)

The new `scripts/review-dhaka-3d-tiles-package-alignment.mjs` reviewer complements package integrity by decoding each emitted GLB POSITION accessor, applying the corresponding child 4×4 ECEF transform, converting transformed coordinates back to WGS84 geodetic coordinates, and comparing the resulting mesh-footprint vertices with the exact source feature identified by the manifest.

- It re-checks the package-integrity gate and cross-binds the full source SHA-256, each feature SHA-256, GLB SHA-256, child URI, and tileset/build-manifest source identity before measuring geometry.
- It measures source-to-mesh and mesh-to-source nearest-vertex horizontal residuals per emitted tile; checks every transformed ground/top vertex against the child `boundingVolume.region`; and records the ellipsoid-height range and transform residual for ground and synthetic top vertices.
- Default horizontal residual threshold is 0.5 m, chosen as a bounded diagnostic for the builder's local degree-to-metre approximation; ECEF-to-ellipsoid height residual threshold is 0.05 m. These are engineering checks, not independent survey tolerances.
- CLI: `npm run review:dhaka-3d-tiles-package-alignment -- --source data/overture/dhaka-buildings-3d-pilot.geojson --package data/overture/dhaka-3d-tiles-multibuilding-pilot --output /tmp/dhaka-3d-tiles-package-alignment-review.json`.
- Tests cover a convex footprint, a concave footprint, MultiPolygon geometry, exact source/package hash binding, a deliberately shifted child ECEF transform whose file hashes have been recomputed, and a wrong source dataset.
- The dedicated P3.6 workflow runs the test suite, runs the reviewer on its bounded real-Dhaka package, and uploads the machine-readable per-tile residual report separately from the package artifact.
- **Validated real-Dhaka report (candidate commit `7978be41a1f1116695e7968eb9c169aca865bc57`):** dedicated PR [run #40821527297](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40821527297) and push [run #40821517344](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40821517344) passed. The report is `pass` for 32/32 tiles; 146 source vertices correspond to 146 transformed unique ground vertices; maximum horizontal residual is `0.067196 m` (threshold `0.5 m`); maximum ellipsoid-height transform residual is `0.000032 m` (threshold `0.05 m`); all transformed vertices are inside the declared child regions; package integrity remains `pass`. Source SHA-256: `f05f14b1cf983c823adf605dc3131f2cf3029afd8ac873d54017155d22fe5f90`.

**Interpretation limit:** the source GeoJSON carries 2D horizontal footprints. The vertical comparison only verifies transformation against the WGS84 ellipsoid and the explicitly synthetic extrusion; it is not a comparison to surveyed ground/top elevations. A pass does not establish rendered appearance, architecture fidelity, source rights, or production readiness. Exact-head CI and a review of its evidence are required before this new gate is marked passed.
## Remaining production acceptance gates

This implementation does **not** complete P3.6 production acceptance. Before integrating this package into ordinary map loading, require:
1. fixed-camera browser renders and human review of several real-Dhaka tile contents;
2. tile-by-tile footprint/placement residual evidence against the original source data, including edges and vertical bounds;
3. a real Cesium viewport test proving selective child requests rather than only manifest parsing;
4. cancellation, failure/fallback, retry and resource-cleanup tests for the live multi-tile controller;
5. documented source rights/attribution review and a defensible source-height/elevation provenance strategy;
6. comparable cold/warm browser performance and memory evidence at a larger, explicitly bounded tile count.

Until those gates pass, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` remain false. Do not infer real-building accuracy or production readiness from a successful CI run.
