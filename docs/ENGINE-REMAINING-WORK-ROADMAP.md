# 3D Geospatial Platform — Engine Completion Roadmap

**Audit date:** 2026-10-25  
**Target branch flow:** `rakibul-hasan` → `development` → `main`  
**Current status:** P3.1 six-sample real-Dhaka browser baseline and screenshot review are recorded on candidate `2b93cb4d7f51cb09f726fe958cdcf974e763ce73`; strict validation and full CI pass. Human review found visible UX/visual-fidelity defects that remain open. P3.2 still lacks real surveyed building evidence.

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

### Phase 1 — P3.1: Reproducible real-Dhaka browser baseline (**capture and first visual review complete; visual defects remain**)

**Scope:** port the older P0 baseline harness onto the current branch; add deterministic helper tests and CI coverage; automate a separate Playwright/Chromium real-data run; document capture and human review. The runner collects candidate SHA, local data file hashes, browser context, navigation timings, bounded map telemetry, resource status groups, and screenshot hashes without storing viewport query values. Map readiness must require a successful viewport stage with at least one actual building feature—not merely a visible canvas.

**Acceptance gates:**
- [x] Helper tests cover percentiles, empty/invalid samples, resource classification, and lookalike-host/privacy boundaries; helper checks and full CI pass on the first promoted candidate.
- [x] A dedicated workflow runs the app in development mode, validates the generated spatial tiles, requires a successful viewport stage with real building features, and saves report/screenshots as an artifact.
- [x] The strict workflow validator passes 3 successful cold and 3 warm samples, six PNGs, report.json, candidate SHA, Overture source/tile hashes, and the bundled road-extract hash. Every sample proves a successful building stage and a rendered offline road layer with zero pending road requests and zero Overpass attempts.
- [x] Screenshot review recorded no blank canvas; the overview shows roads through the building field but the large side panels obscure map area, most buildings are still boxy extrusions with plain roofs, and at least one capture contains a bright red tile/overlay artifact not repeated in the other views. These defects are recorded for correction, not accepted as visually fixed. The CI capture is a Linux/Chromium/SwiftShader baseline, not a substitute for review on the developer's target workstation.

### Phase 2 — P3.2: Independent building accuracy evidence pack

**Scope:** select 2–3 representative buildings (one complex landmark plus ordinary low/high-rise examples), verify rights and source identity, freeze source manifests, record independent dimensions, and use surveyed non-collinear control points where available. Bind every report to exact GLB and reference-image hashes.

**Acceptance gates:** separate statuses for dimensions, horizontal georeferencing, vertical datum, mesh integrity, texture/facade fidelity, image coverage, and human review; no unsupported combined score; missing evidence means incomplete; failures remain fail-closed and unpublished.

### Phase 3 — P3.3: Landmark model correction loop (**candidate implemented; visual acceptance pending**)

**Scope:** review Ahsan Manzil PR #104 and engine mismatch/facade work PR #103 against the current base. Use deterministic front/back/left/right/top and oblique renders, verify the exact generated asset hash, compare real proportions and roof/dome/stair/facade details to source evidence, then create correction tasks and re-run verification.

**Implementation evidence:** the current correction candidate adds a fuller estimated lotus-bud dome, widened arch openings and central portico, individual stair risers/treads and nosing, separate estimated Andarmahal roof height, and camera-fit changes for the 13-view review renderer. The GLB and all 13 screenshot hashes are pinned in the render summary and workflow artifact.

**Acceptance gates:** accepted visual review with recorded, hash-bound reference mappings; geometry/texture QA; any unsurveyed parameter remains estimated; no model is declared accurate from a generated render alone. **These gates are not all met:** roof-deck detail and surface texture/UV are unresolved, geometry QA remains review-recommended, and no independently surveyed dimensions/control points have been attached. Keep publication/release eligibility false and the promotion PR draft until those gates pass.

### Phase 4 — P3.4: Dynamic map real-data quality and performance (**active**)

