# Render correction verification

This step evaluates a correction-task backlog against a new, valid human-authored `render-reference-review-v1` report. It emits a verification snapshot and does not modify the backlog or any model assets.

## Run it

Create a fresh render and reference-review report after the relevant modelling/review step, then run:

```powershell
npm run test:render-correction-verification
npm run create:render-correction-qa-evidence -- ".\\candidate-next.glb" ".\\geometry-qa-next.json" ".\\texture-qa-next.json"
npm run verify:render-correction-tasks -- ".\\render-correction-tasks.json" ".\\render-reference-review-report-next.json" ".\\candidate-next.glb" ".\\render-review-manifest.json" ".\\geometry-qa-next.json" ".\\texture-qa-next.json" ".\\render-correction-verification.json"
```

The output must not already exist. Use a new filename for every verification cycle so previous evidence remains available.

The QA evidence generator writes canonical geometry and texture QA report files from the exact candidate GLB and prints their file SHA-256 values. Record the candidate hash, generated QA report hashes, implementation timestamp, and actual render-manifest SHA-256 in the correction checklist. Mark `textureChangeApplicable` explicitly; when true, the actual texture report hash must match the checklist. The verifier reads the candidate, manifest, and both QA report files as regular files (symlinks are rejected), hashes the exact bytes, and recomputes both QA reports from the candidate GLB. Modified/stale QA JSON, a manifest not pinned by the fresh review, or a candidate hash mismatch is rejected. JSON-supplied hash strings alone cannot pass the gate.

## Model-correction verification rules

A `model-correction-review` task becomes `verified` only when all of these are true:

- The new report is valid, belongs to the same building, and has a different review-report hash.
- The report includes the exact same `viewId` and `referenceImageId` pair.
- The new source-model SHA-256 differs from the task's original model hash.
- The new render-manifest SHA-256 differs from the task's original manifest hash.
- The reference image SHA-256 is unchanged from the original task, so the comparison is against the same reference file content.
- A human reviewer recorded `match` for that pair.
- The actual candidate GLB and render-manifest files match the fresh report's provenance hashes.
- The on-disk geometry QA file matches the recomputed QA report for that exact GLB, and its raw file hash matches `geometryQaReportSha256`.
- When `textureChangeApplicable: true`, the on-disk texture QA file matches a fresh recomputation from that GLB and its raw file hash matches `textureQaReportSha256`.

If the new outcome is `partial` or `mismatch`, the result is `needs-more-work`; `pending` waits for review; `not-comparable` is blocked. A match against unchanged model or manifest evidence is `stale-evidence`, not verification. Missing evidence never closes a task.

## Similarity diagnostics in verification snapshots

If the fresh review report contains image-similarity diagnostics, the verification snapshot carries the compact diagnostic record under `tasks[].matchedEvidence.similarityDiagnostics`. The snapshot summary counts comparisons with diagnostics and screening warnings. It validates the diagnostic schema, metric ranges, and render/reference hashes against the exact comparison before preserving the data. Reports without diagnostics remain supported.

Diagnostics are advisory audit evidence only. A low SSIM/high pixel-error warning does not override a human `match`, and clean metrics do not create one. The verification gates and status mapping stay unchanged; `similarityDiagnosticsSummary.affectVerificationStatus` and the automation policy both explicitly remain false.

## Other task outcomes

| Task kind | Completion rule |
| --- | --- |
| `complete-reference-review` | Any final, non-pending outcome was recorded for the exact pair. A mismatch/not-comparable result can still require separate follow-up work. |
| `resolve-reference-comparability` | The exact pair now has a comparable basis and a final outcome. |
| `add-reference-comparison` | A comparison was added for the previously uncovered view and has a final outcome. |

## Safety and limits

The verifier's file-backed artifact context is included under `artifactIntegrity`. A correction is not verified by calling the pure core verifier without this file-backed context.

This is a deterministic evidence gate, not computer vision. A `verified` result means the report has recorded a human-reported match on new model/render evidence for the exact pair; it does not independently prove facade accuracy, historic fidelity, georeferencing, source rights or overall building correctness. The generated result does not automatically alter the source backlog; review it and start a new correction-task snapshot from any remaining mismatch/partial findings. Publication eligibility remains false.
