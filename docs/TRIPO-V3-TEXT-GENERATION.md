# Tripo V3 text-to-3D candidate route

The current generation pipeline supports a deterministic procedural route, COLMAP photogrammetry and a local TripoSR single-image preview. This document describes a separate, explicitly opt-in Tripo cloud API route for generating a visual candidate from the structured BuildingSpec brief.

## Scope and safety boundary

- The route calls the official Tripo V3 `POST /generation/text-to-model` endpoint, polls `GET /tasks/{task_id}`, then downloads the returned GLB from the documented model CDN.
- Configure `TRIPO_API_KEY` as a server-side environment secret. Never send the key in a request body, browser bundle, source file, or command-line argument.
- Running the route requires both `strategy: "tripo-text"` and `allowPaidProviderGeneration: true`. The CLI also requires `--confirm-paid-provider-generation`; this prevents accidental provider calls from the default `auto` strategy.
- Provider generation may consume account credits. Check the current provider account/billing terms before an operator starts a job. CI tests use a mocked provider and never call the paid API.
- The prompt is composed from the BuildingSpec's name, architectural style, declared floor information, approximate footprint proportions and facade features. Geographic coordinates are not sent to the provider.
- The output is only an AI-proposed visual candidate. The runner validates the downloaded GLB structure/geometry and stores its hash, but does not make it survey-accurate, align it to metric controls, solve WGS84 placement, or approve publication.

## Run from PowerShell

Set the API key in the current terminal session:

```powershell
$env:TRIPO_API_KEY = "<your Tripo API key>"
npm run generate:building-from-brief -- . .\building-spec.json tripo-job-001 --confirm-paid-provider-generation
```

The output is stored under:

```text
.building-engine/jobs/<buildingId>/<jobId>-tripo-v3-text/
  candidate.glb
  report.json
```

The report keeps `mapReady`, `publicationEligible` and `automaticApproval` false, and records the exact prompt, provider task ID, GLB byte count/hash and structural geometry QA.

## Programmatic route

```js
import { generateBuildingAsset } from "./src/core/building-generation/generation-pipeline.mjs";

const result = await generateBuildingAsset(buildingSpec, {
  strategy: "tripo-text",
  tripo: {
    workspaceRoot: process.cwd(),
    jobId: "tripo-job-001",
    allowPaidProviderGeneration: true,
  },
});
```

The API key is read from `TRIPO_API_KEY` by default. Tests inject a mock `fetchImpl`; production callers should not accept API keys from browser-controlled input.

## Provider references

- Introduction and V3 endpoint overview: https://developers.tripo3d.ai/en/docs/introduction
- Text to 3D Model (H Series): https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard
- Task Query: https://developers.tripo3d.ai/en/docs/task-query

The client pins the default geometry model to `v3.1-20260211`, uses `auto_size: false`, validates the task ID/status, and accepts model downloads only from `https://cdn.tripo3d.ai`.
