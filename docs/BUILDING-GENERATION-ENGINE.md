# Building Generation Engine

Status: deterministic procedural generation, source-aware BuildingSpec validation, local media intake, FFmpeg frame extraction, image-quality preflight, COLMAP multi-view reconstruction, textured PLY-to-GLB conversion, TripoSR single-image preview, and shared GLB integrity/geometry QA are implemented. Learned architectural understanding, CAD/IFC/BIM import, durable Admin workflow, ground-control georeferencing and public publishing are not implemented yet.

## 1. Baseline input → 3D model

**building-spec.mjs** validates BuildingSpec version 1.0.0, WGS84 footprint coordinates and building dimensions, style/material/window/door/balcony parameters, source metadata and confidence-linked evidence. **procedural-glb.mjs** generates a deterministic binary glTF (.glb) with walls, repeated windows/frames, a door, front balconies, roof cap and parapet. **generation-engine.mjs** writes a JSON QA/provenance report. The synthetic fixture is for tests only.

~~~powershell
npm run test:building-generation
npm run generate:building-model -- tests/fixtures/demo-building-spec.json artifacts/dhaka-demo-01.glb
~~~

## 2. Unified media-to-model workflow

The runMediaToModelWorkflow function and scripts/build-building-from-media.mjs orchestrate local files into one reviewed output package. A run can ingest source media, compute SHA-256 content IDs, record an explicit licence/permission attestation, extract bounded video frames, sync the current source records into BuildingSpec, choose a generation strategy, and write a GLB with workflow/report metadata.

~~~powershell
npm run test:media-to-model-workflow

# Structured information + one or more source photographs
npm run build:building-from-media -- <workspaceRoot> <base-spec.json> <jobId> --source front-photo=uploads/front.jpg --licence "front-photo=CC BY 4.0" --confirm-rights --strategy procedural

# Single-view AI preview (install TripoSR separately)
npm run build:building-from-media -- <workspaceRoot> <base-spec.json> <jobId> --source front-photo=uploads/front.jpg --licence "front-photo=CC BY 4.0" --confirm-rights --strategy single-image-ai --views front-photo --runner-script <TripoSR/run.py> --confirm-single-view-inference

# Video -> sampled frame IDs such as walkthrough-frame-000001, then choose views for COLMAP
npm run build:building-from-media -- <workspaceRoot> <base-spec.json> <jobId> --source walkthrough=uploads/walkthrough.mp4 --licence "walkthrough=CC BY 4.0" --confirm-rights --strategy photogrammetry --views walkthrough-frame-000001,walkthrough-frame-000002,walkthrough-frame-000003 --up-axis Z --confirm-same-building --confirm-overlap-reviewed --confirm-up-axis-reviewed
~~~

Use a known permission/licence value only after you have checked it. --confirm-rights records your attestation; it does not verify ownership for you. The selected views need to exist in the workspace media store and have approved source metadata. You can use source IDs that were ingested in an earlier run by passing them to --views. COLMAP, TripoSR and FFmpeg are external tools, installed separately. The command does not parse a floor-plan PDF into measured geometry, and never publishes a result to /map.

The base BuildingSpec must contain the best available footprint, WGS84 placement hint and measured dimensions. A video’s sampled frames only become reconstruction input after selection; they do not prove that camera views overlap or that geometry/scale/georeferencing is accurate. Outputs are written to .building-engine/jobs/<buildingId>/<jobId>-workflow/ with building-spec.json, model.glb, and workflow-report.json.

## 3. Ground-control registration to WGS84

The ground-control-registration.mjs module fits a 2D least-squares similarity transform from at least three non-collinear, operator-matched control points. Each point supplies an identifier, modelX/modelZ in the exact GLB's ground plane (Y is up), and surveyed WGS84 longitude/latitude. It estimates metres per model unit, the model X-axis bearing, local horizontal translation, and the WGS84 longitude/latitude of the model origin. Per-point errors, RMS error and configurable acceptance thresholds are included in the report.

~~~powershell
npm run test:ground-control-registration
npm run build:building-from-media -- <workspaceRoot> <base-spec.json> <jobId> --strategy procedural --control-points <control-points.json> --max-gcp-rms-m 0.5 --max-gcp-residual-m 1.0
~~~

The control-points JSON must be a JSON array whose rows have id, modelX, modelZ, longitude and latitude. Those model coordinates must be picked/measured in the exact output GLB, and the WGS84 coordinates must come from a trustworthy survey/control source. Do not use guessed coordinates as ground truth. A fit exceeding its RMS or maximum-residual threshold is labelled calibration-failed-review-required.

This fit is horizontal only. Vertical height datum, roof/ground elevation, camera reconstruction quality, control-point identity and architectural fidelity need independent review. Even a successful fit stays mapReady=false and publicationEligible=false; a person must review the placement before any publishing feature is allowed.

