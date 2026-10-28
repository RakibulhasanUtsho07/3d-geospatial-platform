# BRF-42 — Private intake and quality preflight for the pinned 16-view dataset

**Status:** Engineering implementation under review. The operation is designed to run only on temporary CI storage. A successful report is not reconstruction authorization, rights clearance, or geometry accuracy evidence.

## Purpose

BRF-14 downloads and verifies a pinned set of 16 candidate images and generates derived contact-sheet, coverage and pairwise-overlap evidence. BRF-41 proves that one byte-verified sample can pass through the existing private media intake and image-quality preflight. BRF-42 connects those established components for the entire 16-view set without skipping any evidence gate.

## Run

After the BRF-14 workflow has downloaded and byte-verified all views:

~~~bash
npm run test:brf42-multiview-private-intake
node scripts/run-brf42-multiview-private-intake.mjs \
  --manifest benchmarks/building-reconstruction/brf-14-multiview-source.json \
  --verification-report artifacts/brf-14/multiview-source-byte-verification.json \
  --asset-root "$RUNNER_TEMP/brf14/images" \
  --workspace "$RUNNER_TEMP/brf14" \
  --report artifacts/brf-14/private-multiview-media-intake-report.json
~~~

The command revalidates the supplied byte-verification report against the pinned manifest, hashes every current source file again before creating any private media records, and checks that the existing intake's byte hashes still equal the manifest. It then creates one content-addressed record per view and runs the existing FFmpeg image-quality preflight across all 16 records.

## Expected successful status

**private-multiview-preflight-complete-not-reconstruction-approved** means:

- all 16 local image files match the exact manifest and prior verification report;
- all 16 were added to the existing private media registry with their SHA-256, captured timestamp, URL, attribution and GPS latitude/longitude;
- all 16 images decoded and image-quality metrics were produced;
- the source records remain **usageStatus=unreviewed**, and the preflight must report **rightsApproved=false** and **safeToSubmitToColmap=false**.

The report includes per-image dimensions and quality heuristics, source hashes, warnings, and pairwise near-duplicate candidates. A low perceptual distance is a human-triage hint, not proof of overlap or a camera pose.

## Data boundary

- Raw 16-view imagery and the .building-engine content-addressed copies remain in the ephemeral GitHub runner workspace.
- CI may upload the report JSON and the separate BRF-14 review artifacts, but not source images, private media copies, upstream reference GLBs or source point clouds.
- Source COLMAP poses remain in their separately declared local frame; BRF-42 does not register that frame to GPS, infer a vertical datum, or establish survey truth.
- Rights/owner authority, same-building identity, visual overlap, facade/roof coverage and source up-axis remain pending human review.
- No COLMAP execution, candidate GLB generation, accuracy claim, map change or release-gate promotion is performed.

## Failure behavior

The command blocks before private ingestion if the prior report is missing/inconsistent, any view is missing or altered, any exact URL/hash/size differs, the asset root is a symlink/outside the workspace, or the source manifest is malformed. If image quality decode or declared dimensions fail after ingest, the report is blocked and the CI job fails. This is an engineering validation result and not legal advice.

The four flags acceptanceEligible, publicationEligible, mapReady, and automaticApproval are always false in the output.
