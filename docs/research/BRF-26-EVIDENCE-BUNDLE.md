# BRF-26 — End-to-end reconstruction evidence bundle

BRF-26 consolidates existing BRF-21 source-review, BRF-24 authorization and BRF-25 candidate geometry/evaluator evidence with a human-authored source-camera visual-review decision. It does not replace any upstream validator and does not grant publication.

## Required inputs

The project-relative bundle manifest uses schema version 1.0.0 and record type brf-26-evidence-bundle-manifest. It must include bundleId, buildingId, evidenceMode, workspaceRoot, and an artifacts object with these named entries; each entry contains path and the expected SHA-256 of exact file bytes:

- sourceReviewDecision: completed BRF-21 reviewer-authored decision JSON.
- authorizationRecord: BRF-24 authorization JSON created after actual candidate generation.
- candidateGlb: exact candidate GLB output recorded by BRF-24.
- geometryValidationReport: BRF-25 report for that candidate.
- preparedManifest: BRF-25 independent-geometry preparation output.
- evaluationReport: BRF-25 independent-truth metric report.
- independentReference: the separate source geometry document used by BRF-25.
- sourceCameraReport and renderManifest: visual evidence tied to the candidate.
- visualReviewDecision: completed human review based on the exact hashes above.

Example invocation:

~~~sh
node scripts/build-brf26-evidence-bundle.mjs \
  artifacts/brf26/bundle-manifest.json \
  artifacts/brf26/evidence-bundle-report.json \
  --workspace=workspace
~~~

The command recomputes hashes, rejects symlink/path traversal and malformed/missing files, cross-binds source-review bytes to BRF-24, and confirms the candidate hash is consistent across BRF-24, BRF-25, prepared geometry, metric evaluation and visual review. It refuses to overwrite a previous report.

## Visual-review decision

Start from templates/brf26-visual-review-decision.template.json. The template is intentionally blank and pending. A qualified reviewer must fill it after inspecting the source-camera comparisons. Pin the candidate GLB, source-camera report and render manifest SHA-256 values; provide reviewer identity, an explicit UTC timestamp, a per-view decision and rationale. A report with a pending or not-comparable view cannot become ready for sign-off.

## Dispositions

- VALIDATION_FAILED: conflicting hashes, invalid schemas, unsafe paths or an explicit failed validation.
- BLOCKED: required evidence is missing, source review has not cleared, independent-reference/held-out evidence is incomplete, or the evidence mode is synthetic.
- REVIEW_REQUIRED: the artifacts are consistent but a human decision remains pending.
- READY_FOR_HUMAN_SIGNOFF: the evidence chain is consistent and the human source-camera decision is complete; this is only a request for final independent human sign-off, not model approval.

All output release flags remain false. A hash does not prove reviewer identity, copyright/licence rights or independent survey provenance. Synthetic fixtures test software behaviour only. If the real BRF-22 review or a separately sourced metric reference is unavailable, the real sample remains blocked; do not fabricate a review, reconstruction candidate or accuracy result.
