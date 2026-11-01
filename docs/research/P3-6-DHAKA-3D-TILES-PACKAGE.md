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
- Default: resolve each feature's height from its Overture properties and record the source/clamping provenance. Use `--synthetic-height-meters` only for explicitly synthetic tests (greater than 0 and at most 250 m).
- `--bbox`: WGS84 extent as `west,south,east,north`.

## Package contract

- `tileset.json`: OGC 3D Tiles 1.1 root with one child tile per emitted source feature. Child content references are relative GLB URIs; each child records a WGS84 region, an ENU-to-ECEF transform and source-feature identity in extras.
- `tiles/*.glb`: glTF 2.0 binary content. Roof triangles are created from a triangulated exterior footprint; side faces are emitted per footprint edge.
- `build-manifest.json`: stable source file SHA-256, selected feature IDs/hashes, coordinate conventions, bounds, tile URIs, asset SHA-256/byte lengths, exclusion counts, validation facts and explicit release flags.
- The package builder validates the generated manifest and then invokes the package-integrity verifier before returning success.

## Geometry selection and exclusions

Only GeoJSON Polygon/MultiPolygon building footprints with simple exterior rings are emitted. Features outside the specified pilot extent, invalid coordinates/degenerate footprints, footprints outside the bounded size range, duplicate IDs, unsupported geometries and polygons with interior rings/holes are excluded and counted. An ear-clipping/mesh-generation failure is fail-closed for that candidate rather than replaced by a bounding-box building.

The height used by the default source-driven build is no longer a single synthetic constant: each feature resolves a source height, a labelled floor-count estimate, or a labelled fallback. An explicit `--synthetic-height-meters` override remains available for controlled tests. Source footprints are preserved as polygon outlines, but this output does not reconstruct facade details, openings, roofs, textures or surveyed elevation. The horizontal projection uses a local east/north approximation around each feature anchor and a WGS84 ECEF transform for global placement. The pilot must not be scaled city-wide without a metric projection strategy, more thorough geometry repair and independent placement review.

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

The `scripts/review-dhaka-3d-tiles-package-alignment.mjs` reviewer complements package integrity by parsing actual GLB POSITION and triangle-index accessors, extracting exterior base-perimeter edges from indexed triangles, applying the corresponding child 4×4 ECEF transform, and comparing transformed mesh boundaries with the exact source feature identified by the manifest.

