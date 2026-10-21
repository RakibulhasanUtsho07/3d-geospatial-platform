# Render correction verification

This step evaluates a correction-task backlog against a new, valid human-authored `render-reference-review-v1` report. It emits a verification snapshot and does not modify the backlog or any model assets.

## Run it

Create a fresh render and reference-review report after the relevant modelling/review step, then run:

```powershell
npm run test:render-correction-verification
npm run verify:render-correction-tasks -- ".\\render-correction-tasks.json" ".\\render-reference-review-report-next.json" ".\\render-correction-verification.json"
```

The output must not already exist. Use a new filename for every verification cycle so previous evidence remains available.

## Model-correction verification rules

A `model-correction-review` task becomes `verified` only when all of these are true:

- The new report is valid, belongs to the same building, and has a different review-report hash.
- The report includes the exact same `viewId` and `referenceImageId` pair.
- The new source-model SHA-256 differs from the task's original model hash.
- The new render-manifest SHA-256 differs from the task's original manifest hash.
- The reference image SHA-256 is unchanged from the original task, so the comparison is against the same reference file content.
- A human reviewer recorded `match` for that pair.

If the new outcome is `partial` or `mismatch`, the result is `needs-more-work`; `pending` waits for review; `not-comparable` is blocked. A match against unchanged model or manifest evidence is `stale-evidence`, not verification. Missing evidence never closes a task.

## Other task outcomes

| Task kind | Completion rule |
| --- | --- |
| `complete-reference-review` | Any final, non-pending outcome was recorded for the exact pair. A mismatch/not-comparable result can still require separate follow-up work. |
| `resolve-reference-comparability` | The exact pair now has a comparable basis and a final outcome. |
| `add-reference-comparison` | A comparison was added for the previously uncovered view and has a final outcome. |

## Safety and limits

This is a deterministic evidence gate, not computer vision. A `verified` result means the report has recorded a human-reported match on new model/render evidence for the exact pair; it does not independently prove facade accuracy, historic fidelity, georeferencing, source rights or overall building correctness. The generated result does not automatically alter the source backlog; review it and start a new correction-task snapshot from any remaining mismatch/partial findings. Publication eligibility remains false.
