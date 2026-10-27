# BRF-14 — Pinned multi-view candidate-image intake

**Date:** 27 October 2026  
**Status (27 October 2026):** source manifest and fail-closed verifier are merged into `development`; the BRF-20 branch adds a hash-bound visual review packet after exact-byte verification. Human overlap/identity review and real-building accuracy remain **BLOCKED** until the packet is generated and signed off.  
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


## BRF-20 — Human-review packet before COLMAP

Tracking: [Issue #222](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/222).

After downloading the sixteen manifest-listed JPEGs to ephemeral runner storage and passing the existing byte verifier, the BRF-20 workflow creates:

- `multiview-contact-sheet.png`: four-column contact sheet with stable view ID, filename, capture timestamp, source-reported camera-angle metadata, local camera-centre fields, and abbreviated exact SHA-256.
- `camera-angle-coverage.png`: source-reported azimuth/elevation scatter plot. It is not a georeferenced camera plan and does not establish visual overlap.
- `multiview-review-manifest.json`: per-view exact hashes and metadata, reviewer/UTC-time fields, explicit pending review categories, output hashes, limitations and fail-closed release flags.

Only the verifier report, PNG contact sheet, PNG angle plot and JSON review manifest are eligible for upload. Raw images remain in runner temporary storage and are not uploaded.

The packet is deliberately **not** a COLMAP run. A reviewer must record same-building identity, visual overlap, occlusion/coverage and the source up-axis before the current reconstruction CLI's explicit confirmation flags can be supplied. The imagery licence remains source-declared and has not been independently authenticated; the packet does not approve rights or survey accuracy.
