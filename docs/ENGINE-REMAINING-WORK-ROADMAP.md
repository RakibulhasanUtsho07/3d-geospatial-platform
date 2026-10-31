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

## Primary Dynamic 3D Map delivery path

The highest-priority product outcome is one integrated building workflow: select/identify a building, upload rights-cleared media and information, generate and review a candidate, validate metric scale and geospatial placement, publish an approved version, and load it into the existing Cesium map without manual file copying.

Use [Dynamic 3D Map End-to-End Execution Plan](./DYNAMIC-3D-MAP-END-TO-END-EXECUTION-PLAN.md) as the detailed execution checklist (D3M-00–D3M-13). Use [Engine Integration and Production Roadmap](./ENGINE-INTEGRATION-AND-PRODUCTION-ROADMAP.md) for cross-project dependencies and integration gates.

**Immediate next task: D3M-00 — reconcile current branch/PR ancestry and exact-head CI before changing generation or map integration code.** Do not jump directly to a later implementation phase while the source branch and PR dependencies remain ambiguous.

The roadmap distinguishes existing module foundations from accepted end-to-end behavior. Procedural GLB generation is not photo reconstruction; single-image output is an inference preview; a COLMAP result is a candidate; a GLB load is not geospatial validation; and a passing CI run is not architectural acceptance.

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


---

## Dynamic 3D Map — live continuation status (2026-10-30)

