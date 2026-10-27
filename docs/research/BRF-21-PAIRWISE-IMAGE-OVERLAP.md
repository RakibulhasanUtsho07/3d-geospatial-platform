# BRF-21 — Pairwise image-overlap evidence graph

**Date:** 27 October 2026  
**Status (27 October 2026):** merged into development at SHA 5f7f9ecf93bb43107be5f650b07ea059becaf4fe (PR #225). Exact-head full CI [run #40534364915](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40534364915) and dedicated intake/overlap workflow [run #40534364849](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40534364849) succeeded. Post-merge development CI is tracked separately in [run #40535822648](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40535822648).  
**Tracking:** [Issue #224](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/224).  
**Parent:** [BRF-10 survey-backed building benchmark](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/208).

## Objective

Use the exact BRF-14 source-image bytes and BRF-20 review packet to produce a repeatable, hash-bound pairwise visual-feature graph before the operator attempts COLMAP reconstruction. Camera-position azimuth coverage gives viewpoint spread but is not a measurement of actual image content overlap.

## Method

`scripts/analyze_brf14_multiview_overlap.py` revalidates the BRF-14 byte-verification report and recomputes each image's actual SHA-256 and byte size before decoding. It downsizes grayscale imagery to at most 960 pixels on the longest edge and runs a pinned OpenCV ORB configuration with a fixed random seed and single-thread execution. Hamming descriptor matches are ratio-filtered and made one-to-one. It then evaluates RANSAC homography and fundamental-matrix consensus where sufficient matches are available.

The report contains all (N(N-1)/2) unordered view pairs, including:
- stable view IDs, filenames and the exact source SHA-256 for both sides;
- per-image keypoint counts, ratio-filtered match counts, geometric model and inlier metrics;
- a labelled candidate-edge boolean, fixed thresholds and an explicit no-edge reason;
- the selected input byte-verification report hash, analyzer configuration/version, and derived graph PNG hash.

Candidate-edge thresholds are review heuristics only: at least 12 ratio-filtered matches, at least 10 geometric inliers and an inlier ratio of at least 0.20. These are not calibrated accuracy thresholds and are not claimed to be scientifically optimal for all buildings.

## Outputs and data handling

The dedicated BRF-14 workflow downloads source images to ephemeral CI storage, verifies exact bytes, creates the BRF-20 contact sheet, runs this diagnostic and uploads only derived JSON/PNG files. Raw images and any upstream reference meshes/point clouds are not included in the artifact.

## How to interpret the graph

A strong edge is a proposal for visual review, not evidence of identity by itself. Repeated roof, pavement, landscaping or façade textures can generate false correspondences. A weak or absent edge can be caused by lighting, blur, occlusion, camera displacement or limited texture and does not prove that two images show different buildings. Every pair is therefore retained with measured counts and failure reasons.

Human-review fields remain pending until an authorized review records identity, useful overlap/coverage, occlusion, source-axis interpretation, reviewer and UTC timestamp. The analyzer does not set those values. It does not run COLMAP, create a candidate GLB, establish a GPS/COLMAP transform, produce independent survey truth, or calculate accuracy.

All `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` flags remain false.


## BRF-22 — Hash-bound human-review decision contract

Tracking: [Issue #226](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/226). The next stage provides a template and validator that bind the BRF-20 review manifest, BRF-21 pair report, contact sheet, camera-angle plot and overlap graph to their exact SHA-256 and byte sizes. It records explicit reviewer identity and UTC time, same-building identity, per-view quality/occlusion/surface notes, per-pair overlap decisions, source up-axis interpretation, and separate asset-rights status.

The BRF-21 source run produced 16 views and evaluated all 120 unordered pairs. Fourteen pairs were proposed as candidate edges; four views had no candidate edge. The [derived CI artifact](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40534364849/artifacts/12747786071) contains review materials only, not source images. These counts are image-feature triage, not confirmed overlap, building identity or accuracy evidence.

No real-building human decision has been entered. BRF-22 templates remain pending until an authorized reviewer fills them in. The validator cannot authenticate the reviewer or legal rights, does not run COLMAP, produces no candidate GLB or survey result, and always keeps acceptance/publication/map/automatic-approval flags false.
