# BRF-35 — same-building linkage and metric-frame evidence gate

**Status:** validator and blocked candidate manifest; real-world benchmark remains blocked.  
**Tracking:** issue #248 and asset rights / building mapping issue #240.

## Current pinned source evidence

- Immutable source commit: e032a71fc9b3c9c3d4869e3aca9677d1234086aa
- Source path: citygml/lod3-building-datasets/DEBY_LOD3_4959323.gml
- Git blob ID: 2fd72c942399ff0cc78e3478dced74b60180e5dd
- Whole-object size/SHA-256: 51,178,520 bytes / a7b30f1596683837329e7b674e16d0dada2c98e3640092129d9092479a67ba37
- Parsed in-file Building ID: DEBY_LOD2_4959323; do not silently replace it with the filename label.
- Declared source CRS: EPSG:25832; its Z datum and relationship to the ULS height reference are not yet verified.

The candidate manifest preserves the real source pins but intentionally records no claimed image/ULS match. Validation is expected to remain blocked.


## BRF-47 / BRF-48 provenance and held-out hardening

The validator additionally enforces cross-role source/candidate identity and the following accuracy-evidence contract:

- Every populated source role (CityGML, image, ULS and survey-control) uses one globally unique, syntactically valid asset ID.
- The platform candidate GLB has an asset ID and SHA-256 distinct from every pinned source asset, not only the CityGML reference.
- `accuracy.fitSourceAssetRefs` must contain at least one unique, valid reference. Each reference must match a declared source asset's exact asset ID, SHA-256 and role. The only permitted fit-input roles are `image` and `uls`.
- At least six unique held-out checkpoint IDs are required. Each point must be hash-linked to a declared survey-control asset and use the approved evaluation frame.
- A held-out checkpoint source asset must be disjoint from all declared candidate fit-input assets. A survey-control asset cannot be listed as a candidate-fitting input.
- Synthetic positive fixtures prove schema/completeness behavior only. They do not prove that a real survey curator withheld the observations from fitting; a curator must inspect the actual data split and processing history.

Regression coverage includes cross-role ID collisions, candidate ID/hash reuse, three- and five-point under-counts, duplicate/stale/unknown/wrong-role fit references, prohibited survey-control fitting, fit/holdout source overlap, and a valid six-point synthetic case. The real candidate is expected to remain blocked, with all release flags false.

## What the gate checks

1. CityGML, image, ULS and survey/control records have evidence-backed rights metadata bound to each exact asset hash.
2. A human decision refers to hashes for the CityGML, at least one image frame and the ULS crop.
3. Source axis order and units have a reviewed, hash-bound decision.
4. Horizontal and vertical coordinate operations include definitions, accuracy, area of use, software version and evidence.
5. A platform reconstruction candidate GLB is distinct from source-reference geometry.
6. At least six unique held-out checkpoints bind to hash-pinned survey-control source assets and the approved evaluation frame. Each checkpoint carries its own identifier, source asset ID, source SHA-256, XYZ coordinate, and uncertainty.
7. Candidate fitting inputs are explicitly enumerated in `accuracy.fitSourceAssetRefs` by asset ID, exact SHA-256 and source role. Only `image` and `uls` roles are permitted as fitting inputs; `survey-control` assets are not allowed in this list.
8. No held-out checkpoint's `sourceAssetId` may appear in the candidate fit-source set. The machine-checkable rule enforces asset-level separation; an independent curator must still verify that the actual point observations were not used for registration, fitting, tuning or correction.
9. Accuracy report, threshold policy, candidate/reference hashes and fixed-view visual review are linked.

## Run

~~~bash
npm run test:brf35-building-linkage
node scripts/validate-brf35-building-linkage.mjs \
  benchmarks/building-reconstruction/brf-35-candidate-linkage.json \
  benchmarks/building-reconstruction/brf-33-citygml-candidate-geometry.json \
  artifacts/brf35-linkage-validation.json
~~~

A blocked report is the expected result for the current real candidate. The validator checks completeness and cross-references; it does not download or independently verify imagery and ULS source bytes. The existing source-byte verifiers and human rights review remain mandatory.

## Safety and release policy

This validator is not a license authority, survey verifier, CRS engine, accuracy adjudicator or release approver. HTTPS links and human-entered review fields still need independent inspection; manifest strings alone cannot prove that a remote page grants rights. Do not infer same-building identity from filename suffixes or broad envelope overlap, and do not fit a coordinate transform merely to make a model overlap visually.

Even a complete synthetic fixture produces evidence-complete-human-release-review-required, not a pass. All release flags remain false. A real release must pass the existing independent review workflow separately.


## Integration validation — 2026-11-01

BRF-47 was integrated into `development` at base commit `f7b2a67fcf0c34623196fa92e719640086e2adce`. The BRF-48 change was validated against that exact base at PR head `44e9c7c96b5a2d05966adbf6f7ab63e17488b78b`:

- Full CI: [run 41312726994](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41312726994) — success.
- BRF-35 same-building linkage and metric-frame gate: [run 41312726975](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41312726975) — success.
- The merged BRF-47 base's post-merge Full CI: [run 41312647009](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41312647009) — success.

These are exact-commit software/workflow results. They do not establish that the synthetic held-out observations are genuinely independent, authenticate any source rights, prove a same-building match, validate a real coordinate transform, or assess a platform-generated building model. No independent reviewer approval is recorded for PR #298. The PR remains Draft pending independent review. The real candidate and every release flag remain blocked/false.
