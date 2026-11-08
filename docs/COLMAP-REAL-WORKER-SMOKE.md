# COLMAP real-worker smoke procedure

**Purpose:** verify one real, queue-backed multi-view photogrammetry execution on a provisioned worker host. This is an operator procedure, not an automated CI smoke or a claim that any building has passed.

**Current evidence state (2026-11-08):** the repository contains a COLMAP worker and fixture tests, but no verified operator-host reconstruction result is recorded here. The worker startup capability probe runs the four COLMAP subcommands with --help; that proves only that the executable can start those CLI entry points. A real photogrammetry queue job is required to exercise image matching, sparse/dense reconstruction, texturing and GLB export.

## Scope and safety

The worker accepts 3–120 distinct, non-duplicate JPEG/PNG images or extracted video-frame images for one building. Use genuine overlapping views of the same building, with sufficient viewpoint variation; three files are only the minimum input count, not a promise of reconstructability. The worker rejects duplicate image content and source records that do not match the BuildingSpec identity, asset hash, licence and operation scopes.

Every selected source must have a reviewed permission basis and the required scopes: **private-media-ingestion**, **photogrammetry-reconstruction**, and **texture-baking**. The owner/operator must separately attest source rights, operation scopes, same-building identity, overlap review and source up-axis. These are explicit operator attestations; they are not independent legal clearance, automated building-identity verification or survey proof. Do not use images whose rights do not permit the intended reconstruction/texture operations.

Keep the source images, workspace, COLMAP intermediates, textured PLY/texture and GLB private. Do not commit or upload raw images, COLMAP workspaces, model output or raw logs to Git.

## Worker-host preflight

On the actual machine that will process the queue, check the installed executable:

~~~powershell
colmap -h
colmap automatic_reconstructor --help
colmap model_analyzer --help
colmap model_converter --help
colmap mesh_texturer --help
~~~

If COLMAP is not on PATH, set BUILDING_ENGINE_COLMAP_PATH to the exact executable path. From the repository root, set the same persistent private workspace used by the Next.js API:

~~~powershell
$env:BUILDING_ENGINE_WORKSPACE = "D:\\BuildingEngineWorkspace"
$env:BUILDING_ENGINE_COLMAP_PATH = "<absolute-path-to-colmap-executable>"
node scripts/run-generation-worker.mjs --help
~~~

The actual worker startup probe also checks the four subcommands above using bounded --help calls. A photogrammetry.status=ready result is a command-availability signal only. It does not test image decoding, feature extraction, matching, GPU kernels, sparse registration, dense reconstruction, meshing, texturing or GLB quality. Check authenticated GET /api/building-generation/worker-status for the worker heartbeat and per-strategy readiness; it must share the same BUILDING_ENGINE_WORKSPACE.

## Prepare and queue one job

1. Prepare a complete, schema-valid BuildingSpec for the target building. Its sources entries must refer to the same source IDs, asset IDs, licence values and operation scopes as the ingested source records.
2. Upload each rights-cleared JPEG/PNG through POST /api/building-generation/uploads (or the supported local media-intake CLI). Use the exact source.relativePath returned by the upload response. Do not guess a content-addressed path or rename WebP bytes to .jpg; convert them to actual JPEG/PNG bytes first.
3. Select at least three distinct sourceId values for the same building and set them as viewSourceIds. Confirm that they overlap visually and provide enough different camera positions; remove duplicate frames and near-identical views.
4. Set all source records and BuildingSpec source entries to the exact required least-privilege scopes. Submit separate explicit confirmations: confirmRights, confirmOperationScopes, confirmSameBuilding, confirmOverlapReviewed and confirmUpAxisReviewed. Choose upAxis from the actual source/capture convention; do not guess it.
5. Add measured scale inputs only when a real dimension was independently measured: modelDistanceUnits and realDistanceM must be supplied together. Without them, the report is preview-only and must not be treated as metric scale.

The authenticated job endpoint is POST /api/building-generation/jobs. Minimal shape (not a complete BuildingSpec; replace every placeholder with the exact upload response and independently checked evidence):

~~~json
{
  "buildingSpec": { "...": "complete schema-valid BuildingSpec including matching source records" },
  "strategy": "photogrammetry",
  "sources": [
    { "sourceId": "front-view", "relativePath": "<exact upload relativePath>", "kind": "image", "licence": "<verified permission basis>", "permittedOperations": ["private-media-ingestion", "photogrammetry-reconstruction", "texture-baking"] },
    { "sourceId": "left-view", "relativePath": "<exact upload relativePath>", "kind": "image", "licence": "<verified permission basis>", "permittedOperations": ["private-media-ingestion", "photogrammetry-reconstruction", "texture-baking"] },
    { "sourceId": "right-view", "relativePath": "<exact upload relativePath>", "kind": "image", "licence": "<verified permission basis>", "permittedOperations": ["private-media-ingestion", "photogrammetry-reconstruction", "texture-baking"] }
  ],
  "viewSourceIds": ["front-view", "left-view", "right-view"],
  "confirmRights": true,
  "confirmOperationScopes": true,
  "confirmSameBuilding": true,
  "confirmOverlapReviewed": true,
  "confirmUpAxisReviewed": true,
  "upAxis": "Y"
}
~~~

