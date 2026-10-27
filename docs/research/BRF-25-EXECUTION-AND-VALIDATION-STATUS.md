# BRF-25 — End-to-end reconstruction and geometry-validation status

**Tracking:** [Issue #233](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/233)  
**Implementation PR:** Pending  
**Baseline:** `development` at `655ebab43480f06caf8c0c974cf8920bfee357c9` (BRF-24 merge)  
**Release disposition:** `BLOCKED` pending real reviewed source evidence, actual candidate production, independent truth, and human visual review.

## What was already present at baseline

| Gate | Existing implementation | Status at baseline |
|---|---|---|
| Hash-bound multi-view review | BRF-14/20/21 packets and BRF-22 reviewer-decision validator | Code exists; live human decision pending |
| Reconstruction preflight | BRF-23 preflight report and pinned COLMAP version | Code exists; real packet blocked by pending review |
| Guarded worker execution | BRF-24 executor and authorization audit | Code/CI complete; no real candidate claimed |
| Candidate GLB extraction | `glb-geometry-extraction.mjs` and preparation CLI | Code/tests exist; actual candidate bytes must be supplied |
| Independent truth metrics | independent-truth evaluator and frame adapter | Code/tests exist; independent metric reference must be supplied |
| Masks/features/source-camera review | BRF-05–07 source evidence/visual comparison tools | Partial; real labels, calibrated views and human sign-off remain open |
| Ahsan Manzil proportions/layout | [Issue #203](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/203) | Plan orientation/full-frame evidence unresolved |

## Implementation in this package

The BRF-25 runner binds the worker-generated candidate to the actual geometry-evaluation config and then runs the existing GLB geometry extraction/preparation CLI and independent-truth evaluator in sequence.

```text
BRF-24 authorization
       │ exact source/decision/profile hashes + candidate GLB hash
       ▼
BRF-25 candidate binding
       │ actual bytes == authorization hash == truth-config expected hash
       ▼
prepare-independent-building-truth-manifest.mjs
       │ actual GLB POSITION/indices/transforms + reviewed reference adapter
       ▼
evaluate-independent-building-truth.mjs
       │ footprint/dimensions/held-out checkpoint/optional surface metrics
       ▼
geometry-evaluated-review-required
       │ visual review + reference provenance review still required
       ▼
no automatic acceptance, publication, map-ready or auto-approval
```

### Run command

Use a fresh output directory inside the repository. The candidate path in the truth config must resolve to the worker-produced path recorded in the authorization.

```sh
node scripts/run-brf25-geometry-validation.mjs \
  .building-engine/authorizations/<buildingId>/<jobId>.json \
  benchmarks/building-reconstruction/<truth-extraction-config>.json \
  artifacts/brf25/<evaluationId> \
  --workspace=<workspace-root> --root=.
```

The CLI refuses pending/non-generated authorizations, changed candidate bytes, config-hash mismatch, path substitution/traversal, missing/incorrect reviewer disposition, stale toolchain, insufficient source-image hashes, or release flags already set. It writes `brf25-geometry-validation.json` and all intermediate reports. Select a fresh output directory for each run; outputs are never overwritten.

The output deliberately stops at **review-required**, **incomplete**, **failed**, or **blocked**. It does not report final PASS or promote release flags.

## Verification

- BRF-25 automated tests exercise the authorization/candidate/config binding and fail-closed cases.
- CI validates the CLI and runs the tests.
- Existing geometry preparation/evaluator suites remain part of CI.
- A synthetic test fixture proves only software behavior; it is not a building reconstruction or accuracy result.

## Still blocked on real evidence

- A genuine hash-bound BRF-22 reviewer decision and use-specific rights review.
- Actual engine-produced candidate GLB generated from the reviewed sample.
- Independent, separately sourced metric reference with documented origin, units, CRS/frame and metric-preserving transforms.
- Multiple real held-out checkpoints excluded from fitting/registration and bound to actual candidate geometry.
- Actual geometry-evaluation report reviewed against the correct evidence.
- Reviewed source-camera renders, architectural annotations/masks and human visual sign-off.

If these inputs are absent, the live run remains **BLOCKED**; no benchmark ground-truth model may be relabelled as an engine candidate. The public GT-LOD3 benchmark remains an option, not a completed run.

## Required guardrails

- `acceptanceEligible`, `publicationEligible`, `mapReady`, and `automaticApproval` remain `false`.
- COLMAP local-frame coordinates are not GPS registration or survey scale.
- Published dimensions and synthetic tests do not substitute for independent survey truth.
- Keep candidate GLBs, source photos and private survey assets out of Git; publish only permitted derived reports/renders as workflow artifacts.
- Work via feature PR → `development`; do not promote to `main` until the real-data acceptance and visual review gates have passed.
