# Building Accuracy Upgrade — Medium-Size Engineering Backlog

**Document ID:** BAUB-001  
**Version:** 1.0  
**Date:** 26 October 2026  
**Branch target:** `rakibul-hasan` first; review through `development`; merge to `main` only after required checks and evidence pass  
**Status:** M05–M08 implementation candidate is in `feat/m05-m08-segmentation-features`; contract, evaluator CLI, reviewed-mask gate, observation schema and proposal overlay are implemented with synthetic regression fixtures. Real labelled-building pilot acceptance remains incomplete.  
**Parent plan:** [Building Accuracy Upgrade Plan](./BUILDING-ACCURACY-UPGRADE-PLAN.md)

## Purpose and sizing rule

This document turns the approved building-accuracy plan into bounded engineering tasks. Each item is intended to be one reviewable PR with one main deliverable, specific tests, and inspectable evidence. “M” means medium scope; it is a planning size, not a verified duration estimate. If a task needs a new model-training project, broad refactor, or multiple independent deliverables, split it before implementation.

**Do not rebuild existing tools by default.** The repository already has media intake, BuildingSpec validation, procedural GLB generation, COLMAP, image preflight, mask-guided sketches, calibrated wireframe triangulation, mesh and texture QA, 13-view rendering, render-reference review, correction-task handoff, dimension/GCP checks, an accuracy evidence pack, and release-readiness tooling. Each task must extend or connect those components where possible.

## Current implementation boundary — Batch B (M05–M08)

- M05 benchmark manifest/evaluator and the RGB class palette are implemented, including capture-group split-leakage rejection, actual file hash/dimension verification in the CLI, per-image/per-class metrics and held-out summaries. No candidate model was trained or automatically selected.
- M06 source-bound binary-mask validation and reviewed manual fallback are implemented. Edge maps are rejected as semantic masks; pending/rejected masks cannot feed feature extraction.
- M07 versioned source/view-bound observations, pixel-geometry checks, distinct visibility states and append-only review history are implemented.
- M08 bounded, deterministic mask/edge heuristics, a per-category metric helper, and source-image overlay CLI are implemented. Proposals are explicitly not ground truth.
- **Still required before the acceptance criteria can be checked off:** permissioned real Dhaka imagery, independently reviewed segmentation labels, held-out candidates, real per-class failure review, reviewed feature labels and human inspection of source-overlay artifacts. The current synthetic fixtures establish tooling behavior only; they do not establish model quality or architectural accuracy.

## Non-negotiable implementation rules

- A generated GLB remains a **candidate** until independent measurements, source evidence, render/reference review, and mandatory release gates pass.
- Keep measured, inferred, missing, and human-reviewed data distinct. Never upgrade an inference to “verified” automatically.
- Do not claim a universal accuracy percentage. Report dimensions, placement, geometry, visual comparisons, source coverage, and texture quality separately.
- Similarity scores and image hotspots are triage signals, not proof of a geometric defect.
- Every derived artifact must link to source IDs and hashes. A changed source, configuration, model, or reference invalidates dependent evidence.
- Automatic correction is limited and measurable. Stop on regression, repeated no-improvement, unsupported defect type, or a missing prerequisite; send the case to human review.
- No new model/service becomes mandatory until a small, labelled pilot shows the existing approach is insufficient and a candidate has been compared against reviewed references.
- No real-building result may be labelled “passed” until actual evidence exists. Empty templates and synthetic fixtures validate tooling only.

## Dependency map

```text
M01 Generic renderer
  → M02 Capture-manifest contract → M03 Manifest/coverage validation → M04 Evidence-pack binding
  → M05 Segmentation candidate benchmark → M06 Mask provider/fallback
  → M07 Architectural observation contract → M08 Per-view feature proposals
  → M09 Camera/projection validation → M10 Correspondence QA → M11 Confidence-aware fusion
  → M12 Sparse-candidate-to-mesh readiness
  → M13 Source-camera rendering → M14 Silhouette/edge comparison → M15 Part-aware comparison
  → M16 Defect/fix registry → M17 Bounded correction orchestration
  → M18 Texture gates (geometry prerequisites required)
  → M19 Unified accuracy/release report → M20 Real-building pilot and regression baseline
```

