# Dynamic 3D Engine — Next Execution Plan and Handoff Register

**Audit date:** 2026-11-03  
**Repository:** RakibulhasanUtsho07/3d-geospatial-platform  
**Plan owner:** repository maintainer  
**Status:** live baseline audited; next operational and acceptance gates recorded  
**Canonical branch at audit:** main = dev = ff5f2fed0182e8551f4f77d2ad84178a1906f7ee  
**Plan branch:** docs/dynamic-3d-engine-next-plan-20261103

> This document is the authoritative continuation point for future Dynamic 3D Engine work. A new session must refresh the repository state before acting; this snapshot is not a substitute for live verification.

## 1. Executive assessment

The repository contains a substantial Cesium mapping engine, Overture-based Dhaka footprint/3D Tiles pipeline, generation queue and media intake, candidate review/publication flow, single-image worker code, floor-plan review tooling, source-bound evidence contracts, and broad automated regression coverage.

The product is **not yet an end-to-end, independently validated architectural reconstruction engine**. The largest remaining gap is the difference between implemented software contracts and real, permission-cleared, measured, visually reviewed reconstruction evidence.

Current status in one sentence:

**The map, intake, review and publication foundations exist; the real worker-host inference, trusted human-review operation, independent building truth, architectural mesh quality, and production deployment acceptance are still open.**

Do not describe the current Dhaka footprint extrusion as a finished architectural model. Do not claim a universal accuracy percentage. Do not automatically publish AI-generated geometry.

## 2. Live repository baseline (2026-11-03)

### 2.1 Branch and promotion state

| Ref | Audited state | Decision |
|---|---|---|
| main | ff5f2fed0182e8551f4f77d2ad84178a1906f7ee | Canonical baseline |
| dev | Same SHA as main | Synchronized |
| development | 145 commits behind main at audit | Do not use as integration base |
| rakibul-hasan | 42 commits behind main; no unique commits ahead | Do not promote wholesale |
| PR #336 | Merged dev → main | Promotion completed |
| Main CI run #41600847111 | Successful on ff5f2fed | Exact main push validation passed |

PR #336 promoted dev at d626fdec10c73e50ba9f9f1eaafce0faea643f4e to main at ff5f2fed0182e8551f4f77d2ad84178a1906f7ee. It included the P3.4 map-panel/imagery diagnostic integration previously merged by PR #334.

Links:
- PR #336: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/336
- Main exact-head CI: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41600847111
- PR #334: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/334
- PR #334 source Full CI: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41598309048
- PR #334 source real-Dhaka baseline: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41598308948

The PR #334 real-Dhaka baseline passed six cold/warm samples on source head 75b44be029422f4dee64380fb45d62f52bff53d8. Each sample staged 3,000 building features and rendered 478 road entities; the report recorded zero imagery-tile errors and zero red-outlier flags. The six screenshot hashes are all identical (SHA-256 e6eb87b7e5115e5f91e38c2146a2fcea05d715e61ce6855aeead97e32d5834fa). The downloaded 1280×800 Linux/Chromium screenshot was visually inspected: the map is not blank, buildings and roads render, but the buildings remain boxy footprint extrusions with plain roofs and the Building Discovery, Nearby Places, Property Discovery, Map controls and Map Layers panels cover parts of the map. The report's saturated-red canvas detector flagged 0/6 samples; that signal does not identify a layer or prove the historical red-overlay root cause has been fixed. Cold/warm median map-ready times were 18.45 s / 17.77 s; median road-terminal times were 23.46 s / 22.78 s; median long-task counts were 60 / 57. This is a shared headless CI baseline, not a target-device review, a representative multi-scene visual sample, live provider health, or a production performance SLA. PR #334 explicitly did not declare the historic red imagery anomaly fixed.

### 2.2 Branch safety rules

1. Re-read main HEAD before creating any work branch.
2. Create new implementation branches from the then-current main (or from an explicitly documented current integration target after checking repository policy).
3. Do not use development or rakibul-hasan as a merge base while they remain behind main.
4. Never merge an old stacked branch solely because its title or issue appears relevant. Compare exact head/base SHAs, merge-base, unique commits, changed paths and current file contents.
5. Keep one bounded work package per PR. Prefer Draft PRs until tests, exact-head CI and evidence review pass.
6. Do not force-push, rewrite shared history, close an issue, or merge a PR without checking current status and preserving unique work.
7. Promote only the reviewed PR head. After merge, verify the resulting main SHA and post-merge CI.

## 3. Capability inventory and honest status

