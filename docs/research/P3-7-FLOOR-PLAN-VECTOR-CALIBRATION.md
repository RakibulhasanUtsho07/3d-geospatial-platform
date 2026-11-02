# P3.7 — Floor-plan raster to reviewed vector calibration

## Purpose and status

This slice bridges the existing raster line-proposal report to the existing measured FloorPlanGeometry/GLB shell generator. It is an engineering candidate, not an automatic floor-plan understanding model. Its job is to convert only a fully reviewed line/room trace with explicitly supplied scale and placement into a source-bound metre-space vector JSON draft.

No model is automatically published. The acceptanceEligible, publicationEligible, mapReady, and automaticApproval flags remain false.

## What is implemented

- Binds the review to the exact canonical raster-proposal report hash and the exact source raster's SHA-256 and byte length; the CLI re-reads and rehashes the original raster file.
- Requires an explicit decision for every detected line proposal: accept it as a wall or reject it with a reason. A proposal confidence score is never treated as wall truth.
- Requires reviewed room polygons and wall vectors. The reviewer can adjust detected endpoints, but a change greater than 25 normalized pixels requires a correction reason.
- Requires two image-space calibration points plus their known real-world distance and an evidence description for the dimension used. The computed scale is isotropic (metres per pixel); the tool does not verify the dimension against a survey.
- Converts image coordinates to local x,z metres relative to a reviewer-selected pixel origin. It separately requires a declared WGS84 origin, heading and level dimensions; it does not infer north, height, elevation datum or a geodetic transform.
- Checks that each accepted room boundary edge is covered by reviewed wall centre-lines within a declared tolerance (default 0.15 m, allowed 0.05–0.5 m). Missing wall coverage blocks conversion.
- Independently revalidates opening type, pixel interval bounds/overlap, opening height, sill height, door floor-level semantics, and effective wall height before geometry conversion. The existing production GLB generator independently validates polygon topology, wall lengths, unique IDs, opening fit, and shell geometry. The output records the preview GLB hash and byte size but does not write the GLB to disk.
- Writes geometry JSON and a separate audit JSON with mode 0600 and refuses to overwrite existing files.

## Local commands

npm run test:floor-plan-raster-vector-calibration

npm run calibrate:floor-plan-raster-vectors -- proposal-report.json review.json original-floor-plan.png output-geometry.json output-audit.json

npm run generate:floor-plan-model -- output-geometry.json private-candidate.glb original-floor-plan.png

The last command is a local GLB preflight/candidate file, not a persistent map candidate. It rechecks the original source hash and should produce the same GLB SHA-256 recorded by the calibration audit's in-memory preview. The dedicated CLI integration test verifies this round-trip, including door/window geometry, then ingests the same source bytes through the existing media-intake service, creates a private floor-plan candidate through `createFloorPlanModelCandidate`, reloads it through the integrity-checking reader, and confirms the stored GLB hash is still identical. No map asset is written. Use the same original source raster for hash verification. Output JSON files must not already exist.

## Persistent private candidate handoff

The local editor intentionally makes no API requests and downloads only the review JSON. The following authenticated server handoff is separate from the browser review step:

1. Configure `BUILDING_ENGINE_WORKSPACE` and a `GENERATION_API_TOKEN` of at least 32 characters on the server.
2. Upload the exact original raster/PDF with `POST /api/building-generation/uploads` as multipart form data (`file`, `buildingId`, `sourceId`, `kind=floor-plan`). Media intake records the exact bytes and returns the source SHA-256. The default reuse status is `unreviewed`.
3. Ensure the calibrated geometry JSON's `source.sourceId` and `source.sha256` match that uploaded source record, then POST `{ "floorPlan": <geometry JSON>, "calibrationEvidence": { "proposalReport": <exact proposal report>, "review": <exact completed review JSON> } }` to `/api/building-generation/floor-plan-models` with `Authorization: Bearer <GENERATION_API_TOKEN>`. For a raster-calibrated candidate, include both evidence objects (maximum HTTP JSON body 20 MiB). The private service reopens and rehashes the uploaded raster, reruns `calibrateFloorPlanRasterVectors`, compares the recomputed metre-space vectors and preview GLB hash with the submitted candidate, and stores the proposal report, review JSON and calibration audit as private SHA-256-bound sidecars next to the GLB, normalized geometry and generator report. Candidate loading repeats these checks against the original private source bytes before serving the model. The evidence field remains optional for separately measured vector plans that did not originate from this raster-proposal workflow. The response remains `candidate-requires-human-review`; map/publication flags stay false.
4. Candidate review is a separate authenticated operation at `/api/building-generation/floor-plan-models/{buildingId}/{candidateId}/review`, using the separately configured `GENERATION_REVIEW_API_TOKEN`. Approval requires immutable QA/review evidence, verified source rights, explicit metric/geospatial checks and reviewer attestations. Review does not publish; the explicit publication command remains separate.

