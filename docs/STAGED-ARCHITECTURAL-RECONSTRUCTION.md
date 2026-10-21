# Staged Architectural Reconstruction Pipeline

## Status and intent

This document defines the required reconstruction behavior before implementation. It is not a claim that all stages are already implemented. The current COLMAP worker performs image-quality preflight, multi-view photogrammetry, mesh texturing, and review diagnostics; it does **not** yet produce and reconcile per-image architectural sketches, run 3–4 geometry-correction passes, or automatically repair every detected mesh defect.

The target is evidence-led architectural reconstruction, not merely a textured mesh.

## Required stage graph

`INGEST -> IMAGE_ANALYSIS -> TILED_ANALYSIS -> PER_VIEW_SKETCH -> VIEW_REGISTRATION -> 3D_WIREFRAME -> ITERATIVE_SKETCH_REPAIR -> VOLUME_AND_FACADE_MODEL -> GEOMETRY_REPAIR -> TEXTURE -> FINAL_ACCEPTANCE`

Each stage must write an immutable, versioned artifact and a machine-readable report. A failed gate routes the job back to the earliest stage responsible for the finding. Never silently continue by inventing hidden geometry.

### 1. Ingest and preserve source evidence

- Validate file type, dimensions, orientation/EXIF, image integrity, duplicate/near-duplicate candidates, licensing and source identity.
- Keep original images unchanged and record SHA-256, dimensions, source attribution/licence, tool versions and configuration.
- Confirm that all selected images depict the same building and record known viewpoint/pose/GPS metadata when available.
- Flag blur, clipping, extreme lighting, occlusion and insufficient overlap; a human can exclude a view with a recorded reason.

### 2. Whole-image analysis and overlapping tiles

- Analyse the complete image first so tile results retain global context.
- Create configurable overlapping tiles at multiple scales. Tile size/overlap must be selected based on image resolution and model input limits; do not promise a fixed number of tiles for every image.
- Store each tile's source image ID, pixel bounds, scale, overlap and coordinate transform.
- Merge tile-level predictions in the original image coordinate frame, suppress duplicates, and retain confidence/uncertainty. Tile boundaries must never become architectural edges by themselves.
- Segment building pixels separately from sky, trees, roads, people, vehicles and other background/foreground objects.

### 3. One 2D architectural drawing per view

For each usable image, produce a reviewable drawing artifact containing as available:
- building silhouette and visible boundary;
- roofline, facade edges, corners, floor bands, columns/openings and major planar regions;
- occlusion masks and regions that are not observable;
- confidence per edge/region and provenance back to source pixels.

Keep a raster overlay and vector representation (for example, JSON polylines/polygons). Do not label a hidden facade or unseen roof as verified.

### 4. Register and merge views

- Estimate camera intrinsics/poses and cross-view correspondences using multi-view geometry.
- Match corresponding architectural features across views; reject inconsistent matches instead of averaging them blindly.
- Transform each view sketch into a common 3D coordinate frame using the estimated camera model.
- Produce a provisional 3D architectural wireframe with provenance linking each 3D line/plane to the contributing image observations.
- If camera registration or cross-view support is weak, stop for better imagery/review rather than fabricating a precise model.

### 5. Iterative wireframe validation and repair

Run a configurable 3–4 pass loop, with a maximum-pass limit and explicit convergence rules. Every pass must:
1. detect duplicate/near-duplicate edges, self-intersections, incompatible plane intersections, inconsistent corners, unsupported lines and cross-view projection mismatch;
2. rank findings by severity and confidence;
3. repair only when supported by observations or declared architectural constraints;
4. re-project the updated wireframe into each source view and recompute residuals;
5. save before/after metrics, changed elements, unresolved findings and a pass summary.

Do not treat "four passes completed" as success. Exit early only when all required gates pass; if the maximum passes are reached with unresolved high-severity findings, stop and mark the job as requiring more evidence or human review. Preserve an undoable artifact per pass.

