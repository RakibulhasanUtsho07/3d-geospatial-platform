# Engine-first plan: information, photos and video to 3D building

**Status:** first engine-core slice; not yet an end-user/Admin product. The provider client is mock-tested; real generation requires the Admin upload/job workflow and a server-side API key.

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
| One authorized photo | Parametric base + image-to-3D candidate | Hidden sides are inferred |
| Two or more authorized labelled views, including front + side/rear | Parametric base + multiview AI candidate | Better view coverage; still needs scale and geometry QA |
| Video walkthrough | Extract candidate frames -> Admin labels/selects -> multiview AI or reconstruction check | A video file should not be sent directly to an image endpoint |
| Overlapping multi-view set + scale/georeference control | Photogrammetry candidate (COLMAP lane) | Requires cleanup, scale alignment and GLB export |
| No reliable dimensions | Visual candidate or request more information | Do not promise metric accuracy |

## Provider adapter

A thin server-side Tripo adapter is implemented behind a provider-replaceable module. Tripo documents image-to-3D and multiview-to-3D task endpoints, API-key authentication and an asynchronous task lifecycle. Its multiview endpoint expects named front/left/back/right views; front and at least one other view are required.

This is a pilot integration choice, not proof that Tripo is the best provider. Benchmark it on a small, representative dataset of Bangladeshi houses/apartments/heritage buildings against at least one alternative before production selection. Provider model identifiers, terms, quotas and prices must be checked again when enabling a real account.

The adapter accepts provider-issued file tokens or public HTTPS asset URLs. A future protected upload worker must upload authorized files server-side and supply provider tokens. The browser must never receive the API key. Do not transmit research-only or unknown-permission images to a provider.

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

- **E0 — contracts and routing:** validate requests and return a transparent plan without network or filesystem access. The first implementation slice adds this policy.
- **E1 — async provider task adapter:** submit image/multiview tasks and query state through a server-side secret. Mocked tests cover request shape and failure cases; real credentials are not configured.
- **E2 — upload and job persistence:** Admin authorization, private storage, provider file upload tokens, durable jobs, retries, cancellation and audit.
- **E3 — video worker:** keyframe extraction, deduplication/blur scoring and view-selection workflow.
- **E4 — procedural geometry worker:** generate a correctly dimensioned shell from footprint and height, then add reusable building families.
- **E5 — alignment and QA:** preserve authoritative dimensions, establish origin/heading/scale, validate GLB and create preview renders.
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
