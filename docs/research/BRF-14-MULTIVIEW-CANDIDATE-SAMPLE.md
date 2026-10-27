# BRF-14 — Pinned multi-view candidate-image intake

**Date:** 27 October 2026  
**Status:** source manifest and fail-closed local-byte verifier implemented on `feat/brf-14-multiview-source-intake`; exact downloaded-byte workflow and full CI must pass before this intake is called verified. **Real-building accuracy remains BLOCKED.**  
**Tracking:** [Issue #208](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/208).

## Why this stage exists

BRF-13 established that one image in the Drone Building Scans dataset can be downloaded into runner temporary storage and that its local byte count/SHA-256 matches the pinned upstream inventory. A single image does not establish a multi-view candidate capture for the same building. BRF-14 pins a bounded set of sixteen images from the upstream `flat-roof` capture and verifies each downloaded image's exact bytes.

The sample uses source-reported capture metadata and a pose-aware azimuth-spread selection from the upstream camera-pose file. The view-selection heuristic is not a human review of actual overlap, façade completeness, camera calibration or architectural accuracy.

## Pinned source and sample

- Dataset card: https://huggingface.co/datasets/Matt1up/drone-building-scans
- Upstream repository: https://github.com/Matt1Up/drone-building-scans-dataset
- Metadata commit: `19b3ce9cccf3e8fd414ff705f75d0f2105846fc1`
- Image inventory: https://github.com/Matt1Up/drone-building-scans-dataset/blob/19b3ce9cccf3e8fd414ff705f75d0f2105846fc1/manifest/flat-roof/images.csv
- Image checksum list: https://github.com/Matt1Up/drone-building-scans-dataset/blob/19b3ce9cccf3e8fd414ff705f75d0f2105846fc1/manifest/flat-roof/checksums.sha256
- COLMAP camera poses: https://github.com/Matt1Up/drone-building-scans-dataset/blob/19b3ce9cccf3e8fd414ff705f75d0f2105846fc1/poses/flat-roof/colmap/images.txt
- Sample manifest: `benchmarks/building-reconstruction/brf-14-multiview-source.json`
- Selected views: 16
- Declared combined image bytes: 181,235,712 (approximately 173 MiB)
- Upstream reports 951 aligned images for this capture, but this intake downloads only the selected sixteen.

The source README declares CC BY 4.0 and states the licence covers imagery. The stored rights status is explicitly source-declared and not independently authenticated. This intake does not assume that the separate reference GLB/OBJ, visible trademarks or signage use the same licence.

## Coordinate-frame handling

The manifest retains each view's source GPS latitude, longitude and altitude as metadata, plus its upstream COLMAP camera-centre and camera-pose fields. These coordinate spaces are deliberately kept separate:

- The source inventory supplies WGS-84-style latitude/longitude and altitude, but the altitude's vertical datum is not declared and the metadata is not accepted as independent survey control.
- The local COLMAP world frame is described by the source as metric-scaled using a 1.997 m AprilTag bar. The intake does not claim an EPSG identifier, validated axis mapping, or a transformation between that local frame and GPS.
- Azimuth/elevation and look-angle values in the manifest describe source camera coverage relative to the mean camera centre derived from the complete source reconstruction. That mean is not represented as a surveyed building centroid.

No georeference transform is inferred from visual alignment.

## Actual-byte verifier and CI

`scripts/verify-brf14-multiview-source.mjs` verifies:

1. Source URLs and metadata URLs match the allowlisted hosts/paths and pinned upstream commit.
2. The expected file count, filenames, unique IDs/checksums, byte declarations, image dimensions and total byte budget are valid.
3. Every local asset is a regular non-symlink file directly below the explicit asset root.
4. Streaming SHA-256 and actual byte count match every manifest declaration.
5. All release flags remain false in the report.

The dedicated workflow downloads the selected images into ephemeral runner storage, computes the verification report, and uploads only that JSON report. It does not upload or commit the raw source images. The normal CI runs manifest/path/hash regression tests and the verifier CLI help smoke test.

Usage after the images have been downloaded into a folder:

```sh
node scripts/verify-brf14-multiview-source.mjs \
  --manifest benchmarks/building-reconstruction/brf-14-multiview-source.json \
  --asset-root path/to/downloaded-images \
  --report artifacts/brf-14/multiview-source-byte-verification.json
```

A successful report means only that the selected local files match the pinned size/SHA values and that the source/frame metadata contract passed. It is not a licence authentication, COLMAP re-run, candidate GLB, survey validation or accuracy score.

## What remains blocked

- This PR's verifier does not generate a candidate GLB. Candidate generation still requires the platform reconstruction workflow with reviewed same-building identity, image overlap and explicit source-up-axis confirmation. Those confirmations cannot truthfully be inferred from a manifest alone.
- A candidate generated from these source images must have its own output hash and provenance. The upstream textured GLB/OBJ were reconstructed from the same image set, so neither can be used as independent held-out truth.
- The documented 1.997 m AprilTag was a scale control for the upstream reconstruction; it is not an independent held-out building checkpoint for that same reconstruction.
- No independent laser scan/survey/CAD/BIM reference has yet been paired and rights-cleared for this exact building. No independently surveyed footprint, dimensions or held-out metric checkpoints are supplied by this intake.
- A source-frame registration, vertical datum, held-out controls, actual engine candidate, geometry evaluation report and independent human sign-off remain outstanding.

**Decision:** BRF-14 is an image-source byte-intake step only. Keep the real-building sample `BLOCKED` for accuracy and keep `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false. Do not promote this work to `main` on source-byte validation alone.
