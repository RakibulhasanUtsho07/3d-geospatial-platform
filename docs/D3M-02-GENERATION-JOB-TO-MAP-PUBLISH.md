# D3M-02 — Approved Generation Job to Cesium Map Publication

**Tracking issue:** [#301](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/301)  
**Implementation branch:** `feat/d3m02-generation-job-map-publish-20261101`  
**Status:** Implementation candidate; exact-head CI and review pending  
**Scope:** Explicit operator publication of an already completed and approved generation job, followed by loading the exact active catalog version into the current Cesium session.

## User flow

1. Create a generation job using the existing authenticated upload/job APIs. The browser queue/worker infrastructure remains separate: `GENERATION_API_TOKEN`, `BUILDING_ENGINE_WORKSPACE`, and a running worker are still required.
2. Wait for the worker to finish and inspect the exact candidate GLB plus its QA report.
3. Record the existing review decision through `POST /api/building-generation/jobs/<jobId>/review`, using `GENERATION_REVIEW_API_TOKEN`. Approval requires every existing checklist item to be true.
4. Open **Generated models** on the 3D map, expand **Publish an approved generation job to this map**, and provide:
   - The exact completed job ID.
   - The `GENERATION_PUBLISH_API_TOKEN` bearer token.
   - Explicit WGS84 longitude, latitude and height, plus heading/pitch/roll, scale and GLB axes.
   - Confirmation that the generated GLB and public catalog metadata will be served publicly.
5. Select **Verify, publish and load model**. The server revalidates the approved job and writes the content-addressed GLB plus the new catalog version. The browser then fetches the public catalog with cache disabled, validates it with `getActivePublishedModels`, checks the exact returned model ID/version ID/SHA-256/URL, and only then asks the existing Cesium `GeneratedModelLayer` to load that catalog definition and focus the camera.
6. The loaded model is part of the current browser map session. The static catalog persists across refreshes; the existing catalog selector can reload it after a page refresh.

## API contract

`POST /api/building-generation/jobs/{jobId}/publish`

Required headers:

- `Authorization: Bearer <GENERATION_PUBLISH_API_TOKEN>`
- `Content-Type: application/json`

Request body:

```json
{
  "placement": {
    "position": {
      "longitude": 90.40606,
      "latitude": 23.70860,
      "height": 0
    },
    "headingDegrees": 0,
    "pitchDegrees": 0,
    "rollDegrees": 0,
    "scale": 1,
    "upAxis": "Y",
    "forwardAxis": "Z"
  }
}
```

The example values are illustrative only. Supply the measured placement for the actual building; do not copy these coordinates as a real Dhaka location.

Success returns HTTP 201 with the job/review/model/version identifiers, asset URL, exact model and report hashes, and the normalized placement. The response deliberately omits local filesystem paths. Responses are marked `Cache-Control: no-store`.

The route uses the common timing-safe bearer-token verifier with a distinct server secret. The body is bounded to 16 KiB. Missing server configuration returns 503; invalid/missing credentials return 401; malformed placement returns 400; a missing job returns 404; a busy catalog lock returns 409; review, status or hash failures return 422. Unexpected server errors are sanitized as 500 responses.

## Integrity and filesystem boundaries

- `BUILDING_ENGINE_WORKSPACE` remains the private, persistent workspace containing the queue request/state, generated GLB, report and immutable review record. The generation API and worker must share this workspace.
- The API passes `process.cwd()` as the application public root. Only the checked content-addressed GLB and static catalog manifest are written under `<application-root>/public/models/generated/`; candidate files and private review records remain in the workspace.
- The app's public directory must be writable and persistent for this deployment mode. If the runtime filesystem is read-only/ephemeral, publication must be performed by a deployment pipeline or a separate durable object-store/catalog service instead; do not report a successful live publish in that environment.
- Before publication, the existing core function rechecks completed job status, approved review decision, queue request checksum and identity, immutable review-record checksum, all required checklist flags, candidate GLB hash, QA-report hash and report status. Workspace-relative files must be regular non-symlink files within the workspace.
- The existing catalog publisher validates the GLB 2.0 container, evidence checksum, review checks, model identity and placement. It stores a versioned content-addressed asset and atomically replaces the manifest.
- Catalog manifest updates are serialized by `.generated-model-catalog.publish.lock`. If a process crashes while holding the lock, an operator must first verify no publisher is active, then remove the stale lock directory before retrying. Do not delete a live lock.
- The browser never loads the API's returned `assetUrl` directly. It rereads the manifest and requires an exact match for model ID, active version ID, SHA-256 and URL before loading.

## Trust and release boundary

The `development` branch's existing generation review API is protected by a shared operator token, with a reviewer label and human-supplied checklist. It is not a cryptographically authenticated reviewer identity. This D3M-02 slice does not integrate or promote the separate stacked D3M-01 signed-review registry PR chain; that work remains an explicit dependency before a stronger reviewer-identity claim can be made.

Publication does not mean independent survey accuracy, rights approval by an external authority, automatic acceptance or production readiness. Job state and response flags remain fail-closed:

- `mapReady=false`
- `publicationEligible=false`
- `groundTruth=false`
- `acceptanceEligible=false`
- `automaticApproval=false`

An explicitly published catalog item can be loaded into a Cesium session while the underlying engineering/release gates remain false. This is an operator-controlled visual placement workflow, not an automated image-to-accurate-building guarantee.

## Verification

Focused suites:

```bash
npm run test:publish-approved-generation-job
npm run test:published-model-catalog
npm run test:generated-model-policy
npm run test:generated-model-layer-boundary
npm run lint
npm run build
```

Synthetic tests validate the queue/review/publisher contract. They do not constitute a real building reconstruction, real rights decision, survey control or accuracy result. Exact-head GitHub Actions is required before this branch can be treated as validated.
