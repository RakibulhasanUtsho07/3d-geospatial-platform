# D3M-ENGINE-09 — Signed review-package binding for single-image georeference evidence

**Tracking issue:** [#358](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/358)  
**Stack base:** D3M-ENGINE-08 PR [#357](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/357)  
**Smoke schema:** `1.5.0`  
**Generation receipt schema:** `1.1.0`

## Gap closed by this increment

D3M-ENGINE-08 binds an optional WGS84 control-point manifest and its recomputed horizontal registration to the private single-image smoke report, exact workflow report, output GLB and generation-artifact receipt. The final building review package previously did not ingest those four exact files. It could therefore be signed without binding this particular single-image registration hand-off.

D3M-ENGINE-09 extends the review package as an optional, all-or-none evidence group. Existing packages that do not contain single-image evidence remain valid.

## Builder options

Add both options to the existing nine positional arguments:

~~~powershell
npm run package:building-review -- "<candidate.glb>" "<render-dir>" "<reference-dir>" "<review.json>" "<tasks.json>" "<verification.json>" "<accuracy-evidence.json>" "<readiness.json>" "<new-package-dir>" --single-image-smoke-workspace "<private-workspace>" --single-image-smoke-job-id "<job-id>"
~~~

The builder independently verifies the private D3M-08 smoke, then copies the exact bytes of:

- `reports/single-image-runtime-smoke.json`
- `reports/single-image-generation-artifact-receipt.json`
- `reports/single-image-workflow-report.json`
- `evidence/single-image-control-points.json`

The builder requires schema 1.5.0 / receipt 1.1.0, a present GCP manifest, `calibrated-needs-human-review`, exact building and candidate GLB binding, and a verified generation-artifact receipt. The smoke is verified again after collection; report, receipt, workflow and manifest bytes are checked for drift. Supplying only one CLI option is rejected. Omitting both preserves the ordinary review-package flow. A partial artifact group is rejected.

## Offline verification

The package manifest records each artifact's SHA-256 and byte count plus the job/building/source/candidate binding and unresolved vertical datum. The existing Ed25519 detached signature covers these fields because it signs the exact package-manifest bytes.

The offline package verifier:
1. checks that all four single-image artifacts exist exactly once and no partial group is present;
2. re-hashes each artifact and checks report/receipt/workflow/source/GLB/manifest cross-bindings;
3. requires receipt schema 1.1.0 and canonical receipt serialization;
4. parses the exact packaged GCP manifest bytes and recomputes the horizontal similarity registration using the existing D3M-08 registration function;
5. compares the independently recomputed registration with smoke evidence, generation receipt and workflow report.

The pure byte-based verifier is shared with the original workspace verifier, so both paths use the same manifest normalization and transform implementation.

## Trust and release boundaries

The package signature authenticates the manifest bytes relative to the separately trusted Ed25519 public key. It does not authenticate the operator-supplied survey record or surveyor, GNSS receiver, source-image rights, physical-feature correspondences, model scale beyond the submitted controls, or architectural fidelity. A low residual is not proof that the selected model/image features identify the same physical points.

Registration remains horizontal only. The package explicitly keeps `verticalDatum=not-solved`, `mapReady=false`, `publicationEligible=false` and `automaticApproval=false`. It is a hand-off for final human review, not a publication authorization or a real worker-inference result.
