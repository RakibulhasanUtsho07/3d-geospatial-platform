# Full Repository Gap Audit

**Audit snapshot:** 2026-10-30  
**Audited ref:** `development` at `98b2fa56f387c2bdbf4dad5c24e6f131dd66d076`  
**Purpose:** Record engineering, evidence, production-readiness, and integration gaps found during a repository-level review.  
**Status:** Assessment only; this document does not certify runtime behavior or close any acceptance gate.

## 1. Executive assessment

The repository has substantial working foundations: a Cesium-based Dhaka map, Overture-derived building footprints, viewport and caching controls, procedural and photogrammetry-oriented reconstruction components, GLB integrity/geometry checks, source-byte and rights-scope controls, evidence/review tooling, floor-plan vector work, and a growing BRF validation chain.

The remaining risk is not simply missing features. It is the gap between **a tool or validator existing** and **an end-to-end, independently evidenced, secure production workflow**. In particular:

1. No accepted multi-building Dhaka benchmark pack with independently surveyed dimensions, verified source identity/rights, georeferenced control, held-out checks, and human-reviewed fixed-camera outputs has been demonstrated in the reviewed baseline.
2. The reconstruction path still needs proof that source media, rights, camera/coordinate frames, observations/masks, generated geometry, texture, and final QA remain bound end-to-end.
3. Several user-facing workflows remain pilot/local or illustrative rather than production multi-user services.
4. A green CI run validates the tested commit and test matrix; it does not establish visual fidelity, survey accuracy, production load capacity, or universal device performance.
5. The requested user journey — upload building information/images, generate a candidate, establish trustworthy dimensions and geographic placement, approve it, and have the existing map load it — is not yet demonstrated as one end-to-end workflow. Existing generation, job, review, publishing, and map-loader components remain partly operator-driven and separated by manual evidence/placement steps.

**No universal accuracy percentage (including 90%) is supported by this audit.** Accuracy must be reported per metric, per building, and against independent evidence.

## 2. Scope, method, and limitations

### Reviewed material

- Repository tree and branch metadata available on 2026-10-30.
- `README.md` and `docs/ENGINE-REMAINING-WORK-ROADMAP.md` on the audited `development` ref.
- Open pull-request metadata, including BRF-06 PR #278.
- Known BRF evidence and implementation notes available in the project history.
- Branch heads at audit time: `development` = `98b2fa56f387c2bdbf4dad5c24e6f131dd66d076`, `main` = `7d90b76dadaf9eebd91b9aeb13cf12dcefb5086b`, and `rakibul-hasan` = `01fc0caf4f08b1aa1dc8c1fdced1667c8d7fcb91`.

### Method

This is a repository/document/PR metadata audit, not a fresh execution of every test, deployment, or visual review. Claims are classified as:
- **Implemented evidence:** code/docs/PR artifacts indicate a capability exists.
- **Partial:** a component exists but end-to-end integration or acceptance evidence is incomplete.
- **Gap:** required behavior/evidence is not established by the reviewed material.
- **External dependency:** requires real data, rights-holder response, survey work, deployment infrastructure, or human review.

### Important limitations

- Counts and branch SHAs are a point-in-time snapshot and will change.
- An open PR is not assumed to be missing or complete; it must be compared against its base and current implementation.
- A test fixture, synthetic dataset, manifest, or generated render is not independent ground truth.
- This audit does not claim that all listed gaps are absent from every feature branch. It identifies what was not established on the audited integration baseline.
- The current `rakibul-hasan` branch is behind the audited `development` head. Do not blindly merge either branch or create a large promotion PR without a commit/file-level reconciliation.

## 3. Current baseline: strengths and boundaries

