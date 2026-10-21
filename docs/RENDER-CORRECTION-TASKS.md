# Render review correction tasks

This step converts a valid `render-reference-review-v1` report into a deterministic, evidence-linked backlog. It is a workflow handoff, not an automatic modelling or texture repair system.

## Run it

After creating `render-reference-review-report.json` using [Render-to-reference comparison review](./RENDER-REFERENCE-REVIEW.md), run:

```powershell
npm run test:render-correction-tasks
npm run create:render-correction-tasks -- ".\render-reference-review-report.json" ".\render-correction-tasks.json"
```

The output file must not already exist. This is intentional so an earlier task snapshot is not silently overwritten. Use a new filename for a new review revision.

## Task mapping

| Recorded review outcome | Created task |
| --- | --- |
| `mismatch` | High-priority `model-correction-review` |
| `partial` | Medium-priority `model-correction-review` |
| `pending` | `complete-reference-review` |
| `not-comparable` | `resolve-reference-comparability` |
| Render view with no comparison | `add-reference-comparison` |
| `match` | No correction task |

Each task preserves source-model and render-manifest hashes; comparison tasks also preserve render/reference hashes, reference/view IDs, basis, reviewer, timestamp and notes. If a mismatch has no structured `correctionRequest`, the task explicitly asks a human to inspect the pair and write a correction proposal. The tool does not guess the defect from free text.

When a reference-review report includes validated image-similarity diagnostics for the exact render/reference hashes, the task carries a compact `evidence.similarityDiagnostics` record: the diagnostic report hash, pair hashes, MAE/RMSE/PSNR/SSIM/hash-distance metrics, aspect-ratio screening context and warning strings. Malformed diagnostics or diagnostics bound to different image hashes are rejected. When no diagnostics are supplied, this field is `null`. The backlog summary reports how many tasks carry diagnostics and how many carry screening warnings.

These metrics are triage context only. They do **not** change the human-authored outcome, task priority, task type, verification status, or publication eligibility. In particular, low pixel similarity does not prove a geometry defect, and a clean diagnostic does not prove a correct building model.

## Safe correction loop

1. Open the exact render and reference files, and check that the view/facade comparison basis is appropriate.
2. Have a reviewer propose a concrete change (for example, geometry proportions, camera orientation, texture projection or UV layout) and approve it before editing.
3. Apply the approved correction in the relevant modelling tool. This command does not edit meshes, GLBs, textures, UVs or source assets.
4. Run the relevant geometry/texture QA and generate a new render set.
5. Create a new render/reference report from the new hashes. Only this new evidence can support verification of the revised result.

Task status starts at `open`; `verificationStatus` starts at `not-verified`; `autoApplied` and `publicationEligible` are always false. The review source is required to be structurally valid and to contain valid model/manifest hashes. Human-entered comparison outcomes remain human judgements: this tool does not independently establish visual accuracy, source rights, camera pose, georeferencing or heritage fidelity.
