# D3M-00 through D3M-07 — dependency and evidence reconciliation

**Audit date:** 2026-11-02 (Asia/Dhaka)  
**Repository:** RakibulhasanUtsho07/3d-geospatial-platform  
**Audit baseline:** D3M-07 branch head af28727841169e7c99f68dfb1bbd5e13ea88e877, before this reconciliation update.  
**Purpose:** Distinguish implemented code, exact-head automated validation, branch/dependency integrity, and external operational evidence. This report does not certify an end-to-end production building reconstruction.

## 1. Executive decision

D3M-00 through D3M-07 are **not fully closed**. The repository contains substantial code and test coverage for the current work packages, but several dependency and evidence gates remain open. CI success must not become a claim of real inference, legal rights clearance, survey accuracy, or map readiness.

Safe findings:

- The current D3M-02 through D3M-07 code PRs form an explicit stacked chain, and most exact-head CI checks are green.
- D3M-01 is split into A–G. The code has been implemented in stacked Draft PRs, but the first parent PR is based on a stale development commit and D3M-01.G is based on an older D3M-01.F parent head.
- The D3M-03 current head has a successful Push CI but no exact-head PR-triggered CI run was found.
- The D3M-06 current head has a successful PR CI but no exact-head Push CI run was found.
- The D3M-07 current head has both PR Full CI and Push CI successful.
- No D3M-02 through D3M-07 PR in this chain has been merged. No promotion to development or main is implied.

## 2. Naming clarification: two D3M numbering schemes were mixed

An older planning document, DYNAMIC-3D-MAP-END-TO-END-EXECUTION-PLAN.md, uses D3M-02 for map intake, D3M-03 for rights/provenance, D3M-04 for building identity, D3M-05 for image understanding, D3M-06 for route selection and D3M-07 for geometry generation. Those are broad end-to-end phase labels created on 2026-10-30.

The current GitHub issues and PRs use D3M-02 for approved-job publication, D3M-03 for map-side media intake, D3M-04 for rembg readiness, D3M-05 for a real single-image smoke workflow, D3M-06 for reviewed placement binding and D3M-07 for worker preflight.

These labels are not interchangeable. For current implementation status, dependency decisions and PR references, **the GitHub work-package mapping in Section 3 is authoritative**. The older phase plan remains useful as a product-level future-state roadmap, but its D3M numbers must not be used to identify the current PRs.

## 3. Current implementation and dependency matrix

