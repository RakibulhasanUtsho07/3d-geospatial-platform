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