| Capability | Repository implementation | Remaining acceptance |
|---|---|---|
| Cesium map engine, selection/picking, viewport staging, LOD and caching | Present in src/core/map-engine | Continue lifecycle/browser regression and real-device review |
| Overture Dhaka footprint tiles and manifest/alignment validation | Present; P3.6 package integrated | Does not equal roof/facade architectural geometry |
| Source-height provenance and building/part metadata | Present; P3.7/P3.8 work integrated | Many heights are estimates; metadata is not geometry or survey truth |
| Road layer and bundled Dhaka road extract | Present | Test live deployment, fallback/cancellation and out-of-coverage behavior |
| Map-side still-image intake and generation-job tracking | Main; PR #324 | Actual worker configuration, rights, source review and runtime operation remain |
| Approved generation-job publication to Cesium catalog | Main; PR #302 | Production auth/storage and real placement/accuracy evidence remain |
| Signed source-bound reviewer decision/evidence foundation | Main; PR #326 | Real reviewer onboarding, governance, key provisioning and independent authority remain |
| TripoSR/rembg capability probe and single-image worker | Code and contract tests present | Real worker-host preflight, model/license decision and an actual inference smoke remain |
| Reviewed placement binding | Code/tests exist in the cumulative generation flow | Surveyed coordinate/height/heading truth remains separately unproven |
| Floor-plan raster tracing and calibrated vector-review workflow | Main; PR #333 | Manual review only; not automatic PDF understanding or complete interior generation |
| Ahsan Manzil / Bangabhaban procedural candidates and render evidence | Candidate tooling exists | Geometry/texture defects, independent measurements and human acceptance remain |
| Independent building-accuracy evidence evaluator | Validator and contracts exist | No accepted real 2–3 building benchmark pack yet |
| Marketplace/property data | Demo/illustrative product foundation | Real sourced listings, owner verification, persistence and moderation remain |

### 3.1 Important implementation boundaries

- Current Dhaka Overture 3D Tiles output is footprint extrusion / cuboid massing. The metadata resolver records source or absent/invalid architecture fields; it does not create roof meshes, facade components, windows, doors, balconies, textures, or assembled parent/part building geometry.
- The inspected full Dhaka extract contains 17,008 features. The audit recorded 15,868 with a license value and 1,140 without one. A present license field is not equivalent to an exact asset-level rights review.
- Height values derived from Overture are source metadata, not independent survey truth. Three-metre-per-floor and nine-metre fallbacks are labelled estimates. No verified terrain/vertical datum is established by the 2D footprint source.
- Single-view TripoSR output is an AI-proposed candidate. It can hallucinate hidden geometry and must not be treated as a surveyed building or automatically map-ready.
- A passing unit test, CI build, GLB parser, synthetic fixture, screenshot, manifest, or cryptographic signature proves only the contract it checks. None independently proves physical building identity, legal rights, measured scale, architectural correctness, or reviewer qualification.
- Floor-plan scale is currently human-attested, not independently survey-verified. The current P3.7 workflow does not rasterize PDFs, infer room semantics, generate furniture, publish a final GLB, or add an interior model to the map.

## 4. Remaining work register

Status vocabulary:
- **MERGED** — code has been integrated into the current main line.
- **IMPLEMENTED / OPERATIONAL BLOCKER** — code and tests exist; real environment, human evidence, or provisioning is missing.
- **PARTIAL** — one bounded workflow exists; the full product capability does not.
- **NOT ACCEPTED** — candidate output exists but fails or lacks its acceptance evidence.
- **BACKLOG** — not yet justified for the current critical path.

### WP-00 — Mainline integrity and promotion hygiene

**Status:** current mainline promotion completed; continuous gate.

Remaining:
- Keep main and dev synchronized only when the active release flow requires it.
- Maintain a single authoritative status ledger.
- Reconcile open issues that track functionality already merged (for example D3M-02/D3M-03) without closing issues whose operational acceptance is still pending.
- Review old open PRs #103, #104, #169, #185, #187–#190 and #279 against main. Preserve unique valuable work; do not bulk-merge or bulk-close.
- Replace stale documentation snapshots with this current-main continuation plan. PR #279 is not the authoritative current plan because its branch was based on a historical development SHA.

**Acceptance:** branch comparison is recorded; every retained PR has a decision (continue, rebase/reimplement, superseded with evidence, or close); no unique change is lost; current main CI passes.

### WP-01 — P3.4 dynamic map real-data quality and UX

**Status:** code integrated; CI and six-sample CI browser baseline passed on PR #334 source head; independent visual acceptance remains open.

Completed:
- Responsive map docks and reduced viewport occlusion.
- Dhaka Home and orientation-reset separation.
- Privacy-safe imagery tile error diagnostics.
- Canvas red-pixel anomaly signal.
- Map viewport UX and browser regression tests.
- Six cold/warm browser samples on the exact PR #334 source head.

Completed evidence inspection:
- Downloaded and inspected the six PNGs and report from run #41598308948. All six files have the same 437,683-byte length and SHA-256 e6eb87b7e5115e5f91e38c2146a2fcea05d715e61ce6855aeead97e32d5834fa.
- The 1280×800 headless screenshot shows a populated Cesium canvas, visible road geometry and dense box-like building extrusions; the five floating UI panels listed in §2.1 obscure portions of the map. Roofs remain visually plain.
- Also inspected the dedicated responsive-layout artifact from Full CI run #41598309048 (`p3-4-map-panel-occlusion-visual-evidence`): 1440×900 desktop and 390×844 mobile captures. The browser test verifies the default discovery/map docks do not overlap at these sizes and checks the Cesium attribution remains clear. These captures use deterministic stub imagery (solid-blue map canvas) and sample API responses; they validate layout only, not live Dhaka map rendering or imagery quality.
- Report visualAnomalyReview: saturated-red signal evaluated 6 canvas samples and flagged 0. This is not a root-cause diagnosis.
- Cold/warm median map-ready: 18.45 s / 17.77 s; median road-terminal: 23.46 s / 22.78 s; median long-task count: 60 / 57. These are CI observations, not device-level SLAs.