| Area | Evidence of capability | Boundary that remains |
|---|---|---|
| Dhaka map | Cesium viewport, Overture-derived footprints, roads/nearby service layers, search and picking | Data freshness, height provenance, coverage, and visual quality vary by source and viewport |
| 3D building display | Footprint extrusion, procedural detail, generated GLB loading | Procedural facade details are not surveyed building truth |
| Reconstruction | Media intake, FFmpeg frame extraction, COLMAP adapter, PLY-to-GLB conversion, single-image/procedural paths | One repeatable, rights-aware, independently validated end-to-end pipeline is not yet proven |
| Geometry QA | GLB parsing/extraction and integrity checks, dimension and metric replay work | Passing structural checks does not prove correct building shape or dimensions |
| Evidence/review | Source-bound manual masks and architectural observation/review tooling on feature PRs | Mask/observation/rights/camera/geometry hand-off still needs a single tested contract |
| Floor plans | Raster line proposals, vector calibration and measured-vector shell work | Full PDF/image-to-semantic floor-plan extraction and verified interior model remain incomplete |
| 3D Tiles | Manifest/fixture and tile-related validation work | Fixture validation is not proof of production-quality real-content conversion/rendering |
| Product | Interactive pilot and illustrative property listings | Listings, accounts, persistence, moderation and deployment are not a production marketplace |
| Generated-building user journey | Media intake/upload, generation workers, review/publishing tools, catalog reader, and Cesium GLB layer exist | No accepted single flow yet connects map intake → rights-aware job → reviewed reconstruction → independent placement → approved publication → persistent viewport-aware map loading |

The README explicitly labels property listings illustrative and footprint/gross-floor-area values approximate rather than survey measurements or verified flat sizes. Keep those labels visible in product UI and API responses until real data and validation exist.

## 4. Prioritized gap register

Priority definitions: **P0 = blocks trustworthy acceptance/publication or creates material security/data risk; P1 = blocks core end-to-end product capability; P2 = scale, usability, or operational maturity.**

### G-01 — Independent real-building benchmark and ground truth
**Priority:** P0 · **Status:** External dependency + implementation gap

**Observed gap**
- The reviewed roadmap records a visual-fidelity failure for the Parliament candidate and says independently surveyed dimensions/accepted surveyed control residuals are not attached.
- The roadmap also says P3.2 lacks real surveyed building evidence.
- The reviewed material does not establish a rights-cleared, identity-confirmed, independently measured 2–3 building Dhaka pack with held-out checkpoints.

**Required work**
- Select representative landmark and ordinary buildings.
- Verify building identity and source rights at asset and permitted-operation level.
- Freeze source bytes and source metadata; bind every derivative to hashes.
- Obtain independent footprint, height, roof, and selected facade/control measurements, with measurement method, uncertainty, CRS, and vertical datum.
- Keep training/reference observations separate from held-out validation points.
- Report horizontal, vertical, dimensional, mesh, texture, and visual-review outcomes separately.

**Acceptance evidence**
- Reproducible benchmark manifest; source/GLB hashes; signed or attributable measurement record; coordinate-frame definitions; residual tables; fixed-camera renders; independent reviewer decision; explicit unknown/occluded fields.
- No aggregate accuracy score unless its formula, weighting, sample count, and uncertainty are justified.

### G-02 — Rights and provenance continuity
**Priority:** P0 · **Status:** Partial

**Observed gap**
- BRF-38/45/46 work adds source rights and operation-scope enforcement. This is important, but a hash proves byte identity, not permission.
- The complete chain from source acquisition through derivatives, frame extraction, segmentation/mask, COLMAP, model generation, caching, review export, and publication needs integration-level proof.

**Required work**
- Carry immutable source ID/hash, rights holder, license/permission evidence, allowed operations, expiry/territory/attribution obligations, and derivative policy through every stage.
- Re-check authorization at execution time and when reusing cached outputs.
- Bind derived assets to the exact source set and transformation/config versions.
- Fail closed for unknown, expired, conflicting, or out-of-scope permissions.

**Acceptance evidence**
- Positive and negative tests for each operation; revoked/expired permission tests; cache replay denial; export/publication denial; complete provenance graph from input to output.

