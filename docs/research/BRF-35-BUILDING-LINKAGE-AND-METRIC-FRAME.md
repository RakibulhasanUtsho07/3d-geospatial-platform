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

## What the gate checks

1. CityGML, image, ULS and survey/control records have evidence-backed rights metadata bound to each exact asset hash.
2. A human decision refers to hashes for the CityGML, at least one image frame and the ULS crop.
3. Source axis order and units have a reviewed, hash-bound decision.
4. Horizontal and vertical coordinate operations include definitions, accuracy, area of use, software version and evidence.
5. A platform reconstruction candidate GLB is distinct from source-reference geometry.
6. At least three unique held-out controls bind to a hash-pinned survey source and the approved coordinate frame.
7. Accuracy report, threshold policy, candidate/reference hashes and fixed-view visual review are linked.

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
