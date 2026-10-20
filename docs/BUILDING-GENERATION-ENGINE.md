# Building Generation Engine — first implementation slice

Status: deterministic procedural core and local media intake/video frame extraction implemented. Actual image understanding, photogrammetry reconstruction, AI vision, CAD/IFC/BIM import, persistent Admin workflow and 3D publishing are not implemented yet.

## What works now

This slice validates a versioned BuildingSpec, converts the georeferenced footprint to local metres, makes a routing/review plan, generates an actual binary glTF 2.0 (.glb), and writes a JSON provenance/QA report. The deterministic mesh includes material-colored wall panels, repeated windows/frames, a front door, repeating balconies, roof cap and parapet. It keeps a compact no-new-dependency Node implementation so it can be tested in CI.

Run:
  npm run test:building-generation
  npm run generate:building-model -- tests/fixtures/demo-building-spec.json artifacts/dhaka-demo-01.glb

The CLI writes the GLB and a sibling report JSON file. The tracked fixture is synthetic test data, not a survey or a model of a real property.

## Source evidence and confidence

The JSON schema file at repository root documents BuildingSpec version 1.0.0. Each evidence record refers to source IDs and uses one explicit confidence level: verified, derived, estimated, ai-proposed, or unknown. The validator checks values and source links; it does not independently prove the evidence is true. Preserve source URL, author, licence, attribution, capture location/time and reuse-review status before publishing derived assets.

## Media intake and video frames

`src/core/building-generation/media-intake.mjs` accepts local JPEG, PNG, WebP, MP4/MOV, WebM/MKV and PDF files. It checks signatures (not just filename extensions), enforces per-kind byte limits, rejects path traversal and source symlinks, computes SHA-256 and stores assets content-addressed under `.building-engine/media/<buildingId>/assets/`. A per-source JSON record stores relative path, byte count, hash, MIME type, provenance and reuse status. Unknown licence and unreviewed status are the defaults. This is a local workspace adapter, not a production upload API or a durable shared object store.

`video-frame-extractor.mjs` runs FFmpeg as a child process with an argument array (no shell), bounded FPS (0.05–2), frame cap (1–500), output width and timeout. It ingests extracted JPEGs as child `video-frame` sources and records approximate nominal sample times. It does not download remote URLs. Set up a separate workspace and run `npm run ingest:building-media -- <workspaceRoot> <buildingId> <sourceId> <relativeFilePath> [auto|image|video|floor-plan] [fps] [maxFrames]`. FFmpeg is required for video. The CLI defaults to unknown licence and unreviewed use; review each file's rights before publication.

The generator still does not infer geometry from image pixels, extract camera calibration, or reconstruct a mesh. It generates the baseline model from explicit BuildingSpec parameters. Three or more approved, geolocated frames are only a possible photogrammetry candidate, not a claim that views overlap, all show the same building, or a reconstruction has run.

A single exterior photo cannot reveal hidden sides, true measurements, interior rooms or the roof structure. A future approved media worker must validate rights and building identity, sample video with FFmpeg, assess blur/duplicates and camera poses, use a photogrammetry tool such as COLMAP or AliceVision for an eligible multiview set, calibrate scale with known dimensions, and pass mesh/texturing/coordinate QA before human approval.

## Next milestones

1. Production media intake: replace the local workspace adapter with authenticated private uploads, quotas, retention rules and durable object storage.
2. Image/video evidence: approved frame sampling is now present; add blur/duplicate checks, camera heading/location, same-building and overlap review.
3. Photogrammetry worker: run COLMAP/AliceVision only for eligible approved multiview sets; calibrate scale, clean/texturize mesh and validate output.
4. Strategy adapters: procedural, CAD/floor-plan, IFC/BIM, optional AI vision and photogrammetry jobs behind a common job contract.
5. Geometry QA: scale/orientation/georeference checks, degenerate/watertightness checks and side-by-side reference review.
6. Durable Admin workflow: server-side Admin authorization, database-backed versioned BuildingSpec, private storage, async jobs, draft/preview/publish/rollback.
7. Same-map integration: load only reviewed/published GLBs in the existing /map with the generated model layer, without breaking Overture roads/buildings or Ahsan Manzil.

The existing GLB model-layer registry is currently in-memory only. It is not an asset database or authorization layer. Do not expose unauthenticated arbitrary model URL/upload/publish endpoints; a hidden UI is not access control.