| Current work package | Tracking issue | Implementation PR / branch | Exact code head | Exact-head CI evidence | Audit status |
|---|---:|---|---|---|---|
| D3M-00 — repository/branch reconciliation | Cross-cutting; older docs PR #279 | #279, docs/full-repository-gap-audit-20261030 | 8751c74f08151681edcb1322f04d029910a66a87 | Docs PR CI #41308926283 and Push CI #41308926257 passed on that docs head | **Open:** old-base documentation branch; main/development and rakibul-hasan ancestry remain unreconciled for promotion |
| D3M-01.A/B — source-bound visual + rights/camera/GCP evidence | #283 tracks C; A/B included in #281 | [PR #281](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281) | 21ad424b0f611b0274693c4a3c4f633b7548bedc | PR Full CI #41072445284 passed | **Code/CI candidate:** 35 commits ahead / 5 behind current development; rebase/retarget and rerun CI before integration |
| D3M-01.C — immutable candidate evidence hand-off | #283 | [PR #284](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/284) | dc326af772dce95484cd2565d581ed5f99744369 | Push CI #41076263050 passed; hand-off suite documented 11/11 | **Code/CI candidate:** correctly stacked on #281; rights/camera/GCP remain human-review-required |
| D3M-01.D — trusted-signer geometry review | #285 | [PR #286](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/286) | 3e92b4be02d8f6bad6baec274887c148359ad8f7 | PR CI #41082822869 and Push CI #41082811923 passed | **Code/CI candidate:** synthetic signer tests do not provision real reviewer identity or prove geometry accuracy |
| D3M-01.E — re-verify signed receipt before independent-truth evaluation | #287 | [PR #288](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/288) | 03c8f4fcf213c7f1201d55a55cee6802fec9bd64 | Push CI #41160633951 passed, 182/182 | **Code/CI candidate:** held-out real survey/reference evidence and production trust anchors remain external |
| D3M-01.F — governed reviewer registry lifecycle | #289 | [PR #290](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/290) | ab50f062a5d4da6e52f7e9f9b4564ad11124f386 | Push CI #41315532257 passed | **Code/CI candidate:** production registry, real reviewer onboarding, key custody and deployment secret are not established by CI |
| D3M-01.G — secret-safe registry preflight | #291 | [PR #292](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/292) | 31c4a924e66735807ea3462b8f73f44fc3c5acec | PR CI #41315555896 and Push CI #41315552065 passed | **Stale dependency:** base is D3M-01.F at 89f3f11a..., while current #290 head is ab50f062...; compare reports 10 ahead / 2 behind from the old base. Rebase on current #290 and rerun both checks |
| D3M-02 — approved generation-job publication to Cesium catalog | #301 | [PR #302](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/302) | dff7c70e2cab5936cda0f5b8d02df52b433fcb84 | PR Full CI #41334962827 passed | **Code/CI candidate:** no same-head Push CI run was found; publisher credential, live deployment and real approved job are not evidenced here |
| D3M-03 — map-side image intake and job tracking | #303 | [PR #304](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/304) | e8860543277132008f2b8641f06d15fee90a6b1d | Push CI #41399692306 passed; older failure #41391738912 targeted prior head 9bf7dde... | **Partial validation:** no PR-triggered CI run for current head was found. Exact PR base was D3M-02 feature branch; rerun PR CI after stack is rebased/retargeted onto the reviewed integration base |
| D3M-04 — TripoSR + rembg/ONNX worker readiness | #305 | [PR #306](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/306) | d05274f4c30fddc45dc41cd464573c40b6745e58 | PR CI #41405970254 and Push CI #41405965712 passed | **Code/CI candidate:** only synthetic/fake worker environments in CI; real worker readiness still unverified |
| D3M-05 — offline, fresh-ID, hash-bound single-image smoke | #307 | [PR #308](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/308) | 07e122053ff99059b72661e85e4f2e44b2a3c8ac | PR CI #41412587662 and Push CI #41412580459 passed | **Implementation candidate:** real TripoSR/rembg inference has not been run on the provisioned host; CI uses fakes/synthetic GLB |
| D3M-06 — bind reviewed placement to publication | #309 | [PR #310](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/310) | 0ed7371ec46b71037a5f8971f239322f0ac10709 | PR CI #41429766924 passed | **Push-CI gap:** no Push CI run on this exact head was found; add the branch to the Push workflow filter and require a same-head Push run after revalidation |
| D3M-07 — single-image worker preflight | #311 | [PR #312](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/312) | af28727841169e7c99f68dfb1bbd5e13ea88e877 | PR Full CI #41436755755 and Push CI #41436748360 passed, 184/184 each | **Automated candidate validated:** actual worker-host preflight, D3M-05 inference and independent GLB/human review remain pending |

All commit and run IDs above are exact recorded snapshots, not statements that a run on an older commit validates a newer head. Cancelled or failed runs on superseded commits are not used as evidence for the current SHA.

## 4. D3M-00 branch and integration reconciliation

Snapshot refs:

- main: 0db414c9fe79d4372e351cd551221a67fbea284c
- development: f7b2a67fcf0c34623196fa92e719640086e2adce
- rakibul-hasan: 01fc0caf4f08b1aa1dc8c1fdced1667c8d7fcb91

Observed ancestry:

1. development vs main is diverged: development is 91 commits ahead and 6 behind, merge base e4fd7ddfedd4fbd2faa6cdd185deeddc81dbce1c. Comparing main to that merge base shows the six main-only commits have zero net changed paths. This reduces content-loss concern but does not authorize a promotion merge or replace exact candidate review.
2. rakibul-hasan vs development is diverged: the legacy branch is 10 commits ahead and 94 behind from the common base. Its unique changes include BRF-05–07 evidence tooling and floor-plan raster-trace work. Do not bulk-merge the branch or cherry-pick it as a unit.
3. Documentation PR #279 is based on old development snapshot 98b2a67...; relative to current development it is 113 ahead / 5 behind. It contains useful audit and planning history, but it must be refreshed and reviewed before its documents are treated as current integration truth.
4. D3M-01 parent PR #281 has the same old development base 98b2a67... and is 35 ahead / 5 behind current development. Its exact-head CI passed on its own recorded head, but the parent must be rebased/retargeted and revalidated before integration.
5. The current D3M-02 → D3M-07 feature stack is internally linear at the recorded point: #302 → #304 → #306 → #308 → #310 → #312. Keep that order; do not merge a child independently of its parent.

