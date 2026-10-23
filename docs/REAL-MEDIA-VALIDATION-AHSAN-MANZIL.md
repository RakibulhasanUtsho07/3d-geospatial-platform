# Real-media validation: Ahsan Manzil

**Outcome: FAIL — not an accurate complete-building reconstruction.**  
The generated GLB is retained for review only. It must not be published to the live map as an accurate building model.

## Test setup

- Building: Ahsan Manzil (Pink Palace), Kumartoli, Dhaka, Bangladesh.
- Reference dimensions used in this experiment: overall length 125.4 m, overall depth 28.75 m, dome peak height 27.13 m. These are published reference values, not a new survey; see the Bangladesh Tourism Board / Parjatan references in [the input source manifest](../validation/ahsan-manzil-media-sources.json).
- Input media: images downloaded from Wikimedia Commons with the creator and CC BY-SA license recorded in the artifact's attribution manifest.
- External tools: FFmpeg and Ubuntu-packaged COLMAP. The packaged COLMAP build does not provide the dense CUDA/HIP MVS path or `mesh_texturer`, so the workflow used an explicitly labelled sparse-SfM-to-Poisson surface fallback. That fallback can invent geometry and is not equivalent to dense photogrammetry.
- Latest completed run with the report fixes: [run #39900708592](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39900708592) and its [downloadable model and evidence artifact](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39900708592/artifacts/12479066236). Earlier repeated attempts are linked below for reproducibility comparison.

## Main measured result

The four-photo control set is the connected cluster of the 2010 exterior/front views (files 003–006). COLMAP registered all four selected images, but they mainly see one facade.

| Metric | Reference | Latest completed GLB | Absolute relative error |
|---|---:|---:|---:|
| Long horizontal axis | 125.4 m | 125.4000 m | 0.0000013% |
| Short horizontal axis / depth proxy | 28.75 m | 37.3286 m | 29.84% |
| Vertical extent / height proxy | 27.13 m | 40.8505 m | 50.57% |

The long-axis length was calibrated to 125.4 m. Its match is **by construction**, not independent evidence. The latest run fails both independent dimensions: depth is 29.84% high and vertical extent is 50.57% high. The configured tolerances are 20% for depth and height. The overall dimensions gate therefore fails.

## COLMAP and geometry diagnostics

- Registered cameras: 4/4 in the facade-only control. The configured acceptance gate requires at least six registered images for a full-building candidate, so the set fails coverage even though the four selected photos registered.
- Sparse SfM (latest completed run): 270 points, 741 observations, mean track length 2.744, mean reprojection error 0.601 px. A low reprojection error describes camera-fit residuals; it does not prove complete 3D shape.
- Camera directions (latest completed run): maximum pairwise spread 10.924 degrees; median 5.549 degrees. This fails the 20-degree overall view-spread gate and indicates that the chosen images mostly view one facade.
- Fallback mesh: 4,416 triangles. Geometry QA found five connected components, four small detached components, 162 boundary edges and two non-manifold edges. It is a sparse-point Poisson surface, not a dense MVS reconstruction.
- Texture: unavailable in this COLMAP build. The emitted GLB uses a neutral review material; texture match against the source photos was **not tested**.
- Georeferencing: not solved. Published site coordinates / the BuildingSpec anchor are only placement hints; there is no surveyed control-point registration.

The [latest front/side/top orthographic previews and GLB](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39900708592/artifacts/12479066236) show a sparse, facade-dominated surface with disconnected islands and severe vertical distortion, not a credible complete palace volume. The same four selected inputs produced materially different dimensions despite identical downloaded source-photo SHA-256 manifests: run #39899992722 measured depth/height 87.16 m / 44.01 m; run #39900331596 measured 26.70 m / 48.43 m; latest run #39900708592 measured 37.33 m / 40.85 m. This is an explicit repeatability failure, separate from the dimension-gate failures. A full ten-image experiment ([run evidence](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39897870892)) also failed to find a good initial image pair because the selected still photos form disconnected feature-matching clusters.

## Fixes made while validating

1. Default COLMAP extraction/matching to CPU for headless runners and use supported `automatic_reconstructor` arguments.
2. Add an explicitly opt-in Poisson fallback for a review-only surface when dense MVS is unavailable.
3. Allow a neutral-material GLB when this COLMAP build lacks `mesh_texturer`, while explicitly reporting that source texture accuracy was not validated.
4. Preserve bounded COLMAP stdout/stderr in worker reports.
5. Correct GLB metric metadata during scale calibration: the vertex coordinates are physically scaled, so the calibrated output coordinates are metres and `metresPerModelUnit` must remain 1.0. A regression test covers the scale transformation and independent dimensions.
6. Update the calibrated report to describe the emitted GLB itself (output checksum, output units and output dimensions), not just the pre-calibration input; the overall report now removes the stale unscaled-model warning and explicitly says long-axis agreement is not independent evidence.

## Decision and required next evidence

**Do not merge this experimental validation workflow or this candidate into `main` as an approved building-model release.** The production building-generation engine has not passed complete-building accuracy validation on this test.

The remaining blocker is chiefly source evidence and reconstruction capability, not a passing CI test: provide an authorized continuous walk-around video or a connected set of overlapping exterior photographs spanning front, both corners, both long sides, rear, roofline and dome. Use a COLMAP build with dense MVS support (or another validated MVS backend), camera calibration, surveyed scale/control points and a reviewed vertical datum. Then repeat the same dimensional checks and compare rendered views against the corresponding source frames before marking any result map-ready.
