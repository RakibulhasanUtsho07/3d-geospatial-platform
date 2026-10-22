# Render review correction tasks

This step converts a valid `render-reference-review-v1` report into a deterministic, evidence-linked backlog. It is a workflow handoff, not an automatic modelling or texture repair system.

## Run it

After creating `render-reference-review-report.json` using [Render-to-reference comparison review](./RENDER-REFERENCE-REVIEW.md), run:

```powershell
npm run test:render-correction-tasks
npm run create:render-correction-tasks -- ".\\render-reference-review-report.json" ".\\render-correction-tasks.json"
```

The output file must not already exist. This is intentional so an earlier task snapshot is not silently overwritten. Use a new filename for a new review revision.

## Task mapping

| Recorded review outcome | Created task |
| --- | --- |
| `mismatch` with reviewer, timestamp and notes | High-priority `model-correction-review` |
| `partial` with reviewer, timestamp and notes | Medium-priority `model-correction-review` |
| `pending` | `complete-reference-review` |
| `not-comparable` | `resolve-reference-comparability` |
| Render view with no comparison | `add-reference-comparison` |
| `match` | No correction task |

Mismatch/partial entries without a non-empty reviewer, valid ISO-like review timestamp and non-empty notes are rejected. Each resulting correction task sets `humanReviewConfirmed: true` and retains the exact reviewer, timestamp, notes, view/reference IDs, comparison basis and image hashes. If a mismatch has no structured `correctionRequest`, the task explicitly asks a human to inspect the pair and write a correction proposal; the tool does not guess the defect from free text.

## Diagnostic context and hotspots

When a reference-review report includes validated image-similarity diagnostics for the exact render/reference hashes, the task carries `evidence.similarityDiagnostics`: the diagnostic report hash, pair hashes, MAE/RMSE/PSNR/SSIM/hash-distance metrics, aspect-ratio screening context, supported normalized-luminance/edge metrics, warning strings and (when supplied) a compact `spatialHotspots` object.

The hotspot summary includes up to four cells with the largest preview pixel error and up to four cells with the largest edge-density difference. Each cell preserves its measured values. The coordinates describe a **4×4 grid over the normalized 64×64 grayscale preview only**. They are not geographic coordinates, architectural facade coordinates, semantic building parts or proof of a defect. Reports without spatial diagnostics remain supported and keep `spatialHotspots: null`. Invalid, inconsistent or wrongly ranked per-cell diagnostics are rejected rather than silently repaired.

The backlog summary reports how many tasks carry diagnostics, how many have warnings, how many include spatial hotspots and how many are human-confirmed correction tasks. Diagnostics never create tasks on their own: even a similarity warning attached to a human-reported `match` does not create a correction item. Correction tasks are driven by human-entered `mismatch`/`partial` outcomes, not pixel thresholds.

## Interpretation and safety policy

Metrics and hotspots are triage context only. They do **not** change the human-authored outcome, task priority, task type, verification status or publication eligibility. A large pixel difference cannot identify whether the cause is geometry, camera pose, lighting, texture, crop or source-image comparability. A clean diagnostic cannot prove the building model is correct.

Task status starts at `open`; `verificationStatus` starts at `not-verified`; `autoApplied` and `publicationEligible` are always false. The generator does not edit meshes, GLBs, textures, UVs or source assets.

## Safe correction loop

1. Open the exact render and reference files, and check that the view/facade comparison basis is appropriate.
2. Review the diagnostic hotspots in the actual images. Have a reviewer propose a concrete change (for example, geometry proportions, camera orientation, texture projection or UV layout) and approve it before editing.
3. Apply the approved correction in the relevant modelling tool. This command does not change the model.
4. Run the relevant geometry/texture QA and generate a new render set.
5. Create a new render/reference report from the new hashes. Only this new evidence can support verification of the revised result.

The review source is required to be structurally valid and to contain valid model/manifest hashes. Human-entered comparison outcomes remain human judgements: this tool does not independently establish visual accuracy, source rights, camera pose, georeferencing or heritage fidelity.
