# BRF-41 — Interim dataset admission and claim boundaries

**Status:** Initial policy gate and inventory. One exact imagery sample is admitted only to bounded, private engineering smoke tests; five other research leads remain blocked. This is not legal advice, license authentication, building-accuracy evidence or release approval.

## Why this gate exists

The engine can continue developing before a maintainer replies, but “publicly accessible” cannot be interpreted as permission to reuse. Temporary datasets must have purpose-limited admissions. A sample that is useful for image ingestion or rendering must not silently become independent survey truth or production-map geometry.

## Current inventory decision

| Asset | Decision | Allowed purpose / blocker |
|---|---|---|
| BRF-13 DJI_20260822183442_0005_D.JPG | **Demo-only** | Private byte-integrity, image-ingestion and render smoke tests only. Source says CC BY 4.0 covers imagery, but source authority/license has not been independently authenticated; the pinned SHA-256 must be checked on every new download. |
| TUM2TWIN DEBY_LOD3_4959323.gml | **Blocked** | A repository-level CC BY 4.0 lead exists, but the local rights-evidence snapshot, actual source bytes, any inherited restrictions and human decision are still missing. |
| TUM2TWIN Images.zip | **Blocked** | Zenodo v1.2.0 has no visible license value; exact derivative, commercial, display and redistribution scope is not confirmed. |
| TUM2TWIN TUM_Downtown_ULS_20241217_manual.laz | **Blocked** | Exact file rights, local byte hash, same-building mapping and use scopes remain unresolved. |
| GT-LOD3 Gold Coast collection | **Blocked** | Repository README declares CC BY 4.0 but linked STAC collection says CC-BY-NC-4.0; exact item and commercial-use terms must be clarified by the owner. |
| GT-LOD3 TUM subset | **Blocked** | Exact downloadable item IDs, per-item license coverage and same-building mapping have not been pinned. |

## BRF-13 sample limits

The historic intake workflow verified 8,343,552 bytes and SHA-256 ba7e497c124267242aec031d77f42eab3225e073ca26bf58dd61089017e2798a in run [#40493556811](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40493556811). It uploaded only a JSON report; the image was not retained in the repository. The current register records that historical result, not a permanent substitute for hashing every new acquisition.

This image may exercise source-byte verification, image ingestion and private rendering. It cannot establish:
- an independent survey reference or held-out checkpoint;
- same-building reference linkage or survey-grade dimensions;
- real-building accuracy, including a 90% accuracy claim;
- permission to redistribute the image, publish a derived model, or promote a candidate to the production map.

The published textured reference GLB comes from the same capture imagery, while the 1.997 m AprilTag bar was used as a scale control for the reference scan. They are not independent held-out truth on the current evidence.

## Private sample ingestion workflow

The next BRF-41 slice adds an allowlisted, reproducible workflow for the one demo image:

1. The workflow downloads the image into the GitHub runner's temporary workspace only.
2. `run-brf41-demo-image-smoke-test.mjs` validates the live source bytes against BRF-13's declared byte size and SHA-256 and verifies that the source pin still matches the BRF-41 admission register.
3. Only after byte verification passes, the existing private `ingestMediaFile` pipeline stores a content-addressed private copy and a source record with the declared attribution, but keeps `usageStatus=unreviewed`.
4. The existing FFmpeg image quality preflight checks decode, dimensions and bounded image metrics. One image is expected to remain **not** reconstruction-ready and **not** safe to submit to COLMAP.
5. The workflow uploads a metadata-only JSON report. Neither the source image nor the privately ingested copy is uploaded as an artifact.

Commands:

~~~bash
npm run test:brf41-demo-image-smoke
node scripts/run-brf41-demo-image-smoke-test.mjs --help
~~~

The output status `demo-smoke-tested-not-accuracy-validated` means only that byte verification, private intake and one-image decode/quality preflight succeeded. It is not a 3D model render, mesh reconstruction, independent reference, licence authentication, accuracy pass or publication decision. The CI asserts that `safeToSubmitToColmap`, `reconstructionCandidate`, `rightsApproved` and every release flag remain false.

## Policy behavior

Run:

~~~bash
npm run test:brf41-interim-dataset-policy
npm run validate:brf41-interim-dataset-policy -- benchmarks/building-reconstruction/brf-41-interim-dataset-policy.json --report artifacts/brf41-interim-dataset-policy-report.json
~~~

The validator:
- requires an explicit source record/version, admission decision, rights status and separate allowed/denied use lists;
- admits only the registered candidate image to narrowly defined private smoke tests, with source declaration, attribution and matching historic byte evidence;
- blocks unresolved TUM2TWIN and GT-LOD3 rights leads;
- rejects promotion of demo imagery to independent truth, held-out checkpoints, survey-accuracy claims, public redistribution, derived-model publication or production-map publication;
- requires a matching byte size/hash for the historic verification record, and explicitly says a new download must be re-hashed;
- keeps acceptanceEligible, publicationEligible, mapReady and automaticApproval false even when the register is policy-compliant.

This gate is a claim/use-boundary control. It does not authenticate licensing or replace BRF-38 exact-asset rights evidence, BRF-35 building linkage, BRF-39/40 deterministic replay and metric withholding, independent survey checkpoints or human review.

## Next step

Continue engineering with temporary, appropriately scoped test data and data adapters. For real-map accuracy/publication, obtain exact-file rights evidence, source bytes and same-building independent truth first. See [BRF-41 tracking issue #261](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/261) and [rights/source mapping issue #240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240).