**D3M-00 closeout condition:** resolve the integration base for #281 and the D3M-02 → D3M-07 stack, update exact parent SHAs, validate the combined candidate, and only then decide development/main promotion. Do not force-push, bulk-merge or mark D3M-00 complete from branch counts alone.

## 5. CI-trigger and evidence gaps

### D3M-03 PR-trigger gap

The latest D3M-03 code head has a successful Push CI, but no PR-triggered run on that exact SHA was found. The older failed run targeted a prior head and cannot be used either way. The PR's base was a feature branch that was not yet in the workflow's base-branch PR filter at the time. The child branch now carries broader filters, but that does not retroactively create a PR run on the old SHA. Rebase/retarget the stack to the selected integration base and require exact-head PR Full CI.

### D3M-06 Push-trigger gap

The latest D3M-06 head has exact-head PR Full CI, but no same-head Push CI. The current D3M-07 descendant workflow contained D3M-06 in the PR filter but not in the Push filter. This reconciliation adds the missing D3M-06 Push branch filter for future D3M-06 pushes. It does not manufacture a historical Push CI result for 0ed7371...; the same-head Push check still must be run after the parent branch is safely updated/revalidated.

### CI evidence is not deployment evidence

A workflow pass covers the code and test matrix run by that workflow. It does not prove deployment secrets, worker binaries, model weights, OS-level egress isolation, GPU memory, real inference, legal rights, source identity, survey coordinate quality, human review or map-ready release.

## 6. Source and model operation gates still open

The implementation chain must retain these operational conditions:

- **Rights and source provenance:** source bytes, building identity, licence/permission authority and the exact operation scopes (private ingestion, single-image inference, derivative creation, review and publication) need review for the selected real image. Unknown, conflicting or expired rights stay blocked.
- **D3M-01 reviewer trust:** real trusted public-key registry must be provisioned through the deployment secret manager; designated reviewers must be onboarded and their authority/key custody independently governed. Synthetic CI keys are not production reviewer evidence.
- **D3M-02 publishing:** deployment must configure the separate publisher credential and public asset storage. A successful code test does not prove a live approved job can be safely published or restored in the deployed map.
- **D3M-03 intake/worker:** deployment must configure operator-session credentials, the generation API credential, durable shared private workspace/storage, worker process supervision and actual worker health. The UI supports still images; it does not implement all video/PDF flows.
- **D3M-04 readiness:** actual worker's Python interpreter, TripoSR runner, PyTorch, ONNX Runtime, rembg package, selected device and both model caches must pass the probe on that host.
- **D3M-05 smoke:** use a fresh authorized JPEG/PNG source, fresh source/job/workflow/output IDs, all four confirmations, reviewed TripoSR/rembg model terms, offline policy and host-level network/filesystem controls where strict isolation is required. Then run the independent evidence verifier against exact source/GLB bytes.
- **D3M-06 placement:** WGS84 longitude/latitude and explicitly identified ellipsoidal height, heading/pitch/roll, scale and axis conventions are bound to the review record. The values remain operator-supplied; this is not an independent survey or a solution to orthometric/terrain/building-height datum.
- **D3M-07 preflight:** a ready result is only a precondition; it is not inference, geometry accuracy, licence compliance, GPU capacity or map readiness.

## 7. Gaps addressed by this reconciliation commit

1. Hardened D3M-07 capability-result validation: require the exact capability schema version and a canonical, valid checkedAt timestamp. Unsupported/malformed capability metadata now fails closed and the output uses the local check timestamp instead of echoing an invalid supplied timestamp.
2. Added regression tests for unsupported capability schema and non-canonical capability timestamp.
3. Added the missing D3M-06 branch to the CI Push trigger filter. This fixes future trigger coverage but does not claim an old-head Push CI pass.
4. Added this dependency/evidence matrix and cross-linked it from the remaining-work roadmap.

The updated D3M-07 branch must receive fresh exact-head Push CI and PR Full CI after these changes. The previous successful runs #41436748360 and #41436755755 remain valid only for their recorded pre-audit head af287278....