### G-03 — BRF-05 mask and BRF-06 observation integration
**Priority:** P1 · **Status:** Partial

**Observed gap**
- BRF-05 provides source-bound manual masks; BRF-06 provides source-bound architectural observations and review history.
- The current BRF-06 PR description identifies `mask:null` in its batch path. The two review artifacts are not yet demonstrated as one interoperable evidence bundle.

**Required work**
- Define one versioned evidence-bundle schema linking source, building, view, mask, observations, reviewer events, and export.
- Validate exact source hash/dimensions/pixel coordinate frame across mask and observations.
- Define how mask edits invalidate dependent observations/attestations and how observation edits invalidate downstream prepared exports.
- Preserve append-only reviewer history and reject dangling/mismatched IDs.

**Acceptance evidence**
- Round-trip tests for combined mask + observations; mismatched source/hash/dimensions rejection; stale attestation invalidation; deterministic export/import; browser test covering full operator flow.

### G-04 — Camera calibration, image geometry, and observation-to-mesh traceability
**Priority:** P1 · **Status:** Partial

**Observed gap**
- Source-pixel annotations are useful, but image points/lines alone do not establish camera pose, focal length, lens distortion, scale, or world coordinates.
- The audit did not establish a complete trace from an observed architectural feature to a calibrated ray/plane/3D constraint and then to a mesh correction.

**Required work**
- Record camera calibration or explicitly mark it unknown; preserve EXIF where permitted and document assumptions.
- Define image coordinate origin, pixel convention, crop/resize transform, lens model, camera pose and world frame.
- Link each feature observation to a reconstruction constraint, mesh element/region, uncertainty, and correction event.
- Do not turn uncalibrated image pixels into metric dimensions.

**Acceptance evidence**
- Synthetic calibrated-camera fixtures; reprojection-error tests; crop/resize invariance; feature-to-mesh traceability report; explicit unknown states for uncalibrated sources.

### G-05 — Reconstruction pipeline orchestration and quality gates
**Priority:** P1 · **Status:** Partial

**Observed gap**
- Components exist for media intake, frame extraction, COLMAP, PLY-to-GLB conversion, procedural geometry, single-image/AI output, and QA.
- The reviewed evidence does not prove a robust, restartable orchestrator that selects a valid method, handles sparse/occluded views, tracks stage outputs, and blocks poor geometry/texture before review.

**Required work**
- Formalize a typed stage graph with input/output schemas, deterministic config, software/model versions, resource budgets, cancellation, retries, and cache keys.
- Distinguish method-specific confidence and limitations; never treat a single-image generated facade as measured geometry.
- Gate downstream stages on camera/coverage/geometry/texture quality.
- Persist failure reasons and partial outputs safely.

**Acceptance evidence**
- End-to-end fixture for each supported method; interruption/restart and cancellation tests; deterministic replay; malformed/missing input tests; no silent fallback to an unsupported method.

### G-06 — Geometry, topology, and texture acceptance
**Priority:** P0 for publication · **Status:** Partial

**Observed gap**
- The prior roadmap records degenerate triangles/topology warnings, long edges, non-manifold/open boundaries, disconnected/small components, and untextured primitives for a candidate.
- Structural GLB checks are necessary but not sufficient; visual fidelity and topology suitability need separate gates.

**Required work**
- Make per-primitive and whole-model metrics explicit: degenerate ratio, boundary/non-manifold edges, connected components, normals, scale, bounds, UV/material/texture coverage, texture resolution, and outlier dimensions.
- Set thresholds by model class and preserve warning vs hard-fail semantics.
- Attach deterministic renders and human-reviewed defects to exact GLB hash.
- Ensure the validator does not mistake empty or missing texture data for success.

**Acceptance evidence**
- Adversarial GLB fixtures for each defect; repeatable report; exact asset hash; reviewer sign-off; no publication if hard-fail criteria remain.

