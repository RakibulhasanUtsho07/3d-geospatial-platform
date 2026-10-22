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
5. Record the implementation timestamp, output-model SHA-256, geometry QA report SHA-256, an explicit yes/no decision for whether textures changed, the texture QA report SHA-256 when they did, and the generated render-manifest SHA-256.
6. Create a new render/reference report from the new hashes. Its source-model and render-manifest hashes must exactly match the checklist implementation hashes, and the exact reference image SHA-256 must remain unchanged.

The review source is required to be structurally valid and to contain valid model/manifest hashes. Human-entered comparison outcomes remain human judgements: this tool does not independently establish visual accuracy, source rights, camera pose, georeferencing or heritage fidelity.


## Compare diagnostics in the verification cycle

The verification command can carry the correction task's original `evidence.similarityDiagnostics.spatialHotspots` beside the new review report's validated spatial diagnostics. Each task result includes `diagnosticHotspotComparison` when either review cycle provides hotspots. It records original and verification hotspot cells plus the shared-cell count and cells unique to either report, separately for pixel-error and edge-density rankings.

The comparison stays in the normalized 4×4 grayscale-preview coordinate space. An overlap or a change in the highest-ranked cells does not reveal the physical facade region, prove that a correction worked, or alter `verified` / `needs-more-work` / other task states. Both the original stored hotspots and the new diagnostics are checked for valid cell coordinates, ranking consistency and bounded metric values; malformed evidence is rejected. Older backlogs and new reports without hotspot metrics remain supported.

The verification summary reports how many new comparisons include spatial hotspots and how many task results include a before/after hotspot comparison. The output's automation policy explicitly keeps hotspot overlap and all similarity diagnostics outside the verification decision gates.


## Human correction-review checklist

Each `model-correction-review` task now includes a `reviewChecklist` template with five separately tracked stages:

1. **Issue assessment:** records the original reviewer's notes, outcome, identity and timestamp as evidence. It explicitly asks the next reviewer to confirm the semantic issue against both images; a note is not an automatically inferred defect label.
2. **Source evidence:** pins the exact view, render/reference filenames and SHA-256 hashes plus the comparison basis. Diagnostic hotspot presence is marked as image-space context only.
3. **Correction proposal:** starts at `awaiting-human-proposal`. A recorded `correctionRequest`, when present, is saved as `requestedScope` with its source path; it is **not** copied into `proposalText` or treated as approval. The proposal, author, timestamp and approval rationale remain empty until a human fills them in.
4. **Implementation evidence:** starts `not-started`; output model hash and geometry/texture QA report hashes are null.
5. **Fresh verification:** starts `not-started` with pending gates for changed source-model/render-manifest hashes, the unchanged reference SHA-256, the exact pair and a fresh human-reported outcome.

Use the checklist fields to record the human workflow in the correction-task JSON or in a tracked review artifact. Do not erase original evidence fields when adding progress. The checklist is a hand-off template, not a persistent database or workflow service: generating it does not save later edits automatically.

The checklist does not change task priority, decide a correction category from metrics, authorize edits, or mark a task verified. A person must write and approve a concrete proposal before implementation. Set `correctionProposal.status` and `correctionProposal.approval.status` to `approved` only after the respective human decisions are recorded. The proposal needs a named proposer and valid timestamp; approval needs a named approver, timestamp and rationale. The implementation timestamp must be at or after the approval timestamp. Once checks are actually complete, set `implementationEvidence.status` to `qa-complete`. The implementation evidence includes an output-model SHA-256, geometry QA report SHA-256, an explicit `textureChangeApplicable: true|false` choice, a texture QA report SHA-256 when true, and the generated render-manifest SHA-256.

The separate verification command now requires every one of these gates in addition to a fresh exact-pair `match`, changed source-model and render-manifest hashes, and an unchanged reference-image hash. It reports `awaiting-approved-proposal`, `approval-order-violation`, or `incomplete-implementation-evidence` rather than `verified` when the corresponding gate fails. The recorded output-model and render-manifest hashes must equal the fresh review report provenance.

**Evidence boundary:** this command validates the recorded SHA-256 values and their linkage to the fresh review report; it does not open the geometry/texture QA files or independently attest their contents, and it does not cryptographically authenticate the human identities or approval record. Keep the QA reports and signed/controlled human review records alongside the task JSON for audit. Publication eligibility remains false.