The placeholder IDs and axis are examples only. Use unique real IDs and the actual reviewed up-axis. Do not set an attestation to true unless the source owner/operator has actually reviewed and authorized it. The request must include every selected source in both request-level sources and the BuildingSpec's sources with matching identity/rights metadata.

Example PowerShell submission (run from a trusted local operator shell; never paste the bearer token into a chat, issue or repository):

~~~powershell
$headers = @{ Authorization = "Bearer $env:GENERATION_API_TOKEN" }
$body = Get-Content -Raw ".\\photogrammetry-job.json"
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/building-generation/jobs" -Headers $headers -ContentType "application/json" -Body $body
~~~

The API and worker must use the same persistent workspace. Queue authentication requires GENERATION_API_TOKEN; keep it server-side.

## Execute the worker

In a second trusted shell on the worker host:

~~~powershell
$env:BUILDING_ENGINE_WORKSPACE = "D:\\BuildingEngineWorkspace"
$env:BUILDING_ENGINE_COLMAP_PATH = "<absolute-path-to-colmap-executable>"
node scripts/run-generation-worker.mjs --once
~~~

Use --once for one job, or omit it for continuous polling. The worker claims only strategies that passed its startup readiness probe. An unavailable photogrammetry strategy leaves the job queued without consuming a retry attempt. API and worker must resolve the same BUILDING_ENGINE_WORKSPACE; a different or ephemeral workspace is not valid for this file-backed queue.

Poll GET /api/building-generation/jobs/<jobId> with the same bearer token. Save the sanitized response and private report location in the evidence log. Do not treat worker-status=online or photogrammetry.status=ready as a completed reconstruction.

## Required result checks

A complete workflow normally executes these actual commands:

1. **colmap automatic_reconstructor** — feature extraction/matching and sparse/dense reconstruction.
2. **colmap model_analyzer** — sparse reconstruction metrics when a sparse model is present.
3. **colmap model_converter** — exports the sparse model to text for camera/point coverage analysis.
4. **colmap mesh_texturer** — generates a textured mesh.
5. The repository converter exports the textured PLY/PNG to GLB and geometry QA inspects the GLB structure/topology.

Do not mark the run as passed only because COLMAP exited with code zero. Confirm the job result is completed-requires-review, with the exact expected building/job/source IDs and GLB SHA-256. Review image-quality preflight (flagged views, near-duplicate pairs and warnings); reconstruction diagnostics (input/registered camera counts and ratio, sparse points/observations/track metrics and reprojection error when available); camera coverage; textured PLY and texture output existence; GLB byte length/hash/mesh/geometry summary; and every workflow warning.

If sparse model metrics or camera-coverage diagnostics are unavailable, record them as unavailable; do not substitute zero or infer a pass. Heuristic diagnostics are review hints, not proof of camera overlap, completeness or accuracy.

## Independent GLB inspection and release boundary

Open the exact GLB whose SHA-256 is in the report in an independent viewer such as Blender. Inspect the full exterior, underside/roof, detached components, topology, normals, mesh density, texture/material/UV coverage, holes, seams and occlusion artefacts. Compare it with the exact permitted reference views. Record defects and the exact GLB hash.

The current COLMAP worker does **not** compute ground-control-point registration to WGS84. The BuildingSpec location is a placement hint only. Unless separate reviewed survey/control evidence is supplied through an appropriate workflow, georeference remains unsolved. A known-distance scale check does not determine horizontal placement, heading, vertical datum or building identity.

A technical completion remains completed-requires-review; it is not architectural acceptance. Keep mapReady=false, publicationEligible=false, automaticApproval=false and groundTruth=false. Do not publish or place the candidate into the live map catalog from this smoke.

## Evidence and privacy

Fill one copy of [the COLMAP real-worker evidence log](evidence-templates/COLMAP-REAL-WORKER-SMOKE-LOG.md). Retain raw images, private queue workspace, COLMAP intermediate files, workflow report and GLB only in access-controlled storage. Commit only the sanitized evidence log after a reviewer confirms it contains no private paths, raw logs, credentials or restricted source data.

References: [Durable generation jobs, API and worker](GENERATION-JOBS-API-AND-WORKER.md); [Generation worker health and strategy readiness](GENERATION-WORKER-HEALTH.md); [D3M-05 single-image real-worker procedure](D3M-05-SINGLE-IMAGE-RUNTIME-SMOKE.md).
