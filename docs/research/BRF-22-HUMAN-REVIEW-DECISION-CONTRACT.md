# BRF-22 — Hash-bound human-review decision contract

**Tracking:** [Issue #226](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/226).  
**Inputs:** BRF-14 exact-byte verification, BRF-20 review manifest/contact sheet/coverage plot and BRF-21 pairwise report/graph.  
**Decision:** the real sample stays pending until an authorized reviewer records decisions against the exact evidence hashes.

## Commands

Place the six derived evidence files from the CI artifact in one dedicated directory. Do not add raw source images to Git or to a shared artifact. Generate a blank form:

    python3 scripts/brf21_human_review.py template --artifact-root path/to/brf-14-artifacts

Fill in the generated multiview-human-review-decision-template.json only after personally inspecting the contact sheet, camera-angle plot, pairwise graph, per-pair counts and source metadata. Save it as review-decision.json in the same artifact directory. Validate it:

    python3 scripts/brf21_human_review.py validate --artifact-root path/to/brf-14-artifacts --decision review-decision.json

The template binds the exact bytes and sizes of all five input evidence artifacts: the BRF-20 JSON manifest, BRF-21 JSON report, contact sheet, camera-angle plot and pairwise graph. The validator recomputes each SHA-256 and rejects a stale or modified input rather than silently accepting the previously reviewed evidence.

## Required human fields

- Reviewer name and stable identifier, plus an explicit ISO-8601 UTC review timestamp ending in Z.
- Overall disposition and rationale; same-building identity; adequate/inadequate/uncertain coverage.
- One decision for every source view, including visible surfaces, occlusion, quality and rationale.
- One decision for every unordered image pair, with the candidate-edge flag kept identical to the analyzer report.
- Explicit source up-axis interpretation with axis and direction if declared confirmed.
- A separate asset-rights decision and HTTPS terms/source URL if the use is marked approved.

The validator requires at least three included views that form a connected graph of human-confirmed useful-overlap pairs before the reviewer can select continue-to-reconstruction-preflight. This is a consistency check on the human record; it does not infer overlap from ORB counts. The reviewer may instead record hold, reject or uncertain.

## Safety and interpretation

A pending template is not a valid completed decision. An uncertain or rejected decision remains uncertain or rejected in the validation report. The validator rejects missing/unknown view and pair IDs, hash changes, unsafe paths, symlinks, unsupported axis mappings, missing review rationale and any attempt to set release flags to true.

A validated record only proves that the fields and hash bindings satisfy this contract. It does **not** authenticate reviewer identity or licence claims, establish building identity independently, establish survey accuracy, estimate metric error, run COLMAP, produce a candidate GLB, or authorize publication. A separate authorized workflow decision is still required before reconstruction preflight. A real human decision has not been made by this automated change.

All of acceptanceEligible, publicationEligible, mapReady and automaticApproval remain false.