### G-07 — Vertical geospatial reference and building-height provenance
**Priority:** P0 for metric claims · **Status:** Partial

**Observed gap**
- Horizontal WGS84 ground-control fitting is described in the roadmap, but the reviewed baseline does not establish complete vertical datum/height provenance across source, terrain, building base, roof, and model.
- Overture/OSM height and floor-count attributes may be missing, approximate, or inconsistently sourced.

**Required work**
- Record horizontal CRS, vertical CRS/datum, units, axis order, geoid/ellipsoid assumptions, transform operation and version.
- Store height source, method, timestamp, uncertainty, and whether it is observed, inferred, or defaulted.
- Separate terrain elevation, building base elevation, roof elevation, and relative building height.

**Acceptance evidence**
- Known-control vertical fixtures; round-trip transform tests; source-height provenance coverage; explicit uncertainty and unknown values; no metric-height claim without datum.

### G-08 — Production 3D Tiles content path and city-scale coverage
**Priority:** P1 · **Status:** Partial

**Observed gap**
- Tile manifests/fixtures and viewport performance work exist, but the roadmap distinguishes these from a production Overture-to-3D-Tiles conversion and render path.
- One fixture or local tile package does not establish citywide coverage, LOD correctness, coordinate correctness, or reliable streaming.

**Required work**
- Define source-to-tile conversion, coordinate transform, bounding-volume construction, geometric error, refinement strategy, content URI validation, parent/part handling, and metadata mapping.
- Add a small real Dhaka package and inspect it in browser before expanding.
- Benchmark dense, sparse, boundary, and multi-tile viewports, including cancellation, cache eviction, memory and error recovery.

**Acceptance evidence**
- Tile-level schema/integrity checks; independent footprint/placement overlays; non-empty selective fetch; fixed-camera browser evidence; multi-tile pan/zoom run; coverage report and source hashes.

### G-09 — Floor-plan to semantic interior model
**Priority:** P1 · **Status:** Partial

**Observed gap**
- Raster line proposals, vector calibration, and measured-vector shell generation exist.
- Full automatic PDF/image intake, scale calibration, wall/room/door/window semantics, room polygon closure, furniture placement, and independent accuracy evaluation are not established as a complete workflow.
- CAD/IFC/BIM imports and automatic PDF rasterization remain separate backlog items in the roadmap.

**Required work**
- Support explicit raster/PDF conversion and scale calibration with uncertainty.
- Extract or propose walls, openings, room boundaries and dimensions; keep machine proposals editable/reviewable.
- Validate topology, wall thickness, room closure, doors/windows, units, and floor height.
- Keep furniture placement a separate design layer, not inferred truth.

**Acceptance evidence**
- Real and synthetic plans with ground-truth vectors; scale/rotation/skew/noise tests; false-line and missing-opening tests; independent dimension comparison; reviewed 3D output.

### G-10 — Durable jobs, storage, and multi-user security
**Priority:** P0 before production · **Status:** Partial

**Observed gap**
- The roadmap describes local file-backed workspace/queue pieces and says durable shared storage, production authentication/roles, observability/retention, and admin review need explicit implementation.
- Token authentication/path hardening are useful foundations, not a full multi-user production security model.

**Required work**
- Define identity, roles, tenant/project/building access, ownership, service credentials, token rotation, rate limits, quotas, and audit identity.
- Use durable database-backed job state and private object storage; implement atomic claim/lease/locking, retry, resume, idempotency, and dead-letter handling.
- Define retention, deletion, backup/restore, encryption, malware/file validation, and incident logging.
- Separate operator, reviewer, admin, and publisher permissions.

**Acceptance evidence**
- Authorization matrix and negative tests; concurrent worker and process-restart tests; storage access isolation; deletion/retention proof; audit-log completeness; documented deployment/runbook.

### G-11 — Property marketplace data integrity
**Priority:** P1 before public listing launch · **Status:** Gap/partial

