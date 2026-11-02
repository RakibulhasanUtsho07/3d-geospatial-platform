# BRF-10 — Survey-backed building benchmark readiness audit

**Status (27 October 2026): SOURCE TRIAGE COMPLETE; REAL-BUILDING RUN BLOCKED.**  
Tracking: [Issue #208](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/208).  
Implementation dependency: [BRF-09 PR #207](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/207), merged into `development` at `5587c98b36bced96e1f07acd7a7a365c40cdac49`. Exact-head CI and post-merge development CI passed: [run #40472128740](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40472128740) and [run #40473478338](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40473478338).

## Decision summary

GT-LOD3 is a credible **candidate source family**, but the repository metadata alone does not prove that a specific building's imagery, LOD3 model and independently acquired metric control can be paired. Do not report a real-building evaluation yet. The most promising path is to identify one TUM building for which (1) licensed UAS image inputs exist, (2) an independent manually authored LOD3 reference model can be tied to the same building, and (3) a separately acquired UAS laser-scanning point cloud covers that building. An explicit asset-to-building mapping and a verified coordinate-frame registration are mandatory.

## Evidence from public dataset documentation

### 1. GT-LOD3 Benchmark

Source: https://github.com/gdslab/GT-LOD3-Benchmark  
Publication: https://doi.org/10.5194/isprs-annals-XI-2-2026-293-2026

The repository describes 32 ground-truth LOD3 building instances across Gold Coast, Ohio and TUM, Germany. It lists photogrammetric UAS point clouds, corresponding images, point-cloud labels and ground-truth LOD3 models. The TUM subset contains UAS imagery and photogrammetric point clouds; its CityGML LOD3 model was manually created and includes façade details. The README states CC BY 4.0 for the benchmark repository/dataset and gives an attribution instruction.

**Important independence limitation:** a photogrammetric point cloud generated from the same UAS images used for the candidate is not, by itself, an independent survey control. It can be a supplementary comparison, but it must not be represented as independent solely because it is stored as a separate file. The manually authored LOD3 model is an independent reconstruction reference only after its building identity, modelling provenance and alignment are checked.

### 2. TUM2TWIN UAS laser-scanning data

Dataset documentation: https://tum2t.win/datasets/pc-uas  
Zenodo latest record viewed during this task (Version 1.2.0, published 25 April 2025): https://zenodo.org/records/15282970

The TUM2TWIN page describes point clouds captured by a DJI Matrice 350 RTK UAS with a Zenmuse L2 laser scanner, georeferenced using integrated RTK GNSS; it also describes oblique flights for façades. This is a promising *different sensing modality* from the photogrammetric images. The Version 1.2.0 Zenodo record lists 20.0 GB of files (displayed data volume 21.9 TB across all downloads). The proposed survey input `TUM_Downtown_ULS_20241217_manual.laz` is listed as 2.8 GB with page MD5 `37ce114fb348fb28066cc967cde9771d`; `TUM_Downtown_ULS_20241217_manual_5mm_fillparts.laz` is 687 MB with MD5 `ed46079bee78f4dc939dbfa5dc2c61e8`. These MD5 values are catalog hints only, not SHA-256 and not proof that a local download has been verified. The page has a newer version label than the older record previously reviewed, but its visible License field is blank; therefore this audit does not approve reuse of the ULS files. Pin the exact version and verify asset-specific rights before download/reuse.

**Rights gate:** the GT-LOD3 README's CC BY 4.0 statement must not automatically be applied to every separate TUM2TWIN/Zenodo asset. The viewed Zenodo record did not expose a clear asset-level licence in the retrieved metadata. Before using or redistributing any selected raw image/point-cloud asset, verify the exact record version, file-level licence/attribution and any additional dataset terms. If rights cannot be established, use that asset only as an unapproved research lead and do not place it in CI artefacts.

## Why no real-building result is claimed yet

- No specific building has yet been confirmed as present in all selected image, CityGML/LOD3 and UAS-laser-scan sources.
- The public catalogue metadata is not a source manifest: exact file URL, exact version, byte count, checksum, licence and source citation must still be recorded for each selected asset.
- The UAS laser-scan CRS, axis convention, horizontal/vertical units, vertical datum and local frame must be read from its acquisition documentation and matched to the selected reference model. We must not guess the transform from visual alignment.
- The platform has not yet produced and pinned an engine-generated candidate GLB from the chosen image inputs for this sample.
- A reference JSON, surveyed footprint/dimensions and genuinely held-out control/check points have not yet been prepared for a real sample.
- Dataset ground-truth model files must never be passed off as candidate output from this platform. The independent truth and candidate GLB must have separate provenance/hashes and separate source paths.

## New code gate

The new `assess:building-benchmark-readiness` CLI and `test:building-benchmark-readiness` suite in PR #209 validate the declared source manifest's building identity, asset hashes/metadata, per-asset rights review, candidate/reference separation, coordinate transforms, fit controls and held-out point bindings. A `manifest-complete` report is **metadata preflight only**: the CLI does not download assets or independently verify file bytes, licence terms, survey truth or registration. Real file checksums and the existing BRF-09 prepare/evaluate CLIs are still required.

## Required intake record

For each proposed asset record, capture:

| Field | Required value |
|---|---|
| Dataset/source | Exact name, publisher, DOI/version or commit |
| Building identity | Stable building ID plus evidence that all assets cover the same physical building |
| Asset | Direct source URL and original filename |
| Rights | Exact licence/terms, attribution, reviewed-by and review date |
| Integrity | SHA-256 of downloaded bytes; byte count; media/geometry format |
| Capture | Sensor, acquisition date, image/view IDs and relevant metadata |
| Geometry frame | CRS/frame ID, axes, units, georeferencing method, height datum and known uncertainty |
| Independence | Why the reference/control is independent of candidate fitting and image reconstruction |
| Transform | Documented source-to-evaluation matrix and how it was derived |
| Held-out controls | Stable IDs, independent measurement source, measurement uncertainty and proof they were not used for fitting/alignment |
| Candidate | Engine-generation command/config, exact input hashes and resulting GLB SHA-256 |

## Execution protocol

1. Confirm rights and exact file pairing before processing.
2. Choose a manageable, single-building crop only after the original LAS/LAZ metadata and extent are verified. Keep large raw source archives external; avoid storing multi-gigabyte source archives in Git history.
3. Create the candidate GLB through the platform reconstruction path using the selected allowed image inputs. Hash and preserve the exact candidate.
4. Independently derive the reference geometry from the verified LOD3 model and corroborate it with the separate laser point cloud where valid. Record whether any point-cloud-derived surface is incomplete or occluded.
5. Assign a single documented metric evaluation frame. Fit/register using declared control points only. Keep held-out reference checkpoints out of registration and geometry fitting.
6. Bind candidate checkpoints to actual GLB scene-node/primitive/POSITION vertex indices. Reference check-point coordinates must originate from the independent control source; never fabricate them from the candidate.
7. Run:
   ```bash
   npm run test:independent-building-truth
   npm run prepare:independent-building-truth -- configs/<evaluation>.json artifacts/independent-building-truth/<evaluation>-prepared-manifest.json
   npm run evaluate:independent-building-truth -- artifacts/independent-building-truth/<evaluation>-prepared-manifest.json artifacts/independent-building-truth/<evaluation>-report.json
   ```
8. Inspect dimension errors, footprint area/boundary errors, held-out checkpoint residuals, surface-distance summaries, transform metadata, every source hash and each failed/incomplete check. Human-review the exact report and source artefacts.

## Fail-closed policy

- If asset identity, rights, frame registration or independent control provenance cannot be verified, mark the sample **BLOCKED** or **NOT_COMPARABLE**, not PASS.
- If no true held-out checkpoints can be justified, the report must remain incomplete.
- The software's sampled surface-distance metric is not a continuous Hausdorff-distance proof. The convex-hull footprint is not a surveyed wall outline and loses courtyard/concavity detail.
- Keep `acceptanceEligible`, `publicationEligible`, `mapReady` and automatic approval false until real-data metrics and a human sign-off actually justify a later change.
- This audit is a source-readiness result, not an accuracy benchmark or a release approval.


## Updated source triage — 27 October 2026: TwinWorld alternative

A third source family was checked after the BRF-11 local-byte verifier merged. The [TwinWorld 2026 dataset card](https://huggingface.co/datasets/Zqlin/TwinWorld_Datasets) reports **CC BY-NC 4.0** and a total dataset size of about **1.5 GB**. It packages selected scenes from TUM2TWIN and GT-LOD3 with images, COLMAP camera records, initialization point clouds, and scene point-cloud geometry for some development scenes.

This is not an admissible source for validating a workflow intended for commercial product use unless the rights holder grants appropriate additional permission. The non-commercial dataset terms are explicit; the data's convenience does not make it commercially cleared.

There is also a methodological limitation: the dataset card says train and test images in a scene share one joint COLMAP world frame, and its triangulated `points3D` includes all images. Therefore a folder called `test` is not itself an independent survey holdout. Where available, `3d_gt/point_cloud.ply` is scene-level point-cloud geometry, not a fully surveyed, per-building LOD3 mesh with independently surveyed held-out checkpoints. It could support a separately rights-approved, non-commercial pipeline smoke test, but cannot by itself discharge BRF-10's whole-building metric acceptance gate.

Official source pages reviewed:
- [TwinWorld 2026 dataset card and declared license](https://huggingface.co/datasets/Zqlin/TwinWorld_Datasets)
- [GT-LOD3 benchmark repository and CC BY 4.0 statement](https://github.com/gdslab/GT-LOD3-Benchmark); its linked Gold Coast STAC collection did not provide a working exact sample URL during this audit.
- [TUM2TWIN UAS laser-scanning record, version 1.2.0](https://zenodo.org/records/15282970); the visible record-level licence field is blank, so the asset is not treated as rights-cleared.
- [TUM2TWIN UAS photo acquisition documentation](https://tum2t.win/datasets/im-uas) and [UAS laser-scanning documentation](https://tum2t.win/datasets/pc-uas), which describe co-campaign acquisition and RTK georeferencing but do not, on these pages, resolve the per-asset licence question.

### Decision

**No source is admitted to the real-building acceptance run yet.** A working URL alone is insufficient: the same physical building must be paired across image and reference assets; every exact file/version needs a suitable rights decision, verified bytes, coordinate-frame/vertical-datum metadata, and independently held-out metric controls. Do not download or commit a large archive while licence and intended-use compatibility remain unresolved.

**Next action:** obtain a rights-cleared source with a working exact asset link and a defensible same-building independent-survey pairing; then use the BRF-10 manifest preflight and BRF-11 local byte verifier before candidate reconstruction.


### Correction from direct STAC collection metadata inspection — 27 October 2026

The direct STAC collection metadata endpoint is readable at [the collection JSON URL](https://stac.d2s.org/api/v1/collections/ee10a5c0-2554-44e5-b59f-81eedfe02eb6). Its current response identifies the collection as **Gold Coast** and declares `license: CC-BY-NC-4.0`, with contact `jinha@purdue.edu`. This conflicts with the broader repository README's CC BY 4.0 statement. The collection's `items` link did not resolve through this audit tool, and no exact file-level asset URL/checksum was recovered.

For intake decisions, do **not** normalize this discrepancy in favour of the more permissive licence. Treat the collection and derivative source files as **commercial-use blocked** until the data owner clarifies the applicable terms in writing and provides a working exact item/file URL. The source-selection result remains blocked, even though the collection metadata endpoint itself is accessible.


## Additional candidate imagery source — BRF-13 (27 October 2026)

A smaller, rights-declared imagery source is now recorded in [BRF-13 source-intake report](./BRF-13-DRONE-IMAGE-SOURCE-INTAKE.md). The [Hugging Face dataset card](https://huggingface.co/datasets/Matt1up/drone-building-scans) and [upstream repository](https://github.com/Matt1Up/drone-building-scans-dataset) declare CC BY 4.0 for the imagery and publish camera poses and checksums. One image entry has been selected with a direct URL and upstream expected size/SHA-256; the dedicated workflow will download it to ephemeral runner storage and verify actual bytes without uploading the source image or committing the 16 GB collection.

**Important scope:** the imagery license is source-declared and not independently authenticated. The README says the license covers imagery; the separate reference GLB is not assumed licensed. The flat-roof reference model was generated from the same capture images and the 1.997 m AprilTag bar was used as a scaling control, so neither can automatically be treated as independent held-out geometry truth. This source may qualify as a commercial-use *imagery input candidate* after byte verification and rights review, but it does not by itself discharge BRF-10 whole-building survey-backed acceptance. All acceptance/publication/map/automatic-approval flags remain false.


## Next concrete action — BRF-20 multi-view review packet (27 October 2026)

[Issue #222](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/222) tracks the review prerequisite for the BRF-14 image sample. The implementation branch prepares a source-hash-bound contact sheet, an explicitly non-georeferenced camera-angle plot, and a JSON manifest with per-view review fields. It verifies exact local bytes again before decoding and emits only derived review artifacts.

This resolves a tooling gap, not the human-review gap. Until a reviewer records same-building identity, actual overlap, coverage/occlusion and source-axis interpretation with a name and UTC timestamp, do not invoke COLMAP with confirmation flags. After that review, an engine-generated candidate GLB can be attempted and its own hash/provenance retained. It will still be only a candidate: the current flat-roof imagery, source COLMAP model, upstream reference mesh and 1.997 m scaling bar do not constitute independent held-out survey truth. Do not calculate a real-building accuracy score until the independent reference and at least six held-out metric checkpoints meet BRF-10 requirements.


## BRF-21 — local-feature overlap diagnostics added (27 October 2026)

[Issue #224](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/224) tracks the next review aid added after BRF-20. The pinned sixteen-view sample now has a deterministic, hash-bound pairwise local-feature/geometric-consensus report and a derived network graph in the dedicated CI workflow. The report is useful for prioritizing which pairs a reviewer should inspect, including frames with zero/small candidate-edge degree.

This remains software-generated triage. It cannot confirm same-building identity, rights, camera calibration or source up-axis, and can return false matches on repetitive surfaces. Even when candidate edges appear plausible, no reconstruction is run with implicit confirmation flags. A platform-generated candidate GLB may only be attempted after the required review decisions are explicitly recorded; independent survey truth and held-out checkpoint validation remain separate blockers under BRF-10.


## Multi-view human review contract (BRF-22)

BRF-14 byte verification and BRF-20/21 visual evidence are prerequisites for manual review, not evidence that the chosen frames depict the same building. [BRF-22 Issue #226](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/226) adds a hash-bound decision record for source identity, pairwise overlap, per-view coverage/occlusion, source up-axis interpretation and a separate rights decision. Until a real reviewer supplies a complete record, image identity/overlap/up-axis remain blocked. Even a completed review is not independent survey truth: a candidate engine-generated GLB, independently sourced metric controls and held-out checkpoint evaluation are still required. All release flags stay false.


## Follow-up source and acceptance audit — 31 October 2026

**Decision remains: REAL-BUILDING ACCURACY RUN BLOCKED.** This is a source-readiness update, not a benchmark result.

### Rights conflict and asset-admission boundary

- The [GT-LOD3 benchmark README](https://github.com/gdslab/GT-LOD3-Benchmark) states CC BY 4.0 for the benchmark. However, the direct [Gold Coast STAC collection metadata](https://stac.d2s.org/api/v1/collections/ee10a5c0-2554-44e5-b59f-81eedfe02eb6) declares `CC-BY-NC-4.0`. These statements conflict. Do not choose the more permissive README statement for Gold Coast source files; keep the collection and its derivatives blocked for commercial product validation until the data owner provides written clarification for the exact assets and intended use.
- The [TUM2TWIN/Zenodo record version 1.2.0](https://zenodo.org/records/15282970) displays a License heading without a licence value in the inspected record metadata. TUM2TWIN UAS acquisition pages describe the data as openly available, but that wording alone does not establish the licence and derivative-use scope for each exact image, point-cloud or reference-model file. Do not inherit the separate GT-LOD3 repository licence automatically.
- The [TwinWorld dataset card](https://huggingface.co/datasets/Zqlin/TwinWorld_Datasets) declares CC BY-NC 4.0; it is not an admissible source for commercial product validation absent an additional written grant.
- BRF-13 drone imagery is an imagery-input candidate only: its associated reference mesh was generated from the same imagery and the scale bar was not an independent held-out survey, so it cannot be treated as independent geometry truth.

### Measurement independence requirements remain unmet

A valid benchmark must bind (a) a candidate GLB generated by this platform from permitted source media, (b) a separate independently sourced metric reference, and (c) genuinely held-out control/check points that were not used for fitting or registration. The candidate and reference must share a documented metric frame with justified horizontal and vertical datum handling; source uncertainty and transform provenance must be recorded. At least six independent held-out metric checkpoints are required by this pilot protocol. A photogrammetric point cloud produced from the same UAS imagery is not independent survey truth merely because it is a different file. Dataset availability, a valid hash, a green CI run or a source-to-source comparison does not establish candidate reconstruction accuracy.

### Next admissible sequence

1. Obtain written, asset-specific rights/attribution clarification for the exact imagery, point-cloud and reference-model files and the intended derivative/commercial use.
2. Select one physical building only after documenting the identity link between its permitted images, independent reference model and separately acquired survey/point-cloud source.
3. Download only the bounded selected assets after rights review; verify actual byte length and SHA-256 and preserve acquisition/version provenance.
4. Resolve the horizontal CRS/axis/units, vertical CRS or geoid/datum, metric evaluation frame and transform evidence. Do not substitute a within-dataset alignment matrix for a candidate-to-reference transformation without validating its applicability.
5. Generate the candidate through the platform reconstruction pipeline and pin its exact GLB/input/config hashes. Keep fit controls separate from at least six independent held-out checkpoints.
6. Run the signed-review-authorized independent-geometry preparation/evaluation path, inspect footprint, dimensions, checkpoint and optional surface residuals, then have a human review the source and report bundle.

Until those conditions pass, keep the candidate status `BLOCKED` or `NOT_COMPARABLE`; do not report an accuracy percentage or promote a model to the published map.
