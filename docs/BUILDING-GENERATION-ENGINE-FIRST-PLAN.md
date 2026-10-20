# Engine-first plan: information, photos and video to 3D building

**Status:** engine-core prototype. It validates/normalizes requests, plans evidence-based routes, generates a parametric GLB from metric dimensions, offers a local CLI, has a mocked Tripo image/multiview adapter and has a bounded FFmpeg keyframe-extraction worker interface. Protected Admin APIs, durable jobs and real provider credentials remain unconfigured.

## Decision

Build the generation engine before building the map editor. The engine accepts normalized building information and references, selects a route based on evidence quality, tracks asynchronous provider tasks, and produces a candidate that must be validated and reviewed. Connect it to the existing `/map` only after this core is stable.

Use a hybrid pipeline, not one magic AI model:

1. **Measurements + procedural base** own known footprint, floor counts and height.
2. **Image/multiview AI** proposes appearance where reference-processing permission is explicit.
3. **Video preprocessing** extracts frames; the Admin reviews/selects angles before a multiview request.
4. **Photogrammetry** is a separate candidate route for overlapping images with scale/georeference controls. It is not a substitute for architectural CAD/BIM.
5. **GLB QA** checks bounds, units, orientation, materials, textures and consistency with authoritative dimensions.
6. **Admin review** accepts, rejects or regenerates. A successful provider task is not automatically an approved building.

## Input contract

The provider-neutral BuildingGenerationRequest records:

- building type, design brief, style, materials/colours and roof type;
- total height or floor count plus floor-to-floor height;
- rectangular footprint dimensions or a polygon in local metres;
- image/video/plan/elevation/blueprint references and their declared view, purpose and permission;
- quality target and explicit approval for external-provider processing.

Store every important value as verified, derived, estimated, ai_proposed or unknown. Preserve reference ID, licence, generation strategy, provider/model version and human review outcome. Never label inferred rear/hidden facades as verified.

## Evidence-based route policy

| Input evidence | Selected route | Limitation |
|---|---|---|
| Footprint + height/floors | Procedural base | Predictable dimensions; basic appearance until component families are added |
| One authorized photo | Image -> generated multi-view references -> multiview-to-3D | The generated views are AI-inferred, not true measurements; hidden surfaces still need review |
| Two or more authorized labelled views, including front + side/rear | Parametric base + multiview AI candidate | Better view coverage; still needs scale and geometry QA |
| Video walkthrough | Extract candidate frames -> Admin labels/selects -> multiview AI or reconstruction check | A video file should not be sent directly to an image endpoint |
| Overlapping multi-view set + scale/georeference control | Photogrammetry candidate (COLMAP lane) | Requires cleanup, scale alignment and GLB export |
| No reliable dimensions | Visual candidate or request more information | Do not promise metric accuracy |

## Provider adapter

A thin server-side Tripo adapter is implemented behind a provider-replaceable module. For a single photo, the engine now prefers a two-stage task chain: `POST /generation/image-to-multiview` synthesizes front/left/back/right reference views; after that task succeeds, `POST /generation/multiview-to-model` consumes the source task ID to produce the 3D candidate. This matters because a single photo cannot directly reveal hidden sides. For multiple Admin-labelled views or selected video frames, the engine can submit those labelled views directly to multiview-to-model. All tasks are polled asynchronously, and source-task status/type is checked before chaining.

This is a pilot integration choice, not proof that Tripo is the best provider. Benchmark it on a small, representative dataset of Bangladeshi houses/apartments/heritage buildings against at least one alternative before production selection. Provider model identifiers, terms, quotas and prices must be checked again when enabling a real account.

The adapter uploads authorized JPEG/PNG image bytes to the provider using server-side credentials and passes provider file tokens instead of internal asset IDs. The browser must never receive the API key. Do not transmit research-only or unknown-permission images to a provider. The single-photo multiview path incurs an extra asynchronous provider task and may consume additional credits; no live account/credit usage has been tested here.

## Video path

Do not upload a long video directly to an image-to-3D endpoint. The worker should:

1. validate file size/type/duration and permission;
2. decode frames in a resource-limited FFmpeg worker;
3. sample frames, reject blurry/duplicate images and retain source timestamps;
4. group/label front, sides, rear and oblique views, with human confirmation;
5. send selected frames to multiview AI or route a qualified image set to COLMAP;
6. preserve video provenance and frame IDs in the candidate model version.

COLMAP documents an image-reconstruction pipeline that estimates sparse scene geometry and camera poses using Structure-from-Motion, then reconstructs dense geometry with Multi-View Stereo. That result is not automatically a clean architectural model: known scale, georeferencing, semantic cleanup and export are separate requirements.

## Implementation phases