Remaining:
1. Perform target-workstation browser review at representative desktop and mobile sizes; record browser, viewport, GPU/device and screenshots.
2. Compare the target-workstation layout against the already inspected 1440×900 and 390×844 CI dock captures; the automated assertions passed for those two sizes.
2. Decide whether the panel occlusion seen in CI is acceptable for the intended viewport or requires a measured layout correction.
3. Verify the historic red imagery/overlay anomaly has a diagnosed cause before claiming it is fixed. Pixel detection is a signal, not a root-cause diagnosis.
4. Confirm camera orientation, building/road alignment, image-provider failures, fallback/cancellation behavior and layer toggles.
5. Check the deployed environment separately; CI does not prove deployed Cesium assets, tile providers, API credentials, CORS, cache behavior or device GPU performance.
6. Extend comparable cold/warm measurements only where they answer a concrete regression question. Do not convert shared CI timing into a production SLA.

**Acceptance:** exact candidate SHA; clean working tree; 3 cold + 3 warm successful samples; six inspected screenshots; actual building stage and road-render counts; no unexplained map anomaly; target-device review recorded; no functional regression; deployment smoke recorded separately.

### WP-02 — D3M-04 / D3M-05 / D3M-07 real worker-host validation

**Status:** IMPLEMENTED / OPERATIONAL BLOCKER.

Relevant tracking:
- D3M-04: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/305
- D3M-05: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/307
- D3M-07: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/311

Present in main:
- Bounded worker capability probe for Python, device, TripoSR and rembg readiness.
- Single-image worker with explicit confirmation, source validation and bounded output checks.
- Operator smoke command and independent smoke-evidence verifier.
- Tests for cache readiness, failure states, sanitized output, hash binding and fail-closed gates.

Remaining operational sequence:
1. Select/provision the actual worker host and record its OS, Python, PyTorch, ONNX Runtime, rembg, TripoSR runner version and available device.
2. Explicitly choose the rembg model and review the exact model-weight licence for intended use. Do not infer weight rights from the Python package licence. Do not proceed with an unapproved or unknown licence.
3. Provision model weights out-of-band under the approved deployment policy; confirm the probe reports cached state for both TripoSR and the active rembg model.
4. Apply host-level filesystem and network-egress controls where required. The Python socket guard is not a kernel firewall or hermetic sandbox.
5. Use one rights-cleared JPEG/PNG source, fresh source/building/job identifiers, and all required explicit operator confirmations.
6. Run one real offline smoke through the same media-to-model workflow used by the queue worker.
7. Independently re-run the smoke evidence verifier. Bind source SHA-256, output GLB SHA-256, byte length, mesh count, tool/model versions, device, timestamps and sanitized QA output.
8. Inspect the GLB in a real renderer; record topology, dimensions, visible geometry defects and human-review decision. Keep it private and unpublished.

**Acceptance:** one successful real-host process spawn and completed inference; exact source/output hashes verified independently; no hidden weight downloads; exact model and licence decision recorded; GLB opens and passes structural QA; reviewer records limitations and disposition. This proves one host/input smoke only, not general building accuracy.

**Blocker rule:** if host access, model weights, licence decision, or permitted source image is absent, mark this work blocked. Never replace a real smoke with CI fakes or a simulated success.

### WP-03 — D3M-01 production reviewer trust operation

**Status:** IMPLEMENTED / OPERATIONAL BLOCKER.

Relevant tracking:
- D3M-01.F: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/289
- D3M-01.G: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/291
- Review hand-off / signed decision chain: issues #283, #285 and #287.

Present:
- Source-bound immutable candidate hand-off.
- Ed25519 signed reviewer decision receipt.
- Server-controlled versioned public-key registry contract.
- Registry validity, revocation, rotation and safe preflight code/tests.

Remaining:
1. The operating organization must verify real reviewer identity, role and authority outside this repository.
2. Generate reviewer signing keys using the approved secret-management process; keep private keys out of GitHub, artifacts, source code and application logs.
3. Provision only reviewed public keys to the production server registry.
4. Verify expiry, revocation, emergency lockout, key rotation and audit trail in the deployment environment.
5. Perform a real signed review against a source-bound candidate and independently verify the receipt.
6. Keep reviewer identity/authority, source rights, camera calibration, independent truth and architectural correctness as separate evidence gates.

**Acceptance:** approved organization process; active versioned public-key registry; tested key rotation and revocation; actual authorized reviewer signature; server-side signature verification; complete audit trail. A signature proves possession of a trusted key, not by itself a person's qualifications or model correctness.

### WP-04 — BRF real-building source rights, identity and independent truth

**Status:** PARTIAL / NOT ACCEPTED.

Relevant tracking:
- Same-building link and metric frame: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/248
- Exact source rights / target building: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240
- BRF-05–07 visual evidence: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/199
- Held-out checkpoints: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/297
- Independent survey-backed GLB evaluation: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/208
- Ahsan Manzil ambiguity: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/203