This is a dependency guide, not a claim that all tasks are already implemented. M05 and M06 may retain a human-reviewed mask fallback if no candidate model meets the pilot criteria.

## Task cards

### M01 — Make the building review renderer generic

**Priority:** P0 · **Size:** M  
**Why now:** The current focused-front render path has Rangmahal-specific mesh-name assumptions; the Bangabhaban review failed when those nodes were absent.

**Scope**
- Inspect `scripts/blender/render-building-review.py` and its caller/manifest contract.
- Replace implicit Rangmahal-only discovery with explicit building/view configuration or safe generic node discovery.
- Keep existing Rangmahal review behaviour compatible; report missing required nodes/views clearly instead of producing misleading evidence.

**Acceptance criteria**
- A fixture using Rangmahal names and a fixture without Rangmahal names both exercise the intended renderer path.
- The expected 13-view manifest is complete or the report fails with a precise missing-view reason.
- GLB, manifest, and render hashes remain recorded; no missing render is silently treated as a pass.

**Verification:** Add/extend renderer tests; run `npm run test:render-review-manifest` and relevant heritage/building render checks. Save a Bangabhaban render manifest and inspect the images before claiming visual pass.

**Depends on:** None.

### M02 — Define a versioned Building Capture Manifest

**Priority:** P0 · **Size:** M

**Scope**
- Define a versioned manifest for each building reconstruction job, extending existing media provenance/BuildingSpec structures instead of creating a competing source registry.
- Represent source ID/hash, rights or permission attestation, facade/view direction, capture notes, image dimensions, camera metadata and confidence, occlusion notes, and links to measured dimensions/control points.
- Give each field a status such as verified, operator-attested, inferred, unknown, or missing, with provenance.

**Acceptance criteria**
- A documented schema and a valid example are checked into the repository.
- The schema distinguishes a verified measurement from an operator estimate or a missing value.
- A source item cannot lose its ID or hash while passing through the manifest.

**Verification:** Add schema/contract tests for valid, invalid, missing, and inconsistent examples. Reuse media-intake tests where applicable.

**Depends on:** None; coordinate with existing BuildingSpec and media-ingestion contracts before coding.

### M03 — Validate capture readiness and facade coverage

**Priority:** P0 · **Size:** M

**Scope**
- Add a validator/report for M02 that checks source hash linkage, rights attestation presence, declared view/facade, image readability, duplicate assets, required measured dimensions and camera evidence.
- Make coverage requirements configurable by workflow. The four-side minimum applies to the controlled pilot; do not reject every legitimate single-image preview as though it were a complete reconstruction.
- Report incomplete sides/corners and occlusions explicitly.

**Acceptance criteria**
- Output separates blocking errors from warnings and lists every missing evidence field.
- An incomplete reconstruction cannot enter a workflow that requires full coverage.
- A single-image preview remains clearly labelled as a preview with unverified hidden geometry.

**Verification:** Add tests for incomplete coverage, duplicated images, missing rights metadata, bad hashes, and valid preview-only input. Run `npm run test:building-media` and `npm run test:media-to-model-workflow`.

**Depends on:** M02.

### M04 — Bind independent references to the existing accuracy evidence pack

**Priority:** P0 · **Size:** M

**Scope**
- Extend the current evidence-pack contract only where the audit proves a missing field; do not create a second benchmark/evidence-pack format.
- Bind each reference image and independent dimension/control record to a named building, facade/view, evidence source and SHA-256 hash.
- Separate operator attestations from externally verified survey/published-measurement evidence.

**Acceptance criteria**
- A missing, stale, or mismatched reference/model hash yields incomplete or failed status, never pass.
- Each dimension and control point identifies its provenance and uncertainty/status.
- The report states that hashes prove file identity, not that a measurement or rights claim is true.

**Verification:** Run `npm run test:building-accuracy-evidence-pack` and `npm run test:building-accuracy-benchmark`.

**Depends on:** M02, M03.

### M05 — Benchmark building-mask/occluder segmentation candidates

