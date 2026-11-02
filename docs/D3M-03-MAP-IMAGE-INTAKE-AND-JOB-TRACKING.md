# D3M-03 — Map-side Image Intake and Generation Job Tracking

**Tracking issue:** [#303](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/303)  
**Dependency:** [D3M-02 PR #302](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/302)  
**Implementation branch:** `feat/d3m03-map-generation-intake-20261102`  
**Status:** Implementation candidate; exact-head Full CI passed on `3e4aba47126e585f39ff91a0cc55dc91d38ada78`; strategy-format compatibility fix added afterward and awaiting its own exact-head CI

## User flow

1. Open **3D Map → Generated models → Upload images and start building generation**.
2. Connect the operator session using the deployment's `GENERATION_OPERATOR_LOGIN_TOKEN`. The token is sent once to the same-origin session endpoint and cleared from the React component after success. The server returns a 30-minute `HttpOnly; SameSite=Strict` cookie, marked `Secure` in production and scoped to `/api/building-generation`.
3. Enter the building ID/name, WGS84 center, reference height, footprint width/depth, floor count/floor height and footprint heading. These are explicit operator inputs. The UI converts a metric rectangle to a WGS84 GeoJSON polygon; it does not derive dimensions or coordinates from an image.
4. Select up to 12 JPEG/PNG/WebP facade images (maximum 20 MiB each). Each file is sent sequentially to the existing `POST /api/building-generation/uploads` endpoint. The server checks the actual file signature, hashes and stores it under the private workspace. The UI uses the exact returned `source.relativePath` and source ID; it does not guess any content-addressed path. WebP is accepted by general intake/procedural use, but selected views for single-image AI and COLMAP photogrammetry must be JPEG/PNG; the UI and queue both reject WebP for those strategies before job creation.
5. Enter a non-unknown licence/permission basis, optional author/attribution, and explicitly confirm rights. This checkbox is an operator attestation only. The source record remains `usageStatus=unreviewed` until the existing rights-review workflow records a decision.
6. Choose a generation strategy and explicitly authorize the required source-operation scopes (separate from copyright/reuse rights):
   - **Single-image AI:** `private-media-ingestion` plus `single-image-ai-reconstruction`; exactly one image plus explicit single-view inference confirmation. Hidden/rear geometry is inferred, not observed. The AI worker/runtime must be installed and configured.
   - **Multi-view photogrammetry:** `private-media-ingestion`, `photogrammetry-reconstruction` and `texture-baking`; at least three images plus same-building, overlap and up-axis confirmations. The COLMAP worker/runtime must be configured.
   - **Procedural:** `private-media-ingestion` plus `procedural-model-derivation`; creates a parameter-driven model from the dimensions/architecture input. It does **not** infer facade geometry from the uploaded images; the images are retained as private source records.
   
   Both the rights attestation and operation-scope authorization are required. The helper and server queue record the exact least-privilege scope list for the chosen strategy; the worker's rights-review stage writes that reviewed scope into the source provenance.
7. Select **Upload images and create generation job**. After every upload succeeds, the UI sends the exact returned file paths to `POST /api/building-generation/jobs`. The existing durable queue performs its own path, file-size, licence, strategy and selected-view image-signature checks before creating the job.
8. The UI polls the job status and worker health every 5 seconds while the job is queued/running. Polling stops on completed or failed status. An existing job can be tracked by job ID while an operator session is active.
9. A completed job is only a candidate. Inspect the GLB and QA report, record the separate review, and use D3M-02's publication panel only after review and explicit placement.

## Operator session configuration

The browser must not receive the server's long-lived `GENERATION_API_TOKEN` or `GENERATION_OPERATOR_SESSION_SECRET`.

Configure these server-side environment variables:

- `GENERATION_OPERATOR_LOGIN_TOKEN`: unique random passphrase of at least 32 characters. The operator types it once to connect. Do not reuse the generation, review or publication bearer tokens.
- `GENERATION_OPERATOR_SESSION_SECRET`: different random secret of at least 32 characters used only to HMAC-sign the short-lived session cookie. Never send this value to a browser.
- `BUILDING_ENGINE_WORKSPACE`: persistent private directory shared by the Next.js API and worker.
- Existing `GENERATION_API_TOKEN`, `GENERATION_REVIEW_API_TOKEN` and `GENERATION_PUBLISH_API_TOKEN` remain supported by their respective API/CLI workflows. The browser intake UI uses the operator session cookie instead of exposing the generation bearer token.

The login endpoint is `POST /api/building-generation/operator-session`. It requires a same-origin JSON request with `{ "token": "<operator login token>" }`. Success sets an HttpOnly cookie with a 30-minute lifetime; the response body never contains the session value. `GET` reports whether the cookie is valid and `DELETE` clears it.

The intake/upload, queue, job-status and worker-status routes accept either their existing generation bearer token (for trusted CLI/service callers) or the short-lived operator cookie. Cookie-authenticated writes require an exact same-origin `Origin` header. The cookie is `SameSite=Strict`, `HttpOnly`, scoped to the generation API path, and `Secure` in production. It is not readable by browser JavaScript and is not stored in localStorage.

This repository does not implement user accounts or a multi-user identity provider. The operator login token is a shared deployment credential; restrict distribution, use HTTPS, rotate it, and apply login rate limiting at the reverse proxy/WAF. Do not expose the generation API publicly without an operator-access policy.

## Upload and retry behavior

- Browser preflight allows at most 12 images, JPEG/PNG/WebP only, 20 MiB each. The upload API performs authoritative signature and size validation.
- Uploads are sequential to reduce memory and concurrent file writes.
- Each image receives a deterministic source ID derived from the SHA-256 content and normalized licence. The upload service checks the existing private source record and actual asset hash before deciding whether to reuse it. If upload N fails, source records successfully returned for images 1..N-1 remain in the component's in-memory retry cache while the map dialog stays mounted. Re-selecting the same file with the same building ID and licence reuses its previously returned source record. If the server stored an upload but the response was lost, retrying the deterministic source ID returns the existing record only when its bytes and licence match; different content or metadata is rejected.
- The retry cache is not persisted across page refresh or dialog unmount. The deterministic content-plus-licence source ID and server-side idempotency permit a later retry to recover the existing record without duplicating it, provided the same building ID, file bytes and licence are supplied. No private relative path is stored in localStorage.
- Source assets and source records remain in `BUILDING_ENGINE_WORKSPACE/.building-engine/media/<buildingId>/`; they are never copied into the public static model directory by intake.
- The generation job queue requires each source to have a known licence/permission string and `confirmRights=true`. These checks are syntactic/operator attestations; they do not prove copyright permission.

## Geometry and strategy boundaries

The new helper `src/core/building-generation/generation-map-intake.mjs` constructs a rectangular GeoJSON footprint from WGS84 center, metric width/depth and heading. It labels footprint and floor-count evidence as estimated and explicitly notes that the geometry is not surveyed. This helper does not infer a building's location, actual footprint or vertical datum.

The helper also builds strategy-specific queue requests and mirrors the server-side queue conditions. The server queue remains authoritative. `auto` is intentionally not exposed by the map UI because the current dispatch's auto route is not a guarantee of image-based reconstruction.

## Job status

The UI consumes:

- `GET /api/building-generation/jobs/<jobId>` for queue state, phase, attempts and candidate status.
- `GET /api/building-generation/worker-status` for online/offline/stale heartbeat and sanitized per-strategy readiness (procedural, COLMAP, and single-image AI).

A worker may run on a separate host, but it must access the exact same persistent private workspace. If it is offline or stale, a job remains queued; a queued response is not proof that reconstruction has begun. When a worker is online but a strategy is blocked, that job also stays queued without incrementing its attempt count until a compatible worker is available. The status panel displays the probe blockers.

The UI does not display private filesystem paths, mark any job publication-ready, or auto-place a candidate into Cesium. D3M-02 remains the separate review-approved publication hand-off.

## Verification

Focused commands:

```bash
npm run test:generation-map-intake
npm run test:generation-media-upload
npm run test:generation-queue
npm run lint
npm run build
```

CI now includes the map intake helper suite. Passing synthetic tests validates geometry/request policy only; it does not prove real-world building reconstruction accuracy, source rights, surveyed coordinates or vertical datum.
