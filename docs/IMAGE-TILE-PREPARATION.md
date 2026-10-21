# Image Tiling Preparation

Run from the repository root:

```powershell
npm run tile:building-images -- "E:\Building-Engine-Workspace\uploads\parliament-reference" "E:\Building-Engine-Workspace\runs\parliament-tiles" --tile-size=1024 --overlap=128
npm run test:image-tile-analysis
```

The command reads JPEG/PNG files directly inside the input folder (not recursively), plans overlapping tiles in original pixel coordinates, uses FFmpeg to write each crop as a JPEG, and creates `tile-manifest.json` with the original image dimensions, tile bounds, relative paths and configuration. FFmpeg must be installed or supplied with `--ffmpeg=PATH` / `FFMPEG_BIN`.

Important limitations:
- This is the first **image-tile preparation** stage only. It does not identify building pixels, produce architectural sketches, align views into 3D, repair geometry, or certify accuracy.
- The manifest records crop coordinates, not inferred building features.
- Tiles are intentionally overlapping so features near tile boundaries are visible in multiple crops. Tile-level detections must later be mapped back to source-image coordinates and merged; `image-tile-analysis.mjs` includes tested coordinate mapping and class-aware box NMS primitives for that future detector integration.
- Use the original full images for camera matching and final review. Do not use tiles as independent camera views.
- Start with a manageable subset when testing. High-resolution image sets can create many files and consume disk space.
- This command does not alter or delete source images. The output directory must not be the same path as the input directory; use a new output folder for each run because an existing `tile-manifest.json` is not overwritten.

The next implementation stages are building/background segmentation, per-view vector sketch extraction, cross-view feature correspondence, 3D wireframe construction, and an iterative repair loop. Those stages must not be described as implemented until their artifacts, tests, and measurable acceptance checks exist.