- It re-checks the package-integrity gate and cross-binds the full source SHA-256, each feature SHA-256, GLB SHA-256, child URI, and tileset/build-manifest source identity before measuring geometry.
- It measures source-perimeter-to-mesh-boundary and mesh-boundary-to-source-perimeter residuals in both the local ENU projection and after the child ECEF transform. It samples each segment at endpoints, quarter points and midpoints; vertex-to-vertex residuals remain diagnostic because redundant collinear source vertices can be simplified without changing the boundary.
- It rejects degenerate triangles; validates the index accessor, transform axis orthonormality/handedness and translation anchor; checks every transformed ground/top vertex against the child `boundingVolume.region`; and records synthetic top/ground ellipsoid-height residuals plus perimeter-length differences.
- Acceptance thresholds are 0.5 m for bidirectional horizontal boundary residuals and perimeter difference, 0.05 m for ECEF-to-ellipsoid height residual, and 1 mm for the transform translation anchor. These are engineering checks, not independent survey tolerances.
- CLI: `npm run review:dhaka-3d-tiles-package-alignment -- --source data/overture/dhaka-buildings-3d-pilot.geojson --package data/overture/dhaka-3d-tiles-multibuilding-pilot --output /tmp/dhaka-3d-tiles-package-alignment-review.json`.
- Tests cover convex, concave and MultiPolygon geometry; a redundant collinear source vertex; exact source/package hash binding; a shifted transform and a shifted GLB whose manifest hashes are recomputed; and a wrong source dataset.
- The dedicated P3.6 workflow runs the test suite, runs the reviewer on its bounded real-Dhaka package, and uploads the machine-readable per-tile residual report separately from the package artifact.
- **Validated real-Dhaka report (candidate commit `7978be41a1f1116695e7968eb9c169aca865bc57`):** dedicated PR [run #40821527297](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40821527297) and push [run #40821517344](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40821517344) passed. The report is `pass` for 32/32 tiles; 146 source vertices correspond to 146 transformed unique ground vertices; maximum horizontal residual is `0.067196 m` (threshold `0.5 m`); maximum ellipsoid-height transform residual is `0.000032 m` (threshold `0.05 m`); all transformed vertices are inside the declared child regions; package integrity remains `pass`. Source SHA-256: `f05f14b1cf983c823adf605dc3131f2cf3029afd8ac873d54017155d22fe5f90`.

- **Boundary-review hardening on candidate `5df20658d0cdf795ec5bcee6b5976ee3ee0107e3`:** the per-tile alignment step in dedicated PR [run #40844911653](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40844911653) passed and produced the updated real-Dhaka report. It remained `pass` for 32/32 tiles with maximum bidirectional horizontal boundary residual `0.067196 m`, maximum perimeter difference `0.215084 m` (both against `0.5 m`), maximum ellipsoid-height transform residual `0.000032 m` (against `0.05 m`), zero degenerate triangles, valid transforms, and all transformed vertices inside child regions. Package/source hashes match the report above. This numeric report is historical evidence for candidate `5df20658d0cdf795ec5bcee6b5976ee3ee0107e3`. The latest source head reran the alignment gate successfully; review its exact-head artifact before reusing these numeric values as current-head measurements.

**Interpretation limit:** the source GeoJSON carries 2D horizontal footprints. The vertical comparison only verifies transformation against the WGS84 ellipsoid and the explicitly synthetic extrusion; it is not a comparison to surveyed ground/top elevations. A pass does not establish rendered appearance, architecture fidelity, source rights, or production readiness. Exact-head CI and a review of its evidence are required before this new gate is marked passed.
## Current validation checkpoint and remaining production acceptance gates

**P3.6 source-head provenance checkpoint (2026-10-29):** source-code commit `448b9b06438ca3de6d41fede0f19e83cd18a9ace` passed dedicated workflow push [#40898780195](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40898780195) and PR [#40898795029](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40898795029). The lifecycle browser manifest has schema version 2 and pins `sourceHeadSha`, `workflowSha`, and `eventName`. Push evidence binds source/workflow SHA to `448b9b…`; PR evidence binds the source head to `448b9b…` and records workflow SHA `31d199472a1063153e58225f8214aec4e511181f`, so a synthetic PR merge SHA is not mislabeled as the source commit. Dedicated validation passed; full CI remains a separate required exact-head gate.

### Bounded scale and resource profile (new)

- The dedicated P3.6 workflow now profiles the same local Dhaka footprint extract with requested content limits `32`, `64`, and `128`. `scripts/benchmark-dhaka-3d-tiles-scale-profile.mjs` records source SHA-256/size, emitted content count, total package bytes and file count, GLB size distribution, build-plus-embedded-integrity wall time, standalone integrity wall time, placement-review wall time, alignment residual summaries and RSS snapshots at phase boundaries.
- The benchmark uses ephemeral package directories and uploads only a machine-readable JSON report (`p3-6-dhaka-3d-tiles-scale-profile`); it does not publish or check in generated packages. The report identifies the workflow SHA separately from the PR source head and binds the report to the source-data hash.
- The 32/64/128 sequence is bounded engineering evidence, not a city-scale performance claim. Timings have no flaky CI threshold; RSS is sampled at phase boundaries rather than asserted as peak memory. The 8 m height remains synthetic, and no rights, surveyed accuracy, visual acceptance or release flag is inferred by a successful profile.

### Exact-head artifact audit (source-code commit `448b9b06438ca3de6d41fede0f19e83cd18a9ace`)

- The bounded profile report and per-tile alignment report both return `pass` against source extract SHA-256 `f05f14b1cf983c823adf605dc3131f2cf3029afd8ac873d54017155d22fe5f90` (10,111,710 bytes; 17,008 features). The 32/64/128 profile package sizes are 145,722 / 290,419 / 567,004 bytes. Maximum horizontal residuals are 0.067196 / 0.067196 / 0.087561 m, maximum perimeter differences 0.215084 / 0.231004 / 0.259272 m, maximum ellipsoid-height residual is 0.000073 m, with zero degenerate triangles and all transformed vertices inside their declared regions.
- Live Cesium selective-fetch evidence binds the same source/tileset/build-manifest hashes: first viewport fetched one GLB; after a 2,055.65 m camera move, a different GLB was fetched; only 2 of 32 content GLBs were requested cumulatively and tile failures were zero. This demonstrates lazy child-content fetching in the tested Chromium session, not city-scale performance.
- Fixed-camera screenshot inspection found simple blue block extrusions against an otherwise empty dark background, without facade/roof detail. The automation passes the loading and integrity checks, but these screenshots are **not architecturally accepted** and do not establish real-building fidelity.
- The release flags remain `acceptanceEligible=false`, `publicationEligible=false`, `mapReady=false`, and `automaticApproval=false`. Heights are synthetic 8 m; rights, same-building linkage and independent surveyed dimensions/elevations remain unresolved. Do not merge or publish based on these engineering checks alone.

## Polygon interior-ring support (implementation slice)

The package builder now preserves valid GeoJSON Polygon/MultiPolygon interior rings as courtyard holes. The repository's lockfile-pinned `earcut@3.0.2` triangulator is declared directly as a dependency. Roof and bottom surfaces use exterior-minus-holes triangulation, and vertical wall faces are emitted along courtyard boundaries.

- Each hole must be strictly contained within its exterior and must not intersect, overlap, or nest with another hole. Invalid topology is excluded fail-closed and counted as `invalidHoleGeometry`.
- An area check compares the triangulated surface with projected exterior area minus interior hole areas; incomplete, degenerate, or area-mismatched triangulations are rejected.
- The package alignment reviewer now checks every exterior and interior source ring against GLB boundary edges before and after ECEF placement.
- Regression tests recompute roof triangle area, check courtyard-boundary residuals, and reject an out-of-exterior hole. This remains footprint extrusion: it does not infer facades, roof structures, doors/windows, real heights, or survey accuracy.

### Gate matrix

| Gate | Status at the source-code checkpoint | Evidence boundary |
|---|---|---|
| Package contents, file sizes, SHA-256 and source-feature binding | Passed | Integrity only; a valid hash does not prove geometry is correct. |
| GLB footprint and placement residuals, triangle degeneracy, ENU/ECEF transform and child-region checks | Passed on code commit `448b9b…` | Current bounded profile/artifact reports were inspected: 32/32 child tiles pass; max horizontal residual 0.087561 m, max perimeter difference 0.259272 m, max ellipsoid-height residual 0.000073 m, zero degenerate triangles, all vertices inside child regions. These compare generated geometry with 2D source footprints and transform plumbing, not survey truth. |
| Live Cesium selective child-content fetching across two viewports | Passed | Confirms bounded lazy loading in the tested browser session; not city-scale performance. |
| Controller retry/fallback, disable/destroy cleanup and late-loader result handling | Passed in the live lifecycle browser check | Confirms controller policy and cleanup; does not guarantee the underlying HTTP request is abortable. |
| Real surveyed building heights / independent vertical truth | **Blocked** | Default GLBs now use per-feature source heights or labelled estimates; the 2D source has no surveyed ground elevation or named vertical datum, so the ellipsoid-zero anchor and relative base offsets do not establish independent vertical truth. |
| File-level source rights, attribution and derivative/commercial-use scope | **Blocked** | Public accessibility or the separate benchmark's licence cannot be transferred to every TUM2TWIN/Zenodo asset. See [BRF-29 / issue #240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240). |
| Human fixed-camera architectural review | **Blocked** | The observed review frames show simple footprint extrusions, not accepted facade/roof architecture. Hash-bound screenshots alone do not grant visual acceptance. |
| Bounded package scale profile at 32/64/128 contents | Implemented; exact-head artifact review pending | Records package bytes, GLB size distribution, phase wall times, alignment and phase-boundary RSS samples; shared-runner readings are not production SLOs or peak-memory guarantees. |

### Release decision

PR #275 remains Draft and unmerged. Keep `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` explicitly false. The successful workflows validate this implementation checkpoint only; they do not override the blocked real-height, rights, independent-accuracy or human-review gates. Any documentation-only commit created to record this checkpoint must itself receive fresh exact-head CI before it is called validated.


## Per-building height provenance and vertical interval correction — 2026-11-01

This section supersedes earlier statements that the default P3.6 package always uses a uniform synthetic 8 m extrusion.

### Source semantics

The builder follows the current [Overture Building schema](https://docs.overturemaps.org/schema/reference/buildings/building/) and [BuildingPart schema](https://docs.overturemaps.org/schema/reference/buildings/building_part/):

- `height` is the distance from the feature's lowest point to its highest point.
- `min_height` is the above-ground altitude at which the bottom of the building/building part starts.
- `min_floor` is the integer start floor of a floating building part. When `min_height` is missing, it may be used as an explicitly estimated proxy at 3 m per floor. Explicit `min_height` takes precedence when both are present.
- `num_floors` represents above-ground floors. When no positive source height is available, the current renderer policy estimates 3 m per floor; if neither is available, it uses an explicitly labelled 9 m fallback.
- A supplied `min_height` or estimated `min_floor` base offset is not added to the source `height` span. The GLB vertical interval is `[baseHeightMeters, baseHeightMeters + heightMeters]`.

### Implementation and evidence binding

- Default build and the production review package now use per-feature provenance rather than an unconditional synthetic 8 m height.
- `resolveBuildingHeight` uses strict numeric parsing. Values such as `"18.5m"` are not partially parsed as metres. It retains original/unclamped height and base values and records safety-cap decisions.
- Each tile GLB, build manifest and tileset region now bind `heightStatus`, `heightSource`, `heightMeters`, `baseHeightSource`, `baseHeightEstimated`, `reportedMinHeightMeters`, `reportedMinFloor`, `baseHeightMeters`, `topHeightMeters`, unclamped inputs, clamp flags and the selected base-offset application policy.
- The mesh's bottom vertices are emitted at `baseHeightMeters`; top vertices are emitted at `topHeightMeters`. Root and child `boundingVolume.region` vertical intervals cover the actual per-tile base and top range.
- The alignment reviewer independently re-resolves height and base-offset source from the matching GeoJSON feature properties, checks the source/manifest/GLB cross-binding, recovers the footprint boundary at the non-zero base plane and checks base/top ECEF heights against the declared child region. A forged height value cannot pass merely because GLB and manifest hashes are consistently rebound.
- Dedicated package tests cover explicit source height + non-zero `min_height`, the `min_floor` estimate and its precedence rules, floor-height estimate, fallback estimate, synthetic override, height/base clamping, source-to-GLB provenance drift, and corrupted manifest records.

### Vertical reference limitation — still blocked

The ENU-to-ECEF transform is anchored at WGS84 ellipsoid height zero because the 2D Overture footprint extract does not supply a verified terrain elevation or a named vertical datum. The source `min_height` is applied as a relative above-ground offset from that unverified local ground plane; `min_floor` may supply a separately labelled 3 m-per-floor estimate when `min_height` is absent. Neither establishes absolute building elevation, surveyed ground level, or an independently measured top elevation.

Overture-provided `height` and `min_height` are source data, not independent survey truth. `min_floor`, floor-count and fallback conversions are estimates. The alignment check confirms internal geometry/provenance and transform consistency only. It does not confirm real-world vertical accuracy, architectural fidelity, source rights, or production readiness.

Use `--synthetic-height-meters` only to create an explicitly synthetic test package. The regular CI package build and scale profile now exercise default per-feature height resolution. All release flags remain false.


## Browser evidence audit and merge-base synchronization — 2026-11-01

The previous exact-head P3.6 run `41319856042` completed all 28 dedicated workflow steps successfully on `6750c2839f03ff6550700ba50cc453d0589825c0`. Its retained artifacts were inspected directly:

- The 32-tile alignment report passed all 32 tiles; maximum horizontal residual was 0.067196 m, maximum perimeter difference was 0.215084 m, maximum ECEF/geodetic height residual was 0.000032 m, degenerate triangles were zero, and all transformed vertices were within their declared regions.
- The 32/64/128-content scale profile passed all three bounded samples. Package sizes were 184,756 / 366,901 / 718,186 bytes. Phase-boundary RSS after alignment was 266,158,080 / 375,197,696 / 483,860,480 bytes; these are not peak-memory measurements or production SLOs.
- The 32-tile source sample used 19 labelled fallback-height estimates and 13 floor-count estimates; it contained no positive Overture `height` source value. Larger samples contained a small number of source-height values. Source availability must be reported per sample, not assumed.
- Live Cesium fetched one GLB for the first viewport and one new GLB after a pan approximately 2,056 m away; it did not fetch all 32 contents, and no child tile failed.
- Browser screenshot inspection shows simple footprint extrusions/cuboids only. They are not accepted architectural building models; facades, windows, roofs, textures and human visual approval remain blocked.

**Evidence-report correction:** the earlier browser JSON incorrectly retained a stale limitation string saying all building heights were synthetic uniform extrusions. This contradicted the build manifest and alignment evidence. The review page now reads the actual package height policy and per-feature source/base counts from the build manifest, renders that provenance visibly, and emits accurate limitations distinguishing source attributes and estimates from surveyed truth. A Playwright regression now requires the browser report and visible UI to agree with the manifest and rejects the stale synthetic-uniform statement.

**Branch integration:** the P3.6 branch had been based on `98b2fa56`, five commits behind the updated `development`. Since the only changed paths on the development side were the CI workflow and BRF-35 validator/test, a two-parent merge commit `62520c0d86fab0b57cbfe247e7d96a4457fc6e41` preserves the P3.6 tree while incorporating those exact development versions. The branch is now directly based on `development@f7b2a67`; the compare endpoint reports zero commits behind and GitHub reports the PR mergeable.

The latest merge-synchronized head requires fresh exact-head CI and dedicated P3.6 workflow. The successful run and artifacts above validate the immediately preceding P3.6 code head, not the new merge commit.
