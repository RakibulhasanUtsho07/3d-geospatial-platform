# 3D Geospatial Platform — Engine Completion Roadmap

**Audit date:** 2026-10-25  
**Target branch flow:** `rakibul-hasan` → `development` → `main`  
**Current status:** roadmap and first browser-baseline harness are merged to `main`; automated real-data capture is now being added; human visual sign-off remains pending.

## Ground rules

1. A green CI run proves that the automated checks passed on that commit. It does not prove that a real building matches its source images or that a map renders well on every device.
2. Do not report a single "accuracy percentage" unless the exact model is compared with independent measurements using a documented metric.
3. Every model/evidence result must bind to exact input and GLB hashes. Unknown or occluded geometry stays unknown; AI/single-image/photogrammetry output stays review-only until approved.
4. Keep changes in medium-sized, reviewable batches. Each batch must have focused regression tests, lint/build, CI evidence, and a written status update.
5. Merge upward only after the source SHA is confirmed and all required CI checks succeed. Do not force-push protected work or merge stale branches wholesale.

## Verified baseline

- Current `main` candidate: `0bf007d2c6749475936d18d0168c168b1ca3fd7e`.
- Post-merge CI run [#40119673648](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40119673648) passed lint, production build, automated engine/GLB checks, generated spatial-tile checks, and the production viewport API browser test.
- P2.6–P2.20 viewport workload, caching, cancellation, cross-process repeatability, performance trend, and geometry-read diagnostics are integrated. Their benchmark reports describe bounded workloads; they do not establish a universal FPS or latency SLA.
- Existing capabilities include Cesium viewport loading, Overture-derived footprint extrusion, OSM road geometry/nearby services, deterministic procedural GLB, candidate generation/review gates, GLB QA, dimension checking, horizontal WGS84 ground-control fitting, render/reference diagnostic tools, and a measured-vector floor-plan shell generator.

## Missing evidence and remaining work

The codebase still needs real-data validation and product-level completion. The major gaps are:

- No checked-in, human-reviewed real-Dhaka browser baseline bundle with three cold and three warm samples plus six inspected screenshots. The old P0 PR #105 contains a useful harness, but its branch is based on an old ancestor and must not be merged as a stale history.
- The existing Parliament reconstruction baseline is recorded as **visual-fidelity fail**; independent real-world dimensions and accepted surveyed ground-control residuals are not attached to that baseline. The previous result must not be advertised as an accurate building model.
- Ahsan Manzil proportions and architectural detail changes in PR #104 still need current-base review, deterministic output comparison, and human visual acceptance; estimated dimensions must remain explicitly marked as estimates.
- The generated-model lifecycle extraction in PR #107 needs a current-base review before being accepted as a modularity improvement.
- Floor-plan raster line proposals exist, but complete automatic PDF/image-to-rooms/walls conversion, metric calibration, door/window semantics, and accuracy validation are not finished. PR #80 must be audited and rebased/reimplemented safely rather than merged blindly.
- The repository has OGC 3D Tiles manifest validation and test fixtures, but a fixture/manifest is not the same as a production-quality Overture-to-3D-Tiles conversion and visual render path.
- Generation still relies on local file-backed workspace/queue pieces and operator-attested rights/measurements; durable shared storage, production authentication/roles, observability/retention policy, and an admin review experience need explicit implementation before production use.
- Property listings are demo/illustrative data. A real marketplace needs verified listing ingestion/owner workflows, persistence, moderation, and genuine route/network semantics.
- There are multiple old open stacked PRs. P2.7–P2.20 content appears incorporated by the merged viewport integration, but each remaining open PR must be compared by file/commit before it is closed as superseded. Never close an item merely because its branch looks old.

## Medium-sized implementation phases

### Phase 1 — P3.1: Reproducible real-Dhaka browser baseline (**in progress**)

**Scope:** port the older P0 baseline harness onto the current branch; add deterministic helper tests and CI coverage; automate a separate Playwright/Chromium real-data run; document capture and human review. The runner collects candidate SHA, local data file hashes, browser context, navigation timings, bounded map telemetry, resource status groups, and screenshot hashes without storing viewport query values. Map readiness must require a successful viewport stage with at least one actual building feature—not merely a visible canvas.

**Acceptance gates:**
- [x] Helper tests cover percentiles, empty/invalid samples, resource classification, and lookalike-host/privacy boundaries; helper checks and full CI pass on the first promoted candidate.
- [x] A dedicated workflow runs the app in development mode, validates the generated spatial tiles, requires a successful viewport stage with real building features, and saves report/screenshots as an artifact.
- [ ] The workflow produces 3 successful cold and 3 warm samples, six PNGs, report.json, candidate SHA, and source/tile hashes or explicit missing-input markers.
- [ ] A reviewer records blank-canvas, footprint alignment, building-height, road occlusion, viewport refresh, and console findings. CI alone does not close the human visual evidence gate.

### Phase 2 — P3.2: Independent building accuracy evidence pack

**Scope:** select 2–3 representative buildings (one complex landmark plus ordinary low/high-rise examples), verify rights and source identity, freeze source manifests, record independent dimensions, and use surveyed non-collinear control points where available. Bind every report to exact GLB and reference-image hashes.

**Acceptance gates:** separate statuses for dimensions, horizontal georeferencing, vertical datum, mesh integrity, texture/facade fidelity, image coverage, and human review; no unsupported combined score; missing evidence means incomplete; failures remain fail-closed and unpublished.

### Phase 3 — P3.3: Landmark model correction loop

**Scope:** review Ahsan Manzil PR #104 and engine mismatch/facade work PR #103 against the current base. Use deterministic front/back/left/right/top and oblique renders, verify the exact generated asset hash, compare real proportions and roof/dome/stair/facade details to source evidence, then create correction tasks and re-run verification.

**Acceptance gates:** accepted visual review with recorded reference mappings; geometry/texture QA; any unsurveyed parameter remains estimated; no model is declared accurate from a generated render alone.

### Phase 4 — P3.4: Dynamic map real-data quality and performance (**active**)

**Scope:** extend the baseline beyond the initial landmark to dense-city, sparse/low-rise, and street-level views. Validate road/building alignment, source-height provenance, parent/part duplicate suppression, stale-response cancellation, fallback behavior, cache eviction, and layer hide/show/resize/rapid pan/zoom behavior. Capture comparable cold/warm p50/p95 and memory/DOM trends on a documented device. The first reliability slice adds bounded Overpass endpoint fallback and a reduced road query after a transient failure.

**Acceptance gates:** same-device and same-data comparison; no functional regression; visual defects documented; synthetic CPU microbenchmarks kept separate from browser/GPU performance claims. The road slice must prove cancellation halts retries, transient failures can fall back, reduced results are explicitly marked, and all-endpoint failure remains visible.

### Phase 5 — P3.5: Map-engine ownership and lifecycle modularity

**Scope:** review PR #107's GeneratedModelLayer extraction and continue boundary extraction only where it improves ownership (viewport/staging, road layer, picking, generated GLB lifecycle). Validate teardown, late async completion, visibility/remove/update races, request cancellation, and resource cleanup.

**Acceptance gates:** module-boundary and lifecycle regression tests; no duplicate ownership; production build and full map browser integration pass. Avoid large architectural rewrites without measured maintenance/performance gains.

### Phase 6 — P3.6: Real 3D Tiles production path

**Scope:** distinguish the current GeoJSON-extrusion path and generated fixture from a real OGC 3D Tiles content pipeline. Audit existing manifest validation and the old PR #111; specify converter input/output, coordinate transforms, bounding volumes, geometric error/LOD, content URI safety, and tile coverage. Add one small real Dhaka tile package before scaling.

**Acceptance gates:** schema/integrity tests; fixed-camera footprint/placement comparison; non-empty selective viewport fetch; failure/fallback and cancellation behavior; model/data hashes; no claims that fixture validation equals production tile rendering.

### Phase 7 — P3.7: Floor-plan to interior model review pipeline

**Scope:** audit PR #80 and current raster-line proposals. Keep detected lines as suggestions until reviewed; add explicit scale calibration, vector review, room/wall/door/window semantics, measured-vector GLB validation, and floor-plan source-to-candidate hash linkage.

**Acceptance gates:** synthetic and real sample fixtures; false-line/closed-room/scale tests; dimension comparison to independently measured plan; human review required before publication. Automatic PDF rasterization and CAD/IFC/BIM import remain separate backlog items until implemented.

### Phase 8 — P3.8: Generation job and publication production hardening

**Scope:** document/implement authenticated roles, durable job storage/locking, retry/resume behavior, quotas and size limits, secure private asset storage, retention/deletion, audit trail, worker health, and review/admin workflow. Review file-backed queues and operator-attested licence/rights for their actual deployment assumptions.

**Acceptance gates:** auth/authorization tests, traversal/symlink/hash-mismatch tests, concurrent/restarted worker tests, no candidate auto-publish, verified rollback, and an explicit deploy/runbook.

### Phase 9 — P3.9: Property product data and release readiness

**Scope:** replace illustrative listings with an explicitly sourced data integration; add owner/listing verification and moderation, persistent favorites/user sessions, and a genuine routable network or keep distance indicators clearly labelled straight-line. Finish UX accessibility, error/empty/loading states, attribution, privacy, monitoring, backups and deployment rollback.

**Acceptance gates:** data provenance and freshness documented, non-demo integration tests, security/consent review, real-user browser test matrix, release checklist, and known limitations published. Until these gates pass the repository remains an engineering pilot, not a production marketplace.

## Repository hygiene workstream

- Review old stacked PRs #136–#149 against current `main`; the merged P2.6–P2.20 integration means many may be superseded. Compare unique file contents and CI coverage before closing anything.
- Review #111, #107, #105, #104, #103, and #80 independently. Do not assume that an open PR is either missing or already merged just from its title.
- Keep one authoritative roadmap/status table and update phase status after the CI run and evidence review, not when code has merely been written.

## Current execution record

- [x] Confirmed that the initial P3.1 commit and its development promotion passed full CI; promotion PR #156 merged.
- [x] Audited README, performance/release/accuracy/generation documentation, package scripts, CI workflow, branch state and open PR inventory.
- [x] Added a current-branch P3.1 browser harness and helper tests; canvas-only false readiness is now rejected.
- [x] Dedicated real-data capture workflow produced artifact [run #40157388201](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40157388201), with 3/3 cold and 3/3 warm building-stage samples plus six PNG screenshots on SHA `76032ec65ab9d57069d2ce69c7e6c39fa20a0faa`.
- [x] Initial visual review: 3D buildings are visible and no blank canvas occurs; facade/roof detail is still boxy, UI side panels obscure the map, and raster imagery differs between samples. One warm sample reported an OSM roads API HTTP 502; successful road requests took roughly 13–18 seconds in the server log.
- [x] Improved benchmark to retain the actual staged-feature count, wait for road fetch/render terminal state and record per-sample road success/error/timeout; a refined run is now required because the first screenshots were taken before all map layers settled.
- [ ] Refined baseline: capture six samples with explicit building readiness and road outcome per sample, and review the new screenshot hashes.
- [ ] Human visual review of the refined screenshots and workstation-specific baseline.
- [ ] P3.4 road reliability slice: current branch implementation is awaiting focused/full CI and refined real-data verification.
- [ ] Phase 2 onward: remaining implementation phases above.
