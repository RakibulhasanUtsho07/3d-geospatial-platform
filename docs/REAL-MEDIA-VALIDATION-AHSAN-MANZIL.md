# Real-media validation: Ahsan Manzil

**Outcome: FAIL — not an accurate complete-building reconstruction.**  
The generated GLB is retained for review only. It must not be published to the live map as an accurate building model.

## Test setup

- Building: Ahsan Manzil (Pink Palace), Kumartoli, Dhaka, Bangladesh.
- Reference dimensions used in this experiment: overall length 125.4 m, overall depth 28.75 m, dome peak height 27.13 m. These are published reference values, not a new survey; see the Bangladesh Tourism Board / Parjatan references in [the input source manifest](../validation/ahsan-manzil-media-sources.json).
- Input media: images downloaded from Wikimedia Commons with the creator and CC BY-SA license recorded in the artifact's attribution manifest.
- External tools: FFmpeg and Ubuntu-packaged COLMAP. The packaged COLMAP build does not provide the dense CUDA/HIP MVS path or `mesh_texturer`, so the workflow used an explicitly labelled sparse-SfM-to-Poisson surface fallback. That fallback can invent geometry and is not equivalent to dense photogrammetry.
- Latest run that produced a candidate GLB: [run #39901016334](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39901016334) and its [downloadable model/evidence artifact](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39901016334/artifacts/12479073267). The newer same-photographer dataset run #39901431757 is the latest dataset attempt, but it did not produce a GLB.

## Main measured result

The four-photo control set is the connected cluster of the 2010 exterior/front views (files 003–006). COLMAP registered all four selected images, but they mainly see one facade.

| Metric | Reference | Last GLB-producing run #39901016334 | Absolute relative error |
|---|---:|---:|---:|
| Long horizontal axis | 125.4 m | 125.4000 m | 0.0000011% |
| Short horizontal axis / depth proxy | 28.75 m | 50.1108 m | 74.30% |
| Vertical extent / height proxy | 27.13 m | 23.1202 m | 14.78% |

The long-axis length was calibrated to 125.4 m. Its match is **by construction**, not independent evidence. In the last run that emitted a GLB, depth is 74.30% too large (fail), while the vertical-extent proxy is 14.78% low (passes the 20% exploratory threshold). The overall dimensions gate still fails because depth is far outside tolerance.

## COLMAP and geometry diagnostics

- Registered cameras: 4/4 in the facade-only control. The configured acceptance gate requires at least six registered images for a full-building candidate, so the set fails coverage even though the four selected photos registered.
- Sparse SfM (last GLB-producing run #39901016334): 433 sparse points; 4/4 source images registered. 
- Camera directions: maximum pairwise spread 13.01 degrees; median 6.506 degrees. This fails the configured 20-degree full-building viewpoint-spread gate and means the scene is still heavily front-facing.
- Fallback mesh: 4,846 triangles. Geometry QA flagged five issues for human review. There is no texture atlas; the GLB uses a neutral material. It is a sparse-point Poisson surface, not a dense MVS reconstruction.
- Texture: unavailable in this COLMAP build. The emitted GLB uses a neutral review material; texture match against the source photos was **not tested**.
- Georeferencing: not solved. Published site coordinates / the BuildingSpec anchor are only placement hints; there is no surveyed control-point registration.

The [front/side/top previews and GLB from the last candidate-producing run](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39901016334/artifacts/12479073267) show a thin, sparse, facade-dominated surface rather than a complete palace volume. Repeated solves on similar four-image facade inputs varied sharply: #39899992722 measured depth/height 87.16/44.01 m; #39900331596 26.70/48.43 m; #39900708592 37.33/40.85 m; and #39901016334 50.11/23.12 m. This is a repeatability failure in addition to the dimension/coverage failures. The full ten-image experiment ([run evidence](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39897870892)) also failed to find a good initial image pair because the selected still photos form disconnected feature-matching clusters.

## Final dataset follow-up: same-photographer image set

After the dimensional-failure run above, a second source set from Saeed Ahmad's Wikimedia Commons files `Ahsan_Manzil_view_02.jpg` through `Ahsan_Manzil_view_07.jpg` was tested. The runner downloaded all six source files, recorded SHA-256 checksums, and passed the basic image-quality preflight. However, COLMAP's actual `automatic_reconstructor` log ended with **`No good initial image pair found`**; no sparse model files were written, so the worker could not make a mesh or GLB. The fallback cannot recover a building surface without a registered sparse reconstruction. See [run #39901431757](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39901431757) and its [source/log artifact](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39901431757/artifacts/12479131245).

This distinguishes two independent failure modes:
- **Four-image facade control:** it produced a review GLB, but independent dimensions, mesh topology and full-building camera coverage failed.
- **Six-image same-photographer set:** it did not form a viable COLMAP initial pair; there is no GLB on which to run dimensional checks.

The basic image preflight only checks resolution, luminance, contrast, sharpness heuristics and near-duplicates. It does not prove geometric overlap. The available still images do not establish a connected walk-around sequence, so adding more photographs did not guarantee a reconstructable multi-view set.

`real-media-building-validation.yml` is now **manual-dispatch only**. Further experiments must be deliberately started from GitHub Actions; ordinary report/code edits will not automatically trigger another 3-hour validation workflow.

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