The integration test validates the service-level source-ingestion-to-candidate handoff with synthetic bytes, recomputed proposal/review/audit lineage, private sidecar hashes and permission bits, exact geometry parity, and fail-closed behavior when the review sidecar is modified. It does not exercise deployment secrets, an HTTP upload against a live server, source permission review, human architectural review, or publication.

## Review JSON contract

review.json must include:

- schemaVersion 1.0.0, sourceSha256 equal to the original source bytes, and proposalReportSha256 equal to the canonical JSON hash from hashFloorPlanRasterProposalReport(proposalReport).
- confirmedAgainstSource true, a named reviewer, timezone-bearing reviewedAt, review notes, safe floor-plan/building/source IDs, and a WGS84 placement plus level dimensions.
- originPixel [x,y] in the normalized raster coordinate frame reported by proposalReport.raster.width/height.
- calibration.pointA, calibration.pointB, calibration.distanceM, and calibration.evidenceDescription. Points are in normalized raster pixels and must be at least 5 px apart. Resulting scale is bounded to 0.00001–10 m/px.
- candidateDecisions: one unique entry for every proposal ID with decision accept-wall or reject; rejections require a reason.
- rooms: each with a reviewed/accepted pixel polygon (polygonPx, [x,y] pairs).
- walls: each with a unique ID, proposal ID accepted as a wall, explicit wall semantic/review flags, and reviewed startPx/endPx. openings, if any, are also supplied in source pixels (offsetPx, widthPx) while heights/sill heights are explicitly in metres.
- For corrected candidate endpoints moved by more than 25 px from the detector result, correctionReason is mandatory.

The reviewed flags and reviewer name are assertions supplied by the caller, not digital identity verification or a signature. Keep the original source and review record available for later human audit.

## Evidence status and limits

This slice proves deterministic conversion mechanics, exact byte/hash binding, explicit human review input completeness, room boundary closure, and compatibility with the existing shell geometry validator. It does not prove that the input dimensions, labels, geospatial origin, heading, height or vertical datum are true. It does not rasterize PDF, detect semantic rooms automatically, infer doors/windows, reconstruct furniture, or evaluate real-building accuracy. Independent measurement comparison and a human review of generated renders are still required before publication.

## Regression coverage

The focused suite covers deterministic conversion, source-byte mismatch, stale proposal report, incomplete line review, large endpoint correction reasons, missing room-boundary coverage, an edge assembled from adjacent split wall segments, implausible scale, unreviewed rooms, opening type/bounds/height/sill/overlap checks, pixel-to-metre conversion, and a CLI round-trip proving that the final generated GLB hash matches the in-memory geometry preflight. Split-wall coverage is synthetic and does not replace validation on rights-cleared real plans.

## Interactive local review editor

Route: `/experimental/floor-plan-review`.

1. Open the route in a secure browser context (HTTPS or localhost) and load both the proposal report JSON and the exact original raster image.
2. The page computes browser-side SHA-256 for the source bytes and canonical proposal JSON. A size, MIME or source-hash mismatch blocks export. No fetch/XHR/API request is made by this page.
3. Select each detected line and explicitly accept it as a wall or reject it with a reason. Drag its endpoints on the overlay or edit the pixel coordinates. Corrections exceeding 25 normalized pixels require a reason.
4. Draw room polygon vertices on the overlay, finish each polygon, select it and mark it reviewed. Dragging a room vertex resets its reviewed flag. The export validator checks that every room boundary edge is covered by reviewed wall vectors after the declared calibration.
5. Pick scale points A/B on the overlay and enter the dimension evidenced by the source drawing or survey. Pick the local pixel origin separately. Enter WGS84 placement/heading and level dimensions explicitly.
6. Add door/window intervals to an accepted wall with offset/width in raster pixels and height/sill in metres. Door openings render as orange wall interruptions and windows as blue dashed interruptions on the original raster overlay; each marker is positioned from the edited wall start/end and its wall-relative pixel interval. Invalid, out-of-range and overlapping intervals are rejected at entry; both review-payload validation and the conversion CLI independently reject overlaps and wall-boundary violations.
7. Export the review JSON, then run the calibration CLI below using the original image file, proposal report and exported review JSON.

The route is a local review aid rather than an authenticated web service. It stores no review to the server and does not verify a person's identity. Review flags are operator assertions, not a digital signature. Never infer a real scale, placement or datum from the UI; the reviewer must cite measured evidence. Exports remain drafts and all publication/release flags stay false.


## Browser regression coverage

The production-server Playwright suite includes `tests/browser/floor-plan-review.spec.ts`. It uses a generated synthetic raster and source-bound proposal fixture to verify that modified source bytes block the review, exact source bytes unlock the local canvas, every detector line is explicitly decided, a false annotation can be rejected without breaking the room perimeter, a reviewer can draw/review a room and supply explicit scale/placement inputs, and a hash-bound review-only JSON download is emitted. It also asserts that the editor makes no `/api/` requests. The normal `npm run test:map-browser` command discovers this suite when the production Next.js server is running.

This is synthetic interaction evidence only. It does not prove that the vectors correspond to a real architectural plan or that the scale/placement is surveyed.