## 4. GLB structure and geometry QA

The shared glb-geometry-qa.mjs analyser reads the GLB 2.0 header/chunks and validates its embedded buffer structure. For supported triangle primitives it checks that vertex positions are finite, byte ranges/strides are valid, index values stay inside the POSITION accessor, and triangle counts are well formed. It reports mesh/primitive/vertex/triangle counts, zero-area/degenerate triangles, material/texture/image counts, external URIs, and model-space bounds. The procedural, COLMAP and single-image AI routes attach this report to their generation report.

~~~powershell
npm run test:glb-geometry-qa
~~~

A report with warnings is a manual-review signal, not an automatic rejection or a proof that the mesh matches the real building. Current QA does not calculate watertightness, connected-component quality, facade accuracy, camera calibration, true metric scale, or WGS84 registration. GLB bounds are model-space values unless independent scale calibration is available.

## 5. Local image, video and floor-plan intake

**media-intake.mjs** accepts JPEG, PNG, WebP, MP4/MOV, WebM/MKV and PDF files. It identifies the file from signatures rather than trusting extensions, enforces per-kind size limits, rejects source path traversal and symlinks, calculates SHA-256 and writes a content-addressed copy plus per-source JSON record under .building-engine/media/<buildingId>/. No remote URL is fetched. It is a local workspace adapter, not a production authenticated upload API or shared object store.

**video-frame-extractor.mjs** invokes FFmpeg with argument arrays (not a shell), bounded FPS (0.05–2), frame cap (1–500), output width and timeout. Extracted frames become child video-frame records referencing the parent video. Sampling times are approximate; frame extraction does not prove camera poses or photo overlap.

~~~powershell
npm run test:building-media
npm run ingest:building-media -- E:\Building-Engine-Workspace dhaka-demo walkthrough-01 uploads\walkthrough.mp4 auto 0.5 60
~~~

The default licence is unknown and default usage state is unreviewed. Review source ownership, licence and attribution before changing this state.

### Source review and BuildingSpec source preparation

The reviewBuildingSource function re-checks the stored SHA-256 before it marks a local media record as usageStatus approved. The command records the entered licence/permission basis, timestamp, attribution and optional capture metadata. This is an explicit operator attestation, not an independent copyright check. Only use --confirm-rights if you have verified the source rights yourself.

The prepareBuildingSpecSources function re-hashes selected local assets and joins their current metadata into BuildingSpec.sources by source ID, preserving existing source/evidence records and validating the final spec. It prevents stale copied IDs or hashes from silently drifting away from source metadata.

~~~powershell
npm run test:building-source-workflow
npm run review:building-source -- <workspaceRoot> <buildingId> <sourceId> --licence "CC BY 4.0" --confirm-rights --author "Author" --attribution "Required credit"
npm run prepare:building-spec -- <workspaceRoot> <base-spec.json> <sourceId1,sourceId2,...> <output-spec.json>
~~~


## 6. COLMAP multi-view reconstruction and GLB conversion

**colmap-worker.mjs** stages only explicitly selected sources whose file SHA-256 matches their metadata and BuildingSpec. At least three distinct JPEG/PNG images or extracted video frames are required. GPS tags are useful for georeferencing but are not required for COLMAP to estimate a local multi-view model. Every selected source must have a known licence, usageStatus: approved, and matching assetId. The operator must explicitly confirm same-building identity and adequate view overlap, and choose a source up-axis.

The worker executes colmap automatic_reconstructor and colmap mesh_texturer as child processes without shell interpolation. **textured-ply-to-glb.mjs** converts ASCII or binary little-endian textured PLY triangles and an embedded PNG texture into one self-contained GLB. COLMAP must be installed on the worker host; real GPU/CPU reconstruction is not run in CI. CI tests the PLY converter and worker orchestration using a deterministic mock process.

~~~powershell
npm run test:colmap-worker
npm run reconstruct:building-media -- <workspaceRoot> <buildingSpec.json> <jobId> <sourceId1,sourceId2,sourceId3> <sourceUpAxis> --confirm-same-building --confirm-overlap-reviewed --confirm-up-axis-reviewed
~~~

### Post-reconstruction COLMAP diagnostics

After `automatic_reconstructor` succeeds, the worker looks for the generated sparse model and runs `colmap model_analyzer`. The workflow report records total and registered images, sparse 3D point count, observations, mean track length and mean reprojection error when COLMAP exposes them. Missing diagnostics are recorded as unavailable rather than silently treated as a pass.

