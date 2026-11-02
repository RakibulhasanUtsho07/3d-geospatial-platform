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


## D3M-02 — approved generation job to Cesium map publication (implementation candidate)

**Tracking issue:** [#301](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/301)  
**Implementation branch:** `feat/d3m02-generation-job-map-publish-20261101`  
**Runbook:** [D3M-02 Generation Job to Map Publication](D3M-02-GENERATION-JOB-TO-MAP-PUBLISH.md)

- Added an operator-token-protected `POST /api/building-generation/jobs/{jobId}/publish` route with an independent `GENERATION_PUBLISH_API_TOKEN`.
- Kept generation candidates and immutable review records in the private workspace while targeting the application's `process.cwd()/public` directory for the published content-addressed GLB and catalog.
- Added a catalog publication lock around manifest read/modify/atomic-write so concurrent publishers cannot silently overwrite each other's model versions.
- Added a map dialog panel for explicit job ID, placement, orientation, scale and public-asset confirmation. After publishing, it re-reads the catalog and checks exact model/version/hash/URL before loading and focusing the model in the current Cesium session.
- Added regression cases for a separate public root and a busy catalog lock.
- [x] Exact-head Full CI passed for PR #302 on `dff7c70e2cab5936cda0f5b8d02df52b433fcb84`: [run #41334962827](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41334962827). This is automated validation only; reviewer inspection is still pending and PR #302 remains Draft/open/unmerged.
- **Limits:** existing development review remains shared-token/operator-attested, not cryptographic reviewer identity. Placement remains an explicit operator input. Job release flags remain false; this does not prove image-based architectural accuracy, rights, survey truth or automatic approval.



## D3M-03 — map-side image intake and generation job tracking (implementation candidate; baseline exact-head CI passed)

**Tracking issue:** [#303](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/303)  
**Dependency:** D3M-02 PR #302; implementation branch `feat/d3m03-map-generation-intake-20261102`  
**Runbook:** [D3M-03 Map Image Intake and Job Tracking](D3M-03-MAP-IMAGE-INTAKE-AND-JOB-TRACKING.md)

- Mounted a map-side intake panel for up to 12 JPEG/PNG/WebP facade images, 20 MiB each, using the existing signature-checking private media-upload API.
- Added metric footprint generation from explicit WGS84 center, footprint width/depth, heading, floor count and floor height. The resulting footprint/floor evidence is explicitly marked estimated, not surveyed.
- Added strategy-specific controls for single-image AI, COLMAP photogrammetry and procedural generation; procedural is labeled as dimension-driven and not image-derived.
- Requires a non-unknown rights/licence basis and explicit operator rights confirmation before queue creation. Upload starts with `usageStatus=unreviewed`; worker ingestion later sets `usageStatus=approved` via `rightsReviewMethod=explicit-cli-attestation` using that same operator attestation. This is pipeline eligibility metadata, not independent rights review or legal clearance.
- Added retry reuse of exact uploaded-source records while the dialog remains mounted and job/worker status polling with terminal-state stop.
- Added short-lived HttpOnly operator sessions. A distinct login token is exchanged once for a 30-minute SameSite=Strict cookie; the server-only HMAC signing secret and legacy generation bearer token are never embedded in the browser bundle.
- Added metric-geometry/strategy helper regression tests and a CI step.
- [x] Baseline exact-head Full CI passed on `e8860543277132008f2b8641f06d15fee90a6b1d`: [run #41399692306](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41399692306), 179/179 steps. This validates automated code/build checks, not an actual TripoSR/COLMAP reconstruction, image quality, survey registration or accuracy.
- Added local Hugging Face cache checks for TripoSR `config.yaml` and `model.ckpt`; single-image AI is claimable only when both files are cached. Any commit added after the cited SHA needs its own exact-head checks.
- D3M-03 remains Draft and depends on D3M-02 PR #302; neither has been merged to development/main.
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
- [x] Exact-head PR Full CI passed on D3M-04 branch head `d05274f4c30fddc45dc41cd464573c40b6745e58`: [run #41405970254](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41405970254), job `Lint and production build`, 179 workflow steps, no failed steps. PR #306 remains Draft pending independent review.
- **Important licensing limit:** rembg package licensing is separate from model-weight licensing. Current upstream rembg documentation identifies `bria-rmbg` as its default; BRIA RMBG 2.0 weights are source-available for non-commercial use unless separately licensed. Deployment must deliberately choose a model and verify applicable rights before commercial use.
- **No accuracy claim:** readiness does not prove that a real TripoSR run succeeds, that the output matches a building, that scale/georeferencing is correct, or that the candidate is map-ready. Release flags remain fail-closed.


## D3M-05 — Offline single-image runtime smoke (implementation candidate)

**Tracking issue:** [#307](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/307)  
**Dependency:** D3M-04 PR #306 → D3M-03 PR #304 → D3M-02 PR #302  
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
- **Explicit limits:** CI tests do not use actual TripoSR/rembg weights or GPU hardware. One successful smoke validates only one inference on one host/input. It does not prove broad building reconstruction accuracy, measured scale, orientation, ground-control registration or map readiness. No PR in the D3M-02 → D3M-05 stack is merged by this milestone.

## D3M-06 — bind reviewed placement to the map publication transform (implementation candidate)

**Tracking issue:** [#309](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/309)  
**Dependency:** D3M-05 PR #308 → D3M-04 PR #306 → D3M-03 PR #304 → D3M-02 PR #302  
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
- [ ] Record a separate exact-head Push CI pass before promotion. The available commit-scoped workflow result only exposes PR-triggered runs; no Push CI success is claimed here.
- [ ] Next operational gate: run the D3M-05 single-image smoke on the provisioned worker host using the real TripoSR/rembg caches and reviewed model/source terms, then independently verify and visually inspect the private GLB/report. This requires access to the actual worker host and must not be replaced by CI fakes.
- **Limitations:** placement binding prevents a post-review transform change; it does not independently prove the reviewer identity, coordinate truth, rights, architectural accuracy or vertical datum. All release gates remain false.

## D3M-07 — non-inference single-image worker preflight

**Dependency:** D3M-04 worker capability probe and D3M-05 single-image runtime smoke.  
**Implementation branch:** `feat/d3m07-single-image-worker-preflight-20261102`

- [x] Add a preflight adapter around the authoritative D3M-04 capability probe; request only `single-image-ai` so this check does not launch unrelated COLMAP commands.
- [x] Require TripoSR and rembg caches to be explicitly `cached` before returning ready; reject missing, unknown, malformed and blocked states.
- [x] Add a CLI with explicit Python, TripoSR runner and device overrides; use bounded probe timeout and non-zero exit for blocked/unknown readiness.
- [x] Keep output sanitized: do not serialize environment variables, executable paths, cache paths or credentials.
- [x] Prevent configured runner execution: read and syntax-compile `run.py` in memory; never invoke its top-level code or `--help` handler. Set Python bytecode suppression and Hugging Face offline/telemetry flags for the probe subprocess.
- [x] Keep release flags false and state clearly that preflight does not run inference, verify licences, establish GPU memory sufficiency or prove building accuracy.
- [x] Add unit tests for both model caches, missing/unknown state, malformed capability responses, timestamp validation, secret/path non-disclosure, strategy scoping and a real-Python runner-execution marker check.
- [x] Add the tests and CLI-help validation to Full CI and add this branch to push/PR workflow filters.
- [x] Align the D3M-05 real-smoke readiness recheck with the same single-image-only strategy scope; keep actual TripoSR execution inside the authorized inference workflow.
- [ ] Exact-head Full CI and a separately confirmed Push CI pass must both pass before this checkpoint can be promoted.
- [ ] Operator must run the preflight on the actual worker host, then complete the D3M-05 real inference smoke and independently inspect the GLB.
- **Safety boundary:** the preflight does not execute the configured TripoSR runner or call model-download/inference APIs. Python imports still execute installed package initialization code and may have package-specific side effects; this is not a hermetic read-only environment, OS sandbox or host firewall. Apply host/network egress and filesystem controls when strict guarantees are required.


## 2026-11-02 — D3M-00 → D3M-07 dependency/evidence reconciliation

The canonical current work-package mapping and branch/CI blockers are recorded in [D3M-00–07 Dependency Reconciliation](./D3M-00-07-DEPENDENCY-RECONCILIATION-2026-11-02.md).

Key closeout findings:
- D3M-01.A/B PR #281 is based on an old development head (35 ahead / 5 behind current development); exact-head CI passed, but it still needs rebase/retarget and revalidation.
- D3M-01.G PR #292 is based on D3M-01.F at 89f3f11a..., while current parent PR #290 is ab50f062...; rebase #292 and rerun PR + Push CI.
- D3M-03 current head has Push CI success but no exact-head PR CI run; rerun PR CI after stack rebase/retarget.
- D3M-06 current head has PR CI success but no exact-head Push CI; D3M-06 was added to the Push branch filter by the reconciliation update, but a same-head run is still required after safely updating/revalidating the branch.
- D3M-07 prior head af287278... had both exact-head PR + Push CI success (184/184 each). The current reconciliation commit adds schema/timestamp validation and therefore requires fresh exact-head CI.
- Real D3M-05 inference, independent GLB inspection, source rights, surveyed scale/georeferencing, production reviewer provisioning and deployed map publication remain external acceptance gates. Do not promote release flags.


## 2026-11-02 — D3M-07 fail-closed output hardening follow-up

The D3M-07 preflight now validates capability schema version, canonical/exact probe timestamp, strategy status and allow-listed model cache states. Unexpected model state values and unsafe rembg model identifiers are normalized/omitted instead of being echoed into the preflight report. Added regression coverage for schema, timestamp, stale result, unsupported cache-state and path-injection cases.

Current exact-head PR and Push CI are recorded at [#41443645721](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41443645721) and [#41443642326](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41443642326) on `8947049cd219474859be5923bde44b5c503ebd6d`. At the time of this update both were queued; do not treat the previous `af287278...` green runs as proof for this new head.

## 2026-11-02 — Latest D3M-00→D3M-07 exact-head recheck

This update supersedes the earlier D3M-00→D3M-07 checkpoint above where run IDs, SHA or status differ.

- D3M-02 #302 head 116453207d517db6db6a8a19f6cc5802f5630be0: PR Full CI #41449228282 and Push CI #41449218404 both succeeded.
- D3M-03 #304 head dc826ea5fb327cd4772c7725ad8add85e05a1f13: PR Full CI #41449879790 and Push CI #41449860665 both succeeded.
- D3M-04 #306 head 4028e097f02ebf3e44505c48b4d79424da2aaf27: PR Full CI #41450782703 and Push CI #41450775053 both succeeded.
- D3M-05 #308 head 3ed68591ab133acef70f0fedd45fab0f54aee34a: PR Full CI #41450939744 and Push CI #41450932957 both succeeded.
- D3M-06 #310 now includes D3M-05 parent history through merged sync PR #313, producing head 08344f681210da213261dfa7444b687dcb89796a. Exact-head PR run #41452436484 and Push run #41452430526 were still in progress at last check. In the PR job, steps 1–173 were successful; production-server viewport API verification (step 174) remained in progress. Do not check this gate until terminal success.
- D3M-07 #312 prior head 9956827be12377734ea2ec37c945f643b3a39a99 passed PR #41447645622 and Push #41447633166. Because D3M-06 advanced, synchronization PR #315 was opened (D3M-06 → D3M-07); it is Draft and mergeable, but not merged. Fresh exact-head CI is required after the sync.

D3M-01 chain:
- #281 current head 086c13f3467ebcbd3d2f46e1e4d45d4365a5d361 has current PR #41449210075 and Push #41449201350 success. Compared with live development, it is 36 commits ahead / 5 behind. Sync PR #314 was opened, Draft/mergeable, with only the current development additions across three paths. It remains unmerged pending review and post-sync validation.
- #284/#286/#288/#290/#292 each have a current PR-triggered and Push-triggered success on their respective recorded heads. Their current parent-child compares report zero commits behind.

Remaining:
- Wait for D3M-06 merged-head exact PR + Push runs to reach terminal success, then merge #315 and validate new D3M-07 head on both events.
- Review #314; if accepted, merge it only into the D3M-01.A/B feature branch and run fresh CI, then recheck child stack ancestry and exact-head CI.
- Keep PRs Draft until review. Do not promote development to main in this work item; their refs remain divergent (91 ahead / 6 behind).
- Real worker-host inference, model/source rights, production credentials, independent survey truth, visual accuracy review and release readiness remain external blockers. No accuracy or map-ready claim is made and all release flags remain false.

## 2026-11-02 — Final parent synchronization and numbering correction

- D3M-05 → D3M-06 dependency sync PR #313 is merged as D3M-06 feature-branch commit 08344f681210da213261dfa7444b687dcb89796a. Its exact-head PR Full CI #41452436484 and Push CI #41452430526 both completed successfully.
- D3M-06 → D3M-07 dependency sync PR #315 is merged as D3M-07 feature-branch commit f1991cea20b3533e407c7982edcda9690e485b53. Current parent-child comparison: 51 ahead / 0 behind. New D3M-07 exact-head PR #41453732972 and Push #41453723478 were pending before the final documentation refresh; rerun/inspect CI on the final SHA after the doc commits.
- D3M-01 sync PR #314 remains Draft/open/mergeable. #281 is 36 ahead / 5 behind current development. Keep it unresolved until the development additions are reviewed, integrated only into the D3M-01 parent feature branch, and new exact-head tests pass.
- D3M-02/#302, D3M-03/#304, D3M-04/#306, D3M-05/#308 and D3M-06/#310 each have PR + Push CI success on their current recorded code heads.
- D3M-01.C–G (#284/#286/#288/#290/#292) have PR + Push CI success and 0-behind parent comparisons on their current recorded heads.

Canonical D3M numbering: D3M-00 is the execution baseline / BRF-05/06 visual-review integration; D3M-01.A–G is the source-bound evidence and trusted-review chain; D3M-02 is approved-job map publication; D3M-03 is map-side intake/job tracking; D3M-04 is TripoSR/rembg cache readiness; D3M-05 is the offline real-inference smoke contract; D3M-06 binds reviewed placement; D3M-07 is the scoped non-inference worker preflight. Use this mapping in continuation work instead of the stale mapping from older plan text.

Do not confuse CI success with deployment or accuracy acceptance. Real worker-host preflight/inference, source and model-weight permissions, production operator/publisher credentials, a production trusted reviewer registry, independent metric/survey/vertical-datum truth, human GLB review, and deployed map reload/rollback remain external gates. Keep all ground-truth, acceptance, publication, map-ready, automatic-approval and dispatch flags false.