- **E0 — contracts and routing (implemented):** validate requests and return a transparent evidence-based plan.
- **E1 — provider task adapter (implemented/tested with mocks):** upload image references, submit single-image-to-multiview and multiview-to-model tasks, query state and carry source-task lineage through a server-side secret. No real API key is configured; live provider generation/credit usage is not verified.
- **E1b — first procedural GLB output (implemented/tested):** create a dimension-controlled visual shell with floors, floor bands, facade panels/windows, door, flat roof and optional parapet; includes GLB metadata and explicit assumption warnings.
- **E2a — video keyframe extractor (implemented/tested with fake processes):** probe video duration, apply file-size/duration/frame/timeout limits, use FFmpeg without a shell, retain presentation timestamps where available and clean temp output on failure.
- **E2b — video-to-reference orchestration (implemented/tested with adapters):** resolve a private source-video asset, extract frames, write them through a private asset callback, preserve parent video ID/timestamp/licence and return new frames with unknown view labels for Admin review.
- **E2 — persistent job productionization:** Admin authorization, durable jobs, retries/idempotency, cancellation, audit, upload quotas and immutable model artifacts. Provider image upload to Tripo is implemented as an adapter, but the application-level private asset upload service is still an injected dependency.
- **E3 — video quality selection:** add blur/duplicate scoring and Admin frame-selection/label UI; the current extractor samples frames and preserves time metadata but does not score visual quality or infer view direction automatically.
- **E4 — procedural geometry worker (prototype exists; still needs production worker/persistent job integration):** expand beyond the current shell with tested building families, real opening geometry, richer roof families and detailed component controls.
- **E5 — alignment and QA (prototype implemented):** validate GLB chunks/accessors/indexes/scene transforms, safely download only from the provider CDN allowlist, and add a root transform to align scene-space bounds to the measured footprint/height. `uniform-fit` preserves proportions and fits inside the requested envelope; `fit-dimensions` can force exact dimensions but may distort facade/roof proportions. Preview renders and production QA worker remain next.
- **E6 — provider benchmark:** compare the same inputs against Tripo and an alternative; score visual fidelity, footprint/height error, success rate, latency, cost and data policy.
- **E7 — optional photogrammetry/BIM lanes:** COLMAP and source CAD/IFC support after the first one-building round trip works.
- **E8 — connect Admin editor and publishing to existing `/map`:** preview, approve, publish immutable model versions and rollback.

## Mandatory acceptance gates

- invalid units, dimensions, IDs and ambiguous views are rejected;
- unapproved media is not silently sent to an external provider;
- provider calls handle queued/running/success/failed/cancelled and bounded timeouts;
- retries are idempotent and failed tasks never replace an approved model;
- known-size fixtures meet project-defined dimensional tolerances after export;
- single-view outputs are explicitly approximate;
- generated GLB is reopened/rendered in a known viewer before map publishing;
- Admin review is required before publishing any model candidate.

## Official technical references

- Tripo overview and asynchronous task lifecycle: https://developers.tripo3d.ai/en/docs/introduction
- Tripo image-to-3D: https://developers.tripo3d.ai/en/docs/generation-image-to-model
- Tripo multiview-to-3D: https://developers.tripo3d.ai/en/docs/generation-multiview-to-model
- Meshy image-to-3D alternative: https://docs.meshy.ai/en/api/image-to-3d
- Meshy multi-image-to-3D alternative: https://docs.meshy.ai/en/api/multi-image-to-3d
- COLMAP Structure-from-Motion and Multi-View Stereo: https://github.com/colmap/colmap/blob/main/doc/tutorial.rst
- Khronos glTF/GLB specification: https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/Specification.adoc
- OWASP File Upload Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html

References checked on 20 October 2026. The core policy/provider adapter is not yet an end-to-end generator; protected uploads, persistent jobs, video decoding, procedural mesh generation and asset QA remain planned work.

## Try the information-to-GLB prototype locally

A sample BuildingGenerationRequest is included at `data/building-generation/examples/dhaka-apartment.json`. After pulling the feature branch/merge, run:

```powershell
npm run generate:building-model
```

This writes `artifacts/generated-building-draft.glb` (the CLI refuses to overwrite by default). Then open the GLB in Blender or another glTF viewer. To use another JSON spec:

```powershell
npm run generate:building-model -- --input data/building-generation/examples/dhaka-apartment.json --output artifacts/my-building.glb
```

Use `--force` only when intentionally overwriting the selected output file. This path produces a procedural base from information; it does not yet run AI image/video generation or assert photo-match accuracy.

## Current engine modules

- `src/core/building-generation/types.ts` — provider-neutral request/reference/plan types.
- `src/core/building-generation/input-policy.mjs` — validation and evidence-based route planning.
- `src/core/building-generation/procedural-builder.mjs` — pure Node GLB exporter for the first procedural base tier.
- `src/core/building-generation/providers/tripo-client.mjs` — asynchronous upload/image-to-multiview/multiview-to-model provider adapter.
- `src/core/building-generation/engine.mjs` — route analysis, procedural candidates, protected image uploads, video-to-frame references, provider task polling, validated model download, optional dimension alignment and private candidate storage callback.
- `scripts/generate-building-model.mjs` — local CLI to generate a sample `.glb` from a JSON request.

Still not implemented: protected Admin auth/API, durable job/database records, the real application private asset-store implementation, frame blur/duplicate scoring and Admin selection UI, long-running workers/queue/retries, full mesh repair/retopology and photogrammetry. Provider upload/download, FFmpeg orchestration, GLB validation, metric alignment and candidate storage are tested with mocked services, not live credentials or real footage. Dimension alignment uses the GLB scene bounding box; it does not infer floor layouts or guarantee architectural fidelity. The CLI/engine prototype is not yet a finished automatic reconstruction service.
