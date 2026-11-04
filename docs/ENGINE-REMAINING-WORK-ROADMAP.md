# 3D Geospatial Platform — Engine Completion Roadmap

**Audit date:** 2026-11-03  
**Target branch flow:** `rakibul-hasan` → `development` → `main`  
**Current status:** P3.6–P3.8 and D3M-01 foundations are integrated on current `main`/`dev`. P3.7 floor-plan raster-to-vector calibration has merged as a private human-review workflow; P3.4 map-panel UX and imagery diagnostics are in a refreshed current-main validation candidate. P3.2 still lacks real surveyed building evidence, and P3.4 must not be marked complete until its clean exact-head six-sample baseline and Full CI pass.

## Ground rules

1. A green CI run proves that the automated checks passed on that commit. It does not prove that a real building matches its source images or that a map renders well on every device.
2. Do not report a single "accuracy percentage" unless the exact model is compared with independent measurements using a documented metric.
3. Every model/evidence result must bind to exact input and GLB hashes. Unknown or occluded geometry stays unknown; AI/single-image/photogrammetry output stays review-only until approved.
4. Keep changes in medium-sized, reviewable batches. Each batch must have focused regression tests, lint/build, CI evidence, and a written status update.
5. Merge upward only after the source SHA is confirmed and all required CI checks succeed. Do not force-push protected work or merge stale branches wholesale.

## Verified baseline

- Current `main` candidate (2026-11-04 audit): `bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`.
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


## D3M-02 — approved generation job to Cesium map publication (merged to main)

