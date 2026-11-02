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
| D3M-00 — repository/branch reconciliation | Cross-cutting; older docs PR #279 | #279, docs/full-repository-gap-audit-20261030 | 8751c74f08151681edcb1322f04d029910a66a87 | PR-triggered CI #41308926283 and #41308926257 both passed on that docs head; no same-head Push CI was found | **Open:** old-base documentation branch; main/development and rakibul-hasan ancestry remain unreconciled for promotion |
| D3M-01.A/B — source-bound visual + rights/camera/GCP evidence | #283 tracks C; A/B included in #281 | [PR #281](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/281) | 21ad424b0f611b0274693c4a3c4f633b7548bedc | PR Full CI #41072445284 passed; same-head Push CI not found | **Code/CI candidate:** 35 commits ahead / 5 behind current development; rebase/retarget and rerun CI before integration |
| D3M-01.C — immutable candidate evidence hand-off | #283 | [PR #284](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/284) | dc326af772dce95484cd2565d581ed5f99744369 | Push CI #41076263050 passed; same-head PR Full CI not found; hand-off suite documented 11/11 | **Code/CI candidate:** correctly stacked on #281; rights/camera/GCP remain human-review-required |
| D3M-01.D — trusted-signer geometry review | #285 | [PR #286](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/286) | 3e92b4be02d8f6bad6baec274887c148359ad8f7 | PR CI #41082822869 and Push CI #41082811923 passed | **Code/CI candidate:** synthetic signer tests do not provision real reviewer identity or prove geometry accuracy |
| D3M-01.E — re-verify signed receipt before independent-truth evaluation | #287 | [PR #288](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/288) | 03c8f4fcf213c7f1201d55a55cee6802fec9bd64 | Push CI #41160633951 passed, 182/182; same-head PR Full CI not found | **Code/CI candidate:** held-out real survey/reference evidence and production trust anchors remain external |
| D3M-01.F — governed reviewer registry lifecycle | #289 | [PR #290](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/290) | ab50f062a5d4da6e52f7e9f9b4564ad11124f386 | Push CI #41315532257 passed; same-head PR Full CI not found | **Code/CI candidate:** production registry, real reviewer onboarding, key custody and deployment secret are not established by CI |
| D3M-01.G — secret-safe registry preflight | #291 | [PR #292](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/292) | 31c4a924e66735807ea3462b8f73f44fc3c5acec | PR CI #41315555896 and Push CI #41315552065 passed | **Stale dependency:** base is D3M-01.F at 89f3f11a..., while current #290 head is ab50f062...; compare reports 10 ahead / 2 behind from the old base. Rebase on current #290 and rerun both checks |
| D3M-02 — approved generation-job publication to Cesium catalog | #301 | [PR #302](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/302) | dff7c70e2cab5936cda0f5b8d02df52b433fcb84 | PR Full CI #41334962827 passed; same-head Push CI not found | **Code/CI candidate:** no same-head Push CI run was found; publisher credential, live deployment and real approved job are not evidenced here |
| D3M-03 — map-side image intake and job tracking | #303 | [PR #304](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/304) | e8860543277132008f2b8641f06d15fee90a6b1d | Push CI #41399692306 passed; same-head PR Full CI not found; older failure #41391738912 targeted prior head 9bf7dde... | **Partial validation:** no PR-triggered CI run for current head was found. Exact PR base was D3M-02 feature branch; rerun PR CI after stack is rebased/retargeted onto the reviewed integration base |
| D3M-04 — TripoSR + rembg/ONNX worker readiness | #305 | [PR #306](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/306) | d05274f4c30fddc45dc41cd464573c40b6745e58 | PR CI #41405970254 and Push CI #41405965712 passed | **Code/CI candidate:** only synthetic/fake worker environments in CI; real worker readiness still unverified |
| D3M-05 — offline, fresh-ID, hash-bound single-image smoke | #307 | [PR #308](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/308) | 07e122053ff99059b72661e85e4f2e44b2a3c8ac | PR CI #41412587662 and Push CI #41412580459 passed | **Implementation candidate:** real TripoSR/rembg inference has not been run on the provisioned host; CI uses fakes/synthetic GLB |
| D3M-06 — bind reviewed placement to publication | #309 | [PR #310](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/310) | 0ed7371ec46b71037a5f8971f239322f0ac10709 | PR CI #41429766924 passed; same-head Push CI not found | **Push-CI gap:** no Push CI run on this exact head was found; add the branch to the Push workflow filter and require a same-head Push run after revalidation |
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