The default review heuristics warn when fewer than 75% of selected input images register, sparse points fall below 50 per registered image, mean track length is below 2.0, or mean reprojection error exceeds 2 pixels. Thresholds can be supplied through `reconstructionDiagnosticsThresholds`. These are review hints, not universal photogrammetry quality standards: the worker continues to create a review-only preview, but the warnings are copied into the job report. A passing diagnostic does not prove image overlap, architecture, metric scale, or map readiness.

### Image quality preflight

Before COLMAP starts, the worker samples each staged image through FFmpeg as a 64x64 grayscale thumbnail. It records dimensions, mean luminance, contrast standard deviation, Laplacian-variance blur heuristic, and a 64-bit perceptual difference hash. Cross-view hashes flag potentially near-duplicate images and video frames. A preflight result is a warning/review signal only: it does not automatically discard images or claim to understand camera pose, identify a building, prove overlap or validate architectural accuracy.

Install FFmpeg on the reconstruction worker and run `npm run test:image-quality-preflight` to test the heuristics. If FFmpeg cannot decode a selected image, the job fails with an explicit preflight diagnostic instead of silently treating the image as good input.

### Mandatory output gates

- **Rights and provenance:** source file bytes must match recorded SHA-256, usage must be approved and a known licence must be recorded.
- **Identity/overlap:** manual confirmations are explicit but do not automatically prove these assumptions.
- **Scale:** a known real-world baseline is required for a metric result. Without both modelDistanceUnits and realDistanceM, the output is a provisional-scale preview.
- **Orientation:** up-axis is configured; heading, facade-front direction and vertical axis still require review.
- **Georeference:** source GPS points are not a ground-control registration. Current report marks coordinate alignment as not-solved; the BuildingSpec location is only a placement hint.
- **Human review:** worker status is completed-requires-review; report always sets mapReady=false and publicationEligible=false. It does not publish to /map.

A single exterior photo cannot reveal hidden elevations, measured scale, floor plans or interior spaces. Multi-view photogrammetry also fails when images lack overlap, are blurry, show different buildings or have insufficient texture. A worker success is a candidate mesh, not proof of architectural accuracy.

## 7. Single-image AI preview (TripoSR)

The single-image-3d-worker.mjs module runs an operator-installed TripoSR run.py with a bounded timeout and fixed output format GLB. It validates the selected source's SHA-256, licence, usage approval and BuildingSpec asset ID before running. It records model parameters, input provenance, output checksum and a failure/completion report. The official TripoSR README describes single-image mesh inference, optional background removal and an MIT licence for the published project/model; verify the exact installed revision and notices: https://github.com/VAST-AI-Research/TripoSR

Install TripoSR/PyTorch in a separate Python environment; no ML weights are downloaded or bundled by this repository. Then run:

~~~powershell
npm run test:single-image-3d
npm run generate:building-from-image -- <workspaceRoot> <buildingSpec.json> <jobId> <sourceId> --runner-script <TripoSR-run.py> --confirm-single-view-inference
~~~

This is a single-view inference route, appropriate for visual preview/asset drafting, not accurate architecture reconstruction. It may hallucinate the unseen side and roof, and its model-space scale/orientation is not tied to real measurements. Reports are always labelled ai-proposed-requires-review, mapReady=false and publicationEligible=false.

## 8. Strategy routing

**generation-pipeline.mjs** retains deterministic procedural generation as default. Photogrammetry runs only when explicitly requested and the validated source set qualifies as a multi-view candidate. Single-image AI runs only when explicitly requested and produces an ai-proposed draft. It does not silently infer missing geometry from media. BIM/IFC, CAD/floor-plan parsing and AI-based reference interpretation need separate adapters.

## 9. Next milestones

1. Improved view selection: frame sampling review, camera-pose quality, field-of-view and same-building/overlap assistance (basic blur/duplicate preflight now exists).
2. Ground control: measured baseline inputs tied to named points, heading/front direction and horizontal/vertical datum registration.
3. Image-to-model QA: compare AI-proposed rear/roof geometry against independent multi-view evidence and never merge low-confidence surfaces silently.
4. Mesh QA: scale/axis checks, degenerate triangles, holes/occlusion notes, texture quality and a side-by-side reference review report.
5. Persistent Admin workflow: server-side authorization, database-backed versioned BuildingSpec, private object storage and durable async jobs.
6. Publish integration: human approval, versioned GLB asset and rollback, then load only reviewed/published assets in existing /map without breaking Overture roads/buildings or Ahsan Manzil.
7. Other source routes: CAD/DWG/vector floor-plan parser, IFC/BIM import and optionally AI-assisted visual attribute extraction with source/confidence tracking.

The generated model registry already added to the map engine is in-memory only. This reconstruction worker is not an authorization layer or public upload endpoint. Do not expose unauthenticated model generation, arbitrary asset URLs or publishing controls.