Remaining:
1. Select one target building first; do not combine several buildings or uncertain asset matches.
2. Verify exact asset-level rights for every image, point cloud, CityGML/LOD model, survey file, camera metadata and derivative use.
3. Prove same physical building identity across source images, point cloud, footprint, model and measurements.
4. Pin exact source bytes, URLs/revisions, hashes, CRS, axes, units, coordinate operation and uncertainty.
5. Establish independent metric dimensions and non-collinear held-out checkpoints that are disjoint from fitting inputs.
6. Record mask/architectural feature review, camera calibration, image coverage and human comparison.
7. Evaluate the platform-generated candidate against independent truth with the existing BRF evaluators. Keep geometry, dimensions, horizontal placement, vertical reference, texture and visual assessment as separate outcomes.
8. Publish no single “accuracy %” unless the metric, denominator, independent source and exact tested asset are specified.

**Acceptance:** one rights-cleared, same-building, hash-pinned candidate with independent dimensions and held-out controls; candidate generated by this platform's own pipeline; reproducible report; human review; release decision explicitly recorded.

### WP-05 — P3.3 architectural geometry and texture correction

**Status:** NOT ACCEPTED.

Current candidate history:
- Ahsan Manzil correction PR #104.
- Bangabhaban correction PR #169 / #185.
- Generic 13-view render and evidence pipelines exist.

Known limitations:
- Ahsan Manzil render/geometry QA has reported degenerate triangles, long edges, non-manifold/open boundaries, detached components and missing texture/UV evidence.
- Roof deck, architectural surface detail, facade texture and visual match are not accepted.
- Model dimensions/placements with no independent survey remain estimates.
- A generated render is not independent source evidence.

Remaining sequence:
1. Start only after a rights-cleared reference and measurement pack is available (WP-04).
2. Freeze BuildingSpec, source-image hashes, camera manifest and current GLB hash.
3. Repair topology and geometry defects in a bounded correction pass.
4. Validate walls, openings, arches, columns, stair, roof and dome against source-backed dimensions; do not infer hidden geometry from a cropped photo.
5. Build calibrated camera-to-UV projection and a reviewed texture atlas only from permitted, source-matched images.
6. Produce fixed front/back/left/right/top and oblique views with the exact same camera mapping.
7. Re-run geometry, texture, render-reference and correction-verification reports.
8. Require human sign-off before any model becomes acceptance-eligible.

**Acceptance:** no blocking topology defects; texture/UV checks pass or are explicitly waived with reasons; all reported dimensions trace to source evidence; 13-view manifest hashes match; visual review accepted; no release flag is enabled by automation alone.

### WP-06 — P3.6 / P3.8 actual architectural 3D Tiles

**Status:** PARTIAL; current tile pipeline is real code but architectural output is still extrusion/cuboid massing.

Remaining:
1. Audit the exact Overture source/metadata report and license state for each selected feature.
2. Join parent and building_part by verified building_id; preserve unresolved, ambiguous and excluded records in the report.
3. Choose a small prototype only where permitted source geometry or independently reviewed imagery supports the added detail.
4. Generate roof/wall/facade components as separate deterministic geometry modules; add openings and material/texture only when evidence supports them.
5. Preserve source field provenance, missing/invalid metadata and confidence. Never fill absent metadata with a plausible architectural style.
6. Build a bounded tile package with correct coordinate transforms, bounding volumes, geometric error/LOD, selective content URIs and stable per-building hashes.
7. Validate tileset and GLBs, fixed-camera alignment, cold/warm viewport selection, cancellation, fallback, memory and package size.
8. Verify live Cesium rendering on the target browser/device.

**Acceptance:** one small licensed, source-supported architectural tile prototype; exact source/GLB/tile hashes; parent/part and coordinate tests; selective viewport browser rendering; independent visual review. The fixture/manifest passing is not enough.

### WP-07 — P3.7 floor-plan to interior model

**Status:** PARTIAL; private/manual vector-review foundation merged by PR #333.

Present:
- Raster line proposals and manual trace/review.
- Source-byte and proposal/review hash binding.
- Two-point human-attested scale calibration.
- Reviewed wall vectors and closed-room boundary checks.
- Private preview/candidate workflow.

Remaining:
1. Add rights-cleared real floor-plan examples with independently measured scale/dimensions.
2. Add PDF/image raster ingestion as a separate bounded and secure input pipeline.
3. Support CAD/IFC/BIM imports as separate source adapters; do not silently treat them as raster.
4. Add explicit room, wall, door, window and stair semantics with reviewer correction.
5. Extend multi-floor connectivity, levels, wall heights and floor-to-floor relationships.
6. Add interior furniture only from explicit dimensions/catalog assets; furniture placement must be editable and reviewable.
7. Bind the source plan, metric transform, vector draft and resulting GLB by hashes.
8. Add independent dimension checks and a browser model review.
9. Connect the approved interior candidate to the existing safe publication path only after all gates pass.

**Acceptance:** rights-cleared real plan; independent scale and dimensions; reviewed semantic geometry; valid watertight shell where required; openings fit walls; exact hash linkage; human review; explicit publication approval.

### WP-08 — P3.5 / P3.8 production lifecycle and security

**Status:** PARTIAL; important module boundaries and file-backed job/workflow logic already exist.