**Priority:** P0 · **Size:** M

**Scope**
- Create a small labelled benchmark from permissioned pilot images, including building pixels and relevant occluders/background classes where available.
- Compare plausible pre-trained/local candidates against human-reviewed masks; record model/version, configuration, hardware/runtime, mask output hash, class metrics and failure examples.
- Do not train a new model in this task or introduce a mandatory runtime dependency.

**Acceptance criteria**
- The benchmark contains a train/evaluation separation or a clearly held-out image subset; images from the same short burst cannot silently leak across splits.
- Results include per-image failures and class metrics, not just one average score.
- If no candidate meets the agreed pilot criteria, the report recommends retaining manual review rather than disguising failure.

**Verification:** Commit the benchmark manifest, reviewed-mask provenance and reproducible evaluation command. New numeric thresholds must be explicitly approved/calibrated; do not treat proposed values in the parent plan as already achieved.

**Depends on:** Permissioned source assets; benefits from M02–M04.

### M06 — Add a mask-provider interface and reviewed fallback

**Priority:** P0 · **Size:** M

**Scope**
- Create one provider contract for a candidate segmentation model and the existing manual-mask route.
- Require masks to identify the exact input image hash, dimensions, coordinate convention, provider/model version, confidence/status, and whether a human reviewed the result.
- Keep deterministic edge/sketch output clearly separate from semantic building masks.

**Acceptance criteria**
- A provider can be replaced without changing downstream feature schema.
- Mask/image size mismatch, stale hash, invalid mask, or unavailable provider fails closed or selects an explicitly reviewed manual fallback.
- The pipeline never describes an edge map as a verified building-only mask.

**Verification:** Run `npm run test:mask-guided-building-sketches` and `npm run test:architectural-sketch-preparation`; add provider-contract tests.

**Depends on:** M05; may ship with only the reviewed-mask provider if automatic segmentation fails the benchmark.

### M07 — Define an evidence-linked architectural observation schema

**Priority:** P0 · **Size:** M

**Scope**
- Define a versioned representation for proposed corners, roofline segments, floor bands, wall/facade regions, windows, doors, balconies and visible occluders.
- Every observation includes image/source ID, pixel coordinates or polygon, view identity, confidence, method, and status (proposed/reviewed/rejected).
- Record “not visible” separately from “not detected”; never assume the unseen facade is empty.

**Acceptance criteria**
- Schema validation rejects out-of-image coordinates, dangling source IDs and confidence values outside the documented range.
- Human corrections retain the original proposal and audit history rather than overwriting provenance.
- The structure supports partial observations and unknown features.

**Verification:** Add deterministic fixtures with occluded, partially visible and missing features; add schema tests.

**Depends on:** M02, M06.

### M08 — Produce per-view architectural feature proposals

**Priority:** P0 · **Size:** M

**Scope**
- Implement a bounded first feature-proposal stage over reviewed building masks and edge/contour data.
- Start with observable cues such as silhouette, roofline, outer corners, horizontal floor bands and opening candidates. Use the model selected by M05 only where its output is measurable.
- Preserve per-feature source-pixel evidence and confidence; proposals are not ground truth.

**Acceptance criteria**
- On the labelled pilot subset, report precision/recall or another justified metric per feature category, plus failure examples and unsupported categories.
- A reviewer can inspect proposals overlaid on the original image.
- Missing/occluded features remain unknown rather than being invented.

**Verification:** Add reproducible feature fixtures and tests; include reviewed overlays and hashes in the evidence output.

**Depends on:** M05–M07.

### M09 — Validate camera and projection evidence

**Priority:** P0 · **Size:** M

**Scope**
- Add explicit validation around the calibrated camera/projection matrices currently supplied to the multi-view wireframe stage.
- Check finite values, dimensions/image-size association, camera IDs, coordinate-frame metadata and reprojection against independently checked correspondences where available.
- Keep camera calibration/pose estimation separate from matrix validation; a structurally valid matrix is not proof that the camera is calibrated correctly.

