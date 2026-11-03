# BRF-13 — Commercial drone-image source intake

**Date:** 27 October 2026  
**Status:** Candidate source selected; actual-byte verification is delegated to the scoped GitHub Actions intake workflow. This is not a building-accuracy pass.

## Selected source lead

- Dataset card: https://huggingface.co/datasets/Matt1up/drone-building-scans
- Source repository: https://github.com/Matt1Up/drone-building-scans-dataset
- Source repository commit pinned for the public image manifest: `19b3ce9cccf3e8fd414ff705f75d0f2105846fc1`
- Dataset card declares **CC BY 4.0**. The source README narrows its explicit claim by saying the licence covers the imagery; this intake therefore covers one image only and does **not** presume that the separate photogrammetry reference GLB has the same licence.
- Source attributes the capture to Matthew Guertin and recommends: `Drone Building Scans — Matthew Guertin, 2026. CC BY 4.0. https://github.com/Matt1Up/drone-building-scans-dataset`
- Intended use here: a small candidate-image byte-integrity smoke test, not a redistribution of the 16 GB dataset.

## Pinned image record

The upstream `manifest/flat-roof/images.csv` and `checksums.sha256` at the source-repository commit above declare the following for one image:

| Field | Declared value |
|---|---|
| Building group | `flat-roof` — single-storey commercial building |
| Original filename | `DJI_20260822183442_0005_D.JPG` |
| Direct download URL | https://huggingface.co/datasets/Matt1up/drone-building-scans/resolve/main/flat-roof/images/DJI_20260822183442_0005_D.JPG |
| Byte size | 8,343,552 |
| SHA-256 | `ba7e497c124267242aec031d77f42eab3225e073ca26bf58dd61089017e2798a` |
| Dimensions | 4096 × 3072 |
| Capture timestamp in source CSV | 2026-08-22 18:34:42 |
| GPS as declared in source CSV | 45.0516675277778, -93.3914331111111 |
| Upstream file manifest | https://github.com/Matt1Up/drone-building-scans-dataset/blob/19b3ce9cccf3e8fd414ff705f75d0f2105846fc1/manifest/flat-roof/images.csv |
| Upstream checksum list | https://github.com/Matt1Up/drone-building-scans-dataset/blob/19b3ce9cccf3e8fd414ff705f75d0f2105846fc1/manifest/flat-roof/checksums.sha256 |

The file URL currently resolves through the Hugging Face dataset service. Its `main` reference is mutable; the downloaded byte size and SHA-256 must match the pinned source manifest or the intake fails closed. This repository's GitHub Action downloads the file only into runner temporary storage, verifies the bytes, and uploads only a JSON verification report. It does not commit or upload the source image.

## Implementation

- Source declaration: `benchmarks/building-reconstruction/brf-13-drone-image-source.json`.
- Verifier: `scripts/verify-brf13-drone-image-source.mjs` checks the allowlisted source URL, a regular non-symlink file, the expected byte size, and SHA-256 of the actual downloaded bytes. It has a 100 MiB file bound.
- Regression tests: `tests/brf13-drone-image-source-intake.test.mjs` cover matching bytes, same-size hash mismatch, byte-size mismatch, URL allowlist, symlink rejection, CLI report and fail-closed flags.
- Workflow: `.github/workflows/brf-13-drone-image-intake.yml` runs for this scoped change against `development` and uploads the verification JSON only; it does not retain the image itself.
- **Actual-byte result:** dedicated GitHub Actions run [#40493556811](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40493556811) succeeded (10/10 steps) on exact head `ecd69ac49f31d24e81b13ec6b04dcc1d1dd984c9`. The downloaded file measured **8,343,552 bytes** and its computed SHA-256 was `ba7e497c124267242aec031d77f42eab3225e073ca26bf58dd61089017e2798a`, matching the upstream declarations. Artifact [#12729186366](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40493556811/artifacts/12729186366) contains only the JSON byte-verification report; the image itself remained in runner temporary storage and was not uploaded or committed. This validates byte identity only, not source-owner authority, rights, building identity or independent survey truth.

## What this source does not solve

1. The published flat-roof reference GLB is a textured photogrammetry model generated from the same capture image set. It is not an independently acquired survey and cannot be used as independent geometry truth for candidate acceptance.
2. The dataset says the 1.997 m AprilTag bar was used as control when scaling the flat-roof scan. That same bar cannot be treated as a held-out checkpoint for that scan without leakage.
3. No independent surveyed whole-building footprint, wall outline, dimensions, separate laser scan, vertical datum, or independently held-out checkpoint set has been established for this exact building.
4. The source licence declaration and the uploader's authority have not been independently authenticated; trademark/signage rights are separately noted by the source.

Accordingly this dataset is a **candidate imagery source** and may support a bounded byte-integrity/reconstruction smoke test after rights review. It is not admitted as the BRF-10 survey-backed acceptance benchmark. `acceptanceEligible`, `publicationEligible`, `mapReady`, and automatic approval remain false; no `main` promotion follows from this intake.

## Next action

Obtain an independently surveyed model or laser-scanning reference for this exact building under compatible, explicit reuse terms, plus metric frame/vertical-datum documentation and genuinely held-out controls. If that pairing cannot be obtained, retain this dataset solely as an imagery/source-camera test and keep the real-building accuracy benchmark blocked.