Remaining:
- Audit ownership between map adapter, BuildingViewportManager, RoadLayerManager, GeneratedModelLayer, generation queue, worker and publication catalog.
- Test viewer teardown, late async completion, add/update/remove/visibility races, request cancellation, duplicate IDs, primitive disposal and memory cleanup.
- Avoid broad rewrites; extract one owner at a time only when a measured lifecycle or maintenance defect exists.
- Decide the real deployment model: single host or multiple workers; local disk or durable shared object storage; queue/lock strategy; worker concurrency.
- Implement/verify production authentication and roles, quotas, size/time limits, retry/resume, idempotency, dead-letter handling, private asset storage, retention/deletion, audit records, worker health and rollback.
- Add traversal/symlink/race, interrupted-write, restart and concurrent-worker tests.
- Add deployment runbooks, secrets configuration, monitoring, backup and recovery checks.

**Acceptance:** documented target deployment; security tests; restarted/concurrent worker tests; resource teardown tests; production smoke; rollback exercise. Do not call file-backed queue behavior “multi-instance durable” without testing it on the intended deployment.

### WP-09 — P3.9 property product and release readiness

**Status:** BACKLOG / separate product workstream.

Remaining:
- Replace demo/illustrative listing records with explicitly sourced, fresh and licensed data.
- Add owner/listing verification, moderation, persistent accounts/favorites and audit.
- Provide real routable network paths or label all distances clearly as straight-line.
- Finish accessibility, mobile interaction, empty/loading/error states, privacy, attribution, security, monitoring, backup and rollback.
- Run a user acceptance matrix on supported browsers/devices.

**Acceptance:** non-demo data integration; provenance/freshness and rights recorded; security/privacy review; real-user tests; production runbook. Keep separate from the core reconstruction acceptance gates.

## 5. Recommended execution order

Do not start all work packages in parallel. Follow these dependencies:

1. **WP-00 — maintain a clean main baseline.** Confirm exact HEAD and exact-head CI before creating each next branch.
2. **WP-01 — finish P3.4 evidence review.** The source-branch six-sample CI baseline already passed, and main Full CI passed. Record target-device visual inspection and diagnose the historical red-overlay anomaly. Make another UX code change only if the reviewed evidence identifies a reproducible defect.
3. **WP-02 — execute one real single-image worker smoke.** This is the highest-value end-to-end proof of the intake → worker → private GLB → evidence verifier path. It is blocked until a permitted source, approved model-weight licence and provisioned worker host are available.
4. **WP-03 — provision a real reviewer trust registry.** This enables a real source-bound human decision rather than a test-only signature.
5. **WP-04 — build one independent real-building benchmark.** Do not optimize model accuracy before the candidate/reference pair, exact rights and independent truth are valid.
6. **WP-05 — repair one landmark model against that evidence.** Keep Ahsan Manzil and Bangabhaban candidate work separate; choose one target per correction batch.
7. **WP-06 — promote one evidence-supported architectural tile prototype.** Only after a geometry candidate is accepted independently of the tile manifest.
8. **WP-07 — extend floor-plan review to complete interior generation.** Keep this a separate product lane with its own data and acceptance.
9. **WP-08 — harden the production deployment.** Apply the deployment model to the actual queue, storage and workers.
10. **WP-09 — marketplace integration and release.** Do not use demo property records as production listings.

If WP-02 or WP-03 is blocked by external access/rights/provisioning, record the blocker and continue with the next unblocked bounded engineering task. Do not manufacture evidence to avoid a blocker.

## 6. Next-action pointer

**Last reviewed:** 2026-11-03, after the P3.4 evidence inspection and WP-00 targeted PR reconciliation.

### NEXT-01 — P3.4 target-workstation visual acceptance

- Completed: inspected six 1280×800 live-Dhaka CI screenshots/report from run #41598308948; 6/6 sample records succeeded, each reported 3,000 building features and 478 road entities, with no imagery tile errors and no red-outlier flags.
- Completed: inspected desktop 1440×900 and mobile 390×844 responsive dock captures from run #41598309048. The layout tests assert no panel overlap and clear Cesium attribution at those exact sizes. These are deterministic stub imagery/API layout tests, not live-Dhaka screenshots.
- Not complete: target-workstation/mobile device review, GPU/browser-specific behavior, deployed-provider health, and root-cause diagnosis of the historical red imagery anomaly. No target device or deployed environment evidence is available from the repository audit.
- Decision: treat the remaining device/deployment checks as an external validation blocker. Do not fabricate screenshots or mark P3.4 fully accepted. Reopen code work only when a reproducible defect is supplied with viewport, browser/device, screenshot and exact source SHA.

### WP-00 — targeted historical PR reconciliation

Current `main` is still `ff5f2fed0182e8551f4f77d2ad84178a1906f7ee`; `dev` was identical at the audit. Historical PR decisions from exact branch/head comparisons:

