# BRF-05–07 — Building Visual Evidence and Source-Camera Validation

**Document ID:** BRF-VIS-EVIDENCE-001  
**Version:** 1.0  
**Prepared:** 27 October 2026  
**Status:** Planning baseline — implementation NOT started by this document  
**Tracking issue:** [#199 — BRF-05–07: Building visual evidence and source-camera validation](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/199)  
**Roadmap:** [Building Reconstruction Fidelity Roadmap](./BUILDING-RECONSTRUCTION-90-PERCENT-EXECUTION-ROADMAP.md)  
**Related plan:** [Building Accuracy Upgrade Plan](./BUILDING-ACCURACY-UPGRADE-PLAN.md)

## 1. Executive goal

Deliver the next three reconstruction-backlog items as one coherent feature package:

1. **BRF-05 — Building/occluder masks and review overlays.**
2. **BRF-06 — Per-view semantic architectural feature evidence.**
3. **BRF-07 — Source-camera rendering and comparable reference metrics.**

The package will make the engine explain *which image pixels support each architectural observation*, *what is hidden or uncertain*, and *whether a candidate render is genuinely comparable to its reference*. It should create a trustworthy evidence path from an approved source image to a reviewed GLB comparison, without promoting an unverified model.

This is an execution plan, not evidence of implementation. A schema, passing test, or successful render alone will not prove real-building accuracy. BRF-05/06/07 remain open until their code, exact-head tests, artifacts, limitations and review evidence are recorded.

## 2. Current baseline and assumptions

The repository already has media intake and source-rights records, a BuildingCaptureManifest and candidate evidence manifest, bounded image-quality checks, a generic review renderer, a synthetic baseline with injected defects, geometry QA, and a generated-model candidate workflow. These capabilities provide useful contracts, but do not by themselves guarantee masks, semantically labelled facade features, or comparable real-photo source-camera evaluation.

Treat these items as prerequisites to inspect at implementation time, not as proof that every required integration already exists:
- Approved source and capture manifest with verified path, byte count and hash.
- Image-quality/coverage result, with warnings and missing views preserved.
- Exact BuildingSpec/configuration and candidate GLB hashes.
- Existing generic review renderer contract and the BRF-04 synthetic defect-injection baseline.
- Explicit camera-calibration/pose provenance and independent measurements where available.

Before coding, re-check the current branch heads, existing PRs, overlapping code, CI state, and the schemas already in the repository. Reuse existing names and contracts when compatible; do not create a second competing source-manifest, geometry-QA, or status system.

## 3. Package design and dependency order

Implement one feature branch and one integration PR for the full package, with a separate, reviewable commit for each work package where practical.

| Work package | Inputs | Outputs | Hard dependency |
|---|---|---|---|
| BRF-05: masks | Verified source image + capture manifest | Building/occluder masks, overlay, quality and review state | Source hash/dimensions are verified before decoding |
| BRF-06: semantic features | Source image + accepted/reviewed mask + view metadata | Versioned feature annotations with source-pixel provenance | Every observation maps to a specific original image and coordinate space |
| BRF-07: comparison | Exact candidate GLB + credible source camera + source image/mask/features | Source-camera render and separate geometry/semantic metrics | Non-comparable inputs produce NOT_COMPARABLE, not a numeric pass |
| End-to-end gate | All artifacts above + existing candidate evidence manifest | Hash-linked evidence report and explicit review outcome | No missing evidence can default to PASS |

Do not make the BRF-05 mask implementation dependent on a single hosted segmentation API. The first implementation should support a reliable, inspectable mask artifact and human correction, and keep any optional automatic proposal provider behind a small adapter. Evaluate optional models only after checking local deployment, licence, compute and privacy constraints.

## 4. BRF-05 — Building and occluder masks

### 4.1 Scope

For every supported source view, produce a reviewable pixel-level partition or compatible mask set that distinguishes:
- Building pixels.
- Occluders such as trees/vegetation, vehicles, wires/poles, people, signs and nearby structures where they cover the target building.
- Sky/background.
- Uncertain pixels or boundaries, including shadow boundaries that cannot safely be interpreted as architecture.

Keep class distinctions only where they are supported by the chosen mask representation. If detailed occluder classes cannot be reliably derived in the first slice, preserve an explicit generic occluder/uncertain label rather than inventing a class.

Support an operator-supplied or manually corrected mask even if automatic segmentation is unavailable. Automatic masks are proposals until they pass the chosen validation/review rules.

### 4.2 Artifact contract

The exact schema must be reconciled with the existing evidence manifest before implementation. At minimum each mask artifact must bind:
- Stable building/view/source IDs and the original source SHA-256.
- Actual image width/height, pixel origin, coordinate convention and mask dimensions.
- Mask SHA-256, encoding/label mapping and relative safe artifact path.
- Generator or manual-authoring method, tool/model version and configuration hash when applicable.
- Per-label confidence when available; otherwise an explicit unavailable state rather than a fabricated confidence.
- Review status, reviewer/decision provenance where available, unresolved boundary/coverage notes and failure reasons.
- Versioned schema and validation result.

Mask dimensions must match the verified source image. A mask must never be reused for a different image hash or silently resized/warped to make a mismatch disappear. Any deliberate transform must record the transform and preserve traceability to original pixels.

### 4.3 Review outputs

Generate a deterministic review overlay with:
- Source image and mask boundary/fill shown in distinguishable layers.
- Legend and uncertain/unclassified pixels.
- Source/view ID and truncated hashes for quick inspection.
- A clear status such as NEEDS_REVIEW, ACCEPTED, INCOMPLETE or FAIL.

The overlay is for review, not truth. It cannot, by itself, elevate a source's identity, reuse rights, camera pose, dimensions or geometric accuracy.

### 4.4 BRF-05 tests and acceptance

Required automated cases:
- Valid mask and source image with matching dimensions and hashes.
- Wrong source hash, missing file, unsafe path, corrupt image and corrupt mask.
- Declared image dimensions that differ from decoded dimensions.
- Empty mask, all-building mask, all-background mask and uncertain-boundary mask.
- Tree/wire/vehicle occlusion, cast shadow and partial facade visibility fixtures.
- Near-duplicate views remain separate records and are not counted as independent coverage solely due to having different filenames.
- Deterministic overlay/report for identical bytes, options and software version where deterministic behavior is intended.

**Accept BRF-05 only when** mask/source binding is verified, review overlays can be inspected, failure states are explicit, representative occlusion regressions are covered, and there is no silent PASS for missing/contradictory evidence.

## 5. BRF-06 — Per-view semantic architectural feature evidence

### 5.1 Scope

Create a versioned, reviewable representation for visible architectural observations in original source-image coordinates. Initial feature classes should include:
- Silhouette/outline, roofline and visible corners.
- Facade planes and floor bands.
- Window and door openings.
- Arches, columns, balconies and cornices.
- Visible roof components, including dome/drum/finial where applicable.

Allow a feature to be a point, line/polyline or polygon/region according to its geometry. Avoid forcing all architecture into bounding boxes. Keep class definitions and coordinate semantics explicit and versioned.

### 5.2 Minimum feature record

Each feature observation should reference:
- Stable feature ID, schema version, building ID and view/source ID.
- Original source image hash, image width/height and coordinate frame.
- Semantic class and point/line/region geometry in the original pixel coordinate system.
- Visibility status: OBSERVED, PARTLY_OCCLUDED, INFERRED or UNKNOWN.
- Confidence with a defined scale and producer; use MISSING when no defensible value exists.
- Method/model version, configuration and source-pixel provenance.
- Optional reviewer correction, decision and links to the superseded observation.
- Mask/review artifact reference where relevant.

Do not conflate a detected feature proposal with accepted truth. Preserve provenance when a human corrects a label or location, and keep the original proposal available for audit. A hidden rear window or unseen wing is UNKNOWN/INFERRED unless independent evidence exists; do not fabricate its pixel coordinate or treat a symmetry assumption as an observation.

### 5.3 Feature consistency checks

Validate:
- All coordinates are finite and lie within the declared source coordinate space, with an explicit tolerance policy for line boundaries.
- The referenced source hash and dimensions match the current image.
- Feature type is compatible with its geometry representation.
- An OBSERVED feature has source-pixel support and cannot be attached to a missing or mismatched view.
- PARTLY_OCCLUDED features reference the corresponding mask/visibility evidence where available.
- INFERRED and UNKNOWN features are excluded from observed-feature precision/recall truth unless a separate, explicit evaluation protocol says otherwise.
- Duplicate/conflicting annotations are flagged rather than silently averaged.
- Schema migration preserves original provenance and does not upgrade uncertain observations to observed.

### 5.4 BRF-06 tests and acceptance

Required fixtures:
- A simple facade with known annotated features.
- A partly tree-occluded facade and a shadow that resembles an opening.
- A heritage facade with an arch/column/dome component.
- Invalid coordinates, wrong source hash, incompatible geometry type, missing confidence and contradictory visibility.
- Human-corrected proposal with retained before/after history.
- Serialization/deserialization round-trip preserving coordinates, classes and provenance.

**Accept BRF-06 only when** every evaluated feature traces back to the correct source view and pixels, observed/inferred/unknown are distinct, human review is preserved, and invalid or ambiguous evidence cannot silently pass.

## 6. BRF-07 — Source-camera rendering and comparable metrics

### 6.1 Source-camera validity gate

Render the exact candidate GLB from the source view's camera only when camera pose/intrinsics and the model-to-camera transform are sufficiently documented. Record the pose source (calibrated, SfM-estimated, operator-supplied or unknown), uncertainty, coordinate frame, distortion handling, and any calibration/reprojection diagnostics.

A front photo must not be compared against a side view. A guessed camera pose must not be described as calibrated. If source pose, target facade, crop, image registration or scale cannot be justified, the result must be NOT_COMPARABLE or LOW_CONFIDENCE_REVIEW, with reason codes and no passing comparison score.

Cropping or masking to isolate the target building is allowed only if the same evidence-based region is applied fairly. Do not non-rigidly warp the rendered building or tune camera parameters just to make the candidate score better. Save the exact camera and comparison configuration used.

### 6.2 Separate metric families

Where preconditions are met, report separately:
- **Silhouette:** intersection-over-union (IoU) and the source/render mask definitions.
- **Contour/edge:** symmetric contour distance with pixel units and clear normalization, including the evaluation region.
- **Semantic features:** class-wise precision/recall/F-score or keypoint/line distance against human-reviewed annotations; report per-class counts so an empty class cannot look perfect.
- **Metric geometry:** compare width/depth/height and ground-control residuals only when independent truth with units/uncertainty exists.
- **Appearance:** keep SSIM/LPIPS/colour metrics separate and optional; do not allow an appearance metric to cancel a geometry failure.
- **Coverage/uncertainty:** visible, partly occluded, inferred and unknown surface/feature coverage, as available.

Each metric records formula/version, unit, threshold version, prerequisites, reference ID/hash, GLB hash, render hash, configuration hash, sample count and status. Missing ground truth is MISSING, not zero error. Non-comparable views are excluded from aggregates but counted and explained; they may not be quietly dropped.

### 6.3 Evidence report and provenance

Bind the report to:
- Source image and capture-manifest hashes.
- Building/occluder mask and semantic-feature annotation hashes.
- Camera/pose record and camera-configuration hash.
- Candidate GLB, BuildingSpec and generator/configuration hashes.
- Source-camera render and optional standardized review-render artifacts.
- Metric implementation/version, parameters, thresholds, evaluation status and reviewer decision.

Run the comparison twice on the same deterministic fixture and check report stability. If a renderer, driver or model component is inherently nondeterministic, document and test an explicit tolerance rather than claiming byte-identical images without evidence.

### 6.4 BRF-07 tests and acceptance

Required tests:
- Correct source camera and correct facade.
- Unknown camera pose, missing intrinsics, invalid transform and inconsistent calibration.
- Wrong facade/camera, shifted crop and mismatched image resolution must produce NOT_COMPARABLE/FAIL as specified.
- Wrong roofline, shifted dome, missing wing and window-placement defects are visible to the appropriate geometry or semantic metric.
- Texture/material changes cannot mask a geometry regression.
- Missing independent dimensions, camera metadata or annotations never yields fabricated metrics.
- Source/model/config/report hash mismatch invalidates the evidence package.
- Fixed fixture rendering verifies required review views and, where the renderer supports it, the expected source-camera projection; a source-code test alone is insufficient.

**Accept BRF-07 only when** the comparison is demonstrably source-camera-bound, comparable and non-comparable cases are distinguished, metrics are independently named and hash-bound, injected geometry defects trigger the intended gates, and the output remains review-only.

## 7. Cross-package integration

The combined candidate workflow should follow this order:

1. Verify source identity, reuse/rights state, file integrity and capture-manifest status.
2. Verify image dimensions and quality results.
3. Create/import building and occluder masks.
4. Review/correct mask and visibility uncertainty.
5. Create/import semantic feature proposals and record human edits.
6. Verify camera provenance and source-to-model coordinate transforms.
7. Render the exact candidate from each eligible source camera.
8. Compute only metrics whose preconditions and independent truth are available.
9. Bind all artifacts and metrics to the shared candidate evidence manifest.
10. Emit a final evidence outcome plus explicit blockers and human-review needs.

Expected overall statuses are: PASS, LOW_CONFIDENCE_REVIEW, NOT_COMPARABLE, INCOMPLETE and FAIL, subject to existing repository status conventions. Statuses must be normalized to the current repository contract rather than introducing incompatible duplicate enums. PASS is permitted only for the claims whose required evidence and thresholds actually pass.

## 8. Package-wide regression matrix

| Risk | Injected condition | Required behavior |
|---|---|---|
| Wrong source identity | Correct filename but different source hash | Reject stale mask/annotation binding |
| Corrupt or contradictory data | Bad image/mask bytes or dimensions | Fail closed with reason |
| Occluder contamination | Tree/wire/vehicle across facade | Mark visibility/uncertainty; do not count blocked geometry as observed |
| Shadow hallucination | Shadow resembles a window/arch | Flag uncertain proposal for review |
| Unsupported semantics | Missing or unseen rear features | Keep unknown/inferred; no made-up observation |
| Camera mismatch | Wrong orientation, facade, intrinsics or transform | NOT_COMPARABLE/FAIL, never score as pass |
| Crop manipulation | Candidate is warped/cropped to hide mismatch | Comparison validation rejects or reports the altered region |
| Metric laundering | Good texture score but wrong massing | Geometry hard gate still fails |
| Stale artifact | Model, source, config or report hash changes | Evidence graph invalidated |
| No-op correction | Defect handler does not change geometry | No accuracy-improvement claim; review/fail |
| Empty class | No annotated windows or no detected openings | Report sample count and undefined/missing metric, not automatic perfect score |
| Nondeterminism | Repeated run changes report/render unexpectedly | Regression fails or documented tolerance is exceeded |

## 9. Delivery stages and merge strategy

### Stage A — Contract and fixture groundwork
- Inspect and reuse the existing capture manifest, evidence manifest, renderer profile and geometry-QA contracts.
- Define or extend versioned schemas and status handling.
- Add source-image and camera-coordinate fixture helpers.
- Add schemas, example artifacts and tests before integrating any optional learned segmentation model.

### Stage B — BRF-05 masks and review overlays
- Implement safe input validation, mask storage/validation and a deterministic review overlay.
- Add operator correction/import path and representative occlusion fixtures.
- Record actual runtime evidence and inspect the generated overlays.

### Stage C — BRF-06 semantic feature evidence
- Implement schema, validators, serialization and review history.
- Add class/visibility/pixel-provenance fixtures and consistency checks.
- Keep automated feature extraction as a proposal path until evaluated against labelled examples.

### Stage D — BRF-07 source-camera rendering and metrics
- Implement camera eligibility checks and source-camera rendering.
- Add silhouette, contour and semantic metrics with explicit preconditions and versions.
- Add deliberately wrong-camera/crop and geometry-defect tests.
- Execute renderer/visual QA workflow and inspect produced images/artifacts.

### Stage E — End-to-end gate and evidence package
- Link all artifact hashes in the existing candidate evidence manifest.
- Verify fail-closed statuses and no accidental map-publication eligibility.
- Run full CI on the exact PR head and all applicable renderer/visual workflows.
- Update the roadmap with implementation commit(s), PR URL, workflow IDs, artifact links, actual results, known limitations and exactly one next task.

### Branch/PR discipline
- Working snapshot at plan creation: branch rakibul-hasan, head 2fa1570e418d2e80eb6956e7461ec4b2f99a7dc2.
- Plan-only branch: plan/brf-05-07-visual-evidence.
- Implementation should use a fresh feature branch based on the latest intended base at execution time; do not assume this planning branch is the implementation branch.
- Prefer one combined implementation PR with separate logical commits, but split if safe review, CI scope, or independent change ownership requires it.
- Preserve unrelated local/remote work; do not force-push to or overwrite rakibul-hasan, development, or main.
- Merge into development only after exact-head CI, visual artifacts and review gates pass. Promote development to main only after checking branch heads, conflicts, exact-head CI and applicable renderer QA.

## 10. Exit criteria

The BRF-05–07 package is complete only when all apply:
- [ ] Versioned mask and semantic-evidence contracts are implemented and documented.
- [ ] Source/mask/annotation dimensions and hashes are validated at every boundary.
- [ ] Review overlays and annotation artifacts are generated and visually inspected.
- [ ] Observed, partly occluded, inferred and unknown evidence remain distinct.
- [ ] Source-camera validity is explicit; ineligible views do not receive a passing score.
- [ ] Geometry/semantic/appearance metrics are separate and use versioned formulas.
- [ ] Injected source, occlusion, camera, crop, roofline and opening defects trigger expected states.
- [ ] Repeated deterministic fixtures are stable within documented tolerances.
- [ ] Shared evidence manifest binds the exact image, annotations, GLB, configuration, render and report hashes.
- [ ] Exact-head full CI and relevant visual QA pass with actual workflow URLs and artifacts.
- [ ] Candidate remains non-published/non-map-ready absent the separate release gate.
- [ ] Roadmap execution log states exact commits, findings, limitations and one next task.

## 11. Non-goals and honest claims

This package does not:
- Guarantee a universal 90% architectural match.
- Prove a source photo depicts the claimed building or that its licence attestation is legally sufficient.
- Supply missing survey dimensions, hidden facades or calibrated camera poses from nothing.
- Treat AI-generated images, a synthetic cuboid or a green CI run as independent real-building ground truth.
- Automatically publish reviewed GLBs to the production map.
- Complete BRF-08 independent-truth evaluation, BRF-09 multi-view fusion or BRF-10 bounded repair; those remain downstream roadmap items.

A later accuracy claim must name its metric, eligible evidence tier, building population, reference truth, threshold version and per-building failures/uncertainty. Until such a benchmark exists, real-world improvement remains unquantified.

## 12. Current execution state

- Planning issue: [#199](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/199).
- Plan branch created from the rakibul-hasan head 2fa1570e418d2e80eb6956e7461ec4b2f99a7dc2.
- Planning documentation only; BRF-05, BRF-06 and BRF-07 implementation status remains OPEN.
- Exact-head CI and actual visual artifacts are required after implementation; no accuracy result is asserted by this plan.
