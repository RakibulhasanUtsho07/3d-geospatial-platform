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
