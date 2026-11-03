# BRF-24 — Bind reviewed preflight to COLMAP execution

**Tracking:** [Issue #231](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/231).  
**Dependency:** BRF-23, merged in [PR #230](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/230).

## Command

First ingest the original, unchanged selected photos into the platform's private building-media store, with source rights reviewed. Keep the exact BRF-14/20/21 artifacts, reviewer decision, 16 pinned source JPEGs, profile, and BRF-23 preflight report available locally. Compute and pin the report file's actual SHA-256.

~~~sh
node scripts/reconstruct-brf23-reviewed-source.mjs \
  workspace building-spec.json job-001 view-01,view-02,view-03 \
  brf-artifacts pinned-source-images review-decision.json \
  brf-23-reconstruction-preflight-profile.json reconstruction-preflight-report.json \
  EXPECTED_REPORT_SHA256 --confirm-execute-reviewed-preflight
~~~

Optional flags: \`--quality LOW|MEDIUM|HIGH|EXTREME\`, \`--timeout-ms\`, \`--python-path\`, and \`--ffmpeg-path\`. No metric scale or coordinate-transform flag is offered by this route.

## Execution gates

- Match the pinned report SHA-256, then rehash the seven evidence files, decision, profile, and every raw source JPEG.
- Rerun the BRF-23 CLI against current files. The new report must be byte-identical to the hash-pinned preflight report.
- Require the real reviewer record to confirm same-building identity, adequate source coverage, positive source up-axis, and use-specific rights approval. At least three included views and two useful-overlap pairs must be recorded.
- Require every ingested source hash to appear in the preflight-verified image set and require the COLMAP executable's exact pinned version to match again immediately before execution.
- Save an audit JSON at \`.building-engine/authorizations/<buildingId>/<jobId>.json\` before the worker starts, with exact evidence/review/source hashes and explicit local-frame policy.

## Output limits

A generated GLB is a review candidate only. Candidate generation is not candidate accuracy validation. The bridge keeps independent reference, held-out checkpoints, acceptance, publication, map-ready, and automatic-approval false. It does not authenticate the reviewer's identity or independently prove a licence claim. A negative up-axis direction is rejected because the current exporter doesn't safely represent that inversion.

**Current real sample remains blocked until a human reviewer completes the actual hash-bound BRF-22 decision.** This code's synthetic fixtures test authorization behavior only; they are not a real reconstruction or independent accuracy result.