**Acceptance criteria**
- Invalid, mismatched, or unaudited calibration evidence receives an explicit failure/review status.
- Reprojection errors are reported per camera and per observation.
- Scale and world-coordinate origin are not guessed by this validator.

**Verification:** Run `npm run test:multi-view-wireframe-registration`; add tests for bad matrices, mismatched image dimensions, missing camera IDs and known reprojection failures.

**Depends on:** M02, M07.

### M10 — Add robust correspondence QA and outlier handling

**Priority:** P0 · **Size:** M

**Scope**
- Extend the current DLT triangulation path with explicit correspondence-consistency checks and a documented outlier-rejection strategy.
- Preserve rejected observations and reasons in the report; do not silently delete them.
- Make thresholds configurable and report the effect of rejecting an observation on the remaining reconstruction.

**Acceptance criteria**
- Tests include correct correspondences, one mismatched corner, a low-parallax case, and insufficient-view evidence.
- Outlier rejection cannot turn an underconstrained case into an unconditional pass.
- Reprojection results are reported before/after rejection with the selected observations identified.

**Verification:** Run `npm run test:multi-view-wireframe-registration`; add robust-estimation tests and deterministic fixtures.

**Depends on:** M09.

### M11 — Fuse reviewed observations into a confidence-aware shared wireframe

**Priority:** P0 · **Size:** M

**Scope**
- Connect validated per-view features and accepted correspondences to a shared sparse 3D graph.
- Store each vertex/edge's source observations, confidence, reprojection evidence and review state.
- Mark absent faces/sides as unknown or inferred. Do not imply that a sparse wireframe is a complete watertight building.

**Acceptance criteria**
- Repeated corners are represented consistently across views or flagged as conflict.
- Unseen facades remain explicitly unknown/inferred.
- Output includes enough provenance to trace a 3D point back to the original pixels.

**Verification:** Extend `npm run test:multi-view-wireframe-registration` with cross-view fixtures; inspect a deterministic multi-view overlay/report.

**Depends on:** M07, M09, M10.

### M12 — Gate sparse-wireframe conversion to mesh

**Priority:** P0 · **Size:** M

**Scope**
- Define measurable readiness checks between the sparse wireframe and existing mesh-construction/surface-review stages.
- Verify connectivity, face/edge references, orientation/degeneracy, open-boundary expectations and required facade coverage before attempting mesh creation.
- Preserve existing mesh review rather than adding an alternative mesh generator.

**Acceptance criteria**
- Underdetermined wireframes do not silently generate a publishable mesh.
- Failed readiness checks list actionable reasons.
- A mesh produced from a sparse candidate remains a candidate until independent dimension and visual review passes.

**Verification:** Run `npm run test:wireframe-to-mesh` and `npm run test:mesh-surface-review`; add pass/fail readiness fixtures.

**Depends on:** M11.

### M13 — Render using each reference photo's camera

**Priority:** P0 · **Size:** M

**Scope**
- Define how a reviewed source-camera pose/projection maps into the Blender/render coordinate convention.
- Extend the generic renderer from M01 to render a candidate from a source-photo camera, preserving image dimensions, crop and camera metadata.
- If calibration is unavailable, report that the pair is not same-camera-comparable; do not approximate silently.

**Acceptance criteria**
- A test fixture with known camera parameters reproduces the declared projection within a configured, documented tolerance.
- Render manifests store the source image hash, camera evidence ID, output dimensions, GLB hash and render hash.
- Missing or inconsistent camera metadata fails the same-camera claim.

**Verification:** Add fixed-camera render tests and inspect generated reference overlays; run `npm run test:render-review-manifest`.

**Depends on:** M01, M09, M11/M12 candidate geometry.

### M14 — Add building-mask silhouette and edge comparison

**Priority:** P0 · **Size:** M

**Scope**
- Compare source building masks/edges with same-camera render masks/edges from M13.
- Separate silhouette, contour/edge and image-comparability statuses. Keep lighting and texture differences from being mislabelled as geometry errors.
- Attach inputs, hashes, metric definitions and thresholds to the report.