## 12. CI event-type correction

A final run-metadata pass checked the GitHub Actions `event` field rather than inferring Push CI from a second successful run. The corrected exact-head event matrix is:

| PR | Exact-head PR event | Exact-head Push event |
|---:|---|---|
| #279 (docs) | #41308926283 and #41308926257 — success (both are `pull_request`) | **Not found** |
| #281 | #41072445284 — success | **Not found** |
| #284 | **Not found** | #41076263050 — success |
| #286 | #41082822869 — success | #41082811923 — success |
| #288 | **Not found** | #41160633951 — success |
| #290 | **Not found** | #41315532257 — success |
| #292 | #41315555896 — success | #41315552065 — success |
| #302 | #41334962827 — success | **Not found** |
| #304 | **Not found** | #41399692306 — success |
| #306 | #41405970254 — success | #41405965712 — success |
| #308 | #41412587662 — success | #41412580459 — success |
| #310 | #41429766924 — success | **Not found** |
| #312 prior head | #41436755755 — success | #41436748360 — success |

“Not found” means no completed run with the required event and exact head was returned by the branch/commit Actions history during this audit. It is not inferred from an old run, a child branch's workflow file, or another event type. The current D3M-07 remediation head has fresh runs pending; its terminal status is recorded separately after they complete.

This correction supersedes the older row descriptions above wherever they mislabelled a second PR-triggered run as Push CI. Branch filters added in a descendant workflow only affect future pushes after the workflow file itself exists on the pushed branch; they do not retroactively produce historical runs or fix the parent branch.

## 13. Live branch, dependency and exact-head CI recheck — 2026-11-02 (latest)

This section supersedes earlier event/CI statements above wherever the same branch has since advanced. Values below were re-read from live PR metadata, commit comparisons and GitHub Actions run metadata; a successful historical run is not reused for a different SHA.

### Current feature PR heads

| Work package | PR | Current head | Current branch relationship |
|---|---:|---|---|
| D3M-01.A/B | #281 | 086c13f3467ebcbd3d2f46e1e4d45d4365a5d361 | 36 commits ahead / 5 behind live development at f7b2a67fcf0c34623196fa92e719640086e2adce |
| D3M-01.C | #284 | ba65e823750077955366d210cf12b31a5298c1e0 | 19 ahead / 0 behind #281 current head |
| D3M-01.D | #286 | 5335c4a507fdcc8e3ac5aea1c58ea8c7e00b10c0 | 26 ahead / 0 behind #284 current head |
| D3M-01.E | #288 | 355308148234b0e73955ccc1e9225e515ac0dfd5 | 34 ahead / 0 behind #286 current head |
| D3M-01.F | #290 | ff2fdeb4fc73ae926a122de29f30324eb127cb77 | 11 ahead / 0 behind #288 current head |
| D3M-01.G | #292 | b558508e445c51bfcb8a2421844c167633452da8 | 14 ahead / 0 behind #290 current head |
| D3M-02 | #302 | 116453207d517db6db6a8a19f6cc5802f5630be0 | 24 ahead / 0 behind current development |
| D3M-03 | #304 | dc826ea5fb327cd4772c7725ad8add85e05a1f13 | 83 ahead / 0 behind #302 current head |
| D3M-04 | #306 | 4028e097f02ebf3e44505c48b4d79424da2aaf27 | 11 ahead / 0 behind #304 current head |
| D3M-05 | #308 | 3ed68591ab133acef70f0fedd45fab0f54aee34a | 64 ahead / 0 behind #306 current head |
| D3M-06 | #310 | 08344f681210da213261dfa7444b687dcb89796a | D3M-05 parent history was joined by sync PR #313 |
| D3M-07 | #312 | 9956827be12377734ea2ec37c945f643b3a39a99 | 48 ahead / 6 behind the updated D3M-06 head; sync PR #315 is open and mergeable |

