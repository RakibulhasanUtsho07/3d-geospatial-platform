# BRF-44 — Final execution boundary for multi-view quality and rights evidence

**Status:** Implemented on the feature branch; validation is required on the exact pull-request head. This change does not authorize reconstruction.

## Gap addressed

BRF-43 added `private-multiview-media-intake-report.json` as the eighth hash-bound artifact at the BRF-21/23 preflight stage. The final BRF-24 executor previously validated only seven artifacts. The executor must re-validate the same evidence set immediately before it could route source media to COLMAP.

A second, independent safety rule is necessary: the BRF-42 private-intake report explicitly records the media as unreviewed, with `rightsApproved=false` and `safeToSubmitToColmap=false`. A human-review decision or an editable media-registry record does not convert that state into source-use permission.

## Execution-boundary checks

The executor now:

1. Requires all eight evidence roles, including `privateMediaQualityReport`, with exact filename, byte size and SHA-256 matching the preflight and human decision.
2. Parses the exact BRF-14 manifest, byte-verification report and BRF-42 quality report. It reconciles manifest/report hashes, source commit and license metadata, sample/view IDs, source file hashes and sizes, declared totals, private-intake records, quality rows and decoded dimensions.
3. Requires complete unique per-view quality records, no image decode errors, and consistent rights status across the raw intake and the BRF-23 summary. Stale or changed per-view hashes are rejected even if the outer report bindings have been refreshed.
4. Keeps the BRF-42 release flags false and verifies that identity, rights and geometry-review claims remain pending in the intake report.
5. Fails before writing an execution authorization or starting the worker while BRF-42 still says rights are unreviewed or `safeToSubmitToColmap=false`.

## Important limit

BRF-42 is an intake and quality-screening report, **not** a rights-grant mechanism. The intentional fail-closed result means the currently pinned sample is not eligible for COLMAP merely because its images were fetched, hashed, decoded or marked approved in a separate record.

The next prerequisite for a genuine reconstruction attempt is a separately reviewed, exact-asset rights admission record covering the specific source bytes and intended operations. The intake report must remain an immutable record of its original unreviewed status; do not rewrite it or treat a dataset-card license declaration as authentication of the uploader's authority.

Even after source-use rights are properly documented, this gate does not establish physical building identity, coordinate registration, independent survey truth, held-out checkpoint accuracy or publication readiness. The flags `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` remain false.

## Regression coverage

The BRF-24 executor tests cover:

- the eighth report's hash/size binding and raw report provenance;
- complete source-to-intake-to-quality row matching;
- rejection when a per-view quality hash is changed even after outer report bindings are refreshed;
- rejection of attempts to promote quality-summary rights flags or per-image usage status;
- confirmation that unreviewed rights stop execution before authorization creation and before the COLMAP worker;
- existing file-integrity, reviewer-decision, profile, selected-media and toolchain checks.

Use `npm run test:brf24-colmap-authorization` for the focused regression suite. Full repository CI is still required against the exact PR head before merge to `development`. This work does not merge to `main`.
