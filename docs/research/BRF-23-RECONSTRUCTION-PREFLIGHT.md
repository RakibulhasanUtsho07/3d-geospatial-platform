# BRF-23 — Reconstruction preflight from reviewed multi-view evidence

**Tracking:** [Issue #229](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/229).  
**Scope:** verify the handoff from BRF-22 to a possible local-only COLMAP attempt. This is not a reconstruction or release gate.

## Command

Keep the seven derived BRF-14/20/21 evidence files and reviewer-authored decision in an artifact directory. Keep the original JPEGs in a separate local directory; do not commit or upload them.

~~~sh
python3 scripts/brf23_reconstruction_preflight.py assess \
  --artifact-root path/to/brf-14-artifacts \
  --image-root path/to/pinned-jpeg-files \
  --decision review-decision.json \
  --profile benchmarks/building-reconstruction/brf-23-reconstruction-preflight-profile.json \
  --output reconstruction-preflight-report.json
~~~

The command revalidates BRF-14/20/21 evidence hashes and the complete BRF-22 decision, then hashes every pinned JPEG and compares its filename, byte size and SHA-256 to the source manifest. Symlinks, path components, missing inputs, byte changes, and oversized files are rejected. It probes only the configured executable with the safe COLMAP version command and requires the exact version in the checked-in profile (COLMAP 4.2.1); it never installs tools or invokes a reconstruction subcommand.

## Coordinate handling

The only admitted policy in this sample is **local-only-no-georeference**: the frame is explicitly named, output is unscaled local geometry, and GPS registration remains **not-established**. Source camera GPS metadata and the upstream COLMAP model do not establish an authoritative transform, vertical datum, or independent scale. A future georeferenced profile needs a separate reviewable transform/CRS/vertical-datum artifact and its provenance; this CLI deliberately rejects that mode until it is implemented.

## Status and safety

- **blocked**: any human-review, input-byte, toolchain or profile gate failed. A blank BRF-22 template therefore stays blocked even when the source bytes are correct.
- **preflight-ready-for-local-reconstruction-attempt**: reviewed decision, all exact source bytes, and exact COLMAP version passed. This permits only a later reconstruction attempt in the named local frame.
- The report always sets reconstructionExecuted, candidateGlbGenerated, independentReferenceVerified, acceptanceEligible, publicationEligible, mapReady, and automaticApproval to **false**.
- The only external process started is the version probe. No COLMAP reconstruction is run, no GLB is written, and no map registration/publication is authorized.

Even a preflight-ready result is not evidence of geometry accuracy. The candidate GLB's own provenance and a separately licensed, independent reference plus held-out survey checkpoints remain mandatory under BRF-10. Reviewer identity and licence claims also remain unverified by automated code.

## Current sample

The live BRF-14 artifact currently contains a blank pending-human-review decision template. The real sample is expected to return **blocked**; that is a successful safety outcome, not a failed software test. Raw source images stay in runner-temporary storage and are not part of the uploaded derived report.