**Observed gap**
- README says listings are illustrative demo data and browser-local favorites persist locally.
- Straight-line indicators are not route-network travel times; approximate footprint/floor-area estimates are not verified flat sizes.

**Required work**
- Integrate sourced listing data with owner/agent verification, moderation, listing expiry, evidence, fraud reporting, and persistent user accounts/favorites.
- Distinguish straight-line distance from network route distance/time.
- Keep estimates and demo data visibly labelled.

**Acceptance evidence**
- Provenance/freshness metadata; moderation/audit flow; non-demo integration tests; privacy/security review; accessibility and error/empty/loading-state review.

### G-12 — Performance, observability, and operational SLOs
**Priority:** P1/P2 · **Status:** Partial

**Observed gap**
- Existing benchmarks cover bounded workloads; they do not establish universal FPS, latency, memory, or concurrency guarantees.
- The reviewed roadmap identifies observability and production operations as remaining work.

**Required work**
- Define target devices, browser versions, dataset sizes, concurrency, and workload mix.
- Measure client GPU/CPU/memory, tile/feature request lifecycle, worker queue wait/runtime, failure rates, and cache hit/miss.
- Add privacy-safe structured logs, traces, metrics, alerting, and retention.
- Define SLOs only after representative measurements.

**Acceptance evidence**
- Repeatable same-device benchmark matrix; load/concurrency and soak tests; cancellation/error telemetry; dashboards/alerts; documented known limits.

### G-13 — Branch, PR, and release integration hygiene
**Priority:** P1 · **Status:** Active risk

**Observed gap**
- At the audit snapshot, `development` is at `98b2fa56...`, `main` at `7d90b76d...`, and `rakibul-hasan` at `01fc0caf...`.
- The `rakibul-hasan` branch is not at the current development integration head. Open feature PRs are stacked against `rakibul-hasan`; this can make review diffs confusing and create large promotion deltas.
- PR #278 is Draft and its described work is not yet on the integration branch.

**Required work**
- Build a PR dependency table (head/base/head SHA/merge-base/changed paths/CI status).
- Reconcile branch history by commit and file, not branch name or title.
- Keep each PR focused; rebase only when safe; avoid force-pushing user work.
- Require exact-head CI and separate human review for visual/evidence gates.

**Acceptance evidence**
- No unexplained divergent commits; every PR has a clear dependency/base; exact-head CI green; no stale SHA promotion; explicit reviewer approval before merge.

## 5. Release gates that must remain fail-closed

Until the corresponding independent evidence and human approval exist, retain these outcomes as false:
- `groundTruth`
- `acceptanceEligible`
- `publicationEligible`
- `publishable`
- `mapReady` where map readiness has not been proven by the defined viewport contract
- `automaticApproval`

A rights-cleared asset is not automatically accurate. A structurally valid GLB is not automatically visually correct. A visually plausible render is not ground truth. A passing CI run is not a release approval.

## 6. Recommended immediate sequence

The cross-project dependency plan is maintained in [ENGINE-INTEGRATION-AND-PRODUCTION-ROADMAP.md](./ENGINE-INTEGRATION-AND-PRODUCTION-ROADMAP.md). For the specific image/information-to-live-map feature, use [DYNAMIC-3D-MAP-END-TO-END-EXECUTION-PLAN.md](./DYNAMIC-3D-MAP-END-TO-END-EXECUTION-PLAN.md), which breaks the work into D3M-00 through D3M-13. The short repository-wide order is:

1. Reconcile branch/PR state and establish a single integration baseline.
2. Complete BRF-05/06 combined evidence-bundle contract and tests.
3. Bind BRF-07 camera/calibration and feature-to-mesh traceability.
4. Complete BRF-26 evidence bundle and BRF-27–46 source/rights/coordinate/geometry gates as one reproducible chain.
5. Obtain the independent real-Dhaka benchmark pack (external survey/rights dependency).
6. Harden durable jobs, storage, identity/roles, retention, observability and review.
7. Complete floor-plan semantic extraction and production 3D Tiles content path.
8. Validate marketplace data and release readiness.

