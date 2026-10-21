# Render/reference image similarity diagnostics

This tool computes bounded grayscale pixel-comparison diagnostics for one reference image and one rendered candidate view. It is a screening aid for a human reviewer, not an architectural-accuracy estimator or a substitute for camera matching.

## Run

Install FFmpeg separately and ensure `ffmpeg` is on PATH (or set `FFMPEG_BIN`). Use JPEG or PNG files.

```powershell
npm run compare:render-reference-images -- ".\references\front.jpg" ".\renders\front.png" ".\reports\front-image-diagnostics.json"
```

The tool records SHA-256 hashes, dimensions and byte counts for the exact source files and compares normalized 64×64 grayscale previews. It resizes with aspect-ratio-preserving padding to avoid stretching differently shaped images into different geometry.

## Metrics

- **MAE / RMSE:** average and root-mean-square grayscale pixel difference; lower means the sampled pixels are closer.
- **PSNR:** peak signal-to-noise ratio in decibels; higher usually means smaller pixel error. Exact identical samples return null because the value is mathematically unbounded.
- **8×8-window grayscale SSIM:** average local structural similarity across 64 fixed windows; closer to 1 means closer local luminance structure in the sampled previews.
- **Difference-hash Hamming distance:** rough edge/gradient signature difference (0–64); lower means closer coarse gradient patterns.
- **Aspect-ratio difference:** flags pairs whose source image proportions differ beyond the screening threshold.

The default SSIM/pixel-error thresholds are triage hints, not accepted/rejected accuracy thresholds. The output always has `status: "diagnostics-computed"`; warnings recommend additional review. The output never says that an image pair matches and never changes a human review or release gate.

## Required interpretation

Only compare the same facade from a closely matched camera pose and crop. The tool does not register camera poses, align feature points, compensate perspective, normalize exposure, segment the building from its background, or know which pixels belong to the building. Lighting/shadows, weather, vegetation, occlusion, camera lens, image cropping and texture can dominate these metrics.

A low pixel error is not proof that the 3D geometry is correct: a wrong mesh can have a similar facade texture, while a good mesh rendered under different lighting may have high pixel error. Do not combine these metrics into a single accuracy percentage. Keep dimension checks, survey-based georeferencing and human architectural review as separate evidence.

The tool accepts regular JPEG/PNG files, rejects symlinks, limits FFmpeg output to a 64×64 grayscale preview, and invokes FFmpeg using argument arrays rather than a shell. Its reports set `mapReady: false` and `publicationEligible: false`.