**Scope:** extend the baseline beyond the initial landmark to dense-city, sparse/low-rise, and street-level views. Validate road/building alignment, source-height provenance, parent/part duplicate suppression, stale-response cancellation, fallback behavior, cache eviction, and layer hide/show/resize/rapid pan/zoom behavior. Capture comparable cold/warm p50/p95 and memory/DOM trends on a documented device. The first reliability slice adds bounded Overpass endpoint fallback and a reduced road query after a transient failure. The next slice adds a 60-second per-failed-viewport cooldown to prevent the same view from consuming another ~18-second public-provider retry after camera events, while allowing different viewports and manual layer-toggle retry. The refined run exposed an evidence gap: additional same-bounds HTTP 200 responses appeared after some 504s, but the screenshot-bound telemetry did not confirm a road render. The benchmark now captures road-request lifecycle and a failure retry-grace window. A further gap was found where the visual settle delay followed the wait; that ordering is corrected so the final request-quiescence check occurs immediately before capture. Road render telemetry now carries a positive rendered-entity count, separate from API ways returned.

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
- [x] Refined baseline artifact [run #40170572692](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40170572692) on SHA `2b93cb4d7f51cb09f726fe958cdcf974e763ce73`: 3/3 cold and 3/3 warm; 3,000 buildings staged and 478 offline road entities rendered in every sample; no upstream road attempts or pending road requests. Dataset hashes and six screenshot hashes are embedded in the report.
- [x] Visual review recorded the defects above. The report says `gitWorkingTreeDirty: true` because the benchmark starts the app through `predev` build hooks; the exact post-build changed-file list is not preserved by this report, so treat the capture as a measured candidate and keep that reproducibility caveat visible.
- [x] Focused/full source-branch CI [run #40170572728](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40170572728) passed 118/118 checks. The capture workflow and strict acceptance validator passed on the same candidate SHA.
- [ ] P3.4 visual-quality correction: fix/review the side-panel map occlusion and investigate the red imagery/overlay anomaly; improve building/roof detail only where source evidence supports it. Re-run comparable baseline after changes.
- [ ] Phase 2 onward: remaining implementation phases above.
- [x] P3.3 candidate correction and deterministic 13-view QA workflow added on `rakibul-hasan`; render workflow [run #40174015784](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40174015784) passed build, heritage-model tests, geometry/texture report generation, Blender rendering, contact-sheet creation, and SHA-256 recording. Candidate model SHA-256: `689b3fb6b1aa28a8649f34317aa539439e4e6b9d40db5db9625e5e673213e17e`; render manifest SHA-256: `d49f0acb3556895f189924bd9f64c25302c7f6e84aada984e2d9cccbacb9dd13`. The artifact has 13 unique PNGs whose hashes match the manifest.
- [x] Exact latest PR-head CI passed on `5ccaa5883b3b76104b12d05df1b9a8657d168c9f`: [push CI #40174491755](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40174491755) and [PR CI #40174494505](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40174494505). These passes establish code/automation checks, not real-world model accuracy.
- [x] The revised front review framing isolates Rangmahal and fits the camera to projected geometry bounds; back/side/top and eight oblique views also use computed projected bounds. Human inspection found no missing render images, but the top view still has a large plain roof deck and the stylized massing/material fidelity remains insufficient for visual acceptance.
- [x] Candidate open-license reference sources were identified: [Front view of Ahsan Manzil.jpg](https://commons.wikimedia.org/wiki/File:Front_view_of_Ahsan_Manzil.jpg) (Sumonto.ck, CC BY-SA 4.0), [Ahsan Manzil (side).jpg](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil_%28side%29.jpg) (Mrpluto11, CC BY-SA 4.0), and [Ahsan Manjil Angled view.jpg](https://commons.wikimedia.org/wiki/File:Ahsan_Manjil_Angled_view.jpg) (Samiha Ahmed Rafa, CC BY-SA 4.0). Attribution and share-alike terms apply. These links are potential licensed references and are not yet hash-pinned inputs in the render summary.
- [ ] P3.3 visual acceptance/promotion remains blocked: geometry QA reports degenerate triangles, excessive degenerate ratio, long edges, non-manifold/open boundaries, disconnected/small detached components and no texture atlas. Texture QA reports no embedded images/textures/UV accessors and 21 untextured primitives. Do not relabel `review-recommended` as pass.
- [ ] Independently measured dimensions and surveyed control points are still missing. The [Bangladesh Tourism Board](https://beautifulbangladesh.gov.bd/loc/dhaka/3) publishes overall dimensions and storey heights, but these are literature values, not an independent site survey. P3.2/P3.3 must remain incomplete for accuracy claims until measured references and exact asset/reference hashes are reviewed.



## P3.4.3 / P3.4.4 — Bundled offline road data pipeline (**CI acceptance complete**)

- Added GeoJSON-to-normalized-road conversion while preserving source OSM way IDs, multipart ways, supported footways and source tags.
- Added a versioned local extract schema with ODbL/source/date/coverage/feature-count and geometry validation, size/count limits, parsed-file cache and per-viewport selection.
- Added the local-first API path controlled by `DHAKA_ROADS_EXTRACT_PATH`; fully covered viewports bypass public Overpass and report offline detail/source provenance.
- The importer now records the source PBF SHA-256 separately from the processed GeoJSON input SHA-256, validates those hashes, and rejects output exceeding the runtime loader's 256 MiB cap.
- Added CLI integration tests and `.github/workflows/dhaka-offline-road-baseline.yml`, which downloads the official Geofabrik Bangladesh extract, clips the Dhaka bbox, creates the versioned offline file, and checks the API and six cold/warm rendered-road samples. It uploads the generated data and evidence but does not commit the PBF.
- [x] The data-backed workflow [run #40168121002](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40168121002) passed all 17 steps; it validated the generated extract, API smoke test, six cold/warm browser samples, and committed the normalized dataset (not the raw Bangladesh PBF).
- [x] The refined real-Dhaka baseline [run #40170572692](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40170572692) independently verified the bundled default path without `DHAKA_ROADS_EXTRACT_PATH`: 6/6 road renders, 478 rendered road entities each, `detailLevel: offline`, `local-extract` source, zero upstream attempts and zero pending requests.
- The capture ran against the repository CI candidate, not a deployed hosting environment. A live deployment smoke test is still a separate release gate. Viewports outside the extract bounds continue using Overpass.


## P3.2 — Multi-building accuracy evidence pack (validator added; real-world acceptance pending)

- Added a fail-closed evidence-pack evaluator for a 2–3 building pilot and an input-driven CLI that hashes the candidate GLB, source media, independent references, fixed render manifest and all referenced render PNGs.
- The evaluator binds the existing independent dimension / horizontal ground-control benchmark and 13 fixed renders to the exact GLB hash, requires four-sided source/reference coverage and a reviewer-recorded match for each required view, and reports vertical datum separately.
- Missing inputs or unpinned hashes stay incomplete; hash mismatches and explicit geometry/view/model-binding failures are not silently downgraded. No combined accuracy percentage is produced and publication/automatic approval remain disabled.
- Added focused regression tests and a runbook/template. Tests validate policy and evidence linkage only; they do not establish the accuracy of a specific real building.
- **Acceptance still pending:** no actual 2–3 building source/reference pack with independently verified dimensions, checked permissions, surveyed controls and human-reviewed renders was available in this session. Do not mark the models accurate until those inputs are supplied and the evidence report passes review.