### Current exact-head CI events

| PR | Exact head | PR-triggered CI | Push-triggered CI |
|---:|---|---|---|
| #281 | 086c13f... | #41449210075 — success | #41449201350 — success |
| #284 | ba65e823... | #41449793055 — success | #41449784699 — success |
| #286 | 5335c4a... | #41450192326 — success | #41450181146 — success |
| #288 | 3553081... | #41450249825 — success | #41450240811 — success |
| #290 | ff2fdeb... | #41450285878 — success | #41450275317 — success |
| #292 | b558508... | #41450749550 — success | #41450740985 — success |
| #302 | 1164532... | #41449228282 — success | #41449218404 — success |
| #304 | dc826ea... | #41449879790 — success | #41449860665 — success |
| #306 | 4028e09... | #41450782703 — success | #41450775053 — success |
| #308 | 3ed6859... | #41450939744 — success | #41450932957 — success |
| #310 | 08344f6... | #41452436484 — in progress at last check | #41452430526 — in progress at last check |
| #312 | 9956827... (pre-sync head) | #41447645622 — success | #41447633166 — success |

For D3M-06 merged head 08344f6..., the Full CI job had completed lint, production build, and steps 1–173 successfully. Step 174, Verify viewport API against the production server, was still in progress; evidence uploads after it were pending. Do not mark this merged head green until the run reports terminal success. The earlier #310 success on 4185a7b... is not substituted for the merged head.

### Dependency-sync PRs created in this audit

- **#313 — D3M-05 → D3M-06:** merged into the D3M-06 feature branch only. Merge commit: 08344f681210da213261dfa7444b687dcb89796a. It did not merge into development or main. Fresh PR + Push CI on that merge commit are still required; see runs above.
- **#314 — live development → D3M-01.A/B parent branch:** open, Draft, mergeable. Its reviewed diff is limited to three paths: the CI workflow branch filter, BRF-35 global source-asset ID uniqueness, and candidate-GLB/source-asset identity/hash non-collision plus regression tests. It has not been merged; do not imply the D3M-01 base drift is closed.
- **#315 — D3M-06 → D3M-07:** open, Draft, mergeable, zero changed-file diff (ancestry-only synchronization). Merge only after D3M-06 merged-head PR and Push CI both reach terminal success; then require fresh D3M-07 PR + Push CI on its resulting exact head.

### Corrected closeout status

