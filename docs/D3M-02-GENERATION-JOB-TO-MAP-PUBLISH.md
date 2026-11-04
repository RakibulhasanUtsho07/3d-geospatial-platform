# D3M-02 — Approved Generation Job to Cesium Map Publication

**Tracking issue:** [#301](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/301)  
**Implementation branch:** `feat/d3m02-generation-job-map-publish-20261101`  
**Status:** D3M-02 base publication workflow merged to main through PR #302 (2026-11-03); D3M-06 review-bound placement and the signed catalog publication hardening are included in the current open PR #351 candidate.  
**Scope:** Explicit operator publication of an already completed and approved generation job, followed by loading the exact active catalog version into the current Cesium session.

## User flow

1. Create a generation job using the existing authenticated upload/job APIs. The browser queue/worker infrastructure remains separate: `GENERATION_API_TOKEN`, `BUILDING_ENGINE_WORKSPACE`, and a running worker are still required.
2. Wait for the worker to finish and inspect the exact candidate GLB plus its QA report.
3. Record the review decision through `POST /api/building-generation/jobs/<jobId>/review`, using `GENERATION_REVIEW_API_TOKEN`. Approval requires every checklist item to be true **and** stores the exact placement that was reviewed. The reviewer label is not yet authenticated by this write operation.
4. On the trusted reviewer's workstation, create an Ed25519 receipt for that exact immutable approval (procedure below). The local signing CLI re-hashes the review record, candidate GLB and QA report; the private key never leaves the reviewer's machine.
5. Open **Generated models** on the 3D map, expand **Publish an approved generation job to this map**, and provide:
   - The exact completed job ID.
   - The `GENERATION_PUBLISH_API_TOKEN` bearer token.
   - The signed publication-review JSON receipt.
   - The exact WGS84 longitude/latitude, WGS84-ellipsoid height, heading/pitch/roll, scale and GLB axes captured by the approved review. A changed value is rejected.
   - Confirmation that the generated GLB and public catalog metadata will be served publicly.
6. Select **Verify, publish and load model**. The server revalidates the approved job and writes the content-addressed GLB plus the new catalog version. The browser then fetches the public catalog with cache disabled, validates it with `getActivePublishedModels`, checks the exact returned model ID/version ID/SHA-256/URL, and only then asks the existing Cesium `GeneratedModelLayer` to load that catalog definition and focus the camera.
7. The loaded model is part of the current browser map session. The static catalog persists across refreshes; the existing catalog selector can reload it after a page refresh.

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
    "heightReference": "WGS84-ellipsoid",
    "headingDegrees": 0,
    "pitchDegrees": 0,
    "rollDegrees": 0,
    "scale": 1,
    "upAxis": "Y",
    "forwardAxis": "Z"
  },
  "reviewReceipt": {
    "submission": {
      "schemaVersion": "1.0.0",
      "recordType": "d3m02-generation-job-signed-publication-review",
      "jobId": "the-exact-job-id",
      "buildingId": "the-exact-building-id",
      "reviewRecordSha256": "64-lowercase-hex-characters",
      "candidateGlbSha256": "64-lowercase-hex-characters",
      "qaReportSha256": "64-lowercase-hex-characters",
      "placementSha256": "64-lowercase-hex-characters",
      "reviewerId": "trusted-reviewer-id",
      "reviewedAtUtc": "2026-11-04T05:00:00.000Z",
      "decision": "approve-for-catalog-handoff"
    },
    "signatureBase64": "canonical-64-byte-ed25519-signature"
  }
}
```

The example values are illustrative only. The same complete object must have been included in the approved review request. Supply the measured placement for the actual building; do not copy these coordinates as a real Dhaka location. Height is interpreted as WGS84 ellipsoid height because the Cesium layer uses the WGS84 ellipsoid; convert orthometric/local heights before review and publication.

Success returns HTTP 201 with the job/review/model/version identifiers, asset URL, exact model and report hashes, and the normalized placement. The response deliberately omits local filesystem paths. Responses are marked `Cache-Control: no-store`.

The review API and local publication CLI use the same placement contract. The CLI supplies the fixed `WGS84-ellipsoid` height-reference marker; the human-reviewed values must otherwise match exactly. Legacy approval records without a placement digest are rejected.

The route uses the common timing-safe bearer-token verifier with a distinct server secret. The body is bounded to 16 KiB and must contain both `placement` and `reviewReceipt`. Missing or invalid trusted-key registry configuration returns 503; invalid/missing credentials return 401; malformed placement/receipt envelope returns 400; a missing job returns 404; a busy catalog lock returns 409; untrusted/invalid signatures, cross-job receipt substitution, status or hash failures return 422. Unexpected server errors are sanitized as 500 responses.


## Trusted Ed25519 publication approval

The review API's bearer token authorizes the request to record a review; the caller-supplied `reviewer` label is not individual identity proof. Therefore the public catalog handoff now requires a second, independently signed decision from a currently trusted D3M-01 reviewer.

After the immutable review record is written, the trusted reviewer signs it locally:

```powershell
npm run sign:approved-generation-job-publication-review -- `\
  "D:\\BuildingEngineWorkspace" "<job-id>" `\
  --private-key "D:\\ReviewerKeys\\<reviewer-id>-ed25519-private.pem" `\
  --out "D:\\BuildingEngineWorkspace\\signed-generation-publication-review.json"
```