**Tracking issue:** [#301](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/301)  
**Merged PR:** [#302](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/302), merge commit `4ec5305108870a2cc30bd203c4a3c8c7ab9613a0`.  
**Runbook:** [D3M-02 Generation Job to Map Publication](D3M-02-GENERATION-JOB-TO-MAP-PUBLISH.md)

- Added an operator-token-protected `POST /api/building-generation/jobs/{jobId}/publish` route with an independent `GENERATION_PUBLISH_API_TOKEN`.
- Kept generation candidates and immutable review records in the private workspace while targeting the application's `process.cwd()/public` directory for the published content-addressed GLB and catalog.
- Added a catalog publication lock around manifest read/modify/atomic-write so concurrent publishers cannot silently overwrite each other's model versions.
- Added a map dialog panel for explicit job ID, placement, orientation, scale and public-asset confirmation. After publishing, it re-reads the catalog and checks exact model/version/hash/URL before loading and focusing the model in the current Cesium session.
- Added regression cases for a separate public root and a busy catalog lock.
- [x] Exact-head Full CI passed on D3M-02 head `116453207d517db6db6a8a19f6cc5802f5630be0`: [run #41449228282](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41449228282), 179/179 steps; PR #302 was merged into main on 2026-11-03. This is automated repository validation only; it does not prove production deployment, model accuracy, rights or survey acceptance.
- **Limits:** existing development review remains shared-token/operator-attested, not cryptographic reviewer identity. Placement remains an explicit operator input. Job release flags remain false; this does not prove image-based architectural accuracy, rights, survey truth or automatic approval.

## D3M-03 — map-side image intake and generation job tracking (merged to main; exact-head CI passed)

**Tracking issue:** [#303](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/303)  
**Dependency:** D3M-02 PR #302 merged; D3M-03 promoted by [PR #324](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/324), merge commit `6b3c8e3de3eb1e34685e1a25ab34a95f3a3f1993`.  
**Runbook:** [D3M-03 Map Image Intake and Job Tracking](D3M-03-MAP-IMAGE-INTAKE-AND-JOB-TRACKING.md)

- Mounted a map-side intake panel for up to 12 JPEG/PNG/WebP facade images, 20 MiB each, using the existing signature-checking private media-upload API.
- Added metric footprint generation from explicit WGS84 center, footprint width/depth, heading, floor count and floor height. The resulting footprint/floor evidence is explicitly marked estimated, not surveyed.
- Added strategy-specific controls for single-image AI, COLMAP photogrammetry and procedural generation; procedural is labeled as dimension-driven and not image-derived.
- Requires a non-unknown rights/licence basis and explicit operator rights confirmation before queue creation. Upload starts with `usageStatus=unreviewed`; worker ingestion later sets `usageStatus=approved` via `rightsReviewMethod=explicit-cli-attestation` using that same operator attestation. This is pipeline eligibility metadata, not independent rights review or legal clearance.
- Added retry reuse of exact uploaded-source records while the dialog remains mounted and job/worker status polling with terminal-state stop.
- Added short-lived HttpOnly operator sessions. A distinct login token is exchanged once for a 30-minute SameSite=Strict cookie; the server-only HMAC signing secret and legacy generation bearer token are never embedded in the browser bundle.
- Added metric-geometry/strategy helper regression tests and a CI step.
- [x] Baseline exact-head Full CI passed on `e9fd101aca605ef0d8ad6d582df1cb449d09f7eb`: [run #41397515751](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41397515751), 179/179 steps. This validates automated code/build checks, not an actual TripoSR/COLMAP reconstruction, image quality, survey registration or accuracy.
- Added local Hugging Face cache checks for TripoSR `config.yaml` and `model.ckpt`; single-image AI is claimable only when both files are cached. Any commit added after the cited SHA needs its own exact-head checks.
- D3M-03 was reconciled against current main and promoted through PR #324 on 2026-11-03; its source intake, operator-session, consent gates and job tracking are now part of main. The later D3M-04→D3M-07 cumulative stack was promoted through PR #325.
- **Limits:** only still images (JPEG/PNG/WebP) are supported by this UI; video/PDF and map-click auto-location are not included. WebP is not a valid selected input for the current single-image AI or COLMAP photogrammetry worker; it is rejected at UI and queue preflight for those strategies. Worker binaries/models and shared persistent workspace remain deployment prerequisites. This does not prove accuracy or rights, and no candidate is automatically approved or placed into the map.

## D3M-04 — TripoSR background-removal runtime readiness

**Tracking issue:** [#305](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/305)  
**Dependency:** D3M-03 PR #304; implementation is stacked on `feat/d3m03-map-generation-intake-20261102`  
**Implementation branch:** `feat/d3m04-triposr-background-cache-readiness-20261102`

- [x] Audit confirmed that the worker launches TripoSR without `--no-remove-bg`; upstream TripoSR therefore creates `rembg.new_session()` by default. The effective default model depends on the installed rembg version.
- [x] Import ONNX Runtime/rembg during the bounded worker startup probe; identify the installed default rembg model and resolve its local model file without initializing a session or making a network request.
- [x] Keep single-image AI unclaimable until both TripoSR weights and the active rembg model weights are cached; unknown API/resolver layouts remain `unknown` and fail closed rather than being mislabeled as missing.
- [x] Surface missing/unknown background-removal cache state in the operator panel and persist only sanitized model identifiers/state, never cache paths or process output.
- [x] Add executable Python-probe contract tests for cached/missing/unknown states, missing ONNX Runtime import, legacy worker-status compatibility, and worker-level queue non-consumption (attempt remains zero).
- [x] D3M-04 cache-readiness implementation was included in the cumulative main promotion PR #325. The post-promotion main Full CI #41649268743 passed 207/207 steps, including D3M-05/07 and worker inventory checks. The real worker's Python/device/cache state still requires operator preflight on the provisioned host.
- **Important licensing limit:** rembg package licensing is separate from model-weight licensing. Current upstream rembg documentation identifies `bria-rmbg` as its default; BRIA RMBG 2.0 weights are source-available for non-commercial use unless separately licensed. Deployment must deliberately choose a model and verify applicable rights before commercial use.
- **No accuracy claim:** readiness does not prove that a real TripoSR run succeeds, that the output matches a building, that scale/georeferencing is correct, or that the candidate is map-ready. Release flags remain fail-closed.


## D3M-05 — Offline single-image runtime smoke (implementation integrated; real-host gate pending)

**Tracking issue:** [#307](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/307)  
**Source integration:** cumulative D3M-04→D3M-07 promotion PR #325 merged to main; D3M-ENGINE-02 host inventory follow-up merged by PR #347.  
**Implementation branch:** `feat/d3m05-single-image-runtime-smoke-20261102`  
**Runbook:** [D3M-05 Single-image Runtime Smoke](D3M-05-SINGLE-IMAGE-RUNTIME-SMOKE.md)

- [x] Added an operator-invoked CLI and orchestration wrapper that reuses the same `runMediaToModelWorkflow` path as the durable queue worker; no second TripoSR inference implementation was added.
- [x] Require four separate operator confirmations: source reuse rights, media-operation scopes, single-view inference and review of TripoSR/rembg model-licence terms.
- [x] Refuse to reuse a source record, reconstruction job state, workflow output directory or TripoSR sub-job directory from an earlier run; fresh IDs are required to prove a new inference attempt.
- [x] Re-run D3M-04 readiness immediately before workflow execution; missing/unknown TripoSR or rembg weights block before inference.
- [x] Add offline Hugging Face/Transformers flags and a temporary Python `sitecustomize.py` socket guard for the probe/inference subprocesses. This is application-level Python socket blocking, not kernel/OS network isolation; the runbook explicitly requires host/network isolation when strict no-egress is required.
- [x] Bind the private smoke evidence to the exact source SHA-256, workflow/job/building IDs, model ID/device/resolution, GLB SHA-256/bytes/mesh count and sanitized geometry-QA output. Re-check the source record, private output directory, GLB header and hash chain before a smoke can report pass.
- [x] Add a separate evidence verifier CLI that re-hashes the source and GLB after the run, validates GLB structure/byte counts, rejects symlinked paths and refuses reports with any release gate enabled.
- [x] Add CI help/syntax validation for both the operator smoke command and the independent evidence verifier.
- [x] Keep `mapReady`, `publicationEligible` and `automaticApproval` false. The report labels the output as an AI-proposed candidate requiring human review.
- [x] Add fake-workflow contract tests for model-cache blocking, input signatures, offline socket policy, required confirmations, output hash binding, failure sanitization and immutable evidence; add the test command to Full CI.
- [x] Add the D3M-05 operator runbook, prerequisites, licence cautions, exit codes and review checklist.
- [x] Add an operator-host preflight note for Python/PyTorch/ONNX/rembg versions and device visibility, plus a sanitized per-run evidence log template at `docs/evidence-templates/D3M-05-REAL-WORKER-SMOKE-LOG.md`. The private source image, GLB, smoke JSON and raw logs must remain on the restricted worker workspace.
- [x] Focused D3M-05 tests, lint and production build passed on the prior PR head `b3b03b303239e3f4ab25c9b0e4a391e47b377b0f`; the matching Push CI [#41410709005](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41410709005) and PR CI [#41410715603](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41410715603) both completed 182/182 successfully.
- [x] Post-CI audit found that workflow failure before the TripoSR child-process `spawn` event could be mislabelled as inference failure. Runtime evidence and the independent verifier now distinguish workflow failure, runner launch attempt, actual process spawn and completed output; regression tests cover pre-launch failure and OS process-spawn failure.
- [x] Exact-head PR Full CI passed on the D3M-05 runner-launch-correction branch head `07e122053ff99059b72661e85e4f2e44b2a3c8ac`: [run #41412587662](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41412587662), job `Lint and production build`, 182 workflow steps, no failed steps. The D3M-06 descendant branch also re-ran the complete suite successfully; this does not replace the still-pending real worker-host inference.
- [ ] Operator-run one real inference on the provisioned worker host with model licences, source rights, runtime/device and local cache checked; retain the private smoke report and independently review the GLB.
- [x] Implementation stack integrated into main through PR #325; later worker-host inventory tooling added through PR #347. Main Full CI #41649268743 passed 207/207 and includes the D3M-05 contract test and CLI validation.
- **Explicit limits:** CI tests do not use actual TripoSR/rembg weights or GPU hardware. One successful smoke validates only one inference on one host/input. It does not prove broad building reconstruction accuracy, measured scale, orientation, ground-control registration or map readiness. Source integration is complete; the actual worker-host inference and independent GLB review are not.

## D3M-06 — bind reviewed placement to the map publication transform (integrated into main; operational proof pending)

**Tracking issue:** [#309](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/309)  
**Source integration:** cumulative D3M-04→D3M-07 promotion PR #325 merged to main.  
**Implementation branch:** `feat/d3m06-reviewed-map-placement-binding-20261102`

- [x] Repository audit confirmed the review API stored boolean metric-scale/georeference checks but no numeric placement; the map publication API independently accepted a new transform after approval.
- [x] Define explicit placement approval: WGS84 longitude/latitude, WGS84 ellipsoid height, heading/pitch/roll, uniform scale and distinct GLB axes.
- [x] Store normalized placement and SHA-256 in the immutable review record and job summary.
- [x] Require publication to match the exact normalized placement and digest from both review sources; reject legacy/missing placement records.
- [x] Add regression cases for malformed height reference/axes/coordinates, transform changes, legacy approvals and tampered job-summary placement digests.
- [x] Update the CLI to use the same fixed WGS84 ellipsoid-height reference as the authenticated API and update the D3M-02, generation jobs and published-model runbooks.
- [x] Add an operator CLI end-to-end regression that publishes a synthetic approved job using the exact stored placement digest and WGS84 ellipsoid height reference.
- [x] Focused review/publication tests, ESLint and production build passed in the exact D3M-06 branch Full CI job on code head `f8b974465ac6d52b32ada50fb2356844a6f126d8`; see PR CI run [#41415299310](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41415299310). The run includes the approved-review-to-explicit-map-publication test, review-decision/candidate-integrity/publication-gate tests, and production build.
- [x] Exact-head PR Full CI passed on `f8b974465ac6d52b32ada50fb2356844a6f126d8`: [run #41415299310](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41415299310), job `Lint and production build`, 182 workflow steps, no failed steps. The run contains successful ESLint, reviewed catalog publishing/rollback, approved generation review-to-map publication, review-decision/candidate-integrity/publication-gate checks, and production build.
- [x] Cumulative D3M-06 code and tests were included in main through PR #325; post-merge main CI #41649268743 passed 207/207.
- [ ] Operational gate remains the D3M-05 real worker-host smoke, independent verifier and human GLB inspection. Reviewed placement binding does not itself prove survey truth or architectural accuracy.
- **Limitations:** placement binding prevents a post-review transform change; it does not independently prove the reviewer identity, coordinate truth, rights, architectural accuracy or vertical datum. All release gates remain false.

## D3M-07 — non-inference single-image worker preflight (integrated into main; real-host run pending)

**Dependency:** D3M-04 worker capability probe and D3M-05 single-image runtime smoke.  
**Source integration:** cumulative main promotion PR #325; inventory hardening follow-up PR #347.

- [x] Add a preflight adapter around the authoritative D3M-04 capability probe; request only `single-image-ai` so this check does not launch unrelated COLMAP commands.
- [x] Require TripoSR and rembg caches to be explicitly `cached` before returning ready; reject missing, unknown, malformed and blocked states.
- [x] Add a CLI with explicit Python, TripoSR runner and device overrides; use bounded probe timeout and non-zero exit for blocked/unknown readiness.
- [x] Keep output sanitized: do not serialize environment variables, executable paths, cache paths or credentials.
- [x] Prevent configured runner execution: read and syntax-compile `run.py` in memory; never invoke its top-level code or `--help` handler. Set Python bytecode suppression and Hugging Face offline/telemetry flags for the probe subprocess.
- [x] Keep release flags false and state clearly that preflight does not run inference, verify licences, establish GPU memory sufficiency or prove building accuracy.
- [x] Add unit tests for both model caches, missing/unknown state, malformed capability responses, timestamp validation, secret/path non-disclosure, strategy scoping and a real-Python runner-execution marker check.
- [x] Add the tests and CLI-help validation to Full CI and add this branch to push/PR workflow filters.
- [x] Align the D3M-05 real-smoke readiness recheck with the same single-image-only strategy scope; keep actual TripoSR execution inside the authorized inference workflow.
- [x] Promoted into main through PR #325. Main Full CI #41649268743 passed the D3M-07 preflight test and CLI validation; D3M-ENGINE-02 inventory tests also passed on the same main head.
- [ ] Operator must run the preflight and inventory on the actual worker host, then complete the D3M-05 real inference smoke and independently inspect the GLB.
- **Safety boundary:** the preflight does not execute the configured TripoSR runner or call model-download/inference APIs. Python imports still execute installed package initialization code and may have package-specific side effects; this is not a hermetic read-only environment, OS sandbox or host firewall. Apply host/network egress and filesystem controls when strict guarantees are required.

## 2026-11-03 — Promotion state and remaining operational gates

- D3M-02 and D3M-03 are merged to main (PRs #302 and #324).
- D3M-04 through D3M-07 were promoted onto main through PR #325; the reviewer-authentication chain was subsequently integrated through PR #326. D3M-ENGINE-02 host inventory tooling was added by PR #347.
- Current main is `bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`; post-merge Full CI [#41649268743](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41649268743) passed 207/207 steps. Its steps 138–144 cover D3M-05 runtime smoke, D3M-07 preflight, D3M-ENGINE-02 inventory and all corresponding CLI checks.
- Production reviewer keys/registry provisioning and actual worker-host model provisioning remain separate operator/deployment gates.
- A real worker-host TripoSR/rembg inference, independently verified GLB and human visual review have not been completed. CI uses synthetic fixtures and does not establish model accuracy.
- Rights and model-weight licences require an explicit deployment decision. In particular, verify the selected rembg weight licence for the intended use.
- `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` remain false. No automatic publication or accuracy claim is made.

## D3M-01 — source-bound review and governed reviewer trust

- **Integrated into main:** PR #326 merged on 2026-11-03 (merge commit `fb3537d3199c98b43218b7853303858b5c9c0590`). Production reviewer keys/registry provisioning remains an operational gate.
- Includes the BRF-05/06 local source-bound mask and architectural-observation review tools, BRF-07 evidence bundle, immutable source-bound candidate hand-off, Ed25519-signed reviewer decision receipt, and D3M-01.F/G public-key registry lifecycle/preflight.
- Reviewer signatures bind the exact hand-off artifact, candidate GLB and geometry report. Production accepts only the versioned server-configured public-key registry; API callers cannot submit trusted keys. Revoked, expired, malformed, duplicate, orphaned or invalid key chains fail closed.
- A valid signature proves possession of a key provisioned in the server trust registry only. It does not prove a person's civil identity, legal authority, source rights, survey accuracy or architectural correctness.
- The mask and observation editors remain local manual annotation tools; source rights, camera calibration, independent reference data and human review remain separate evidence gates.
- No real reviewer has been onboarded and no production registry or signing key has been provisioned. `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` remain false.

## 2026-11-03 — P3.6 through P3.8 main integration candidate

- P3.6–P3.8 bounded Dhaka 3D Tiles, source-height provenance, building composition metadata and full Overture metadata coverage are reconciled onto D3M-01→D3M-07 in `integration/p3-6-8-main-reconciled-20261103` (PR #327; exact-head validation pending).
- P3.8 source head `5f98943775968b8a582f3f2eb5ba5141893eafe0`: Full CI #41331329853 and dedicated #41331329843 passed. P3.7 `cd3eff7e7b557d2690a9d755bee1aef7d379b8be`: Full CI #41329725567 and dedicated #41329725582 passed. P3.6 `6e5fd3fd68905e5098303f37d6f3e83b983ffcf6`: Full CI #41322041348 and dedicated #41322041296 passed. New main-based CI is still mandatory.
- Output remains bounded footprint-extrusion/cuboid massing, not reconstructed architecture: no roof/facade meshes, doors, windows, textures or parent/part assembly.
- 3 m/floor and 9 m fallback heights are labelled estimates; no surveyed vertical datum/elevation is claimed.
- P3.8 found license metadata on 15,868 of 17,008 records; 1,140 lack a license value. Acceptance/publication/map-ready/automatic-approval gates remain false.

## P3.6 height-provenance implementation slice — 2026-11-01

The default bounded Dhaka 3D Tiles package now derives each tile's vertical interval from feature properties instead of applying a uniform synthetic 8 m height.

- Overture `height` is used as the vertical distance from lowest to highest point; `min_height` is applied as the relative above-ground bottom offset. When `min_height` is absent, integer `min_floor` may be used as a labelled 3 m-per-floor estimate. GLB vertices, tileset root/child vertical regions, build-manifest records, and the alignment reviewer use the same `baseHeightMeters` / `topHeightMeters` interval.
- Height provenance is preserved in the GLB and build manifest: source category, source/unclamped height, clamping, reported `min_height` / `min_floor`, base-height source/estimate flag, base and top values, the exact base-offset policy and the ground/vertical-reference limitation. The alignment reviewer recomputes the expected values from source properties and rejects GLB+manifest values that are consistently rebound but disagree with the source feature.
- Floor-count conversion and the 9 m fallback remain explicitly labelled estimates. Overture-provided height is source data, not independent survey truth.
- Strict numeric parsing rejects partial values such as `"18.5m"` rather than accepting the numeric prefix.
- The alignment reviewer checks height metadata cross-binding and base/top positions after ECEF transformation. Synthetic test packages remain available only through an explicit `--synthetic-height-meters` override.
- Production review-package build and the P3.6 dedicated workflow no longer force a synthetic 8 m override. The 32/64/128 bounded scale profile exercises source-derived per-feature intervals by default.

**Vertical limitation remains:** the source extract has 2D footprints and no verified terrain elevation/vertical datum. The ENU origin remains at WGS84 ellipsoid height zero; `min_height` is only a relative above-ground offset from this unverified plane, and a `min_floor` conversion is an estimate. No surveyed absolute elevations, building accuracy, rights or release readiness are claimed. Exact-head CI and live browser validation are required before this slice is promoted.


### P3.6 browser evidence audit — 2026-11-01

- The previous dedicated run `41319856042` passed all 28 steps and uploaded browser, controller, alignment, scale-profile and bounded package artifacts. Its 32-content sample passed every footprint/placement check: max horizontal residual 0.067196 m, max perimeter difference 0.215084 m, max vertical transform residual 0.000032 m, zero degenerate triangles.
- The 32/64/128 scale samples all passed; per-sample package bytes and phase-boundary RSS are retained in the uploaded profile. RSS is not peak memory and shared-runner timings are not production SLOs.
- Live Cesium fetched one child GLB on the first viewport and one new GLB after a pan, without fetching the full 32-content package or reporting tile failures.
- Artifact review caught an outdated browser limitation sentence claiming uniform synthetic heights even though the current build used per-feature provenance. The browser review page and Playwright test were corrected to derive and assert the actual height-policy/source counts from the build manifest.
- Screenshot review still shows simple cuboid footprint extrusions, not building architecture. Facades, fenestration, roof form, textures and human visual acceptance remain unimplemented/blocked.
- The 32-tile sample contained 19 fallback estimates and 13 floor-count estimates, and no positive Overture `height` value. The 64/128 samples had only one Overture-provided height. Do not imply complete source height coverage.
- P3.6 feature branch was synchronized with `development@f7b2a67` using a two-parent merge commit; current branch is no longer behind development. Fresh exact-head Full CI and dedicated workflow are mandatory after this integration and evidence-report fix.


## P3.7 — Overture building composition and architecture evidence (metadata gate)

A follow-on branch to the P3.6 footprint/height pilot adds a typed, source-bound architecture metadata layer.

- The resolver pins supported fields/enums to Overture Buildings schema v2.0.0: `type`, `building_id`, `has_parts`, facade color/material, roof color/material/shape/direction/orientation/height. Enum values/types were checked against the pinned official schema source.
- Every field is explicitly `source`, `absent`, or `invalid`; numeric values are not coerced, colors must match Overture hex syntax, identifiers must be non-empty whitespace-free strings, and unknown enum values are not mapped to a plausible style.
- A full-source composition audit resolves every `building_part.building_id` against parent `building` feature IDs, distinguishes missing/ambiguous parent links, checks part records against `has_parts` claims, and separately records whether parent and parts are both selected in the bounded tile package.
- Each GLB and build-manifest tile carries the same architecture-evidence object, including its composition link. Manifest/tileset aggregates report per-field availability, parent/part statuses and whole-source linkage counts.
- The independent alignment reviewer recomputes the architecture object and complete composition audit from the hash-matched FeatureCollection, then verifies source + GLB + manifest + aggregate agreement. Regression cases tamper both GLB and manifest to a false roof shape and require the source-bound reviewer to reject them.
- The browser review page displays actual roof/facade metadata coverage and explicitly reports `footprint-extrusion-only` with zero generated architectural details.
- Parent `has_parts=true` and part `building_id` are evidence only. The composition audit reports whether part records resolve to one parent, whether the parent claim agrees, and whether both were emitted; it does not merge their geometries or mean that a building is assembled.

**Not implemented by P3.7:** roof meshes, facade components, windows/doors, balcony/arch geometry, textures or parent/part assembly. No source metadata is invented to fill absent fields. The next geometry stage must first join and validate parent/part records by `building_id`, then generate only geometry supported by source metadata or independently reviewed images. Keep the acceptance/publication/map-ready/automatic-approval flags false.


Implementation contract and pinned schema references: [P3.7 Building Composition Evidence](./research/P3-7-BUILDING-COMPOSITION-EVIDENCE.md).


## P3.8 — Full Dhaka Overture architecture coverage audit

- Added a deterministic CLI audit for the complete committed Dhaka FeatureCollection, with source-byte SHA-256, input length, report SHA-256, normalized role counts, per-role field coverage, source provenance and parent/part linkage summary.
- Raw Overture properties.type coverage is reported separately from extractor-derived properties._renderRole. This prevents internal extraction metadata from being presented as an original Overture schema field.
- The full 17,008-feature extract has 16,986 regular building roles, 7 building_parent roles and 15 building_part roles. All 15 parts resolve to one of the seven parent-role features by building_id; all 15 _parentBuildingId values agree.
- Initial full-source field inspection: facade_material 2,495; facade_color 1; roof_color 9; roof_material 2; roof_shape 10; roof_direction 1; roof_orientation 0; roof_height 1. These numbers are source metadata coverage only. The CI artifact report binds the exact source SHA and supersedes the manual counts if the input changes.
- CI and the dedicated P3.6 workflow now run the focused audit tests; the dedicated workflow also builds and uploads the full-source report. The 17,008 source records include 17,008 provenance records, but only 15,868 carry a license value; the other 1,140 must not be treated as rights-cleared.

**Not completed:** roof/facade geometry, imagery texture, windows/doors or parent/part assembly. All release flags stay false. Next gate is to inspect the hash-pinned report and choose one small geometry prototype only when its parent/part source geometry and independent measurements are sufficient; otherwise request rights-cleared, calibrated imagery or independent reference data.


## 2026-11-03 — P3.7 floor-plan raster calibration current-main port

- Added a browser-only review workspace for manual wall/room review, source-image SHA verification, two-point known-distance scale input and explicit room-boundary closure.
- Added deterministic raster-to-metre vector conversion with proposal/review canonical hashes; every proposed line has explicit accept-wall/reject decision; room boundary edges must be covered by reviewed wall vectors; door/window openings are checked for bounds and overlap.
- The private candidate API reopens the ingested raster, recomputes the calibrated vectors/preview GLB and checks all hashes before storing sidecars in a private regular directory. API authentication, exact source-byte identity, bounded inputs and fail-closed response are retained.
- Scale is explicitly **human-attested, not independently survey-verified**. Origin/heading/elevation/CRS are not surveyed by this workflow. It does not rasterize PDF, infer room semantics or generate furniture, publish GLBs, or add a map asset. `acceptanceEligible`, `publicationEligible`, `mapReady`, and `automaticApproval` remain false.
- Current-main port is on `integration/p37-floorplan-refresh-20261103`. Fresh exact-head Full CI and P3.7 dedicated validation are required before promotion; real, rights-cleared floor plans and independent measurements remain a later human evidence gate.


## 2026-11-03 — Post-P3.7 promotion and P3.4 current-main validation

- PR #333 merged to `main` at `145d80744bac0859f129e15bd5e93da6ff07d597`; `dev` and `rakibul-hasan` were fast-forwarded to the same commit. Exact-head Full CI #41592869839, dedicated P3.7 #41592869858, P3.6 package #41592869798, BRF-14 #41592869930, BRF-35 #41592869834, BRF-45 #41592869830 and BRF-05–07 #41592869980 all succeeded.
- P3.7 remains a private, manual, hash-bound floor-plan vector review workflow. Its scale is human-attested rather than independently survey-verified. It does not rasterize PDFs, infer room semantics, publish GLBs or add models to the map. `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` remain false.
- P3.4 panel UX, Dhaka Home/orientation controls, URL-redacted imagery diagnostics and canvas red-pixel diagnostics are being ported onto the post-P3.7 main in `integration/p34-main-after-p37-20261103`. The port preserves the P3.7 CI/test scripts, floor-plan API and roadmap entry instead of reverting those current-main changes.
- The prior P3.4 baseline failed its clean-tree provenance gate because the benchmark's own nested artifact directory appeared in Git status. The benchmark now parses NUL-delimited porcelain status and excludes only its own output subtree; tracked edits and all other untracked paths remain dirty. A temp-Git-repository regression test covers nested generated evidence plus unrelated tracked/untracked changes.
- The P3.4 current-main candidate must still pass exact-head Full CI and the six-sample clean working-tree Real-Dhaka baseline. Until both succeed and the resulting screenshots/report are inspected, P3.4 is not accepted as complete. The diagnostics do not prove that the previous red imagery anomaly has been fixed.
- The independent building accuracy, rights, survey, visual review and production workflow gates remain separate; no universal accuracy percentage or release eligibility is claimed.


## D3M current-main status — 2026-11-03 post D3M-ENGINE-02

- Current `main`: `bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`.
- D3M-02 and D3M-03 are integrated through PRs #302 and #324; D3M-04 through D3M-07 are integrated through cumulative PR #325; D3M-01 reviewer-authentication source is integrated through PR #326; D3M-ENGINE-02 worker-host inventory is integrated through PR #347.
- Main post-merge Full CI [#41649268743](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41649268743) completed successfully (207/207 steps). The same run passed D3M-05 contract tests, D3M-07 preflight tests, D3M-ENGINE-02 host inventory test/CLI and production viewport verification.
- This is source/automated validation only. No provisioned worker-host inventory, D3M-04 real device/cache report, D3M-05 TripoSR/rembg inference, independent GLB verification or human visual review is recorded.
- Next operational acceptance remains: provision/review the actual worker host and local caches; run the inventory and preflight; confirm source and model rights; run one fresh D3M-05 inference; verify the exact source/GLB hashes and GLB structure; inspect the private GLB independently; save a sanitized evidence-log record.
- Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false until their separate evidence/reviewer gates are completed.


## 2026-11-04 — D3M-ENGINE-03 execution checkpoint

- Current `main`: `bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`; no milestone change has been merged to `main`.
- Consolidated PR [#351](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/351) carries the facade/GLB work from #350, unique BRF-04 topology regression from #349 and the D3M-ENGINE-03 source-bound vertical-slice integration. Its execution branch is `feat/d3m-engine03-evidence-backed-vertical-slice-20261103`; current head at this checkpoint: `550d169a3fac0d0cb4f77ab9d9063a86d8f1da2d`.
- Software workflow: parent report binds the source-image set, image byte hashes, rights scopes, geometry-input hash and two resumable child workflows. Child reports are bound to the exact media engine + photogrammetry strategy and exact architectural-geometry engine version, building ID, deterministic child job ID and geometry input path. Regression tests cover cross-job, cross-building and cross-profile substitution.
- The facade-opening GLB regression now checks both footprint windings, arch geometry, zero degenerate triangles and zero non-manifold edges across all generated mesh primitives. Exact-head CI step 20 passed on `80e54a3b494f468eb57fbde13563d25d03ada698`; follow-up exact child-profile tests were added after that head and require a new exact-head validation.
- Exact-head automated evidence on prior head `10a962601e9ed9c0c861f57bb98d0e329ade299d`: BRF-14 source-byte intake, BRF-05–07 reference intake, BRF-35 same-building linkage and P3.7 floor-plan validation succeeded. Full CI failed only in two newly added identity-guard tests because a shared mutable fixture leaked the BuildingSpec mutation from a prior test; the fixture was isolated in `550d169a3fac0d0cb4f77ab9d9063a86d8f1da2d`. Exact-head CI and renderer rerun for this latest head remain pending verification.
- Generic renderer smoke, Real-Dhaka browser baseline, P3.6 package and BRF-45 real-asset rights admission are independent workflows. A synthetic renderer pass or byte-intake success does not prove real building accuracy or source-owner permission.
- External blockers remain: real TripoSR/rembg host inference (issue #307), actual COLMAP/multi-view reconstruction on authorized data, model-weight/source rights decisions, independent surveyed/CAD/BIM/LiDAR truth, held-out control points, provisioned trusted reviewer signing identity, surveyed WGS84 placement and vertical datum, and real candidate Cesium browser inspection.
- Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false until the matching evidence and authorized review exist. Do not merge #351 or close #349/#350 until exact-head validation and human review are complete.

## 2026-11-04 — D3M-ENGINE-03 signed publication-review hardening

- Extended the existing D3M-01 Ed25519 trust primitive for D3M-ENGINE-03 catalog publication; no parallel reviewer registry or request-supplied public-key trust path was introduced.
- Catalog publication now requires a separate signed receipt whose canonical payload binds the exact building ID, parent vertical-slice report SHA-256, source-set SHA-256, textured candidate GLB SHA-256 and publication-attestation file SHA-256.
- The receipt must explicitly decide `approve-for-catalog-handoff`. Its reviewer ID and canonical UTC review timestamp must match the reviewer and timestamp recorded in the attestation. The signature is checked against the server-configured `RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON` registry; production mode requires the versioned public-key-only registry.
- Invalid/missing signatures, untrusted or revoked keys, stale/changed attestation bytes, cross-building/report/source/candidate substitution, non-approval decisions and invalid review timestamps fail before the catalog write.
- The generated catalog version retains the verified Ed25519 provenance (reviewer/key/registry IDs, public-key fingerprint, signed payload hash, signature hash and receipt-file hash). The metadata reader validates the provenance shape and exact reviewer/timestamp binding; older catalog entries without this optional field remain readable.
- New regression coverage includes successful signed publication, required receipt/registry, tampered signature, untrusted key, changed-after-signing attestation and a validly signed hold decision. These checks prove the software contract with ephemeral test keys only; they do not onboard a real reviewer.
- The CLI now requires `reviewReceiptPath` in its config and reads trust anchors only from the runtime environment. Never store reviewer private keys or the production registry in Git, request/config files, logs or workflow artifacts.
- **Still blocked externally:** no production reviewer identity/authority has been onboarded, no production registry has been provisioned, and no real source/legal approval, independent surveyed truth, held-out accuracy, real worker inference or survey-backed placement is supplied. All release flags remain false.
- **Validation:** exact-head Full CI and renderer smoke must be re-run after the signed-receipt/catalog changes. No merge to `main` is authorized by this software increment.
### Exact-head validation checkpoint — 2026-11-04 05:20 UTC

- Current branch/PR head: `d721fdbe34957fd3edb2d3d59b8858d0e9ea9f4c`.
- Full CI [#41778202163](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41778202163): 197/208 steps completed at the last poll; no failures observed. The exact reviewed vertical-slice publication test (step 38) and existing reviewed-catalog test (step 14) both completed successfully. Production build / viewport verification and evidence upload remained in progress.
- Same-head P3.6 bounded Dhaka 3D Tiles [#41778204757](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41778204757), BRF-14 byte intake [#41778207200](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41778207200), and BRF-45 policy-validator [#41778209593](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41778209593) succeeded.
- Generic Blender renderer [#41778084791](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41778084791) remained active at the 13-view default render stage; Real-Dhaka baseline [#41778084802](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41778084802) remained active at cold/warm browser capture. Neither result is claimed as passed.
- These runs validate software contracts with synthetic fixture keys and benchmark inputs only. No production reviewer is provisioned; no real building visual approval, source-rights clearance, worker inference, independent truth or survey placement is supplied. PR #351 remains open/unmerged and no main promotion is authorized.

## 2026-11-04 — Catalog final-read integrity / TOCTOU hardening

- Audited the D3M-ENGINE-03 signed publication path through the shared `publishReviewedBuildingModel` file reads. Found a time-of-check/time-of-use gap: reviewer-signature and source/report/candidate hash checks happened in the wrapper, then the generic catalog publisher reopened the candidate GLB and publication attestation without knowing the exact hashes already checked.
- Added optional expected-input SHA-256 guards to the generic catalog writer. It hashes the bytes actually read for the candidate and attestation and rejects any drift before it parses the attestation or writes a content-addressed GLB/manifest.
- D3M-ENGINE-03 now passes its already-verified candidate and attestation hashes to the final writer. The D3M-02 approved-generation-job path also passes the candidate digest and the digest of the exact temporary placement attestation bytes it created, keeping the D3M-06 placement binding intact through the final filesystem read.
- Added focused regression coverage for candidate-byte and attestation-byte drift after upstream review; both cases must leave the public catalog manifest absent. The existing approved-job and signed vertical-slice tests also exercise the updated shared writer path.
- Documentation updated in the D3M-02 and D3M-ENGINE-03 runbooks. No release flag is enabled and no `main` merge is performed.
- **Validation pending on the latest code head:** focused catalog, approved-job and signed vertical-slice suites plus exact-head Full CI and renderer/browser workflows. The hash guards are software integrity controls; they do not replace private workspace ACLs, trusted reviewer provisioning, source rights, independent survey truth or real GLB inspection.

