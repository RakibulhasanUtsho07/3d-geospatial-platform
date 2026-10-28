# BRF-29 — asset rights and one-building selection

**Status:** BLOCKED / source-rights evidence separated from acceptance  
**Tracking issue:** [#240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240)  
**Target branch:** development

## Purpose

This stage must identify which exact files may be used, converted, displayed, redistributed, or included in a product, then bind one building across candidate images, an independent-sensor reference crop, and a specific reference model. It does not treat open data, a repository-level licence, or a campus-wide dataset as automatic approval of every file in that dataset.

The machine-readable matrix is [brf-29-rights-and-building-mapping.json](../../benchmarks/building-reconstruction/brf-29-rights-and-building-mapping.json). The registry intentionally contains no selected GML ID, no exact reference file, and no approved raw-image/ULS licence. All release flags remain false.

## What the inspected public sources currently establish

- **Zenodo TUM Downtown record v1.2.0:** [source record](https://zenodo.org/records/15282970). It lists Images.zip and TUM_Downtown_ULS_20241217_manual.laz (among other files) and calls the dataset open, but our reviewed record view did not expose a specific asset-level licence value. The registry keeps the imagery and ULS rights unresolved. Dataset Open is not treated as a licence name.
- **GT-LOD3 Benchmark:** [public repository README](https://github.com/gdslab/GT-LOD3-Benchmark) explicitly says the benchmark dataset is released under CC BY 4.0 and describes a TUM subset with 28 manually modelled LOD3 building instances. This is the clearest public licence statement for the GT-LOD3 dataset itself. A specific TUM model file and building ID still need to be selected, provenance-matched and byte-pinned before that reference can be used.
- **TUM2TWIN model repository:** the [public GitLab data repository](https://gitlab.lrz.de/tum-gis/tum2twin-datasets) has a root `LICENSE` whose contents were fetched at commit `e032a71fc9b3c9c3d4869e3aca9677d1234086aa`; it begins `Attribution 4.0 International` and has SHA-256 `9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411`. A metadata-only inventory found 27 GML files in the LOD3 catalog. The repository licence evidence is now recorded, but a human must still review its scope, exceptions and use-specific rights for the exact model before publication. It does not license the distinct Zenodo imagery/ULS archive.
- **Model derivation:** the [TUM2TWIN semantic-model page](https://tum2t.win/datasets/cm-buildings) says individual LOD3 models are manually modelled based on official LOD2 models plus additional mobile-laser-scan point clouds. This provenance must be reflected in any accuracy claim: a model can be a useful reference, but its derivation does not by itself make every geometric dimension an independent survey checkpoint.

## Required steps to unblock

1. **Rights scope:** for each intended image, ULS crop, trajectory, metadata and reference model, record the exact source/version/file and applicable licence/permission. Store required attribution and modification notices, and state whether commercial platform use, public model display and model-file redistribution are allowed. If the licence is not explicit, keep it pending and request written clarification from the asset owners.
2. **Pick the exact reference model:** choose one GT-LOD3 TUM building GML ID only after confirming the model file, its licence scope and provenance. Do not substitute a campus-level CC BY statement for file identification.
3. **Bind the same building:** produce evidence that the chosen UAS image frames, ULS point crop and GT-LOD3/TUM2TWIN model describe the same building, including view/roof/facade coverage and location. Keep all asset IDs and evidence links stable.
4. **Pin chosen bytes:** download only the selected source files/crops after rights review; record actual byte sizes and SHA-256. Do not use publisher MD5 as SHA-256. The existing 8 MiB ULS-prefix digest is not a whole-file hash.
5. **Resolve metric frames:** reconcile the PDF local XYZ wording with EPSG:32632 in the header, name the vertical datum/geoid or explicitly document why it remains unavailable, and approve source-to-evaluation transforms from traceable evidence.
6. **Run the model test only after input eligibility:** generate a platform candidate GLB via the engine's approved path, extract its real vertex geometry, and use at least six independent held-out checkpoints that were not used for model fitting. Execute BRF-25/26 and obtain a separate human visual review.

## Fail-closed contract

The registry regression test must fail if the initial fixture acquires an unreviewed selected building or any release flag becomes true. A source-declared CC BY 4.0 label is recorded with its stated scope; it is not a substitute for exact file selection, attribution, or same-building evidence. No acceptance, publication, map-readiness or automatic-approval flag may be set by this document or its tests.