**Acceptance criteria**
- Known synthetic shifts/scale changes produce expected metric direction in tests.
- Missing masks, mismatched dimensions, wrong view IDs or stale hashes yield not-comparable/incomplete, not pass.
- No single image metric can independently approve a building.

**Verification:** Run `npm run test:render-image-similarity-diagnostics` and `npm run test:render-reference-review`; add tests for the new building-specific metrics.

**Depends on:** M06, M13.

### M15 — Add part-aware facade comparison

**Priority:** P0 · **Size:** M

**Scope**
- Compare only feature categories for which the source/reference has reviewed labels: roofline, floor bands, windows, doors, balconies and corners.
- Report errors per facade/view/category and link each error to the source pixels, proposed 3D feature and rendered evidence.
- Clearly mark unlabeled or occluded categories as not-evaluated.

**Acceptance criteria**
- Category-level results are reproducible and contain the exact source/render/model hashes.
- A missing ground-truth label cannot be reported as zero error.
- Human review can override an algorithmic flag with a recorded reason without erasing the diagnostic.

**Verification:** Add labelled fixture tests and evidence overlays. Use category metrics only where the pilot has ground-truth labels.

**Depends on:** M07, M08, M13, M14.

### M16 — Define a defect taxonomy and supported-fix registry

**Priority:** P0 · **Size:** M

**Scope**
- Extend the existing human correction-task workflow with a constrained taxonomy such as scale/proportion, placement/orientation, silhouette, opening layout, roofline, texture projection, UV seam, source/camera mismatch and insufficient evidence.
- Map each supported defect to a specific diagnostic, prerequisites, an available repair adapter (if one truly exists), and a required verification test.
- Unknown or ambiguous causes map to human review, not a guessed geometry edit.

**Acceptance criteria**
- Every automatic fix has an explicit supported-input contract and post-fix validation.
- Unsupported categories remain manual-only.
- Task records retain the original review and evidence hashes.

**Verification:** Run `npm run test:render-correction-tasks` and `npm run test:render-correction-artifact-evidence`; add taxonomy mapping tests.

**Depends on:** M14, M15.

### M17 — Orchestrate bounded correction and regression checks

**Priority:** P0 · **Size:** M

**Scope**
- Connect only approved fix adapters from M16 to a bounded repair loop.
- Start with a maximum of three attempts per defect family, recording each input/output model hash and geometry/texture/render QA result.
- Stop on no improvement, regression, missing prerequisite, hash mismatch or unsupported fix; produce a human-review task.

**Acceptance criteria**
- Tests prove retries are bounded and deterministic given the same inputs/configuration.
- A failed repair cannot overwrite the last known candidate or its evidence.
- A metric improvement on one view cannot waive a regression or mandatory failure on another view.

**Verification:** Run `npm run test:render-correction-verification`, `npm run test:render-correction-artifact-evidence`, and relevant GLB/texture QA tests; add no-improvement and regression fixtures.

**Depends on:** M12, M14–M16.

### M18 — Gate texture reconstruction on geometry and source suitability

**Priority:** P1 · **Size:** M

**Scope**
- Integrate the existing calibrated texture-view selection, UV projection review and atlas baking behind explicit geometry/source readiness checks.
- Track image exposure/colour handling and seam review as separate diagnostics; do not use colour similarity to compensate for geometric mismatch.
- Preserve per-face source-view provenance and uncovered/occluded regions.

**Acceptance criteria**
- Texture baking cannot hide a failed geometry gate or fill unsupported regions with fabricated source textures.
- Incomplete face coverage, UV seams and contaminated/background pixels remain visible in QA.
- Texture changes trigger fresh texture and render evidence.

**Verification:** Run `npm run test:calibrated-texture-uv-projection`, `npm run test:calibrated-texture-view-selection`, `npm run test:texture-atlas`, `npm run test:glb-texture-binding-qa`, and relevant seam-review tests.

**Depends on:** M06, M12, M13; may proceed independently after those contracts stabilise.

### M19 — Produce one accuracy report and enforce the final release gate

**Priority:** P0 · **Size:** M

