# Mask-guided building edge sketches

This stage uses a **human-reviewed building mask** to clip edge detections to the visible building region. It deliberately does not pretend to perform automatic semantic segmentation.

## Prepare masks

For each source file such as `front-facade.jpg`, place a PNG mask in the mask directory named exactly `front-facade.jpg.mask.png`.

- Mask dimensions must exactly match the source image's original pixel dimensions.
- White (pixel value 128–255) means visible building.
- Black (pixel value 0–127) means background to suppress.
- Manually inspect the mask. Include the building's visible roof, facade and other intended parts; exclude trees, sky and nearby buildings unless those are intentionally part of the target.
- Do not infer hidden walls or unseen architectural features.

## Run

```powershell
npm run test:mask-guided-building-sketches
npm run build:mask-guided-sketches -- "E:\Building-Engine-Workspace\uploads\parliament-reference" "E:\Building-Engine-Workspace\runs\parliament-reviewed-masks" "E:\Building-Engine-Workspace\runs\parliament-masked-sketches" --max-edge=4096
```

FFmpeg must be available as `ffmpeg`, through `FFMPEG_BIN`, or via `--ffmpeg=PATH`. The input and mask directories are read non-recursively. The command skips source images with missing masks and reports those skips in `masked-sketch-manifest.json`. Each processed record includes SHA-256 hashes for the original image and mask, plus output name and processing settings. Use a fresh output directory for each run.

## What it produces

A raster edge preview with edge responses suppressed outside the supplied mask. This is useful for reviewing facade and roofline cues before multi-view alignment.

## Limits

- The mask is supplied by a person; this command does not evaluate its semantic correctness.
- The edge preview is not a vector drawing, CAD model, registered 3D wireframe or a geometry repair system.
- Incorrect masks can cut off real building structure or retain background clutter.
- Camera calibration, cross-view feature correspondence, multi-view wireframe fusion and geometry generation remain later stages.
- No real-world accuracy percentage is produced.
