# Per-view architectural sketch previews

This stage produces one deterministic edge-drawing preview per source image so a reviewer can inspect visible structure before building/background segmentation is implemented.

## Usage

```powershell
npm run test:architectural-sketch-preparation
npm run prepare:architectural-sketches -- "E:\Building-Engine-Workspace\uploads\parliament-reference" "E:\Building-Engine-Workspace\runs\parliament-sketch-previews" --low-threshold=0.08 --high-threshold=0.25 --max-edge=4096
```

FFmpeg must be installed or provided through `FFMPEG_BIN` or `--ffmpeg=PATH`. The command reads JPEG/PNG images directly inside the source directory (non-recursive), writes `*.edges.png` previews, and writes `architectural-sketch-manifest.json` containing source dimensions, SHA-256 provenance, settings and limitations. Use a new output directory for each run.

## What this stage does

- Converts each input view into a grayscale edge-drawing preview.
- Bounds the longest output edge to a configurable maximum while preserving aspect ratio.
- Records source-file hash and the parameters used to generate the preview.
- Does not modify or delete original photos.

## Important limitations

An edge map is **not yet a building-only architectural sketch**. It includes tree branches, sky boundaries, road markings, people, texture edges and other objects. It is not semantic segmentation, vector CAD geometry, a registered 3D wireframe, or an accuracy measurement. Review it as a diagnostic preview only.

The next stage must produce a building/background mask (preferably with a real segmentation model or a manually reviewed mask), extract structural lines within the mask, and retain per-feature confidence and source-pixel provenance. Cross-view correspondences and camera calibration are needed before a 3D sketch can be assembled. Do not infer hidden facades from a single image or silently treat edge-map output as verified architecture.