**Scope**
- Connect, rather than duplicate, the capture manifest, independent dimensions, GCP status, geometry QA, render/reference comparison, correction verification, texture QA and human sign-off.
- Keep separate gate results for geometry/scale, placement, image similarity, facade parts, coverage/rights, textures and review.
- Make publication eligibility consume the current exact artifact hashes and required gate statuses.

**Acceptance criteria**
- Any missing mandatory evidence, stale hash, failed dimension/GCP gate, unresolved high-severity mismatch or absent human approval blocks publication.
- Reports distinguish pass, fail, incomplete, not-comparable, and review-required.
- Unit/CI success alone never certifies real-building accuracy; the report never claims an overall accuracy percentage without a separately validated definition.

**Verification:** Run `npm run test:building-release-readiness`, `npm run test:building-review-package-integrity`, `npm run test:publish-approved-generation-job`, and `npm run test:published-model-catalog`; add gate-combination tests.

**Depends on:** M03, M04, M12, M14–M18.

### M20 — Run the real-building pilot and pin regression baselines

**Priority:** P0 · **Size:** M for the first 2–3 buildings; the wider 10–15 building study is a follow-on set of repeatable runs, not one oversized implementation task.

**Scope**
- Use permitted imagery and independent reference material for one complex landmark, one ordinary low-rise, and (for a three-building pilot) one ordinary high-rise.
- Require front/back/left/right source coverage where obtainable, independently verified dimensions and suitable control evidence; document any missing side instead of inventing it.
- Generate fixed-view renders, reports and hashes; have a reviewer judge each view against the correct reference.
- Freeze the exact source, configuration, model, reference, render and report hashes as a regression baseline.

**Acceptance criteria**
- Each building has a completed evidence manifest, or a clear incomplete status with reasons.
- Dimensions, GCP/georeferencing, geometry QA, facade comparison, textures and human review remain separate results.
- A baseline change requires an explained model/source/config change and fresh review; no historic evidence is silently replaced.
- The pilot report lists known limitations and does not generalise from 2–3 buildings to all Dhaka buildings.

**Verification:** Run `npm run test:building-accuracy-evidence-pack`, `npm run test:building-accuracy-benchmark`, `npm run test:building-release-readiness`, plus the relevant generation, render, geometry and texture test suites. Manually inspect all required images before claiming visual pass.

**Depends on:** M01–M19 in the applicable workflow. A limited pre-integration baseline may be gathered earlier, but it must not be misrepresented as end-to-end validation.

## Proposed execution order

| Batch | Tasks | Completion condition |
|---|---|---|
| A — unblock review evidence | M01–M04 | Generic render works; capture/reference evidence is versioned and validated. |
| B — trustworthy per-view input | M05–M08 | Segmentation choice has evidence; reviewed masks and feature proposals retain source-pixel provenance. |
| C — consistent geometry | M09–M12 | Calibration/correspondences are checked; sparse fusion and mesh readiness fail closed. |
| D — meaningful comparison | M13–M15 | Source-camera renders and building/part-level comparisons are reproducible. |
| E — safe correction and release | M16–M19 | Only supported fixes run; regressions stop; current evidence drives the final gate. |
| F — real-world validation | M20 | Independent pilot evidence and repeatable regression baselines exist. |

## Per-PR checklist

Before a task is marked complete, the PR must include:

- [ ] A short code-change summary naming the existing module(s) reused and any new contract introduced.
- [ ] Unit/integration tests for pass, fail, missing evidence, stale hashes and regression where applicable.
- [ ] The exact commands run and their real results; do not write “pass” without a run record.
- [ ] Relevant JSON reports, manifests, source/reference hashes, render hashes and screenshots/overlays for visual work.
- [ ] Explicit limitations and any manual-review steps still required.
- [ ] No changes to `development` or `main` until the `rakibul-hasan` implementation is reviewed; merge to `main` only after required CI and evidence review pass.

## Completion definition

This backlog is a planning artifact, not proof that any task has been implemented. A task is complete only after its acceptance criteria and tests pass on the relevant commit. The full upgrade is complete only when the integrated pipeline runs on real permissioned buildings with independent references, failed cases remain blocked, and the end-to-end evidence can be reproduced from pinned hashes.
