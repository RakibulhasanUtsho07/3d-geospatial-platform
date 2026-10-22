# Durable Building Generation Jobs

This feature connects the existing media-to-model workflow to a persistent local queue. It is designed for a trusted operator/control plane and a separately running Node.js worker.

## What it does

- Persists queued generation requests and job status under `.building-engine/generation-queue/jobs/<jobId>/`.
- Exposes authenticated enqueue/list/status endpoints.
- Runs the existing `runMediaToModelWorkflow` in a single local worker, recording attempts, last errors, heartbeats and a bounded retry policy.
- Recovers interrupted jobs when the worker starts, after obtaining the single-worker lock.
- Writes the generated GLB and workflow report to the configured workspace; it does **not** add the model to the map catalog.

Every completed result keeps `mapReady=false` and `publicationEligible=false`. A reviewer must inspect the model, architecture, dimensions, horizontal and vertical reference, provenance and usage rights before using the separate reviewed-model publishing workflow.

## Server configuration

Set these server-side environment variables:

- `GENERATION_API_TOKEN`: a secret bearer token of at least 32 characters. Never expose it to browser JavaScript or commit it to Git.
- `BUILDING_ENGINE_WORKSPACE`: an existing, writable directory shared by the Next.js server and generation worker. Keep this workspace private.
- Optional worker settings: `BUILDING_ENGINE_QUALITY` (`LOW`, `MEDIUM`, `HIGH` or `EXTREME`), `BUILDING_ENGINE_COLMAP_PATH`, `BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT`, `BUILDING_ENGINE_PYTHON_EXECUTABLE`, and `BUILDING_ENGINE_DEVICE`.

The workspace directory must exist before the API or worker starts. The server uses a file-backed queue, so this deployment mode requires a persistent filesystem shared between API and worker. Serverless instances with ephemeral or isolated filesystems are not a suitable queue backend.

## API

All routes require `Authorization: Bearer <GENERATION_API_TOKEN>`. If the secret is missing/too short, the routes fail closed. Responses never provide credentials.

- `POST /api/building-generation/jobs` — enqueue a JSON request and return HTTP 202.
- `GET /api/building-generation/jobs?limit=20` — list up to 100 recent jobs.
- `GET /api/building-generation/jobs/<jobId>` — retrieve status/result/error for a job.

Example request:

```json
{
  "buildingSpec": {
    "schemaVersion": "1.0.0",
    "id": "demo-building",
    "name": "Demo Building",
    "location": { "longitude": 90.4, "latitude": 23.7, "heightM": 0 },
    "footprint": {
      "type": "Polygon",
      "coordinates": [[[90.4,23.7],[90.4001,23.7],[90.4001,23.7001],[90.4,23.7001],[90.4,23.7]]]
    }
  },
  "strategy": "procedural",
  "sources": []
}
```

Use a complete valid BuildingSpec. For supplied media, each source must have a unique `sourceId`, a safe workspace-relative `relativePath`, and a known licence/permission basis; also set `confirmRights: true` only after checking that the rights claim is accurate. Upload/ingest the media into the private workspace first; this API does not itself accept binary media uploads.

For photogrammetry, include at least three `viewSourceIds`, and explicitly set `confirmSameBuilding`, `confirmOverlapReviewed`, `confirmUpAxisReviewed`, and `upAxis`. For single-image AI inference, provide exactly one selected view and set `confirmSingleViewInference: true`. These flags are operator attestations, not independent proof.

## Run the worker

On a machine that can access the same workspace:

```bash
# Poll continuously; stop polling with Ctrl+C after the active job completes
BUILDING_ENGINE_WORKSPACE=/srv/building-engine-workspace node scripts/run-generation-worker.mjs

# Or process at most one available job and exit
BUILDING_ENGINE_WORKSPACE=/srv/building-engine-workspace node scripts/run-generation-worker.mjs --once
```

On Windows PowerShell, set the environment variable first:

```powershell
$env:BUILDING_ENGINE_WORKSPACE = "E:\\building-engine-workspace"
node scripts/run-generation-worker.mjs --once
```

The procedural strategy is the deterministic smoke-test path. Photogrammetry requires the relevant COLMAP setup, and single-image inference requires the separately installed AI worker/dependencies configured for this deployment. The queue itself does not install external models, CUDA, FFmpeg or COLMAP.

## Local outputs and review

Queue state is in `.building-engine/generation-queue/jobs/`. Reconstruction stage artifacts and workflow reports are stored by the existing resumable workflow under `.building-engine/reconstruction-jobs/` and `.building-engine/jobs/`. Back up this workspace if it contains important outputs; do not expose it as a public static directory.

A completed queue job indicates that the workflow produced a review candidate, not that the building is accurate, legally cleared, scaled, georeferenced or publishable. Use the existing QA/review tools and only activate a version through the published-model catalog after a qualified human review.
