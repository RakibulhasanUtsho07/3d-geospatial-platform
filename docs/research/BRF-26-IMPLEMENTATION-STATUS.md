# BRF-26 — Implementation status and real-evidence gap matrix

**Audit date:** 2026-10-28  
**Audited baseline:** `development` at `6504e3abee0da051043a10133b6fd5dcd827b48b` (BRF-26 PR #235 merged).  
**Purpose:** Separate code delivery from evidence that can legitimately establish the accuracy of a real reconstructed building.

## Status vocabulary

- **IMPLEMENTED** — the code/CLI or validation contract exists and has automated coverage.
- **PARTIAL** — tooling exists, but at least one important integration, input, or real-world evidence condition is still missing.
- **MISSING** — the required real artifact or independent measurement is not present in the reviewed repository evidence.
- **BLOCKED** — the next real-data action depends on a human decision, permission/rights evidence, a real candidate, or independent reference material that must not be fabricated.

These statuses describe different layers. A code-level IMPLEMENTED status never upgrades real-building accuracy to PASS.

## Implementation matrix

| Stage | Code / contract status | Real-sample evidence status | Evidence and limitations |
|---|---|---|---|
| BRF-14 — selected source bytes and camera metadata | **IMPLEMENTED** | **PARTIAL** | [Source manifest](../../benchmarks/building-reconstruction/brf-14-multiview-source.json) and [byte verifier](../../scripts/verify-brf14-multiview-source.mjs) pin selected files and source-pose metadata. The manifest explicitly says the source COLMAP model was derived from the same image set and is not independent survey truth. It records that owner authority is not independently authenticated and that no separate survey, six held-out checkpoints, or accuracy metrics are included. |
| BRF-20 — labelled human-review packet | **IMPLEMENTED** | **BLOCKED pending human review** | [Packet-preparation workflow](../../.github/workflows/brf-14-multiview-source-intake.yml) and the [BRF-20 tracking issue](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/222) cover derived review material. The generated packet must remain pending; creating a contact sheet or coverage plot is not the same as approving identity, overlap, rights, or coverage. |
| BRF-21/22 — hash-bound human decision | **IMPLEMENTED** | **BLOCKED pending a genuine decision** | [Human-review validator](../../scripts/brf21_human_review.py) validates reviewer-supplied view/pair decisions, timestamps, rationale, and rights/up-axis decisions against exact evidence hashes. [Issue #226](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/226) is closed for the code contract; that does not mean the actual sample has a completed, independently performed human review. |
| BRF-23 — reconstruction preflight | **IMPLEMENTED** | **BLOCKED until review/rights/inputs pass** | [Preflight CLI](../../scripts/brf23_reconstruction_preflight.py) is a gate only; it explicitly does not execute reconstruction or create a GLB. A preflight-ready status permits only a separately authorized local reconstruction attempt, not geometry accuracy. |
| BRF-24 — guarded COLMAP reconstruction | **IMPLEMENTED** | **BLOCKED: real candidate not evidenced** | [Reviewed reconstruction entry point](../../scripts/reconstruct-brf23-reviewed-source.mjs) requires explicit confirmation and preserves all release flags as false. A real worker-generated candidate bound to a completed review record still needs to be produced; a source/reference GLB cannot be relabelled as the engine candidate. |
| BRF-25 — actual GLB geometry extraction and independent-truth evaluation | **IMPLEMENTED** | **BLOCKED: independent metric truth is missing** | [Geometry-validation runner](../../scripts/run-brf25-geometry-validation.mjs) orchestrates exact-candidate binding, GLB geometry extraction, preparation, and independent-truth evaluation. Its documented results remain review-only. The BRF-14 manifest does not supply a separate surveyed reference or held-out accuracy metrics. [BRF-10 issue #208](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/208) tracks this real-data gap. |
| BRF-05–07 — masks, architecture features and source-camera comparison | **PARTIAL** | **BLOCKED: real reviewed labels/render evidence missing** | [Visual evidence package](../../src/core/building-generation/building-visual-evidence-package.mjs), [source-camera contract](../../src/core/building-generation/source-camera-render.mjs), and [render-review manifest](../../src/core/building-generation/render-review-manifest.mjs) are implemented. The package still requires independently reviewed real masks/annotations, a rights-reviewed real source, comparable candidate renders, and held-out evidence. Synthetic fixtures do not prove visual accuracy. See [issue #199](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/199). |
| BRF-26 — cross-artifact evidence bundle | **IMPLEMENTED** | **REVIEW/BLOCKED until genuine evidence exists** | [Evidence-bundle CLI](../../scripts/build-brf26-evidence-bundle.mjs), [contract](../../src/core/building-generation/brf26-evidence-bundle.mjs), [blank visual-review template](../../templates/brf26-visual-review-decision.template.json), and [tests](../../tests/brf26-evidence-bundle.test.mjs) are merged in PR #235. The gate recomputes hashes, rejects unsafe/missing inputs, binds the candidate across geometry/camera/render artifacts, checks actual PNG bytes, requires complete view coverage, and keeps all release flags false. A synthetic fixture can only prove software behaviour. |
| Independent survey/metric reference, frame mapping and genuinely held-out checkpoints | **MISSING** | **BLOCKED** | No independent survey/reference plus held-out set and real accuracy report are established by the current BRF-14 source manifest. The source COLMAP model, a GLB made from the same source photos, and the source scale-control bar cannot be counted as independent held-out building truth. |
| Rights and same-building identity for the chosen real input | **PARTIAL** | **BLOCKED pending human attestation** | The source manifest records a source-declared CC BY 4.0 statement but explicitly notes that owner authority is not independently authenticated. Legal/use-specific permission and same-building identity must be reviewed and recorded for the exact bytes before reconstruction. |
| Release/publication gate | **IMPLEMENTED** | **NOT APPROVED** | BRF-14 through BRF-26 validators keep `acceptanceEligible`, `publicationEligible`, `mapReady`, and `automaticApproval` false. No current evidence in this audit justifies changing these flags. |

## CI evidence

- Exact-head PR validation before the merge passed: [CI run #40626977815](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40626977815). This included the BRF-26 test/CLI steps, the repository regression suite, production build, and viewport API smoke check.
- Exact-head real-building reference-intake workflow passed: [run #40626977792](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40626977792).
- BRF-26 was squash-merged into `development` at [`6504e3abee0da051043a10133b6fd5dcd827b48b`](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/commit/6504e3abee0da051043a10133b6fd5dcd827b48b).
- Post-merge checks were still running when this matrix was drafted: [push CI #40631507823](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40631507823), [PR-triggered CI #40631514221](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40631514221), and [reference intake #40631514143](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40631514143). Do not report those post-merge runs as passed until their completed conclusions are checked.

## Next execution order

1. Complete and archive the exact-source human review for the chosen multi-view set: same-building identity, coverage/overlap, visibility/occlusion, up-axis, and use-specific rights.
2. Only if that review clears, run the existing BRF-23 preflight and BRF-24 guarded worker to generate the candidate from the reviewed source bytes.
3. Acquire/identify a separately sourced metric reference with documented units, coordinate frame and frame transforms. Keep fitting controls separate from genuinely held-out checkpoints; do not use the source COLMAP model or a ground-truth benchmark model as the engine candidate.
4. Run BRF-25 on the actual candidate and independent reference; inspect the numeric footprint/dimension/checkpoint/surface residuals and failure cases.
5. Produce same-camera renders and the BRF-05–07 reviewed source/mask/feature package tied to the candidate's exact GLB SHA-256.
6. Assemble the BRF-26 bundle and obtain independent human sign-off. Missing rights, non-comparable views, reference provenance or held-out evidence must remain blockers.
7. Verify the post-merge `development` CI before proposing any promotion. This work package does not authorize a `main` change.

**Conclusion:** The code-level evidence chain is implemented and regression-tested. The real-building reconstruction and accuracy claim remain **BLOCKED**, principally by an authentic human-reviewed source decision and independent metric truth/held-out checks. No reviewer decision, survey measurement, candidate GLB, or accuracy result is invented by this matrix.