## 8. Required next order

1. Resolve D3M-00 integration policy and rebase D3M-01.A/B PR #281 onto the selected current development base; run exact-head CI.
2. Rebase D3M-01.G PR #292 onto current D3M-01.F PR #290 head ab50f062...; run both PR and Push CI.
3. Once the parent stack is accepted, promote D3M-02 #302 to the approved integration branch and validate it; rebase D3M-03 #304 and run exact-head PR + Push CI on the new base.
4. Revalidate D3M-04 #306 → D3M-07 #312 as one stack after parent SHAs move. Ensure every child PR is based on the accepted current parent, with exact-head PR and Push CI where required.
5. Run D3M-07 preflight on the actual worker host; then D3M-05 real inference, independent hash verification and human GLB inspection.
6. Only after rights, survey, vertical frame, reviewer trust, geometry/texture quality, independent held-out accuracy and map reload/rollback acceptance are complete may release-gate evaluation begin.

## 9. Release gates

Keep groundTruth, acceptanceEligible, publicationEligible, publishable, mapReady, automaticApproval and worker dispatch/publication authorization false until their separate evidence contracts are independently satisfied.

**Audit conclusion:** The code path is materially more complete than a basic prototype, but the D3M-00→D3M-07 chain is not yet an end-to-end, real-worker-validated building reconstruction and map-publication system. The dependency/CI/documentation gaps listed here must be closed before claiming completion.


## 10. Follow-up hardening — D3M-07 capability response contract (2026-11-02)

The initial reconciliation follow-up added capability schema-version and canonical timestamp checks. A second review tightened the output contract further:

- A capability status must be one of `ready`, `configured` or `blocked`; unsupported/missing statuses fail closed.
- TripoSR and rembg cache states are allow-listed to `cached`, `missing` or `unknown`. Unexpected strings/paths are normalized to `unknown` and cannot be copied into the sanitized report.
- The rembg model name is emitted only when it matches the restricted model identifier syntax; filesystem-like/path values are not returned.
- The capability timestamp must be canonical UTC and exactly match the timestamp requested for this probe. Missing, stale or changed timestamps fail closed; the report falls back to the locally generated timestamp.
- Added tests for unsupported cache-state/path injection, unsafe rembg model identifiers and stale probe timestamps.

The updated source and tests are on the D3M-07 branch. The current exact-head PR and Push CI runs are:
- PR Full CI: [#41443645721](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41443645721), head `8947049cd219474859be5923bde44b5c503ebd6d`.
- Push CI: [#41443642326](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41443642326), same head `8947049cd219474859be5923bde44b5c503ebd6d`.

At the time this section was written, both runs were queued and had no job result yet; **no pass is claimed**. Earlier runs #41436755755/#41436748360 validate only the pre-reconciliation head `af287278...`.

## 11. Remaining explicit blockers after repository-side work

The following cannot be truthfully closed by source edits or synthetic CI:

1. D3M-00 promotion ancestry: `development` and `main` remain diverged (91 ahead / 6 behind at the audited refs); no release approval was supplied. The legacy `rakibul-hasan` branch is also divergent and must not be bulk-merged.
2. D3M-01 parent stack: #281 still needs a reviewed rebase/retarget onto the selected current development base. D3M-01.G #292 must then be rebased onto the current #290 head. Do not force-push or rewrite shared branches without a reviewed parent/child plan.
3. D3M-02/03/06 CI/base consistency: D3M-02 #302 lacks a same-head Push run; D3M-03 #304 lacks a same-head PR run and its base must be reconciled; D3M-06 #310 lacks a same-head Push run. The D3M-07 workflow filter only enables future D3M-06 Push runs after the parent branch itself receives the filter.
4. Real deployment configuration: publisher token/public model storage, operator login/session secrets, durable private shared worker storage, service supervision and the real worker status have not been verified in the target deployment.
5. Real model operation: no provisioned worker-host preflight or actual TripoSR/rembg inference report with a real authorized source has been supplied in this run.
6. Real-world acceptance: independent dimensions, survey/control sources, vertical datum, held-out points, production trusted reviewer registry, human GLB review, geometry/texture accuracy and end-to-end map reload/rollback are still not proven.

No PR was merged, no branch was force-pushed or retargeted, and no release flag was enabled by this audit.