The signing command rechecks the immutable review-record checksum, exact candidate GLB bytes and exact QA-report bytes before preparing the payload. The signature covers the job ID, building ID, exact review-record SHA-256, candidate GLB SHA-256, QA-report SHA-256, reviewed placement SHA-256, reviewer ID, review timestamp and the explicit `approve-for-catalog-handoff` decision. It uses the same canonical UTF-8 JSON signing format as D3M-01 (recursively sorted object keys, array order preserved, compact JSON, no trailing newline).

Keep the private key only on the trusted reviewer's protected workstation/key store. Do not upload it to the application, put it in the generation workspace, pass it to the publication API, commit it or paste it into logs. The output receipt contains only the submission and public signature; upload that JSON receipt in the map panel. The server reads trust anchors exclusively from `RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON`; production requires the versioned, time-bounded, revocable public-key-only registry. An untrusted/revoked/expired key, missing registry, altered review record, candidate, report or placement is rejected before catalog writes.

The catalog version records the authenticated reviewer ID, key ID, registry ID, public-key fingerprint, signed-payload hash, signature hash and receipt hash. A valid signature proves key possession, not the person's civil identity, legal/professional authority, source rights, survey accuracy or vertical datum. Those still require the platform's separate governance and evidence processes.

## Integrity and filesystem boundaries

- `BUILDING_ENGINE_WORKSPACE` remains the private, persistent workspace containing the queue request/state, generated GLB, report and immutable review record. The generation API and worker must share this workspace.
- The API passes `process.cwd()` as the application public root. Only the checked content-addressed GLB and static catalog manifest are written under `<application-root>/public/models/generated/`; candidate files and private review records remain in the workspace.
- The app's public directory must be writable and persistent for this deployment mode. If the runtime filesystem is read-only/ephemeral, publication must be performed by a deployment pipeline or a separate durable object-store/catalog service instead; do not report a successful live publish in that environment.
- Before publication, the core function rechecks completed job status, approved review decision, queue request checksum and identity, immutable review-record checksum, all required checklist flags, candidate GLB hash, QA-report hash and report status. It also recomputes the canonical placement hash and requires the submitted transform to match the transform in both the immutable approval record and job summary exactly. Workspace-relative files must be regular non-symlink files within the workspace.
- Approved review payloads must include `placement` with explicit finite longitude, latitude, height, heading, pitch, roll and scale, distinct GLB up/forward axes, and `heightReference: "WGS84-ellipsoid"`. Legacy approved records without this binding are not publishable through D3M-06.
- The existing catalog publisher validates the GLB 2.0 container, evidence checksum, review checks, model identity and placement. It stores a versioned content-addressed asset and atomically replaces the manifest.
- Catalog manifest updates are serialized by `.generated-model-catalog.publish.lock`. If a process crashes while holding the lock, an operator must first verify no publisher is active, then remove the stale lock directory before retrying. Do not delete a live lock.
- The browser never loads the API's returned `assetUrl` directly. It rereads the manifest and requires an exact match for model ID, active version ID, SHA-256 and URL before loading.

## Trust and release boundary

The generation review-write API is protected by a shared operator token and stores a reviewer label/checklist, but that first write is not individual identity proof. **Catalog publication is now separately gated** by an Ed25519 receipt from the D3M-01 server-configured trusted-reviewer registry, bound to the exact immutable review record, candidate, QA report and placement. A caller cannot publish merely by choosing a reviewer name. The signing key remains on the trusted reviewer's workstation; only the signed receipt is sent to the publication API. The signature authenticates key possession only; the platform operator must establish the reviewer's identity and authority separately.

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
npm run sign:approved-generation-job-publication-review -- --help
npm run publish:approved-generation-job -- --help
npm run test:published-model-catalog
npm run test:generated-model-policy
npm run test:generated-model-layer-boundary
npm run lint
npm run build
```

Synthetic tests validate the queue/review/publisher contract. They do not constitute a real building reconstruction, real rights decision, survey control or accuracy result. Exact-head GitHub Actions is required before this branch can be treated as validated.

## Exact-input pinning at the catalog writer boundary — 2026-11-04

The reviewed-job publisher now computes SHA-256 for the exact candidate GLB and the exact attestation bytes it creates, then passes both digests as required expected-input guards to the generic catalog writer. The writer re-reads the two files and checks those digests **before** parsing the attestation, creating a content-addressed asset or writing the manifest.

This closes a filesystem TOCTOU gap between upstream review/placement validation and the catalog writer's own file reads. If either the candidate or attestation changes between those operations, publication fails before any public catalog write. The generic writer keeps these expected digests optional for existing direct callers; the D3M-02 approved-job flow always supplies both.

Regression coverage injects mismatching expected candidate and attestation hashes and verifies that no catalog manifest is created. This proves the final-read guard; it is not a replacement for private workspace ACLs, a trusted reviewer identity, source rights, or independent survey evidence.
