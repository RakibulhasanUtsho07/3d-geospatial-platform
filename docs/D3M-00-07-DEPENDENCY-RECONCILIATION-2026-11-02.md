# D3M-00 through D3M-07 — dependency and evidence reconciliation

**Audit date:** 2026-11-03 (Asia/Dhaka)  
**Repository:** `RakibulhasanUtsho07/3d-geospatial-platform`

## Current promotion state

- Main: `6b3c8e3de3eb1e34685e1a25ab34a95f3a3f1993`
- D3M-02 publication base: merged through [PR #302](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/302), merge commit `4ec5305108870a2cc30bd203c4a3c8c7ab9613a0`.
- D3M-03 map-side intake/job tracking: merged through [PR #324](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/324), merge commit `6b3c8e3de3eb1e34685e1a25ab34a95f3a3f1993`. Its exact-head PR Full CI [#41576745792](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41576745792) passed 179/179.
- D3M-04→D3M-07 source stack head `e60a46162e873846a81122812151be0855ec83d3` passed exact-head PR Full CI [#41464331828](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41464331828), 184/184. That CI predates this main-based reconciliation, so the new integration PR must pass exact-head CI independently.
- D3M-01.A/B and D3M-01.C→G reviewer trust chain remains separate and unmerged. The current D3M-01.G head is `54d4c6d040726bc0cf8edda34e97f3f185877e87`; its exact-head PR CI [#41462785232](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41462785232) passed. Code/CI does not provision a production registry or real signing keys.

## D3M-04 — TripoSR/rembg cache readiness

- Worker startup checks Python, PyTorch, ONNX Runtime, configured device, TripoSR model files and the installed rembg default model cache.
- Missing or unknown model state keeps single-image jobs unclaimable; cache inspection does not initialize an inference session or download weights.
- Verify the selected rembg model-weight licence independently. Package licensing does not grant rights to model weights; the default model may have non-commercial terms.
- Readiness checks do not prove model compatibility, GPU memory sufficiency or a successful inference.

## D3M-05 — offline single-image smoke

- The operator-invoked smoke uses the existing media-to-model workflow, not a parallel TripoSR implementation.
- It requires explicit confirmations for source rights, operation scope, single-view inference and model terms.
- It binds a fresh run to source/GLB hashes and a separate evidence verifier; CI exercises synthetic/fake fixtures only.
- A real operator run on the provisioned worker host and independent GLB review are still outstanding.

## D3M-06 — reviewed placement binding

- Review approval stores the normalized WGS84 placement, ellipsoid-height reference, heading/pitch/roll, scale and GLB axes with a digest.
- Publication rejects a different or missing placement in the immutable review record or job summary.
- This prevents post-review transform drift; it does not independently verify coordinates, datum, survey truth or reviewer authority.

## D3M-07 — non-inference worker preflight

- The preflight checks only the single-image AI strategy and requires explicit cached TripoSR/rembg weights.
- It syntax-compiles the configured TripoSR runner in memory; it does not execute the runner or its `--help` handler.
- Output is sanitized and fails closed for missing, unknown or malformed cache/capability state.
- Python imports can still execute installed package initialization code. This is not an OS sandbox, a hermetic read-only runtime or a host firewall.

## Dependency and integration notes

- D3M-04 → D3M-05 → D3M-06 → D3M-07 is treated as one cumulative stack for this main-based reconciliation so the D3M-07 non-executing preflight supersedes D3M-04's earlier runner help-probe behavior.
- The reconciliation preserves main's D3M-02/03 endpoints, operator-session auth, source operation scopes, map UI and floor-plan raster-trace CI.
- D3M-01 reviewer trust is not included in this integration; keep its separate PR chain fail-closed until it receives its own main-based review and exact-head CI.
- Worker binaries, model weights, secrets, durable shared workspace, OS-level egress controls, actual inference and independent human review are deployment/operational requirements.

## Release boundary

`groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` remain false. A green CI run or cached-model preflight does not establish real building reconstruction accuracy, licence clearance, survey truth or automatic publication.


## 2026-11-03 — promotion correction after D3M-ENGINE-02

This section supersedes the earlier snapshot's main SHA and pending-promotion statements.

- Current `main`: `bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`.
- D3M-03 reconciliation PR #324 merged to main at `6b3c8e3de3eb1e34685e1a25ab34a95f3a3f1993`.
- D3M-04 through D3M-07 cumulative source stack merged through PR #325 at `6aeb6d97e719497d957c722260c507e5fedbf8ac`. Its source includes D3M-05 runtime smoke orchestration and verifier, D3M-06 reviewed placement binding and D3M-07 non-inference preflight. The old stacked source PRs were closed as superseded.
- D3M-01 reviewer-trust integration merged through PR #326 at `fb3537d3199c98b43218b7853303858b5c9c0590`.
- D3M-ENGINE-02 worker-host inventory and cache-byte fail-closed checks merged through PR #347 at `bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`.
- Post-merge main Full CI [#41649268743](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41649268743) passed 207/207 steps. It covers the D3M-05 offline smoke contract test, D3M-07 preflight test, D3M-ENGINE-02 inventory tests/CLI and production viewport verification.
- BRF-35 linkage [#41649268750](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41649268750) and BRF-45 exact-asset rights [#41649268800](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41649268800) also completed successfully on the same main SHA.

**Remaining operational acceptance:** no actual worker-host inventory report, successful TripoSR/rembg inference, independently verified private GLB or human visual disposition has been recorded. D3M-05 issue #307 remains open. CI fixtures and a cached-model preflight are not real inference evidence. Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false.

## 2026-11-04 — D3M-ENGINE-03 current-main vertical-slice integration

- Current `main` remains `bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`; PR [#351](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/351) is the consolidated current-main integration for facade structural openings, BRF-04 topology regression and the source-bound building-to-map vertical slice. It carries the unique work from #350 and #349; do not merge either source PR independently ahead of #351.
- The branch implements a still-image (3–100 views) parent workflow that binds exact source byte hashes, rights scopes, selected view IDs and geometry-input hash to two resumable child jobs. Child reports must now match the exact expected engine/profile, building ID, child job ID and geometry input path; regression tests reject cross-building and cross-job report substitution.
- On exact head `10a962601e9ed9c0c861f57bb98d0e329ade299d`, BRF-14 byte-intake, BRF-05–07 reference intake, BRF-35 same-building linkage and P3.7 floor-plan validation completed successfully. Full CI, renderer smoke, Real-Dhaka browser baseline, P3.6 package and BRF-45 rights admission were still running or awaiting a fresh completion check at the time of this update.
- These automation runs validate contracts and code paths only. The real worker-host inference, exact asset rights decision, independent building truth, trusted reviewer signing identity, survey-supported WGS84/vertical datum and real candidate Cesium browser validation remain external acceptance gates.
- Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false. PR #351 is not merged to `main`; merge is a separate action after exact-head checks, artifact review and human approval.

## 2026-11-04 — D3M-ENGINE-03 acceptance evidence snapshot

**Current base:** `main@bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`  
**Integration PR:** [#351](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/351)  
**Current branch head at this record:** `b3a040e1a4f7466f591585fa0cb760cc996f647b` (59 commits ahead / 0 behind; PR remains open and unmerged).

### Software implementation and automation

- PR #351 consolidates the unique topology regression from #349 and replaces the facade-opening implementation in #350 with an integrated wall-shell builder in `procedural-glb.mjs`. The standalone #350 `facade-wall-openings.mjs` file is not copied; the required rectangle/arch, full-depth reveal and both-winding behavior is implemented and covered by GLB-level tests in the integrated generator.
- The generated-output topology test checks both footprint windings with an arched first-storey arcade and requires zero degenerate triangles and zero non-manifold edges across all generated GLB mesh primitives. On prior exact code head `80e54a3b494f468eb57fbde13563d25d03ada698`, Full CI steps 20 (BuildingSpec/procedural GLB) and 37 (D3M-ENGINE-03 vertical-slice orchestration) passed. Exact-child-profile guards and tests were added afterwards; latest exact-head Full CI on `b3a040e1a4f7466f591585fa0cb760cc996f647b` is running and is the required final code validation.
- Parent orchestration binds exact source/image hashes, rights operation scopes, source IDs/paths/licences, selected-view IDs, geometry-input hash, media candidate hash and textured-geometry candidate hash. It requires the exact media engine + photogrammetry profile and exact architectural-geometry engine version, building ID, child job ID and geometry input path. Cross-job, cross-building and cross-profile substitution tests are included.
- The catalog handoff remains explicit, exact-hash bound and fail-closed. It does not automatically publish or change `acceptanceEligible`, `publicationEligible`, `mapReady` or `automaticApproval`.

### Map/browser baseline (real Dhaka data, not the reconstructed sample building)

- Real-Dhaka Browser Baseline [run #41775485573](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41775485573) succeeded on code head `80e54a3b494f468eb57fbde13563d25d03ada698`: 3 cold + 3 warm samples; all six staged 3,000 buildings and rendered 478 offline road entities; all six samples reached map-ready and roads-rendered; working tree was clean; the canvas-only saturated-red detector flagged 0/6 samples.
- Cold map-ready median was approximately 28.9 s; warm median approximately 27.6 s. This is a bounded Linux/Chromium CI baseline, not a device-wide performance SLA.
- Human screenshot inspection of the baseline shows the large floating panels still cover significant map area and buildings remain mostly boxy footprint extrusions. Record these as visual-quality defects; the baseline pass does not accept the generated heritage architecture or prove D3M-ENGINE-03 real-building accuracy.
- P3.6 bounded Dhaka package [run #41775659942](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41775659942) passed on the same prior head. Latest-head re-run is pending/in progress.

### Multi-view building sample — byte verification is not rights or reconstruction approval

- BRF-14 packet [run #41775662451](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41775662451) verified all 16 selected JPEG source files by exact SHA-256 and byte count: 181,235,712 bytes total, zero byte-verification blockers. A human-review packet and pairwise overlap report were produced.
- This sample is the upstream flat-roof drone-building dataset at approximately latitude 45.05, longitude -93.39 (Minnesota, USA); it is **not a Dhaka building** and cannot be used as a Dhaka placement example. The dataset declares CC BY 4.0 for imagery, but exact owner authority and permitted derivative/public-display scope are not independently established by that declaration.
- All 16 rows in the BRF-45 exact-asset rights admission record remain `pending`. The BRF-45 action success means the policy/evidence contract was evaluated, not that rights were granted. The human review manifest is still `pending-human-review`; same-building identity, image overlap, facade/roof coverage and camera up-axis have not been accepted by a reviewer.
- Pairwise image triage evaluated all 120 possible pairs and reported 14 candidate overlap edges; four views have no candidate edge. These are review hints only, not a same-building proof or a camera calibration.
- Reconstruction preflight remains `blocked`: rights rows are pending, the decision template has no valid reviewer identity/decision, and the configured COLMAP 4.2.1 executable was not found. `reconstructionExecuted=false`; no candidate GLB was generated; no independent reference was verified.

### External acceptance blockers remain active

- No fresh TripoSR/rembg inference on a provisioned real worker host; D3M-05 issue #307 remains the tracking gate. CI fakes and the inventory/preflight code are not real inference.
- No authorized rights-cleared source set with reviewer-confirmed same-building identity, visual overlap and up-axis; no successful authorized multi-view/COLMAP reconstruction run.
- No independently surveyed/CAD/BIM/LiDAR dimensions, held-out checkpoints or accepted horizontal/vertical residuals for the candidate building. No real-building accuracy score may be reported.
- D3M-01 reviewer-authentication code exists, but no real reviewer identity/authority has been onboarded and no production Ed25519 public-key registry has been provisioned/verified. Synthetic CI signing keys do not satisfy that gate.
- No surveyed WGS84 placement/vertical datum or human-inspected real candidate GLB rendered in Cesium with an exact approved model hash.

**Acceptance status:** software integration and bounded synthetic/CI contracts are progressing; real-world source, worker, independent truth, authorized reviewer, survey placement and publication gates remain **blocked**. Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false. PR #351 remains separate from `main` until latest exact-head CI/renderer checks and human review pass; no automatic main merge is performed.
