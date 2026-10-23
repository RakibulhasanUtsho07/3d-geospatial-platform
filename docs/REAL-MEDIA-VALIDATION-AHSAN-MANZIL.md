# Real-media validation: Ahsan Manzil

**Outcome: FAIL — not an accurate complete-building reconstruction.**  
The generated GLB is retained for review only. It must not be published to the live map as an accurate building model.

## Test setup

- Building: Ahsan Manzil (Pink Palace), Kumartoli, Dhaka, Bangladesh.
- Reference dimensions used in this experiment: overall length 125.4 m, overall depth 28.75 m, dome peak height 27.13 m. These are published reference values, not a new survey; see the Bangladesh Tourism Board / Parjatan references in [the input source manifest](../validation/ahsan-manzil-media-sources.json).
- Input media: images downloaded from Wikimedia Commons with the creator and CC BY-SA license recorded in the artifact's attribution manifest.
- External tools: FFmpeg and Ubuntu-packaged COLMAP. The packaged COLMAP build does not provide the dense CUDA/HIP MVS path or `mesh_texturer`, so the workflow used an explicitly labelled sparse-SfM-to-Poisson surface fallback. That fallback can invent geometry and is not equivalent to dense photogrammetry.
- Latest measured run: [run #39899992722](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39899992722) with its [downloadable model and evidence artifact](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39899992722/artifacts/12477993389). Earlier runs and artifacts are linked in the run history.

## Main measured result

The four-photo control set is the connected cluster of the 2010 exterior/front views (files 003–006). COLMAP registered all four selected images, but they mainly see one facade.

| Metric | Reference | Latest calibrated GLB | Absolute relative error |
|---|---:|---:|---:|
| Long horizontal axis | 125.4 m | 125.4000 m | 0.0000020% |
| Short horizontal axis / depth proxy | 28.75 m | 87.1600 m | 203.17% |
| Vertical extent / height proxy | 27.13 m | 44.0055 m | 62.20% |

The long-axis length was calibrated to 125.4 m. Its match is **by construction**, not independent evidence. Both independent checks failed by a wide margin.

## COLMAP and geometry diagnostics

- Registered cameras: 4/4 in the facade-only control. The configured acceptance gate requires at least six registered images for a full-building candidate, so the set fails coverage even though the four selected photos registered.
- Sparse SfM (latest run): 298 points, 766 observations, mean track length 2.57, mean reprojection error 0.821 px. The bundle adjustment log ended with “No convergence.” Even a low reprojection error describes camera-fit residuals; it does not prove complete 3D shape.
- Camera directions (latest run): maximum pairwise spread 36.001 degrees; median 18.104 degrees. The selected images still mainly see the front facade.
- Fallback mesh: 3,338 triangles, three disconnected mesh components and 116 open boundary edges; the geometry QA explicitly flagged the topology for review.
- Texture: unavailable in this COLMAP build. The emitted GLB uses a neutral review material; texture match against the source photos was **not tested**.
- Georeferencing: not solved. Published site coordinates / the BuildingSpec anchor are only placement hints; there is no surveyed control-point registration.

The [latest front/side/top orthographic previews and GLB](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39899992722/artifacts/12477993389) show a warped, sparse, facade-dominated surface rather than a credible complete palace volume. The same four selected inputs also produced materially different depth/height extents across runs (earlier control: 63.77 m / 50.74 m; latest: 87.16 m / 44.01 m). This instability is an additional warning that this sparse fallback is not yet a repeatable building-geometry reconstruction. A full ten-image experiment ([run evidence](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39897870892)) also failed to find a good initial image pair because the selected still photos form disconnected feature-matching clusters.

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