| PR | Current finding | Decision |
|---|---|---|
| #103 | Head `f75cbc13...`, 71 unique commits from merge base `271b7c5c...`; 878 commits behind current main in the divergent comparison. The specific `facade-placement.mjs` helper is absent from main, but the 29-file PR also changes multiple generation/worker/renderer files. | Do not merge wholesale. Preserve as a source for targeted review of facade-local insert placement; port only after checking current implementation and tests. |
| #104 | Head `d1347e81...`, 62 unique commits from the same old merge base; 878 behind in the divergent comparison. Main already contains the Ahsan model builder, parameter JSON and LOD3 GLB, while this PR changes those same assets and renderer/test paths. | Treat as a stale model revision, not a clean promotion. Compare its parameter/render evidence against the current main candidate before selecting any individual correction. |
| #169 | Head `c9c285d9...`, base was historical development `2868a479...`; 42 unique commits and 393 behind current main in the divergent comparison. Bangabhaban review/model/evidence paths in the diff are not in main. The candidate still has documented topology, texture and independent-measurement blockers. | Preserve Draft as a historical candidate/evidence source; do not promote until a current-base independent visual/geometry review closes its blockers. |
| #185–#190 | Stacked chain rooted at `46dbd970...` on old `rakibul-hasan`; the heads are 245 commits behind current main in the divergent comparisons. Main lacks the old BRF-01 generic profile module, BRF-02 candidate manifest module and BRF-04 controlled synthetic fixture. Current main already has later BRF-25/26 evidence and D3M-01 signed-review paths, so overlap must be reviewed rather than copied. | No stacked merge. BRF-04 is being clean-ported independently in PR #339. Review #185–#189 separately for non-duplicate value and current API compatibility. |
| #279 | Documentation branch based on historical development `98b2fa56...`; 114 unique commits and 150 behind current main in the divergent comparison. It contains an old repository snapshot/roadmap, not a current-base integration candidate. | Keep as historical reference; PR #338 is the current-main continuation plan. Port only still-useful material after comparing it with #338. |

The comparison counts above describe divergent history from each merge base; they are **not** safe merge instructions and do not prove that each unique commit is still relevant. Never use an ahead count alone to cherry-pick or merge.

### NEXT-02 — BRF-04 controlled GLB regression clean port

- New clean branch: `feat/brf04-controlled-glb-baseline-main-20261103`, based on `main@ff5f2fed0182e8551f4f77d2ad84178a1906f7ee`.
- Draft PR #339: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/339
- Exact head: `50f19f26d365f66b42b3ce02bd07025d572762bb`; 6 commits ahead / 0 behind, 6 changed paths.
- Adds a synthetic 10×8×6 cuboid GLB fixture, deterministic SHA-256 regression, +20% Y-scale and degenerate-triangle defect injection, invalid-input checks, npm script, CI step and limitations documentation.
- Reuses main's `glb-geometry-qa.mjs` and `reference-dimension-validation.mjs`; no old BRF-01/02/03 stack was merged.
- Exact-head Full CI run #41604594271 **passed**; focused BRF-04 step #131 also passed.
- Real-Dhaka browser baseline #41604594444 **passed all six cold/warm samples**.
- Same-head supplementary PR checks passed: P3.6 #41604594440, P3.7 #41604594280, BRF-05–07 #41604594463, BRF-14 #41604594287 and BRF-35 #41604594347. A separate BRF-45 manual dispatch rerun #41604671931 also passed.
- Separate manual workflow_dispatch CI run #41604663810 and P3.6 browser run #41604666326 failed because the lifecycle evidence test accepted only `push` / `pull_request` even though the repository supports manual `workflow_dispatch`. The failure occurs at the event-name assertion, after the browser lifecycle report itself is produced. This is not a PR-triggered BRF-04 failure; the cross-event contract is tracked separately in PR #341.
- PR #339 remains Draft/unmerged pending review. Its synthetic checks do not prove real-building fidelity or survey accuracy.

### NEXT-03 — explicit facade selection, right-handed glTF map frame and Blender review orientation