## 7. Audit change control

Update this document only when a concrete artifact changes status. Each status update must include:
- exact branch and commit SHA;
- code/document paths and PR/issue links;
- exact test command/workflow run and result;
- evidence artifact hashes where relevant;
- what is still unverified;
- whether the change affects a release gate.

Do not mark an external dependency complete because a request packet or intake manifest was created. Do not mark visual acceptance complete from CI screenshots without human review.


---

## D3M-00 live branch/PR reconciliation addendum — 2026-10-30

The detailed PR-by-PR continuation matrix is maintained in [Dynamic 3D Map — D3M-00 execution log](./DYNAMIC-3D-MAP-END-TO-END-EXECUTION-PLAN.md#10-d3m-00-live-execution-log--2026-10-30).

**Freshly observed refs:** \`main@7d90b76dadaf9eebd91b9aeb13cf12dcefb5086b\`, \`development@98b2fa56f387c2bdbf4dad5c24e6f131dd66d076\`, and \`rakibul-hasan@01fc0caf4f08b1aa1dc8c1fdced1667c8d7fcb91\`.

- \`development\` and \`main\` are diverged (86 ahead / 4 behind). PR #228 remains a release candidate only; the four main-only commits require content/ancestry review before promotion.
- \`rakibul-hasan\` and \`development\` are diverged (10 ahead / 89 behind). Do not merge the stale branch wholesale.
- #274 and #196 overlap on 23 files, with 21 identical common patches; #274 is the stronger map-UX candidate because it also includes the real-Dhaka baseline workflow. Keep #196 open pending #274 review.
- #277 and #278 each target the old \`rakibul-hasan\` base. Their feature deltas require clean-base ports and exact-head revalidation, not history promotion.
- #275 (bounded Dhaka 3D Tiles) and #276 (floor-plan vector calibration) remain separate Draft workstreams with their own passed exact-head CI; neither proves image-driven, independently surveyed exterior reconstruction.
- #193's generated-model-layer module blob is identical to the current development file, and current development's Cesium adapter already delegates model lifecycle methods. A final PR-specific docs/tests comparison is still needed before closing it as superseded.

This is metadata/diff review, not a fresh local build, deployment test, source-rights decision, survey, or architectural visual acceptance. No application code, branch refs, PR state, or release flags changed during this addendum. D3M-00 remains **IN PROGRESS**.

### D3M-00.B implementation note — 2026-10-30

A clean-base replacement for the old-base manual mask editor PR #277 has been opened as Draft PR [#280](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/280). Branch `feat/brf05-07-manual-mask-review-dev-20261030` is based exactly on `development@98b2fa56f387c2bdbf4dad5c24e6f131dd66d076`, with head `09a52828e78f853c3a19a8f60c5bd32b3ccc73fd`. It changes four paths only (editor HTML/JS, Playwright browser spec, additive BRF report section); it does not cherry-pick the stale branch history or modify API/schema/release gates.

Exact-head CI #2513 / [run 40997949731](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40997949731) was in progress at the last check. No tests are claimed passed for this clean port yet. Keep #277 as source evidence until #280 is reviewed and accepted. D3M-00 remains in progress.
### D3M-00.C — observation-review clean-base port

The old-base BRF-06 studio from PR #278 is now selectively ported onto a branch descended from the validated mask-editor PR #280 head. The combined Draft PR is [#281](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281), head `f0de3b3bb2e4dd4aa7b3eafdec0483c93faff548`, base `development@98b2fa56f387c2bdbf4dad5c24e6f131dd66d076`, 9 unique paths / 917 additions / 0 deletions. It includes the #280 prerequisite; do not merge #280 and #281 separately.

Parent PR #280 exact-head CI #2513 passed all steps, including browser/API integration, but the PR remains Draft with no review. Combined PR #281 exact-head CI #2519 / [run 40998801920](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40998801920) is in progress; no new-base pass is claimed yet.

The observation studio still exports `mask: null`; it is not yet integrated with the manual mask editor. The shared source-bound mask/observation bundle, invalidation rules, rights/camera linkage, and authenticated review history remain open. JSON event validation does not provide a cryptographically signed audit log. All ground-truth/publication/map-ready gates remain false.
### D3M-00.C — BRF-06 canonical combined candidate (2026-10-30)

Canonical combined Draft PR [#281](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281) contains the validated parent mask-editor change from #280 plus the clean-base BRF-06 observation studio, M07 schema-history update and regression tests. It is based on the exact #280 head `09a52828e78f853c3a19a8f60c5bd32b3ccc73fd`; current exact head is `04b62ceb910b6c63986703ec1587846a1676bc85`.

The unique diff against development is nine paths / 930 additions / 0 deletions. CI #2519 succeeded on the previous head; after adding the missing rejected-review normalization/round-trip assertions, updated CI #2530 / [run 41000920752](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41000920752) is in progress. Do not claim success until this exact run completes.

Duplicate PR #282 was closed without merge and points to #281. Do not merge #280 independently; #281 is the combined candidate. Require human review before merge and keep all release gates false. The UI remains manual, and the mask+observation shared-bundle hand-off is still a D3M-01/WP-01 gap.

### BRF-06 canonical PR reconciliation — 2026-10-30

- Canonical combined clean-base candidate is [PR #281](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281), head `04b62ceb910b6c63986703ec1587846a1676bc85`, based on development. It contains both #280's mask editor and the BRF-06 observation review port (9 unique paths in total).
- Updated exact-head CI #2530 / [run 41000920752](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41000920752) is pending/in progress at this checkpoint. Earlier #2519 passed only on the prior head and cannot validate the current commit.
- Duplicate [PR #282](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/282) has been closed; do not merge/reopen it. Old-base #278 remains reference evidence only.
- Keep #281 Draft; no merge until exact-head CI and human review. #280 is its parent content and must not be merged independently if #281 is accepted as the combined candidate.
- Observation studio still exports `mask: null`; shared mask/observation bundle and cross-artifact tests are a D3M-01 prerequisite. Release gates remain false.

See the [D3M execution log](./DYNAMIC-3D-MAP-END-TO-END-EXECUTION-PLAN.md#107-d3m-00c--canonical-brf-06-clean-base-port-2026-10-30) for exact dependency and continuation details.


### Exact-head CI completion — PR #281 (2026-10-30)

Correction to the pending status above: CI #2530 / [run 41000920752](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41000920752) completed successfully on exact head `04b62ceb910b6c63986703ec1587846a1676bc85`. All workflow job steps passed, including the full unit/contract suite, lint, production build, Chromium production-server viewport API/browser integration and P2.3–P2.6 evidence uploads. PR #281 remains Draft/open/unmerged pending human review; no merge or release-gate change is implied. The mask/observation bundle remains unintegrated (`mask: null`).


### D3M-00 branch/PR reconciliation — 2026-10-30

- Canonical P3.4 clean-base port is [PR #274](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/274), exact head `439e5c8ee26f263471b060a35296d681e0add182`; exact-head CI #2285 and Real-Dhaka Browser Baseline #45 both succeeded. PR remains Draft pending human inspection of six-sample evidence.
- Duplicate #196 closed without merge (implementation patches match #274; #274 additionally carries the real-Dhaka baseline workflow). Old-base #193 closed without merge because its generated-model-layer code/test and CI/package hooks are already present on development; its architecture note is retained on the docs branch.
- Main promotion #228 is not safe to merge yet: development is 86 ahead / 4 behind main with 204 changed paths. The four main-only commits remain to be individually inspected. No release gates are enabled.


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
