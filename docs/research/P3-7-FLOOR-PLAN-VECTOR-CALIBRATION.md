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
- Delegates polygon validity, wall lengths, unique IDs, opening fit, and shell geometry checks to the existing production GLB generator validator. The output records the preview GLB hash and byte size but does not write the GLB to disk.
- Writes geometry JSON and a separate audit JSON with mode 0600 and refuses to overwrite existing files.

## Local commands

npm run test:floor-plan-raster-vector-calibration

npm run calibrate:floor-plan-raster-vectors -- proposal-report.json review.json original-floor-plan.png output-geometry.json output-audit.json

npm run generate:floor-plan-model -- output-geometry.json private-candidate.glb original-floor-plan.png

The last command is an optional subsequent candidate-generation step. Its own review/publication flow remains separate and fail-closed. Use the same original source raster for hash verification. Output JSON files must not already exist.

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

The focused suite covers deterministic conversion, source-byte mismatch, stale proposal report, incomplete line review, large endpoint correction reasons, room boundary closure failure, implausible scale, unreviewed rooms, opening pixel-to-metre conversion and the private CLI/non-overwrite behavior.

## Interactive local review editor

Route: `/experimental/floor-plan-review`.

1. Open the route in a secure browser context (HTTPS or localhost) and load both the proposal report JSON and the exact original raster image.
2. The page computes browser-side SHA-256 for the source bytes and canonical proposal JSON. A size, MIME or source-hash mismatch blocks export. No fetch/XHR/API request is made by this page.
3. Select each detected line and explicitly accept it as a wall or reject it with a reason. Drag its endpoints on the overlay or edit the pixel coordinates. Corrections exceeding 25 normalized pixels require a reason.
4. Draw room polygon vertices on the overlay, finish each polygon, select it and mark it reviewed. Dragging a room vertex resets its reviewed flag. The export validator checks that every room boundary edge is covered by reviewed wall vectors after the declared calibration.
5. Pick scale points A/B on the overlay and enter the dimension evidenced by the source drawing or survey. Pick the local pixel origin separately. Enter WGS84 placement/heading and level dimensions explicitly.
6. Add door/window intervals to an accepted wall with offset/width in raster pixels and height/sill in metres. The payload builder checks basic fit; the conversion CLI runs the authoritative geometry/opening validation again.
7. Export the review JSON, then run the calibration CLI below using the original image file, proposal report and exported review JSON.

The route is a local review aid rather than an authenticated web service. It stores no review to the server and does not verify a person's identity. Review flags are operator assertions, not a digital signature. Never infer a real scale, placement or datum from the UI; the reviewer must cite measured evidence. Exports remain drafts and all publication/release flags stay false.