- Current-main gaps: procedural entrance selection used longest-edge inference only; facade insert placement needed winding-aware local coordinates; GLB/render review lacked one shared geospatial front-bearing and coordinate-frame contract.
- Historical sources: facade-local insertion from stale PR #103; compass bearing and dome bounds-center policy from stale PR #185. Neither old PR was merged.
- Clean branch: `feat/explicit-front-facade-and-insert-clearance-main-20261103`, based on `main@ff5f2fed0182e8551f4f77d2ad84178a1906f7ee`.
- Draft PR #340: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/340
- Current exact head: `72ec5446be34a9ddd69b1d40603d410ca78ab8ca`; 62 commits ahead / 0 behind, 16 changed paths. The ahead count includes isolated incremental commits; all remain on the Draft feature branch.
- Adds mutually exclusive `architecture.frontFacadeEdgeIndex` and `architecture.frontFacingAzimuthDegrees`; selects the nearest outward footprint normal, warns and keeps review-required if alignment is beyond 15 degrees. Evidence conflicts downgrade orientation confidence to `unknown`.
- Adds central dome anchors `front-inset` and `footprint-bounds-center`; retains center and evidence confidence. Bangabhaban's 180-degree front and bounds-centered dome remain **estimated**, never promoted to surveyed truth.
- Maintains winding-aware facade-local tangent/normal placement, 2 mm inner-face clearance and jamb offsets along facade tangent.
- Coordinate contract now uses a right-handed geospatial glTF frame: `+X=east, +Y=up, +Z=south, -Z=north`. Longitude east maps to positive local X; latitude north maps to negative local Z. Compass bearing (b) is encoded across X/Z as `(sin(b), -cos(b))`.
- Blender's glTF importer mapping converts `(x,y,z)` to Blender world `(x,-z,y)`: `X=east, Y=north, Z=up`. Review cameras, top-view roll and lighting now follow that frame; missing GLB bearing uses deterministic south-facing 180-degree camera direction but retains `renderer-default/unknown` provenance.
- Renderer rejects a GLB that supplies geographic bearing without `coordinateFrame=gltf-right-handed-x-east-y-up-z-south`; final manifest separately rejects frame/bearing mismatch and preserves the frame.
- Added numeric cardinal/elevation/turntable camera tests, right-handed east/north footprint conversion tests, GLB frame assertions, render-manifest mismatch tests, renderer and heritage regression checks.
- Exact-head Full CI before the coordinate migration: #41609731172 passed on older head `2cade9a...`; it is not acceptance evidence for the migrated frame.
- Intermediate current-frame CI #41614929630 on `21da6c...`: generator #17, render manifest #117, Blender syntax/numeric camera policy #132, heritage suite #187, production build #191 and Chromium install #192 all passed. Production-server viewport check #193 remained in progress at the last query; no failed steps. A later new head superseded it.
- Current exact-head Full CI [#41615973376](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41615973376) runs on `72ec5446be34a9ddd69b1d40603d410ca78ab8ca`. At 10:04 UTC, ESLint and all focused suites—including BuildingSpec/procedural GLB, render manifest, Blender camera-axis numeric policy, heritage GLBs, geometry QA, Dhaka tiles and benchmark gates—passed. Production build passed; Chromium installation was active. Production viewport/browser verification and evidence uploads remained pending. No failure observed; not terminal Full CI success.
- Exact-head P3.6 [#41615973496](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41615973496) completed with `success` on the same SHA; it is separate from Full CI.
- Intermediate regeneration #41614888112 failed manifest test #5 because its fixture lacked `modelCoordinateFrame`; the fixture was subsequently corrected and current CI #17/#117/#132/#187 passed.
- Current-head Bangabhaban regeneration [#41615964154](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41615964154) checked out exact head `72ec5446be34a9ddd69b1d40603d410ca78ab8ca`. At last refresh, generated-model/frame validation #5, Blender/dependency setup #6 and licensed reference hash verification #7 passed; 13-view Blender render #8 was in progress, no failures. Added final verification to require GLB JSON extras, candidate report and render manifest to agree on coordinate frame, front bearing and confidence/source before artifact upload/branch commit.
- Current-head Bangabhaban regeneration [#41615964154](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41615964154) checked out exact head `72ec5446be34a9ddd69b1d40603d410ca78ab8ca`. Model/frame validation #5, Blender/dependency setup #6 and licensed reference SHA verification #7 passed; 13-view Blender render #8 was active at 10:04 UTC. No failure observed.
- Tracked Bangabhaban report still referenced legacy model SHA `a3d0c9c6dde5432c24efc95c2cf8035aefd6f285f72bc3e48f44681c03633cc6` and had no verified new frame; no artifact was yet exposed and save-to-branch had not run. Do not call the candidate updated until the manifest gate and save-to-branch succeed, then verify model SHA, coordinateFrame and bearing/confidence parity.

### NEXT-04 — workflow_dispatch evidence event provenance

- Root cause: manual dispatches were supported by CI/P3.6, but the controller lifecycle browser test accepted only `push` and `pull_request`. Manual runs #41604663810 and #41604666326 failed at that assertion after browser lifecycle scenarios ran.
- Clean branch based on main: `fix/p36-workflow-dispatch-evidence-event-20261103`.
- Draft PR #341: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/341
- Head `e7abfcbb294561954d460b85bb021c1c06784df1`; one test-file change. Manifest retains actual `GITHUB_EVENT_NAME`; test accepts `workflow_dispatch` while rejecting missing/unrecognized events.
- Exact-head Full CI #41606193975 **passed** and P3.6 workflow #41606193939 **passed**.
- Manual workflow-dispatch rerun remains outstanding; the current GitHub connection can inspect Actions but cannot invoke the manual dispatch. Do not call the manual trigger path verified until a real dispatch run exists.
- PR #341 remains Draft pending manual trigger verification and code review.

### NEXT-05 — raw video must not count as a facade capture without extracted frames

- Current-main gap: `assessBuildingCaptureManifest` counted raw `video` records as inspectable view records. A video file itself is not an independently inspectable still/frame for front/back/left/right coverage.
- Historical source: stale stacked PR #189 suggested a similar safeguard in a larger image-quality integration. Only the narrow video/frame relationship was ported.
- Clean branch based on main: `fix/capture-video-frame-evidence-coverage-main-20261103`.
- Draft PR #342: https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/342
- Exact head `7559946227c4cf156b7faa81586e1a97a0cdfcbb`; 3 commits ahead / 0 behind, 3 changed paths.
- Only `photo` and `video-frame` records count toward view coverage; videos are counted separately. Each capture video needs at least one linked extracted-frame record by parent `sourceId`.
- Added `video-frame-extraction` readiness check, regression tests for raw-video rejection and linked-frame acceptance, and documentation.
- Exact-head Full CI #41607259442 **passed**, including capture-manifest step #30 and production-server viewport verification.
- PR #342 remains Draft pending code review. This schema does not decode/extract actual video or establish frame quality.

### NEXT-06 — generic, profile-driven Blender review renderer

- Targeted audit of stale PR #187 found a useful renderer architecture gap: current main's `scripts/blender/render-building-review.py` still contains Rangmahal-specific node-name selection (`Rangmahal_GF`, `Dome`, `RoofDeck`, `Site_`). It falls back to whole-model rendering for other buildings, but adding another heritage building requires another code change.
- PR #187 is stacked on old base `fix/bangabhaban-front-dome-alignment@5c936c7...`, so it cannot be merged wholesale. The unique profile idea can be ported independently after #340 stabilizes.
- Candidate scope: a validated versioned render profile that supports global excluded-node prefixes, front-view include/exclude exact node names, bounded elevation, deterministic framing label, profile SHA-256 provenance and Node/Blender parity validation. Default remains generic whole-model; a Rangmahal profile preserves the known focused view without hard-coded names in the renderer.
- Must preserve PR #340's new GLB bearing/confidence metadata and current render-manifest checks when porting. Do not overwrite those fields with the older PR #187 manifest implementation.
- Acceptance: profile schema tests (unknown keys, wildcards, duplicates, include/exclude conflict, invalid elevation, missing selected mesh), deterministic profile hash, Blender receives the exact preflight hash, raw/final manifest records profile metadata, generic synthetic GLB produces 13 views in real Blender smoke, and explicit Rangmahal profile produces a focused front view without changing the GLB.
- Do not start the implementation until current PR #340 exact-head CI #41609196223 is terminal and reviewed. Then create a dependent PR based on the reviewed #340 branch or first integrate #340; avoid a second clean-main PR that conflicts on the same renderer/manifest files.

**Immediate next action:** refresh #41615964154 and require all 13 renders, final manifest/GLB/report parity, evidence upload and successful save-to-branch. Re-fetch the tracked GLB/report and verify exact model SHA, right-handed coordinateFrame and front-bearing/confidence fields. Refresh #41615973376 and wait for terminal Full CI including production viewport/browser verification and evidence uploads. P3.6 #41615973496 is already terminal success on this SHA. Keep #340 Draft; do not merge before independent code/geometry review. Only after these gates should NEXT-06 generic profile-driven renderer port begin. PR #341 operator-run workflow_dispatch, P3.4 target-device review and WP-02 real worker-host smoke remain separate external blockers.





## 7. Mandatory acceptance checklist for every future work unit

A unit is not complete merely because code was written.

- [ ] Re-read this plan and refresh main/dev/development/rakibul-hasan HEAD SHAs.
- [ ] Re-check open PRs, issues and branch ancestry for existing work.
- [ ] State the precise gap being fixed and why it is the next dependency.
- [ ] Record the baseline SHA, changed paths and exact expected behavior.
- [ ] Add focused regression tests, including failure and stale/async paths when relevant.
- [ ] Run relevant focused tests, lint and production build locally/CI as appropriate.
- [ ] Run browser/API or real-data workflow where the feature requires it.
- [ ] Inspect generated evidence, hashes, screenshots and logs; distinguish CI from real-world evidence.
- [ ] Verify all release flags remain false unless separate, explicit human acceptance authorizes them.
- [ ] Update this plan's status, exact SHAs, PR/run links, outcome, unresolved risks and next action.
- [ ] Promote only the exact reviewed PR head after required CI passes.
- [ ] Verify post-merge main CI and update the ledger again.

### Release gates that must remain fail-closed

Unless explicit evidence and separate human approval justify otherwise, keep all of these false:

- groundTruth
- acceptanceEligible
- publicationEligible
- mapReady
- automaticApproval

A technical publication API being available does not mean an unreviewed candidate is eligible for publication. A successful publication test with synthetic fixtures does not authorize a real building model.

## 8. “Next” continuation protocol for any future chat

When the user says **“next”**:

1. Open this file first and read its current Next-action pointer and mandatory checklist.
2. Query GitHub again for the current main/dev SHAs, latest CI runs, open PRs/issues and relevant branch ancestry. Never rely on the audit snapshot if the repository has changed.
3. Compare the intended work item against the current main code and existing open/merged PRs. Avoid duplicate work and avoid stale branches.
4. Choose the first unblocked action in the recommended order. If an action needs the user's private worker host, credentials, source rights, model weights or a real human reviewer, report the exact blocker and do not simulate it.
5. Make one bounded change only. Create a fresh branch from the verified current main SHA, add focused tests and documentation, and open a Draft PR unless the work is documentation-only and policy clearly permits direct merge.
6. Validate the exact head SHA. Read CI step results and logs for failures; never call a pending run successful.
7. Inspect the actual artifact/report and update this file with what changed, what passed, what failed, and the next single action.
8. Do not merge to main unless the exact-head checks pass and the relevant human review/approval is complete.

A future chat should be able to resume with only the instruction **“next”** by following this protocol and refreshing live state first.

## 9. Audit references

- Current roadmap snapshot: docs/ENGINE-REMAINING-WORK-ROADMAP.md
- P3.4 merged implementation: PR #334 and PR #336
- D3M-01 signed review foundation: PR #326
- P3.6–P3.8 Dhaka tiles and metadata integration: PR #327
- P3.7 floor-plan raster/vector review: PR #333
- D3M-02 publication path: PR #302
- D3M-03 map intake/job tracking: PR #324
- Main exact-head CI: run #41600847111

All links are scoped to the repository and audit snapshot date. Refresh them when continuing work.