- D3M-02 through D3M-05 now have both PR and Push CI success on their current recorded feature heads. This closes the prior event-type gaps for those exact SHAs.
- D3M-06's missing Push trigger was corrected on its branch and both event types ran on the new merged head; terminal outcome was still pending at the last check.
- D3M-07's previous head had both events pass, but its parent has advanced; the new child head still needs synchronization and fresh validation.
- D3M-01.C through .G are ancestry-contiguous in the current compare checks and each has PR + Push success on its present head. D3M-01.A/B (#281) still needs the #314 development-sync decision and post-sync validation.
- All listed implementation PRs remain Draft/open. No release promotion is authorized by these CI results.

### Remaining external acceptance blockers

The repository-side CI/ancestry work does not provision production credentials, a trusted reviewer registry or worker host. A real operator must still verify private durable workspace/storage, operator and publisher credentials, worker supervision, Python/PyTorch/ONNX/rembg/TripoSR compatibility, both model caches, host-level network egress controls, and a real source image with reviewed operation rights and model licences. Run D3M-07 preflight and D3M-05 inference on that actual host, independently re-hash and visually inspect the GLB, then obtain independent survey/metric-scale/vertical-datum evidence and human review. Until those gates pass, keep all ground-truth, acceptance, publication, map-ready, automatic-approval and dispatch flags false.

The repository development and main refs remain diverged (91 commits ahead / 6 behind in the latest comparison; 204 changed paths). No merge to main or broad promotion was performed. This requires a separate explicit release plan and review.

## 14. Post-sync closeout refresh — 2026-11-02

The D3M-05 → D3M-06 and D3M-06 → D3M-07 parent synchronizations have now completed as branch-only merge commits.

- PR #313 merged D3M-05 head 3ed68591ab133acef70f0fedd45fab0f54aee34a into the D3M-06 feature branch. The resulting D3M-06 head is 08344f681210da213261dfa7444b687dcb89796a.
- Both exact-head D3M-06 checks on 08344f6... are now terminal-success: PR Full CI #41452436484 and Push CI #41452430526.
- PR #315 merged D3M-06 head 08344f6... into the D3M-07 feature branch. The resulting D3M-07 head is f1991cea20b3533e407c7982edcda9690e485b53.
- The current compare from D3M-06 08344f6... to D3M-07 f1991ce... is 51 commits ahead / 0 behind, with 13 changed paths in the PR view. This confirms the child contains its latest parent.
- Fresh exact-head D3M-07 PR CI #41453732972 and Push CI #41453723478 were queued/pending on f1991ce... when this document update was prepared. A later doc-only commit changes the head again; use the final branch SHA and its own event runs, not these pre-doc-edit pending runs.
- PR #314 remains open, Draft and mergeable. It is only a proposed development-to-D3M-01.A/B branch sync and has not been merged or validated on a new feature-branch SHA. D3M-01.A/B #281 remains 36 ahead / 5 behind current development. Do not mark this drift resolved.

### Work-package numbering reference

Use the repository issue/PR contracts rather than the stale pre-reconciliation numbering in older execution-plan paragraphs:

| Work package | Verified scope |
|---|---|
| D3M-00 | Dynamic 3D Map execution baseline and BRF-05/BRF-06 visual annotation/review integration and audit documentation |
| D3M-01.A–G | Source-bound evidence, rights/camera/GCP linkage, immutable candidate hand-off, trusted human geometry review, signed receipt, governed reviewer-key registry and registry preflight |
| D3M-02 | Approved generation-job publication into the Cesium model catalog/map |
| D3M-03 | Map-side image intake, operation-scope checks and generation-job tracking |
| D3M-04 | TripoSR plus rembg worker/model-cache readiness |
| D3M-05 | Authorized offline single-image inference smoke and independent artifact verifier |
| D3M-06 | Bind the reviewed placement transform to the map-publication record |
| D3M-07 | Scoped non-inference worker preflight using the authoritative capability probe |

### Current status after dependency sync

D3M-02 through D3M-06 each have PR-triggered and Push-triggered terminal success on the current recorded code head. D3M-07 now includes its latest parent, but its new head still needs fresh exact-head PR and Push CI after all final documentation updates. D3M-01.C–G are currently contiguous in the parent-child compare checks and have exact-head PR + Push success; D3M-01.A/B is the unresolved parent-base issue tracked by #314.

No sync PR merged into development or main. No feature PR was marked ready for review. All release flags remain false.

## 13. Late-day D3M-00 → D3M-07 reconciliation update — 2026-11-02

This section supersedes earlier "remaining sync" and exact-head event rows above wherever the same branch/PR has since advanced. All SHA and run references below are exact-head observations.

### 13.1 D3M-01 parent/child ancestry is synchronized

The selected current development head is f7b2a67fcf0c34623196fa92e719640086e2adce. D3M-01.A/B PR #281 was reconciled with that branch by merging the current development ref into the feature branch, not into development/main:

- PR #314 was merged into the D3M-01.A/B feature branch; merge commit 116cd65a81e1687dc889341940f2772358cf82ec.
- A subsequent CI-trigger correction added the D3M-01.A/B branch to its own pull_request.branches filter. Current #281 head: daa02d5aa0d7c7ba4c0de6860fe1678160682998.
- Exact-head Push CI: [#41461160231](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41461160231) — success.
- Exact-head PR CI: [#41461174767](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41461174767) — success.

The complete D3M-01 chain now has no missing parent commits at the audited refs:

| Parent → child | Parent head | Child head | Comparison |
|---|---|---|---|
| #281 → #284 | daa02d5aa0d7c7ba4c0de6860fe1678160682998 | cf1728ca6924b6fa4af8e6ccdcc6cf26615be9dc | 22 ahead / 0 behind |
| #284 → #286 | cf1728ca6924b6fa4af8e6ccdcc6cf26615be9dc | 310eba45a4b57444009651d1d5e0371a79bb6a8f | 27 ahead / 0 behind |
| #286 → #288 | 310eba45a4b57444009651d1d5e0371a79bb6a8f | 5a495e7d0b651cf84e1fd5bc91c81a43f6d0b9c5 | 35 ahead / 0 behind |
| #288 → #290 | 5a495e7d0b651cf84e1fd5bc91c81a43f6d0b9c5 | 236c02b54a353780baa360d9833058c2bab8264c | 12 ahead / 0 behind |
| #290 → #292 | 236c02b54a353780baa360d9833058c2bab8264c | 54d4c6d040726bc0cf8edda34e97f3f185877e87 | 15 ahead / 0 behind |

The merge-conflict cases on the D3M-01 branch stack were resolved with explicit two-parent merge commits. Sync-only PRs #316, #317, #318 and #319 were closed after the equivalent merge commits were applied to their intended child branches. Their closure does not discard the implementation work. The merge commits preserve the child-specific hand-off, authenticated review, BRF-25 and registry implementation; the shared BRF-35 source/candidate uniqueness checks and CI trigger changes are incorporated in all descendants.

### 13.2 D3M-01 exact-head CI checkpoint

| PR | Current head | PR CI | Push CI |
|---:|---|---|---|
| #281 | daa02d5aa0d7c7ba4c0de6860fe1678160682998 | #41461174767 — success | #41461160231 — success |
| #284 | cf1728ca6924b6fa4af8e6ccdcc6cf26615be9dc | #41461409064 — in progress at checkpoint | #41461401395 — success |
| #286 | 310eba45a4b57444009651d1d5e0371a79bb6a8f | #41461924513 — in progress at checkpoint | #41461920651 — success |
| #288 | 5a495e7d0b651cf84e1fd5bc91c81a43f6d0b9c5 | #41462368236 — in progress at checkpoint | #41462360896 — in progress at checkpoint |
| #290 | 236c02b54a353780baa360d9833058c2bab8264c | #41462671163 — in progress at checkpoint | #41462663993 — in progress at checkpoint |
| #292 | 54d4c6d040726bc0cf8edda34e97f3f185877e87 | #41462785232 — in progress at checkpoint | #41462774252 — in progress at checkpoint |

Do not substitute a prior-head green run for any of the in-progress checks. All #281–#292 feature PRs remain Draft/unmerged pending exact-head terminal results and independent human review.

### 13.3 D3M-02 → D3M-07 exact-head CI and sync results

| PR | Current head | Exact-head PR CI | Exact-head Push CI |
|---:|---|---|---|
| #302 / D3M-02 | 116453207d517db6db6a8a19f6cc5802f5630be0 | #41449228282 — success | #41449218404 — success |
| #304 / D3M-03 | dc826ea5fb327cd4772c7725ad8add85e05a1f13 | #41449879790 — success | #41449860665 — success |
| #306 / D3M-04 | 4028e097f02ebf3e44505c48b4d79424da2aaf27 | #41450782703 — success | #41450775053 — success |
| #308 / D3M-05 | 3ed68591ab133acef70f0fedd45fab0f54aee34a | #41450939744 — success | #41450932957 — success |
| #310 / D3M-06 | 08344f681210da213261dfa7444b687dcb89796a | #41452436484 — success | #41452430526 — success |
| #312 / D3M-07 | 761f6e01e79fe1b33bb08dd891b9b980072f9ada | #41453880459 — success | #41453875535 — success |

- PR #313 synchronized the D3M-05 parent history into the D3M-06 feature branch. The resulting D3M-06 head above passed both event types.
- PR #315 synchronized that D3M-06 head into the D3M-07 feature branch. The resulting D3M-07 head above passed both event types.
- D3M-06 and D3M-07 remain Draft. These checks validate software orchestration and contract tests, not real model inference or architectural accuracy.

### 13.4 Trigger and BRF-35 hardening

- The D3M-06 branch now has its own Push filter; same-head Push and PR results exist on the resulting merged head.
- The D3M-01 stacked branches now add their parent branch to pull_request.branches and themselves to their own pull_request.branches for the next child PR. This closes the base-branch event-filter gap across the current D3M-01 stack.
- The shared BRF-35 validator now rejects duplicate source asset IDs across CityGML, images, ULS and survey/control roles. It also rejects a candidate GLB whose asset ID or SHA-256 collides with any source/reference asset. Synthetic regressions cover cross-role collisions and candidate/source identity collisions. All release flags remain false.
- An intermediate D3M-01C workflow merge omitted a newline between the Push and Pull Request blocks; its first run [#41460767486](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41460767486) failed before jobs were created. The YAML boundary was corrected and the current #284 head has a successful Push CI. The new PR CI remains recorded separately in the table above.

### 13.5 D3M-00 promotion and real-world gates remain blocked

- Current development vs main compare remains diverged: 91 commits ahead, 6 behind, and 204 changed paths in the compare result. No promotion to main was performed.
- PR #279 remains an old-base documentation PR; it is not a substitute for the current reconciliation record on the D3M-07 branch.
- All D3M feature PRs remain Draft/unmerged. No release gate was enabled.
- There is still no supplied evidence of a provisioned production reviewer registry, deployment publisher/operator secrets, durable worker-host storage, actual worker-host preflight, real TripoSR/rembg inference, independent GLB visual review, verified source/model licence grant, surveyed metric scale, validated WGS84/vertical datum, held-out accuracy, or deployment map reload/rollback.
- Keep groundTruth, acceptanceEligible, publicationEligible, publishable, mapReady, automaticApproval and worker dispatch/publication authorization false.

**Conclusion:** branch ancestry and CI event coverage are now reconciled at the listed SHAs. The D3M-01 child PR checks still in progress at this checkpoint must reach terminal success before that stack can be called CI-complete; real-worker and real-building acceptance gates remain open.


## 14. Latest terminal-status correction — 2026-11-02

This section supersedes the status table in §13.2 where runs have since reached a newer terminal state, and supersedes any older reference to the D3M-07 code-only head as the current PR head.

- D3M-01.A/B PR #281 on `daa02d5aa0d7c7ba4c0de6860fe1678160682998`: Push #41461160231 and PR #41461174767 both **success**.
- D3M-01.C PR #284 on `cf1728ca6924b6fa4af8e6ccdcc6cf26615be9dc`: Push #41461401395 and PR #41461409064 both **success**.
- D3M-01.D PR #286 on `310eba45a4b57444009651d1d5e0371a79bb6a8f`: Push #41461920651 and PR #41461924513 both **success**.
- D3M-01.E PR #288 on `5a495e7d0b651cf84e1fd5bc91c81a43f6d0b9c5`: Push #41462360896 and PR #41462368236 both **success**.
- D3M-01.F PR #290 on `236c02b54a353780baa360d9833058c2bab8264c`: Push #41462663993 and PR #41462671163 were still **in progress** at last live inspection. Both jobs were inside the 30-minute “Verify viewport API against the production server” step; no pass is claimed.
- D3M-01.G PR #292 on `54d4c6d040726bc0cf8edda34e97f3f185877e87`: Push #41462774252 and PR #41462785232 were still **in progress** at last live inspection, at the same viewport verification step; no pass is claimed.
- D3M-07 PR #312 has since advanced due to documentation updates. Its current head at this check was `2bcb5490a46fe7229927b5fbaf186444ee8dd8d1`, not the earlier code head `761f6e01...`. Current-head Push #41463110850 and PR #41463119697 were **in progress** at the same viewport verification step. The earlier `761f6e01...` green runs do not validate this later documentation head.
- The viewport verification step is intentionally retained in Full CI. It starts two separate production Next.js processes and exercises the real built viewport API. Do not remove or skip it just to obtain a green status. If it reaches its 30-minute timeout, inspect the captured primary/repeat server logs and fix the underlying test/runtime issue.

The D3M-01 ancestry remains 0-behind for every parent/child pair at the SHAs in §13.1. No feature PR was promoted or merged into `development`/ `main`; only branch-to-branch sync commits were applied. The working code paths remain Draft.

**Remaining completion gate:** obtain terminal-success exact-head PR and Push CI for #290, #292 and the newest #312 documentation head. Then re-check the PR heads have not moved, re-run the 0-behind ancestry comparisons, and update this audit again. Real worker-host inference, licensed source/model use, production reviewer provisioning, independent survey/accuracy review and map publication/rollback remain separate external gates.


## 15. Final D3M-01 CI terminal reconciliation — 2026-11-02

This update supersedes the §14 statement that #290/#292 were in progress.

The D3M-01 parent-to-child ancestry remains 0-behind throughout #281 → #284 → #286 → #288 → #290 → #292. Every listed implementation branch remains Draft/unmerged, but both required CI event types have now reached terminal success on the current recorded code heads:

| PR | Exact code head | PR Full CI | Push CI |
|---:|---|---|---|
| #281 | `daa02d5aa0d7c7ba4c0de6860fe1678160682998` | #41461174767 success | #41461160231 success |
| #284 | `cf1728ca6924b6fa4af8e6ccdcc6cf26615be9dc` | #41461409064 success | #41461401395 success |
| #286 | `310eba45a4b57444009651d1d5e0371a79bb6a8f` | #41461924513 success | #41461920651 success |
| #288 | `5a495e7d0b651cf84e1fd5bc91c81a43f6d0b9c5` | #41462368236 success | #41462360896 success |
| #290 | `236c02b54a353780baa360d9833058c2bab8264c` | #41462671163 success | #41462663993 success |
| #292 | `54d4c6d040726bc0cf8edda34e97f3f185877e87` | #41462785232 success | #41462774252 success |

The prior current D3M-07 documentation head `3f6c079299729e27f6f775bab61d608f883ad594` has queued exact-head PR #41464027945 and Push #41464018711. The audit and roadmap are being updated in this final commit, so the resulting branch SHA changes once more; only runs targeting that resulting SHA may validate the latest D3M-07 branch. Do not inherit the prior-head CI status.

**D3M-01 CI closeout:** complete for the recorded implementation heads. **D3M-07 latest documentation-head CI:** pending final exact-head run. All PRs remain Draft/unmerged pending review/integration approval. No promotion to `development` or `main` was performed.

Operational gates remain open: real worker preflight/inference, source/model rights, independent GLB review, production reviewer/operator/publisher provisioning, surveyed scale and vertical datum, held-out accuracy, and deployed map reload/rollback. Keep all release flags false.