**D3M-00: IN PROGRESS.** The live branch and critical-PR snapshot is recorded in the [D3M-00 execution log](./DYNAMIC-3D-MAP-END-TO-END-EXECUTION-PLAN.md#10-d3m-00-live-execution-log--2026-10-30). Do not restart the broad audit from zero; re-fetch the live SHAs and continue from its exact next-task pointer.

- Integration baseline observed: \`development@98b2fa56f387c2bdbf4dad5c24e6f131dd66d076\`; \`main@7d90b76dadaf9eebd91b9aeb13cf12dcefb5086b\`; \`rakibul-hasan@01fc0caf4f08b1aa1dc8c1fdced1667c8d7fcb91\`.
- \`development\` vs \`main\` is diverged (86 ahead / 4 behind); \`rakibul-hasan\` vs \`development\` is diverged (10 ahead / 89 behind). Do not merge stale histories wholesale.
- PR #274 is the stronger current-base map-UX candidate; PR #196 has duplicate overlapping patches and stays open until #274 review.
- PRs #277 and #278 are BRF-05/06 feature deltas on an old base. Clean-port them one at a time from a newly re-confirmed \`development\` head.
- PR #228 is not ready for promotion based only on green CI; reconcile the main-only commits and review the exact merge candidate.
- D3M-00 has not passed acceptance; no application code or release flags changed during the audit pass.

**Next exact task:** D3M-00.B — create a new branch from the latest verified \`development\` head and selectively port only PR #277's manual mask editor, browser test, and additive report section. Do not cherry-pick the old branch history. Record exact-head focused/browser/full-CI results before moving to D3M-00.C (#278).

### D3M-00.B — manual mask editor clean-base port (2026-10-30)

**In progress — Draft PR [#280](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/280).**

- New branch `feat/brf05-07-manual-mask-review-dev-20261030` is based exactly on `development@98b2fa56f387c2bdbf4dad5c24e6f131dd66d076`.
- Four paths are ported from old-base PR #277: local mask editor HTML/JS, a Playwright browser spec, and the additive BRF-05–07 evidence-report section. No old branch history was cherry-picked.
- PR head `09a52828e78f853c3a19a8f60c5bd32b3ccc73fd`; exact-head CI #2513 / [run 40997949731](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40997949731) was in progress at last check.
- Keep the PR Draft; no test pass is claimed yet. Original PR #277 remains open until #280 is verified/reviewed.
- All release flags remain fail-closed.

**Next:** finish #280 exact-head CI and review. Then clean-port #278 sequentially (D3M-00.C).

### D3M-00.C — BRF-06 architectural observation studio clean-base port (2026-10-30)

**In progress — combined Draft PR [#281](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281).**

- Branch `feat/brf06-observation-review-dev-20261030` was created at the exact validated parent PR #280 head `09a52828e78f853c3a19a8f60c5bd32b3ccc73fd`, itself based on `development@98b2fa56f387c2bdbf4dad5c24e6f131dd66d076`.
- New head: `f0de3b3bb2e4dd4aa7b3eafdec0483c93faff548`; combined development-relative diff is 9 unique paths, 917 additions, no deletions.
- Parent PR #280's CI #2513 passed all steps, including browser/API integration, but it has no review and remains Draft/open.
- Child/combined PR #281 includes the #280 mask editor and #278 observation studio. Do not merge #280 and #281 independently; after #281 is accepted, #280 is subsumed.
- PR #281 CI #2519 / [run 40998801920](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40998801920) is in progress; latest inspection showed ESLint running and later tests pending.
- Important gap recorded: observation batches still have `mask: null`; a shared source-bound mask/observation contract remains D3M-01/WP-01 work.

**Next:** resolve #281 CI, review combined diff, then define the unified BRF-05/06 evidence bundle. Release gates stay false.

### D3M-00.B / D3M-00.C — BRF-05/06 clean-base combined candidate (2026-10-30)

- **Parent #280:** manual mask editor clean-port at `09a52828e78f853c3a19a8f60c5bd32b3ccc73fd`; full exact-head CI #2513 / [run 40997949731](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40997949731) passed. #280 remains Draft and is not merged.
- **Canonical combined PR #281:** [BRF-05 mask + BRF-06 observation studio](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281), branch `feat/brf06-observation-review-dev-20261030`, current head `04b62ceb910b6c63986703ec1587846a1676bc85`, base `development@98b2fa56f387c2bdbf4dad5c24e6f131dd66d076`, 9 unique paths / 930 additions / 0 deletions.
- Its prior exact-head CI #2519 passed on the previous head, and an additional rejected-review round-trip test block has now been added. Updated exact-head CI #2530 / [run 41000920752](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41000920752) is in progress; no pass is claimed for the latest head yet.
- **Duplicate #282 is closed** (not merged); #281 is the single canonical candidate. The BRF-06 source files are SHA-identical to old-base PR #278; the fuller unit test and shared report are retained in #281.
- Merge #281 only after its latest exact-head CI and human review pass. Do not merge #280 independently; #281 includes its parent change. After #281 merges, close #280/#277/#278 as superseded only after confirming they are fully subsumed.
- The mask editor and observation studio are still separate; observation batches export `mask: null`. D3M-01/WP-01 must define the shared mask+observation source-bound bundle. All ground-truth, acceptance, publication, map-ready and automatic-approval flags remain false.

**Next:** check CI #2530 on the exact head, then finish the remaining D3M-00 map duplicate, #193 residual-diff, and #228 release-ancestry work. See the [D3M execution log](./DYNAMIC-3D-MAP-END-TO-END-EXECUTION-PLAN.md#10-d3m-00-live-execution-log--2026-10-30).


### BRF-06 canonical PR reconciliation — 2026-10-30

- Canonical combined clean-base candidate is [PR #281](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281), head `04b62ceb910b6c63986703ec1587846a1676bc85`, based on development. It contains both #280's mask editor and the BRF-06 observation review port (9 unique paths in total).
- Updated exact-head CI #2530 / [run 41000920752](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41000920752) is pending/in progress at this checkpoint. Earlier #2519 passed only on the prior head and cannot validate the current commit.
- Duplicate [PR #282](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/282) has been closed; do not merge/reopen it. Old-base #278 remains reference evidence only.
- Keep #281 Draft; no merge until exact-head CI and human review. #280 is its parent content and must not be merged independently if #281 is accepted as the combined candidate.
- Observation studio still exports `mask: null`; shared mask/observation bundle and cross-artifact tests are a D3M-01 prerequisite. Release gates remain false.

See the [D3M execution log](./DYNAMIC-3D-MAP-END-TO-END-EXECUTION-PLAN.md#107-d3m-00c--canonical-brf-06-clean-base-port-2026-10-30) for exact dependency and continuation details.


### Exact-head CI completion — PR #281 (2026-10-30)

Correction to the earlier pending checkpoint: canonical combined PR #281 head `04b62ceb910b6c63986703ec1587846a1676bc85` completed exact-head CI #2530 / [run 41000920752](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41000920752) with **success**. All job steps passed, including ESLint, unit/contract tests, production build, Chromium production-server viewport API/browser integration and P2.3–P2.6 evidence uploads. This does not equal human review or merge approval: #281 remains Draft/open/unmerged, #280 remains its parent, and the shared mask/observation bundle gap (`mask: null`) remains. Continue D3M-00 ancestry reconciliation (#274/#196, #193, #228); do not enable release flags.


### D3M-00 branch reconciliation — 2026-10-30

- P3.4 canonical [PR #274](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/274), head `439e5c8ee26f263471b060a35296d681e0add182`: exact-head CI #2285 and Real-Dhaka Browser Baseline #45 both passed. Keep Draft pending human review of six-sample evidence; no claim that the imagery anomaly is fixed.
- Duplicate #196 was closed without merge; its implementation patches are present in #274, which adds the real-Dhaka baseline workflow on current development. Old-base #193 was closed without merge because its generated-model-layer implementation and test are already byte-identical in development; architecture note preserved at `docs/MAP-ENGINE-MODULARIZATION.md`.
- Main promotion PR #228 stays open/unmerged: development is 86 commits ahead / 4 behind main, 204 changed paths, merge base `e4fd7ddfedd4fbd2faa6cdd185deeddc81dbce1c`. Inspect all four main-only commits before any promotion. Do not merge blindly.
- Next: inspect four main-only commits, record their contents and decide safe reconciliation. D3M-01 remains blocked on the source-bound shared mask/observation bundle.


### Main ancestry check — 2026-10-30

A direct compare of main `7d90b76dadaf9eebd91b9aeb13cf12dcefb5086b` against its exact merge-base `e4fd7ddfedd4fbd2faa6cdd185deeddc81dbce1c` reports 4 commits ahead, 0 behind, but **zero changed paths**. Thus the four main-only ancestry commits introduce no net tree difference relative to the merge base; the 204-path delta in PR #228 is the development-side work. Do not cherry-pick those four commits or describe them as missing code. Keep PR #228 unmerged until exact-head promotion CI/review is checked and the current development tree is intentionally approved for main. This resolves the content-loss concern, not the release authorization.


### 10.12 D3M-01.A — shared mask + observation evidence bundle (2026-10-30)

**Status: IMPLEMENTED ON PR #281; exact-head CI pending. Not yet merged or accepted.**

- Added `src/core/building-generation/source-bound-visual-evidence-bundle.mjs`. It hashes actual source bytes, mask PNG bytes, mask-manifest bytes and observation-export bytes; checks decoded source/mask dimensions supplied by the decoder; requires exact source ID/SHA-256/dimensions across artifacts; checks mask encoding/size/hash; rejects conflicting observation mask hashes; normalizes the observation batch and inserts the exact mask SHA-256 into its batch-level mask reference.
- Added local browser wizard `/experimental/source-bound-evidence-bundle.html` + `.js`. User selects original source image, mask PNG, mask-review JSON and observation JSON. Browser hashes all bytes, decodes both images, verifies binary white-foreground mask pixels and emits a single manifest with the normalized observation batch. The files are not uploaded; original source/mask/manifest/export files must be retained alongside the bundle.
- Added core regression tests for valid linkage, source-byte tampering, mask-byte tampering, decoded dimension mismatch, source mismatch, conflicting mask references, per-observation mask hash mismatch, release-gate tampering, review-state consistency and malformed/missing files. Added local-wizard static contract tests and a Chromium end-to-end browser spec that creates source/mask fixtures, exports observations from the existing editor, builds the bundle and rejects a mask-byte mismatch.
- Registered `test:source-bound-visual-evidence-bundle` in `package.json` and added it to `.github/workflows/ci.yml`; browser spec is picked up by the Playwright browser suite.
- Canonical implementation remains on [PR #281](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281), branch `feat/brf06-observation-review-dev-20261030`, exact head `ee76e33135174b67fac35c2f75e4c6c38ebaaf11`. Compare to development: 22 commits ahead, 0 behind, 17 changed paths. Exact-head CI #2557 / [run 41002994374](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41002994374) is pending at this checkpoint; do not claim test success until it completes.
- **Acceptance boundary:** this joins artifacts by exact bytes and provenance; it does not validate semantic mask correctness, independently authenticate reviewers, grant rights, establish building identity, calibrate a camera, provide surveyed dimensions or prove model accuracy. Bundle and all release flags remain false. The observation editor still exports its standalone original with `mask: null`; the new wizard creates a separate normalized batch with the exact mask reference rather than mutating the source export.
- **Next:** poll exact-head CI #2557. If it passes, inspect the browser artifact and add any needed regression fixes. Then extend the bundle contract to bind rights/camera/ground-control evidence only when those inputs exist; never synthesize missing evidence or turn this bundle into automatic publication.


**D3M-01.A validation hardening checkpoint (2026-10-30):** browser bundle wizard now also validates observation IDs/categories/methods/status/visibility/confidence, geometry bounds, original-proposal source/view provenance and append-only review-history consistency before emitting the bundle. Static UI contract test covers the validation entry point. Latest PR #281 head is `598b2eb3e54d0e15fa2e9113910ab8ea546001b7` (17 paths, 1,633 additions vs development); exact-head CI #2563 / [run 41003170124](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41003170124) is pending. Earlier run #2557 was started on an earlier head and must not be used as validation for this SHA.


**Latest exact-head checkpoint (2026-10-30):** browser end-to-end fixture was corrected to use a valid but hash-mismatched binary mask, and the wizard now validates observation batch ID/timestamp as well. Canonical PR #281 head is now `db3603b7f9280ba7e8aa9139c0dc9669d57295c5`, 17 changed paths / 1,635 additions against development. Exact-head CI #2569 / [run 41003359778](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41003359778) is pending; earlier run #2563 was cancelled after the head changed and cannot validate this SHA.


### 10.13 D3M-01.B — rights, camera and ground-control evidence linkage (2026-10-30)

**Status: implementation committed on canonical PR #281; exact-head CI pending. Not merged; not a release gate.**

- Added `src/core/building-generation/source-bound-reconstruction-evidence.mjs` to link the per-view visual bundle to BRF-45 exact-asset rights records, camera calibration evidence and WGS84 ground-control evidence for one exact building/source/candidate-GLB tuple.
- Rights linkage hashes the raw BRF-14 source manifest, BRF-45 rights register and BRF-45 validator report; checks source-manifest digest and exact source ID/SHA-256 across source view, rights row and validator report. It explicitly records that the rights validator report is linked but not recomputed by this module and does not authenticate grantor authority or legal permission.
- Camera linkage verifies actual calibration-evidence bytes against declared SHA-256/size, binds each camera's calibration evidence ID/hash to the same building/source image and candidate GLB hash, and recomputes existing camera matrix/image-bounds/reprojection validation through `validateCameraProjectionEvidence`. Unverified calibration remains review-required.
- Ground-control linkage verifies actual survey-evidence bytes, exact source-image and candidate-GLB hashes, requires each control point to reference a byte-verified evidence asset, and recomputes the existing WGS84 similarity registration through `registerModelToWgs84`. It retains the existing explicit limitation that vertical datum is not solved.
- Added `tests/source-bound-reconstruction-evidence.test.mjs` for a valid synthetic linkage, stale rights-source-manifest hash, tampered camera evidence bytes, tampered survey evidence bytes, unaudited camera calibration and release-flag promotion attempts. Registered `test:source-bound-reconstruction-evidence` in package scripts and CI.
- Canonical parent PR #281's later exact head is `21ad424b0f611b0274693c4a3c4f633b7548bedc`; exact-head CI [#41072445284](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41072445284) passed 181/181 steps. The earlier `a89e0a0...` snapshot was superseded; its pending state must not be mistaken for the later parent-head result.
- The extension is a linkage/recomputation and review-preparation artifact only. It does not read or validate the GLB bytes, prove building identity, verify survey authority, authenticate human reviewers, solve vertical datum, establish architecture accuracy or authorize map placement/publication. Every policy/release flag remains false.
- **Next:** wait for exact-head CI and fix any failing contract. Then define the explicit human review record and immutable decision flow; do not promote release flags. Afterward proceed to D3M-02 upload/intake UX only when the evidence contract is stable.


**D3M-01.B exact-head CI correction checkpoint (2026-10-30):** first integration run [CI #2576](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41072030603) failed only in the newly added evidence-linkage tests. The log identified a fixture variable typo (`groundControlManifestBytes` was not defined); the test was corrected to use the declared `groundManifestBytes`. The stale rights-report test was also corrected to assert a fail-closed blocked result rather than expecting an exception, and the unaudited-camera fixture now retains its byte-linked calibration artifact while asserting review-required status. Latest code head `21ad424b0f611b0274693c4a3c4f633b7548bedc`; a fresh exact-head CI run has not appeared yet. Do not treat #2576 as passed.

### D3M-01.C — immutable candidate hand-off (planned 2026-10-30)

- Tracking issue: [#283](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/283).
- Dependency: PR #281 exact head `21ad424b0f611b0274693c4a3c4f633b7548bedc`; exact-head CI [#41072445284](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41072445284) later passed 181/181 steps, including production-server viewport/browser integration. This supersedes the earlier planning-time snapshot that recorded the run as still in progress.
- Integrate the evidence *after* the model-generation stage has emitted the real candidate GLB, because D3M-01.B binds camera and ground-control evidence to that actual candidate hash. Bind the exact QA report and source/job identities in an immutable review-only hand-off. Reuse reconstruction-job stage artifacts and upstream fingerprints.
- Reject stale/tampered bytes, inconsistent identities, unsafe paths, unlinked evidence assets and invalid GLB container data. Keep rights and human-review requirements explicit; do not mark any model accepted or map-ready.
- Existing rights report remains human-review-required; WGS84 registration does not resolve vertical datum. No accuracy or publication claim.

### D3M-01.C — candidate evidence hand-off implementation (2026-10-30)

**Status: Implemented; exact-head CI passed.**

- Code: stacked Draft [PR #284](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/284), exact head `dc326af772dce95484cd2565d581ed5f99744369`, parent [PR #281](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281) exact head `21ad424b0f611b0274693c4a3c4f633b7548bedc`.
- Validation: [CI #41076263050](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41076263050) PASS, 181/181 workflow steps; focused hand-off tests 11/11 pass, including immutable resume, incomplete-rights fail-closed, candidate/QA tamper, wrong source, malformed GLB, traversal and file/directory symlink tests.
- Integration: two-stage immutable child job uses current reconstruction-job artifacts; CLI and CI test-step added. Candidate/evidence linkage happens only after actual worker GLB and QA report exist.
- Still blocked: both PRs are Draft/unmerged; rights and calibration/GCP authority require human review; vertical datum and geometry/architectural accuracy are not proved. No dispatch, human acceptance, publication or map readiness.
- Next: inspect and human-review PRs #281 and #284 together. D3M-01.D is implemented on dependent PR #286 with exact-head CI PASS; proceed next to D3M-01.E signed-receipt enforcement in the independent-truth evaluation path, without changing release flags.

### D3M-01.D — trusted-signer geometry review (2026-10-30)

**Status: Implemented on stacked Draft PR #286; exact-head CI PASS, 182/182 workflow steps. PR remains Draft/unmerged.**

- [Issue #285](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/285) / [PR #286](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/286), branch `feat/d3m01d-authenticated-geometry-review-20261030`, head `3e92b4be02d8f6bad6baec274887c148359ad8f7`. Stacked on D3M-01.C #284 head `dc326af772dce95484cd2565d581ed5f99744369`.
- Runs existing GLB geometry/topology QA on exact D3M-01.C candidate bytes and pins the report to the immutable hand-off artifact, candidate SHA-256 and byte length.
- Ed25519 signed review records use server-provisioned public keys only; decision payloads are canonical JSON, signed outside server, and stored in a separate immutable child job. API rejects untrusted reviewer IDs, wrong keys, payload tampering and caller-supplied public keys.
- Continue-to-independent-validation is blocked unless all human review checks and upstream hand-off integrity flags are true, including vertical datum. That decision is not acceptance/publication approval.
- Exact-head full CI [#41082811923](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41082811923) passed 182/182 steps, including D3M-01.D focused tests, production build and production-server viewport/browser integration. P2.3–P2.6, multi-tile workload and Ahsan Manzil GLB artifacts were uploaded.
- Deployment still requires configuring `GENERATION_EVIDENCE_REVIEW_API_TOKEN` and `RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON` as server secrets. Private keys stay with the reviewer. No production reviewer registry is claimed.
- All truth, geometry-acceptance, release, publication, map-ready and dispatch flags remain false. Deployment still needs `GENERATION_EVIDENCE_REVIEW_API_TOKEN` and `RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON`; private keys stay with reviewers. PR #286 and its parent chain remain Draft/unmerged. Next: D3M-01.E signed-receipt enforcement in independent-truth evaluation.



## D3M-01.E — signed reviewer receipt required by BRF-25 (2026-10-30)

[Issue #287](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/287) / [Draft PR #288](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/288), stacked on D3M-01.D PR #286. Branch `feat/d3m01e-brf25-authenticated-review-gate-20261030`; current head `8bd2bc4c74bc57cd0375a256e9d97a31ab8baf7f`.

The BRF-25 runner requires the D3M-01.D immutable reviewer child-job ID and building ID. It recomputes the hand-off, candidate GLB and geometry QA report, reads and checksum-validates the stored review artifact/job, reconstructs the canonical signed payload, and re-verifies the signature against the current server registry. It blocks all extraction/evaluation for absent receipts, invalid/rotated trust keys, hash or identity mismatches, malformed metadata and decisions other than `continue-to-independent-validation`.

CI regression coverage includes a valid synthetic receipt and blocked missing/rotated-key/hold receipts before extraction. The verifier's signature-hash check deliberately derives the digest from stored signature bytes and compares it to the immutable source manifest, preserving compatibility with the D3M-01.D receipt schema without assuming a duplicate hash field inside its authentication object.

Exact head CI [#41094817059](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41094817059) is **in progress** as of this update; earlier heads failed on issues that have since been corrected, so there is no D3M-01.E pass claim yet. All truth, accuracy, acceptance, publication, map-ready and dispatch flags remain false. Synthetic keys do not represent a provisioned production reviewer trust registry or real human review. Next: terminal exact-head CI success, all evaluator entry-point bypass review, then human PR review. Keep #288 and all parent PRs Draft/unmerged.


## D3M-01.E hardening — direct independent-truth evaluator bypass closed (2026-10-31)

The evaluator had a second runnable entry point: `scripts/evaluate-independent-building-truth.mjs` / `npm run evaluate:independent-building-truth`. Unlike BRF-25, that direct CLI did not require the signed D3M-01.D review receipt. This bypass is now covered by [Draft PR #288](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/288), [Issue #287](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/287).

The standalone CLI now requires workspace, exact building ID and immutable review-job ID, re-reads and validates the stored D3M-01.D decision, recomputes the linked hand-off/GLB geometry report, and verifies the canonical Ed25519 signature with the current server-side trusted-key registry before metric replay/computation. A missing or invalid receipt emits a blocked report with `metrics: null` and exits non-zero. BRF-25 passes the same binding through to its evaluator subprocess, which independently re-verifies the receipt. The pure in-memory evaluator API is explicitly marked as a non-authorizing metric kernel and keeps all truth/release flags false.

Direct CLI tests now cover valid receipt, no receipt, rotated key, wrong building and stale candidate bytes. Current code head `4d69948d32dec9c01b6a9482dc605b5feb2fe46d`; [CI #41159581178](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41159581178) is in progress; no new exact-head CI pass is claimed yet. Prior BRF-25 and signer tests had passed on preceding D3M-01.E head, and full CI for that earlier code head was successful, but the current bypass closure needs its own run. Production trust registry and real reviewer signing remain unverified. All geometry/truth/acceptance/publication/map-ready/dispatch flags remain false.


### D3M-01.E extraction-entrypoint hardening follow-up (2026-10-31)

The independent-truth preparation CLI `scripts/prepare-independent-building-truth-manifest.mjs` is also a direct GLB geometry-extraction entry point. It now independently requires the same D3M-01.D signed reviewer receipt, building ID, review job ID, workspace and current trusted-key registry before extracting candidate geometry. The BRF-25 runner passes the verified context to both the preparer and the evaluator subprocess; each subprocess re-verifies the immutable receipt rather than relying on a parent-process Boolean. Tests in the geometry-preparation CLI fixture now create synthetic signed D3M-01.D records and cover missing receipt and rotated-key rejection. Current code head: `5c4886630279b2d6684dd19c61b261f416c6b58a`; exact-head CI [#41159947313](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41159947313) was still in progress at the time of this documentation commit, during dependency installation. No new CI pass is claimed. All truth/accuracy/acceptance/publication/map-ready/dispatch flags remain false.


## D3M-01.E hardening — direct geometry-preparation CLI secured (2026-10-31)

Repository audit found a second direct route in `scripts/prepare-independent-building-truth-manifest.mjs`, which can extract candidate GLB geometry and write a prepared manifest without first calling the BRF-25 parent runner. This direct entry point now requires the same workspace, building ID, immutable D3M-01.D review-job ID and current server-side Ed25519 registry; it recomputes/validates the exact candidate hand-off binding before GLB extraction. BRF-25 passes the same binding to both preparation and evaluation subprocesses, each of which verifies independently.

Tests now exercise the real verifier dependency graph in the isolated CLI fixture, including no receipt and rotated-key denial. The config/caller building-ID variable collision and blocked evaluator report newline have been fixed; stale-candidate assertions expect a pre-replay authorization block with metrics withheld.

Code head `03c8f4fcf213c7f1201d55a55cee6802fec9bd64`; [exact-head CI #41160633951](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41160315096) is in progress at this documentation update. There is no current-head pass claim. All geometry validation, reference truth, held-out accuracy, ground truth, acceptance, publication, map-ready and dispatch flags remain false.