### 6. Construct building volumes and architectural shape

- Build primary volumes/facade planes from the accepted wireframe before adding secondary details.
- Fit planar surfaces and intersections robustly; keep openings, columns, bands, rooflines and other features as separate traceable elements where practical.
- Compare projected model silhouettes and edges against every registered view, weighted by visibility and image quality.
- Treat unobserved surfaces as unknown or explicitly inferred. Record inference method and confidence; never present inferred detail as verified.
- Require independent reference dimensions or control points to claim metric scale or geospatial accuracy.

### 7. Geometry validation and automatic repair

Check at minimum:
- self-intersections, duplicate/internal faces, holes, non-manifold edges, disconnected fragments and degenerate triangles;
- long stretched triangles, spikes, inverted normals and implausible thin sheets;
- silhouette/edge reprojection residuals per view;
- dimensions against independently sourced references;
- background contamination and texture/view mismatch.

Repairs must be targeted and conservative: remove identified background components, resolve supported duplicate geometry, remesh/retopologize where justified, and re-run all checks. Never close a hole or smooth a feature if doing so would erase a real architectural opening or unsupported-but-plausible detail. QA detection alone is not a repair.

### 8. Texture only after geometry review

- Texture the accepted geometry using view visibility, viewing angle, resolution and source quality.
- Mask sky, vegetation, people and other non-building pixels.
- Detect stretched textures, seams, missing UV/materials and background patches.
- Reproject texture to source views and retain per-face/source-view provenance where possible.

### 9. Final acceptance gates

A job is not final/map-ready unless all required gates are explicitly recorded:
- source and view coverage reviewed;
- per-view sketches and 3D wireframe accepted;
- wireframe correction converged, with no unresolved critical overlap/intersection findings;
- geometry checks passed or exceptions explicitly approved;
- multi-view silhouette/edge residuals within project-defined tolerances;
- independent dimensions and scale validated for metric use;
- surveyed control-point residuals and vertical datum documented for geospatial placement;
- texture review passed;
- reproducible run manifest and human sign-off stored.

Keep `mapReady=false` and `publicationEligible=false` if any mandatory gate is missing or failed.

## Report contract

The final report should include:
- stage status, start/end times, tool/model versions and configuration hash;
- source manifest and per-image quality/segmentation/sketch artifacts;
- tile count and coordinate metadata per source image;
- camera poses, registration status and cross-view correspondence statistics;
- per-view sketch confidence and 2D/3D projection residuals;
- wireframe repair pass count, per-pass findings, changes and convergence status;
- geometry and texture findings before and after repairs;
- independent dimension/control-point metrics and their reference provenance;
- unresolved findings, human decisions, and final gate status.

## Implementation sequence

1. Add typed/versioned stage artifact schemas and a resumable job-state machine.
2. Implement multi-scale overlapping tile planning and deterministic coordinate mapping, with unit tests.
3. Add building/background segmentation and per-view edge/silhouette/vector-sketch artifacts.
4. Register sketches against COLMAP camera poses and create a first 3D wireframe with traceable observations.
5. Add the 3–4 pass validation/repair loop and convergence tests.
6. Build volumes from the accepted wireframe; connect existing mesh QA as a gate, not as a substitute for repair.
7. Add view-conditioned texture masking and final acceptance report.
8. Benchmark with the Parliament reference set and independently verified dimensions; report measured errors, not an invented single accuracy percentage.

## Resource and accuracy constraints

- Use bounded tile batches and configurable resolution/worker concurrency for CPU-only systems.
- Persist intermediate artifacts so a failed stage can resume without repeating all earlier work.
- More pixels, tiles, vertices or triangles do not prove accuracy.
- A model must be evaluated against independent observations. If image coverage, camera geometry or reference measurements are insufficient, the correct output is a documented uncertainty/failure state, not a guessed building shape.
