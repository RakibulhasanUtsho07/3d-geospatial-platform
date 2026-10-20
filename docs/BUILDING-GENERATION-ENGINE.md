# Building Generation Engine — first implementation slice

Status: deterministic procedural core implemented; image/video reconstruction, AI vision, CAD/IFC/BIM import, persistent Admin workflow, and photogrammetry workers are not implemented yet.

## What works now

This slice validates a versioned BuildingSpec, converts the georeferenced footprint to local metres, makes a routing/review plan, generates an actual binary glTF 2.0 (.glb), and writes a JSON provenance/QA report. The deterministic mesh includes material-colored wall panels, repeated windows/frames, a front door, repeating balconies, roof cap and parapet. It keeps a compact no-new-dependency Node implementation so it can be tested in CI.

Run:
  npm run test:building-generation
  npm run generate:building-model -- tests/fixtures/demo-building-spec.json artifacts/dhaka-demo-01.glb

The CLI writes the GLB and a sibling report JSON file. The tracked fixture is synthetic test data, not a survey or a model of a real property.

## Source evidence and confidence

The JSON schema file at repository root documents BuildingSpec version 1.0.0. Each evidence record refers to source IDs and uses one explicit confidence level: verified, derived, estimated, ai-proposed, or unknown. The validator checks values and source links; it does not independently prove the evidence is true. Preserve source URL, author, licence, attribution, capture location/time and reuse-review status before publishing derived assets.

## What happens to images and video right now?

Visual sources are stored as provenance and considered by the strategy planner, but this version does not run image understanding, extract video frames, or reconstruct geometry from media. It still generates the base model from explicit dimensions, footprint and facade parameters, and it warns that the model is procedural. Three or more geolocated and licence-approved media records are only a photogrammetry candidate, not a claim that a photogrammetry worker ran or that images overlap/show the same building.

A single exterior photo cannot reveal hidden sides, true measurements, interior rooms or the roof structure. A future approved media worker must validate rights and building identity, sample video with FFmpeg, assess blur/duplicates and camera poses, use a photogrammetry tool such as COLMAP or AliceVision for an eligible multiview set, calibrate scale with known dimensions, and pass mesh/texturing/coordinate QA before human approval.

## Next milestones

1. Media intake: private uploads/job storage, file-type/size limits, SHA-256, metadata capture and licence/retention rules.
2. Image/video evidence: approved frame sampling, blur/duplicate checks, camera heading/location, same-building and overlap review.
3. Strategy adapters: procedural, CAD/floor-plan, IFC/BIM, optional AI vision and photogrammetry jobs behind a common job contract.
4. Geometry QA: scale/orientation/georeference checks, degenerate/watertightness checks and side-by-side reference review.
5. Durable Admin workflow: server-side Admin authorization, database-backed versioned BuildingSpec, private storage, async jobs, draft/preview/publish/rollback.
6. Same-map integration: load only reviewed/published GLBs in the existing /map with the generated model layer, without breaking Overture roads/buildings or Ahsan Manzil.

The existing GLB model-layer registry is currently in-memory only. It is not an asset database or authorization layer. Do not expose unauthenticated arbitrary model URL/upload/publish endpoints; a hidden UI is not access control.