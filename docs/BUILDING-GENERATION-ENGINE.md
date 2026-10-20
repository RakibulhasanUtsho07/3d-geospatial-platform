# Building Generation Engine

Status: deterministic procedural generation, source-aware BuildingSpec validation, local media intake, FFmpeg frame extraction, COLMAP orchestration and textured PLY-to-GLB conversion are implemented. Durable Admin workflow, AI vision, CAD/IFC/BIM import, georeferencing against control points and public publishing are not implemented yet.

## 1. Baseline input → 3D model

**building-spec.mjs** validates BuildingSpec version 1.0.0, WGS84 footprint coordinates and building dimensions, style/material/window/door/balcony parameters, source metadata and confidence-linked evidence. **procedural-glb.mjs** generates a deterministic binary glTF (.glb) with walls, repeated windows/frames, a door, front balconies, roof cap and parapet. **generation-engine.mjs** writes a JSON QA/provenance report. The synthetic fixture is for tests only.

~~~powershell
npm run test:building-generation
npm run generate:building-model -- tests/fixtures/demo-building-spec.json artifacts/dhaka-demo-01.glb
~~~

## 2. Local image, video and floor-plan intake

**media-intake.mjs** accepts JPEG, PNG, WebP, MP4/MOV, WebM/MKV and PDF files. It identifies the file from signatures rather than trusting extensions, enforces per-kind size limits, rejects source path traversal and symlinks, calculates SHA-256 and writes a content-addressed copy plus per-source JSON record under .building-engine/media/<buildingId>/. No remote URL is fetched. It is a local workspace adapter, not a production authenticated upload API or shared object store.

**video-frame-extractor.mjs** invokes FFmpeg with argument arrays (not a shell), bounded FPS (0.05–2), frame cap (1–500), output width and timeout. Extracted frames become child video-frame records referencing the parent video. Sampling times are approximate; frame extraction does not prove camera poses or photo overlap.

~~~powershell
npm run test:building-media
npm run ingest:building-media -- E:\Building-Engine-Workspace dhaka-demo walkthrough-01 uploads\walkthrough.mp4 auto 0.5 60
~~~

The default licence is unknown and default usage state is unreviewed. Review source ownership, licence and attribution before changing this state.

## 3. COLMAP multi-view reconstruction and GLB conversion

**colmap-worker.mjs** stages only explicitly selected sources whose file SHA-256 matches their metadata and BuildingSpec. At least three distinct JPEG/PNG images or extracted video frames are required. Every selected source must have a known licence, usageStatus: approved, and matching assetId. The operator must explicitly confirm same-building identity and adequate view overlap, and choose a source up-axis.

The worker executes colmap automatic_reconstructor and colmap mesh_texturer as child processes without shell interpolation. **textured-ply-to-glb.mjs** converts ASCII or binary little-endian textured PLY triangles and an embedded PNG texture into one self-contained GLB. COLMAP must be installed on the worker host; real GPU/CPU reconstruction is not run in CI. CI tests the PLY converter and worker orchestration using a deterministic mock process.

~~~powershell
npm run test:colmap-worker
npm run reconstruct:building-media -- <workspaceRoot> <buildingSpec.json> <jobId> <sourceId1,sourceId2,sourceId3> <sourceUpAxis> --confirm-same-building --confirm-overlap-reviewed --confirm-up-axis-reviewed
~~~

### Mandatory output gates

- **Rights and provenance:** source file bytes must match recorded SHA-256, usage must be approved and a known licence must be recorded.
- **Identity/overlap:** manual confirmations are explicit but do not automatically prove these assumptions.
- **Scale:** a known real-world baseline is required for a metric result. Without both modelDistanceUnits and realDistanceM, the output is a provisional-scale preview.
- **Orientation:** up-axis is configured; heading, facade-front direction and vertical axis still require review.
- **Georeference:** source GPS points are not a ground-control registration. Current report marks coordinate alignment as not-solved; the BuildingSpec location is only a placement hint.
- **Human review:** worker status is completed-requires-review; report always sets mapReady=false and publicationEligible=false. It does not publish to /map.

A single exterior photo cannot reveal hidden elevations, measured scale, floor plans or interior spaces. Multi-view photogrammetry also fails when images lack overlap, are blurry, show different buildings or have insufficient texture. A worker success is a candidate mesh, not proof of architectural accuracy.

## 4. Strategy routing

**generation-pipeline.mjs** retains deterministic procedural generation as default. Photogrammetry runs only when explicitly requested and the validated source set qualifies as a multi-view candidate. It does not silently infer missing geometry from media. BIM/IFC, CAD/floor-plan parsing and AI-based reference interpretation need separate adapters.

## 5. Next milestones

1. Image QA: blur/duplicate checks, frame sampling review, camera-pose quality and same-building/overlap assistance.
2. Ground control: measured baseline inputs tied to named points, heading/front direction and horizontal/vertical datum registration.
3. Mesh QA: scale/axis checks, degenerate triangles, holes/occlusion notes, texture quality and a side-by-side reference review report.
4. Persistent Admin workflow: server-side authorization, database-backed versioned BuildingSpec, private object storage and durable async jobs.
5. Publish integration: human approval, versioned GLB asset and rollback, then load only reviewed/published assets in existing /map without breaking Overture roads/buildings or Ahsan Manzil.
6. Other source routes: CAD/DWG/vector floor-plan parser, IFC/BIM import and optionally AI-assisted visual attribute extraction with source/confidence tracking.

The generated model registry already added to the map engine is in-memory only. This reconstruction worker is not an authorization layer or public upload endpoint. Do not expose unauthenticated model generation, arbitrary asset URLs or publishing controls.