# Street imagery and building reconstruction

## Goal

Connect a selected Dhaka building footprint to nearby public street-level references, then use those references as inputs to a later quality-controlled 3D reconstruction workflow. A nearby image is only a candidate: GPS error, camera heading, distance, trees, parked vehicles and occlusion mean it may show a neighbouring building rather than the selected footprint.

## First source: KartaView

The app queries the public KartaView photo API on demand for one selected building. The API route:

- validates WGS84 latitude/longitude, a 50–500 m radius and a maximum of 50 results;
- caps concurrent upstream calls, times out slowly responding requests, coalesces duplicate calls and caches only query metadata for five minutes;
- filters private/deleted records, unsafe media links, invalid coordinates, duplicates and captures outside the chosen radius;
- keeps attribution and the CC BY-SA 4.0 media licence with the reference results.

The app does not crawl all city imagery, download original media in bulk, or claim that nearby imagery belongs to a selected building. Query-on-selection is intentional: a city-wide image sweep could overload a shared public provider and is not a guarantee of complete building coverage.

KartaView public API and licence:
- https://kartaview.org/doc/photos
- https://kartaview.org/terms

Other providers can be added behind the same interface. For example, Mapillary imagery has its own API/token and attribution requirements. Google Street View has separate terms and restrictions around caching, indexing, downloading and reuse; do not scrape it or use its images as a bulk-training corpus.

## Architecture confidence stages

1. **Estimated** — no usable street references. Continue to use the current footprint/height extrusion and mark the result as estimated.
2. **Reference only** — one or two distinct capture positions. Use them for visual clues, not claims of a complete reconstruction.
3. **Multi-view candidate** — at least three distinct GPS capture positions were returned. This is only a candidate label; angle overlap and building identity still require review.

The current implementation discovers and displays references. It does not yet infer true façade geometry, generate a textured mesh or overwrite building surfaces based on the images.

## Next reconstruction stage

For an approved group of overlapping photographs or sampled video frames, a local photogrammetry worker can test Structure-from-Motion and Multi-View Stereo using COLMAP or Meshroom/AliceVision. The resulting mesh must pass quality checks before it becomes a Cesium model asset. A practical pipeline will need to record input provenance and licence, building ID, source image IDs, capture positions, processing parameters, reconstruction status and confidence. Never infer hidden sides, room interiors or exact measurements from a single exterior image.

Useful references:
- https://colmap.github.io/tutorial
- https://github.com/alicevision/Meshroom
- https://docs.overturemaps.org/guides/buildings/
