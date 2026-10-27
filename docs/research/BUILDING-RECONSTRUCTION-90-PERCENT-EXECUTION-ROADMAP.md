# Building Reconstruction Fidelity — 90% Target Execution Roadmap

**Document ID:** BRF-90-ROADMAP-001  
**Version:** 1.0  
**Prepared:** 26 October 2026  
**Status:** Proposed implementation plan; this document does not itself change engine code.  
**Related research:** [Building Accuracy Upgrade Plan](./BUILDING-ACCURACY-UPGRADE-PLAN.md)

## New-chat continuation protocol

When resuming this engineering work in a new chat, read this document first and then review the linked research plan. Before editing code, inspect the current GitHub branch/PR head, exact commit SHA, open review threads and CI state; the execution log below is the source of the next-step pointer, not a substitute for checking live GitHub state.

1. Continue the earliest backlog item marked **IN PROGRESS**. If none is in progress, take the earliest unchecked task in the order defined in Section 7.
2. Make one small, scoped implementation per feature branch/PR. Preserve existing unrelated changes and use the existing branch relationship recorded in the live PR.
3. Add/adjust automated tests and a regression test for the gap being fixed. Run CI on the exact commit SHA; don't describe pending checks as passing.
4. At task end, update this roadmap's checkbox and execution log with the changed files, commit SHA, PR link, test/workflow ID and actual result, known limitations, and exactly one next task.
5. Do not merge through to `development` or `main` until exact-head CI and applicable evidence/review gates pass. Do not claim a model's architectural accuracy from a green code CI run.

`PASS` is a test/evidence outcome, not a promise of universal 90% fidelity. Keep missing data explicitly missing and carry confidence/observed/inferred distinctions throughout.


## 1. Goal and honest definition

Upgrade the building-generation system to make evidence-backed, high-fidelity models across diverse building types. “Around 90% match” is a target to validate on suitable, well-documented cases, not a guarantee for any building from any input. A rectangular block with surveyed dimensions is easier to reconstruct than a heritage palace with occluded wings, curved roofs, deep arcades and only one frontal photo.

Always report separate dimensions of fidelity:

1. **Massing and silhouette:** footprint, wings, total envelope and roof form.
2. **Metric geometry:** width, depth, height, floor levels and critical component dimensions against independent measurements.
3. **Facade structure:** visible wall planes, floors, openings, arches, columns, balconies and cornices.
4. **Surface geometry:** mesh-to-reference distance, completeness, topology and major normals.
5. **Appearance:** source-supported colour, material and texture under comparable imaging conditions.
6. **Placement:** scale, axis convention, orientation, coordinate frame and geospatial registration.
7. **Evidence confidence:** observed versus inferred versus unknown parts and the provenance behind each.

Do not publish one unexplained “90% accurate” number. A texture score must never hide a wrong footprint or height. If a composite score is eventually shown, publish its formula, per-axis metrics, hard-gate failures, evidence tier and uncertainty.

**Evidence rule:** a valid GLB, successful render, clean topology or photorealistic AI image is not proof that a model matches the real building.

## 2. Research-derived gaps and fixes

The linked research plan contains the fuller repository audit and source notes. These are the implementation-critical gaps:

| ID | Gap | Why it matters | Fix | Priority |
|---|---|---|---|---|
| G01 | Input coverage, source rights and measurement provenance are not guaranteed as an end-to-end hard contract. | Photos may cover one side only, depict different renovations or lack scale; unseen geometry can be invented. | Versioned capture manifest, rights/source provenance, independent dimensions, camera metadata and explicit missing/unknown states before route selection. | P0 |
| G02 | Building masks and semantic facade understanding are not consistently integrated into the default pipeline. | Trees, wires, cars, shadows and perspective distortions can be mistaken for architecture; edges do not identify a window or arch. | Per-view building/occluder masks, roofline/corner/floor/opening labels, confidence and source-pixel provenance, with human correction. | P0 |
| G03 | SfM, sparse wireframe, mesh generation and texture stages exist as separate capabilities but are not guaranteed to form a single confidence-aware workflow. | Successful individual stages can still produce conflicting corners, wrong scale or missing sides. | One resumable orchestration path; common camera/feature frame; outlier rejection; per-part provenance; unsupported surfaces marked inferred/unknown. | P0 |
| G04 | Render comparison may not have the same source camera, facade, crop, building mask and matching hashes. | Comparisons from different viewpoints are misleading; synthetic-to-synthetic tests do not validate against a real photo. | Source-camera render where pose is credible; silhouette, contour and facade-part metrics; exact hash binding; non-comparable views do not pass. | P0 |
| G05 | A defect report or correction task does not prove the GLB was corrected. | A task can describe a wrong dome or wing without changing model geometry. | Typed defect-to-action registry, safe preconditions, bounded retries, before/after metrics, regression checks and human-review fallback. | P0 |
| G06 | Deterministic procedural output can remain too generic for unique architecture. | A box with repeated windows, flat roof and primitive dome can be structurally valid but visually far from the target. | Hybrid model: measured footprint/dimensions plus evidence-conditioned semantic components and reusable parametric grammar; unsupported details stay provisional. | P0/P1 |
| G07 | Photogrammetry, image-to-3D, NeRF and Gaussian Splatting solve different problems. | Generative methods may hallucinate unseen geometry; radiance/gaussian representations may render well without producing a scaled, clean architectural mesh. | Benchmark methods per task. Use COLMAP/MVS when overlap supports it; treat generative output as proposal until geometry is independently checked; mesh extraction/repair is a separate gate. | P1 |
| G08 | Texture can hide geometry defects and may include wrong camera projections, UV stretching or background contamination. | A pasted window texture can make a blank wall look detailed without correct geometry. | Geometry-first gate; face-wise image selection; occluder masking; UV/stretch/seam QA; source-face attribution; report appearance independently. | P1 |
| G09 | A small number of tuned examples cannot establish a universal 90% claim. | Evaluating on buildings used to tune rules exaggerates generalisation. | Development set plus separate holdout buildings with independent references; report per-building/per-class performance and failures. | P0 |
| G10 | Green CI can be conflated with architectural accuracy. | A build only proves the tests that ran. | Separate software health, pipeline integrity, metric regression and human-reference review gates, all bound to exact hashes. | P0 |

## 3. Target architecture

Keep the deterministic procedural path; do not replace it with a single black-box AI endpoint. Integrate the existing capabilities into an evidence-driven workflow:

~~~text
Source registry + rights
  → Capture manifest + quality/coverage preflight
  → Per-view analysis
      • camera intrinsics/pose/uncertainty
      • building mask + occluder masks
      • silhouette, corners, roofline, floor bands
      • windows/doors/columns/arches/roof features
  → Geometry evidence fusion
      • surveyed footprint/dimensions
      • COLMAP SfM + dense MVS when inputs support it
      • matched features, robust outlier rejection
      • observed / inferred / unknown labels
  → Hybrid geometry builder
      • measured base shell and levels
      • planes, wings, roof profiles
      • parametric architecture components
      • optional reconstructed detail mesh
  → Mesh, units, scale and coordinate QA
  → Source-camera render + geometry/semantic evaluation
  → Defect registry → bounded fix → re-evaluate
  → Geometry accepted?
      • no: LOW_CONFIDENCE_REVIEW or FAIL
      • yes: UV/texture/PBR → appearance QA
  → Evidence package + PASS / LOW_CONFIDENCE_REVIEW / FAIL
~~~

Every stage must emit a versioned artifact and typed status, not only console output. Preserve repeatability where possible and bind every report to immutable inputs, configuration and output hashes.

### Required model evidence package

- Capture manifest, source hashes and allowed-use/attribution status.
- Camera intrinsics, distortion, pose source and uncertainty per image.
- Independent measurements, units, measurement source, uncertainty and control/check-point IDs.
- Per-view building/occluder masks, semantic annotations and review overlays.
- Pipeline route, software/model versions, configuration and random seed where applicable.
- GLB hash, dimensions, topology report, units, axes and orientation.
- Source-camera render manifest and source/reference/model/render hashes.
- Per-view and per-part metrics, plus observed/inferred/unknown surface coverage.
- Each repair action, preconditions, before/after metrics, retry count and result.
- Final gate, unresolved blockers and human-review decision if required.

## 4. Phased implementation plan

### Phase 0 — Generic renderer and trustworthy baseline (P0)

**Work**
1. Remove building-name/node/material assumptions from the review renderer.
2. Define a shared candidate evidence-manifest schema used by renderer, QA, report and release gate.
3. Freeze deterministic baseline fixtures, including the current Bangabhaban candidate, with GLB/report/render hashes.
4. Distinguish: generated, structurally validated, rendered, comparable to real references, independently measured, human reviewed.
5. Make missing or stale evidence fail closed.

**Acceptance**
- Any supported valid fixture GLB can render from fixed review views.
- Repeated runs with identical inputs/config produce stable reports and renders within explicit tolerances.
- Missing camera/reference data returns NOT_COMPARABLE, never pass.
- CI clearly distinguishes engine correctness from real-building fidelity.

### Phase 1 — Capture manifest and pilot benchmark (P0)

**Work**
1. Add a versioned BuildingCaptureManifest: source ID/hash, rights, image orientation/size, view/facade, capture metadata when available, camera/pose provenance, quality/occlusion, control points, independent dimensions and uncertainty.
2. Preflight blur, exposure clipping, orientation, near-duplicates, same-building identity, overlap, front/back/side/corner coverage and occlusion.
3. Define evidence tiers:
   - **A — Survey-grounded:** independent survey/LiDAR/CAD/BIM or reference mesh, measured dimensions and coordinate frame.
   - **B — Multi-view-grounded:** overlapping views, credible camera pose, scale/control points and footprint/dimensions.
   - **C — Sparse-reference:** limited views, incomplete overlap/scale or unseen sides.
   - **D — Single-image/generative preview:** no independent scale or depth truth.
4. Build a development set of 10–15 diverse buildings and reserve 3–5 separate buildings as an untouched holdout. Include ordinary, irregular, tall and heritage examples if lawful reference data is available.
5. Keep licence, attribution and access conditions attached to every reference.

**Acceptance**
- Every used source has stable ID, hash and reviewed reuse status.
- Each required view is usable, excluded with a reason, or missing.
- Each critical dimension is independently sourced or labelled MISSING; inferred values are never labelled measured.
- Holdout buildings are not used to tune thresholds or model rules.
- Tier C/D output cannot be labelled as independently verified geometry.

### Phase 2 — Per-view architectural understanding (P0)

**Work**
1. Generate reviewable building masks and separate masks for trees, wires, cars, sky and other occluders. Segmentation model outputs are candidates, not architectural truth.
2. Extract feature candidates in original image coordinates: silhouette, roofline, corners, floor bands, windows, doors, columns, arches, balconies, cornices and visible roof/dome components.
3. Save confidence, source-pixel positions, visibility, algorithm/version and manual overrides.
4. Import or estimate camera intrinsics/pose; record calibrated, SfM-estimated, operator-supplied or unknown state. Undistort only when supported by camera parameters.
5. Propagate occlusion and uncertainty; do not count fully hidden components as observed architecture.

**Acceptance**
- Labelled validation samples report segmentation and feature precision/recall.
- Engineers can inspect an overlay and trace each feature to its supporting pixels.
- Camera calibration status and reprojection residual are recorded.
- Synthetic fixtures with clutter and partial occlusion exercise the relevant failure paths.

### Phase 3 — Confidence-aware multi-view fusion (P0)

**Work**
1. Reuse COLMAP for compatible SfM/MVS capture sets, preserving camera and scale diagnostics.
2. Bring poses and matched features into one explicit coordinate frame.
3. Reject outlier matches robustly; enforce shared-corner, facade-plane and footprint constraints only where evidence supports them.
4. Resolve observations using calibration confidence, reprojection error, visibility, angle, sharpness and independence of views; preserve rejected alternatives and reasons.
5. Trace each output part/surface to source observations. Mark unseen surfaces inferred/unknown.
6. Verify scale and footprint against independent dimensions/controls; document horizontal and vertical datum separately.

**Acceptance**
- Test wrong matches, camera conflict, low overlap, missing facades and contradictory dimensions.
- Report median/p95 reprojection error, corner residual, footprint IoU, independent scale source and inferred-surface percentage.
- Worker success alone cannot mark a candidate PASS.
- Unresolved cross-view conflict produces review/fail, not a silent averaged geometry.

### Phase 4 — Hybrid geometry and architectural grammar (P0/P1)

**Work**
1. Use measured footprint, width/depth/height and major levels as constraints when available.
2. Extend BuildingSpec to represent wings, floor bands, roof profiles, arches, columns, domes/drums/finials, openings, cornices and balconies with explicit provenance: measured, observed, inferred, default or missing.
3. Build reusable parametric components with dimension/normal/topology tests; apply symmetry only where justified by the evidence.
4. Fit parts to observations rather than using one universal facade template.
5. Maintain distinct levels of detail. Macro massing must remain stable when adding details; texture must not fake missing geometry.
6. Optional reconstructed detail meshes must pass scale, topology and geometry comparison before acceptance.

**Acceptance**
- Golden fixtures validate primitive dimensions, orientation, normals and topology.
- Same spec/config/version produces repeatable output.
- Major footprint and envelope meet applicable independent-measurement tolerances.
- Unsupported roof/facade forms generate warnings/review instead of silent misleading fallback.
- Geometry gates cannot be bypassed by changing materials/textures.

### Phase 5 — Source-camera, semantic and geometric evaluation (P0)

**Work**
1. Render from source-camera pose when credible; otherwise record why a view is not comparable.
2. Align source/candidate masks and crop but never warp away genuine shape differences just to improve the score.
3. Report metric families separately:
   - silhouette IoU and symmetric contour/edge distance;
   - floor-band, window/door/arch/column precision-recall and keypoint error;
   - per-axis width/depth/height error against independent measurements;
   - footprint IoU and, when a true reference scan/mesh exists, Chamfer, Hausdorff and thresholded F-score;
   - SSIM/LPIPS or appropriate appearance metrics only for comparable views;
   - reprojection and independent check-point residuals.
4. Report median, p95, worst error, coverage and uncertainty by view/building; don't allow appearance to mask geometry failure.
5. Freeze thresholds only after the pilot, measurement precision and reviewer agreement are understood; evaluate on untouched holdout.

**Provisional pilot thresholds — not universal or yet validated**
- Footprint IoU: test ≥ 0.90 where an independently traced footprint exists.
- Width/depth/height relative error: test ≤ 5% when reference measurement precision supports it.
- Reprojection error: test median ≤ 2 px and p95 ≤ 5 px only with credible camera calibration and verified correspondences.
- Opening/floor/arch metrics: set thresholds after review of labelled pilot examples.
- 3D distance thresholds: derive from task needs and survey precision.
- Texture/color thresholds: only after defensible illumination/exposure treatment.

**Acceptance**
- Each metric documents formula, unit, preconditions, threshold version and evidence ID.
- Missing required truth yields MISSING, never a made-up score.
- A 90% claim is allowed only for named metrics and a validated building/evidence population with mandatory gates passed.

### Phase 6 — Typed correction loop (P0)

**Work**
1. Define defect records with defect type, affected part/view, supporting evidence, confidence, proposed action, preconditions, expected metric and side effects to re-check.
2. Implement fix handlers incrementally: camera misregistration, bad mask, footprint/dimension mismatch, roof/wall-plane mismatch, opening/floor mismatch, texture source/seam.
3. Start with a maximum of three automatic repair passes per candidate. Require human review for ambiguous architectural interpretation.
4. Save immutable before/after GLBs, reports and hashes.
5. Stop on no improvement, critical regression, repeated defect, insufficient evidence or exhausted retry budget. A task/report alone is not a completed fix.

**Acceptance**
- Injected defects route to correct handler or human review.
- Each fix carries before/after metric changes and hashes.
- Any critical metric regression blocks pass.
- Retries are bounded; unresolved critical defects produce LOW_CONFIDENCE_REVIEW or FAIL.

### Phase 7 — UV, texture and appearance (P1, after geometry approval)

**Work**
1. Select reference images per face by visibility, angle, resolution, sharpness and occlusion.
2. Mask background/occluders; apply seam-aware multi-view blending and preserve face/source attribution.
3. Test UV coverage/stretch, material bindings, seam discontinuity, texture sharpness and background contamination.
4. Mark every surface source-textured, procedural, inferred or untextured. Never present a hidden side as photo-observed.

**Acceptance**
- Required UV/material bindings have no unreviewed failures.
- Texture coverage and provenance are reported.
- Appearance gains cannot change or override geometry results.

### Phase 8 — Holdout evaluation and release (P0 release blocker)

**Work**
1. Run the frozen system on untouched holdout buildings.
2. Report results per building, class, evidence tier and reconstruction route, including failures and uncertainty.
3. Change thresholds only by reviewed decision; never relax them automatically to pass CI.
4. Require human review of complex/heritage structures and any candidate with critical uncertainty.
5. Publish only PASS; keep LOW_CONFIDENCE_REVIEW in a separate review layer and reject FAIL.
6. Require exact-head CI plus the relevant evidence package before promotion to development/main.

**Acceptance**
- Holdout results are reproducible and no holdout data was used for tuning.
- The report includes per-axis distributions, failures and uncertainty, not only averages.
- Map eligibility is tied to exact GLB/source/config/report hashes.
- A broad “90%” claim is made only for explicit metrics and validated evaluation conditions.

## 5. Technology-selection rules

- **COLMAP + dense multi-view stereo:** classical geometry path where overlap and texture support feature matching; check scale and completeness independently.
- **OpenCV:** calibration, undistortion, geometric transforms and reprojection diagnostics when camera data supports them.
- **Segmentation (e.g. SAM 2) plus facade-specific feature detection:** candidate masks/labels only; general object masks are not a complete facade grammar.
- **Open3D or equivalent mesh tools:** point/mesh distance, completeness and geometry checks when an independent reference is available.
- **Procedural/parametric GLB generation:** deterministic base and architecture components, conditioned on actual evidence rather than one generic template.
- **NeRF / 3D Gaussian Splatting:** optional appearance/scene-reconstruction experiments, not a default substitute for scaled, clean architectural meshes.
- **Image-to-3D/generative models:** proposals until independent geometry evaluation demonstrates reliability; track version, licence, nondeterminism, data handling and compute costs.
- **CityGML/CityJSON, GIS and BIM:** use structured footprint/roof/wall data only with known licence, coordinate frame and freshness.

Do not add a dependency just because a paper claims a benchmark gain. Reproduce a small local baseline comparison, measure quality/runtime/cost, then check licence, deployment, GPU and security requirements.

## 6. CI regression matrix

| Area | Cases to test | Required behavior |
|---|---|---|
| Evidence intake | Missing dimensions, wrong building, duplicate, bad orientation, blur, low overlap, unknown reuse status | Explicit warning/rejection; never verified |
| Masks/features | Trees, wires, cars, shadows, partial occlusion, arch confused with shadow | Reviewable overlays; propagate uncertainty |
| Camera/scale | Bad intrinsics, conflicting distances, collinear controls, poor pose | Fail or mark not verified |
| Fusion | Wrong correspondences, missing side, contradictory corners and dimensions | Reject outliers; retain conflicts and unknown surfaces |
| Geometry | Wrong height, missing wing, shifted dome, flat-roof fallback, disconnected component | Relevant metric/structural gate detects defect |
| Render/compare | Wrong camera/crop/facade, synthetic reference, stale hash | NOT_COMPARABLE or fail, never false pass |
| Texture | Stretched UV, wrong binding, background baked in, no source visibility | Texture gate flags issue; geometry score unchanged |
| Repair | No-op action, cross-facade regression, repeated defect, retry exhaustion | Stop, save evidence, review/fail |
| Release | Missing ground truth, unresolved critical defect, stale report, low confidence | No PASS/publication |

Each golden fixture should include inputs, expected dimensions, camera matrices, reference renders, GLB/config hashes and expected gate result. Include injected-defect tests to verify the gate itself continues to work.

## 7. First implementation backlog

These are proposed tasks, not code changes already completed.

- [x] **BRF-01 (P0, COMPLETE):** Generic renderer contract; exact-head CI and the dedicated Blender 13-view smoke test passed in PR #187. This establishes renderer/manifest integrity, not real-building architectural accuracy.
- [x] **BRF-02 (P0, COMPLETE):** Shared candidate evidence manifest implemented in Draft PR #188; exact-head CI #40347926520 passed with 132 successful workflow steps. Hash/path, camera provenance, confidence and publication-disabled gates are tested.
- [x] **BRF-03 (P0, COMPLETE):** Draft PR #189 passed exact-head CI #40352859459 (132 successful workflow steps). JPEG/PNG quality screening, near-duplicate hints, dimension consistency, safe file integrity and still/video-frame coverage are regression-tested; publication remains disabled.
- [x] **BRF-04 (P0, COMPLETE):** Controlled synthetic cuboid baseline (10×8×6 m), fixed 2% dimension tolerance, deterministic repeatability, and injected 20% Y-scale / degenerate-triangle defects are implemented in Draft PR #190. Exact documentation-updated head `dce0d4f92e6e30feb9cff2880c3175dc2feeaf13` passed full CI run #40360853267. This is a synthetic QA baseline, not proof of real-building accuracy.
- [ ] **BRF-05 (P0):** Building/occluder masks with review overlays and human correction.
- [ ] **BRF-06 (P0):** Per-view architectural-feature schema with confidence and provenance.
- [ ] **BRF-07 (P0):** Source-camera render comparison with silhouette/contour and facade-part metrics.
- [ ] **BRF-08 (P0, IN PROGRESS):** Independent-truth evaluator for footprint/dimensions, surface distance when reference geometry exists, and check points. First scoped slice adds physical-building-level holdout split protection, equal-weight per-building segmentation summaries, and explicit held-out failure cases; independent metric-geometry/surface-distance evaluation and real-world acceptance remain open.
- [ ] **BRF-09 (P0):** Confidence-aware multi-view fusion and observed/inferred/unknown surface coverage.
- [ ] **BRF-10 (P0):** Defect registry plus bounded correction/re-test.
- [ ] **BRF-11 (P1):** Parametric grammar for roof, arches, domes, columns, openings and cornices fitted to evidence.
- [ ] **BRF-12 (P1):** Face-wise source selection, UV/texture checks and appearance metrics after geometry approval.
- [ ] **BRF-13 (P0 release gate):** Separate holdout set, threshold freeze, report card and fail-closed map eligibility.

**First engineering package:** BRF-01 → BRF-02 → BRF-03 → BRF-04. Establish a comparable baseline and evidence contract before investing in a larger learned reconstruction pipeline.

## 8. Release checklist

A candidate can be PASS only when every applicable hard gate has explicit evidence:

- [ ] Source identity, reuse rights, coverage and hashes traceable.
- [ ] Camera pose/calibration and scale marked measured, estimated or unknown.
- [ ] Major footprint/dimensions have independent references or are explicitly unverified.
- [ ] Observed, inferred and unknown geometry are separated.
- [ ] GLB topology, units, axes and coordinate frame pass.
- [ ] Required reference views are comparable or marked NOT_COMPARABLE.
- [ ] Applicable geometry/facade metrics meet versioned thresholds.
- [ ] Texture/UV QA passes independently where required.
- [ ] Repairs are bounded and no critical metric regressed.
- [ ] No unresolved critical finding remains.
- [ ] Source, candidate, config, reports and renders have matching hashes.
- [ ] Human review is recorded where required.

Allowed outcomes: **PASS**, **LOW_CONFIDENCE_REVIEW**, **FAIL**. Missing evidence cannot default to PASS.

## 9. References

The related [Building Accuracy Upgrade Plan](./BUILDING-ACCURACY-UPGRADE-PLAN.md) contains the deeper repository-specific audit and research rationale. Key sources:

- COLMAP, Structure-from-Motion and Multi-View Stereo tutorial: https://colmap.github.io/tutorial.html
- OpenCV camera calibration: https://docs.opencv.org/doc/doxygen/html/dc/dbb/tutorial_py_calibration.html
- Meta AI, Segment Anything Model 2: https://ai.meta.com/research/sam2/
- Open3D point-cloud/mesh metrics: https://www.open3d.org/docs/latest/python_api/open3d.t.geometry.TriangleMesh.html and https://www.open3d.org/docs/latest/python_api/open3d.t.geometry.PointCloud.html
- OGC CityGML standard: https://www.ogc.org/standards/citygml/
- Khronos glTF 2.0 specification: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
- Jarzabek-Rychard et al., building reconstruction review (ISPRS Archives, 2025): https://isprs-archives.copernicus.org/articles/XLVIII-G-2025/701/2025/isprs-archives-XLVIII-G-2025-701-2025.pdf
- GS4Buildings, prior-guided Gaussian Splatting for building reconstruction (2025): https://arxiv.org/abs/2508.07355
- MVGSR, multi-view consistency Gaussian Splatting: https://mvgsr.github.io/
- NeRF: https://arxiv.org/abs/2003.08934

## 10. Decision

Start with BRF-01 through BRF-04. This gives the engine a generic renderer, an evidence contract, input quality gates and a measurable baseline. Then integrate per-view semantics and confidence-aware fusion, followed by hybrid geometry, bounded fixes and texture.

A model that looks good is not automatically accurate. The roadmap makes independent truth, reproducible comparison and regression prevention part of the engine rather than an afterthought.


## 11. Execution log — update after every task

### 2026-10-26 — BRF-01 Generic renderer (complete)

- **Branch:** `feat/brf-01-generic-renderer`, based on `fix/bangabhaban-front-dome-alignment`.
- **PR:** [#187 — feat(renderer): make building review renderer generic](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/187) (still Draft; not merged into development/main).
- **Exact-head commit:** `5ec16ed677019c28c8380362b56de4062c683e4a`.
- **Implemented:** removed building-specific node selectors from the Blender renderer; added a validated generic profile and external Rangmahal profile; added profile ID/hash, front bearing and mesh-count provenance to manifests; reject invalid/stale profiles and missing requested meshes; updated docs/tests and CI.
- **Dedicated runtime evidence:** [run #40341288926](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40341288926) — **success**. Blender install, NumPy dependency, renderer/profile/manifest/heritage tests, demo GLB generation, 13 renders at 256×256, profile provenance checks and the `publicationEligible: false` guard passed.
- **General CI:** [run #40341288833](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40341288833) — **success**, 131 successful workflow steps.
- **Install issues fixed during this task:** first, Ubuntu Azure archive download timed out while fetching Blender; switched to the regular Ubuntu archive with bounded retries/timeouts. The first actual renderer run then exposed missing NumPy; added `python3-numpy`. The subsequent dedicated smoke test passed.
- **Scope caveat:** BRF-01 verifies generic review rendering, not real-building fidelity, and publication remains disabled.
- **Next action:** begin **BRF-02 — shared candidate evidence manifest**, consolidating source/model/config/camera/reference/render hashes and confidence states into one versioned candidate evidence contract. Do not merge the stacked feature PR to `development`/`main` without review of the complete feature chain.


### 2026-10-26 — BRF-02 Shared candidate evidence manifest (complete)

- **Branch:** `feat/brf-02-candidate-evidence-manifest`, stacked on `feat/brf-01-generic-renderer`.
- **PR:** [#188 — shared building candidate evidence manifest](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/188) (Draft; not merged into development/main).
- **Exact-head commit:** `21b0df2fc527f6e9adbe70f2918c9a690fa3cbd7`.
- **Implemented:** `src/core/building-generation/building-candidate-evidence-manifest.mjs` provides normalization and assessment for a single candidate's evidence graph; `tests/building-candidate-evidence-manifest.test.mjs` has 11 regression tests; `package.json` and `.github/workflows/ci.yml` run them; contract documentation is at `docs/research/BUILDING-CANDIDATE-EVIDENCE-MANIFEST.md`.
- **Contract coverage:** model/spec/config/report artifacts; capture/reference assets; camera calibration and frame alignment; independent dimensions with uncertainty and ground control; 13-view render set; QA/comparison/accuracy/release-report bindings to the exact candidate hash; confidence-to-artifact provenance; explicit missing evidence; safe paths and actual byte integrity.
- **Hardening:** evidence tier A/B requires verification of the actual artifact path, SHA-256 and byte count. An unsupported measured-confidence claim fails; missing evidence stays incomplete; any report forces `publicationEligible: false`.
- **Test correction:** run `40345789120` exposed an inconsistent fixture (estimated dimensions still labelled `measured`). The fixture was corrected and a regression test for contradictory confidence added.
- **Exact-head CI:** [run #40347926520](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40347926520) — **success**, 132 successful workflow steps, zero failed steps.
- **Scope caveat:** this is an evidence-linking contract. Hashes prove byte identity, not survey truth, photo identity, rights, or architectural accuracy. It does not create model geometry from photos or approve publication.
- **Next action:** start **BRF-03 — capture manifest and input quality/coverage preflight**. Do not merge PR #188 through `development`/`main` until the full feature chain and review/evidence gates pass.


### 2026-10-26 — BRF-03 Capture quality and coverage preflight (complete)

- **Branch:** `feat/brf-03-capture-quality-coverage`, stacked on `feat/brf-02-candidate-evidence-manifest`.
- **PR:** [#189 — validate capture image quality and coverage](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/189) (Draft; not merged).
- **Exact head:** `69eb71ec90d60f49f0913ddf25533a074b70c63d`.
- **Implemented:** filesystem capture-manifest validator analyzes photo/video-frame JPEG/PNG sources only after path/hash/byte integrity checks; JSON output includes dimensions, bounded grayscale sharpness/contrast/luminance heuristics and perceptual-hash near-duplicate hints.
- **Fail-closed behavior:** declared camera image-dimension mismatch and file/hash/byte contradictions fail; missing image paths and low-quality/repeated views remain incomplete/warn rather than being falsely marked ready.
- **Coverage rule:** raw video cannot satisfy a front/back/left/right view; extracted `video-frame` records need to be linked through matching source provenance.
- **Regression tests:** capture-manifest unit + CLI tests cover low-resolution images, near-duplicate warnings, actual-vs-declared image dimensions, raw-video coverage and missing-path state.
- **Exact-head CI:** [run #40352859459](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40352859459) — **success**, 132 successful workflow steps, zero failures.
- **Limitations:** quality metrics are screening heuristics, not proof of correct building identity, licensing, calibrated camera poses, geometric overlap or architectural fidelity. Publication/map readiness remain disabled.
- **Next action:** start **BRF-04 — baseline fixtures, expected measurements and deliberate defect injection**. Keep the stacked PR chain unmerged into `development`/`main` until review/evidence gates pass.


### 2026-10-26 — BRF-04 Baseline fixtures and deliberate defect injection (complete)

- **Branch:** `feat/brf-04-baseline-defect-benchmarks`, stacked on `feat/brf-03-capture-quality-coverage`.
- **PR:** [#190 — controlled baseline and deliberate defect injection](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/190) (Draft).
- **Controlled baseline:** `benchmarks/building-reconstruction/brf-04-controlled-baseline-v1.json` defines a synthetic closed cuboid 10×8×6 model-space metres, 1 mesh, 12 triangles, zero degenerate triangles and a 2% dimensional screening tolerance.
- **Defect injection:** `tests/fixtures/building-baseline-glb.mjs` generates deterministic GLB bytes and injects (1) +20% Y scaling and (2) a repeated triangle index. Five tests validate baseline dimensions/counts, repeatability, both detection gates and synthetic/publication-policy disclaimers.
- **Documentation:** `docs/BUILDING-ACCURACY-BENCHMARK.md` now explains how to run the suite, expected controlled results and what this does not prove.
- **CI test gate:** `npm run test:building-baseline-defect-injection` is wired into the full CI workflow.
- **Code/test head passed:** `165f2ff0583ae42e50730271e8c1df957a48abf5`, [run #40356308562](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40356308562) — **success**, 133 successful steps, no failures. Step 73 (the new baseline/defect-injection suite) passed.
- **Precision issue fixed:** initial run #40355894005 used exact equality against 9.6 but GLB float32 produced 9.60000038. The regression test now rounds observed bounds to four decimal places; 2% tolerance remains unchanged.
- **Latest docs-updated head:** `dce0d4f92e6e30feb9cff2880c3175dc2feeaf13`, [run #40360853267](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40360853267) — **success**; exact-head full CI completed successfully.
- **Limitation:** this synthetic fixture verifies the baseline/QA harness only. It is not a measured building, image-based reconstruction or real-world accuracy test. `mapReady`, `publicationEligible`, and automatic approval remain false.
- **Next action:** start **BRF-05 — image-to-geometry correspondence and per-view semantic evidence**. Keep PR #190 and the stacked chain out of `development`/`main` until their human visual and evidence gates pass.


## 12. Consolidated implementation package — BRF-05 through BRF-07

**Tracking issue:** [#199 — Building visual evidence and source-camera validation](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/199)  
**Detailed plan:** [BRF-05–07 Visual Evidence Plan](./BRF-05-07-VISUAL-EVIDENCE-PLAN.md)  
**Implementation report:** [BRF-05–07 implementation/evidence report](./BRF-05-07-IMPLEMENTATION-AND-EVIDENCE-REPORT.md)  
**Real-building pilot report:** [Ahsan Manzil real-reference observations (2026-10-27)](./AHSAN-MANZIL-REAL-REFERENCE-PILOT-OBSERVATIONS-2026-10-27.md)  
**Model/framing follow-up:** [Issue #203](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/203)

### Implementation status — code merged into rakibul-hasan

- [x] **BRF-05 integration:** existing source-bound mask validation is integrated into an evidence package; encoded image/mask bytes and dimensions are checked; bounded source-embedded SVG mask review overlays are emitted; occluder classes are explicit; missing occlusion evidence stays incomplete.
- [x] **BRF-06 integration:** source-bound feature proposals and reviewed annotation comparison are integrated; reviewed feature categories include roofline, floor bands, windows, doors, balconies, arches, columns, domes, cornices, pediments, staircases, parapets and ornaments. Proposal output is not ground truth.
- [x] **BRF-07 integration:** exact source/GLB/camera/calibration/alignment/render hashes are tied into the evidence graph; source-camera comparability is required; silhouette IoU/precision/recall/F1 and contour-distance diagnostics are separate from semantic-feature and metric-geometry evidence.
- [x] **Runnable tooling:** **npm run build:building-visual-evidence-package -- path/to/evidence-bundle.json** validates the input bundle and produces an evidence report plus overlays; **npm run prepare:building-visual-review-packet -- path/to/verified-manifest.json** creates a hash-pinned real-photo review packet with pending annotation templates.
- [x] **Regression/CI coverage:** synthetic fail-closed integration tests and packet-builder regression tests are wired into CI. They test software contracts, not actual building accuracy.
- [x] **Roadmap planning baseline:** [PR #200](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/200) merged to rakibul-hasan.
- [x] **BRF implementation:** [PR #201](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/201) merged to rakibul-hasan at c5b13b75058dc4c0fb55cb93bac589db79a7f424. Its exact-head full CI passed: [run #40381892198](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40381892198).
- [x] **Real-reference intake tooling:** [PR #202](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/202) merged to rakibul-hasan at 848802c44e5849a60008cd7aea056f26f26e3168. On the PR's exact head, full CI [run #40446153586](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40446153586) and reference intake [run #40446153578](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40446153578) passed.
- [x] **Actual source bytes obtained:** four Ahsan Manzil views—front, side, oblique and a clearly identified Wikimedia-generated 1280×853 aerial derivative—were downloaded through the allowlisted workflow, verified, locally SHA-256 hashed and uploaded with attribution/licence metadata and a contact sheet. Latest packet artifact: brf-05-07-ahsan-manzil-reference-review-packet, ID 12708581364, 30-day retention.
- [x] **Visual framing audit recorded:** the front photograph is cropped at both facade boundaries, so image-width ratios cannot be compared directly with full-plinth model coordinates. The candidate remains NOT_COMPARABLE; no geometry correction or accuracy pass is inferred. See pilot report and [Issue #203](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/203).

### Real-building acceptance status — OPEN / release-blocking

- [ ] Independent rights review for the exact downloaded/derivative assets.
- [ ] Human-reviewed building masks and separate occluder masks for every evaluation view; colour-threshold proposals are not accepted labels.
- [ ] Independent review/history for architecture features and occlusion/visibility states.
- [ ] Building-level held-out evaluation split/report with verified source/ground-truth/prediction hashes, per-class metrics, failure cases and reviewer sign-off.
- [ ] Credible camera calibration and model-frame alignment, independently grounded control points, and same-camera renders. Every unsuitable view stays NOT_COMPARABLE.
- [ ] Independent surveyed dimensions/footprint or other accepted metric control before claiming physical 3D accuracy.
- [ ] Human visual inspection of the exact candidate render/overlay and recorded decision before release eligibility.

acceptanceEligible, publicationEligible and mapReady remain false. Synthetic tests, successful CI, file hashes and published dimensions do not independently establish licence truth, annotation correctness, camera calibration or architectural accuracy. No automatic provider is selected by this package.

### Exact-head and post-merge validation

- **BRF integration full CI:** [run #40381892198](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40381892198) — success on PR #201's exact head.
- **Reference-intake workflow:** [run #40446153578](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40446153578) — success; source manifest/hash validation, packet build and artifact upload succeeded.
- **PR #202 exact-head CI:** [run #40446153586](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40446153586) — success.
- **Post-merge rakibul-hasan validation at 848802c44e5849a60008cd7aea056f26f26e3168:** [CI #40449769937](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40449769937), [offline-road baseline #40449769945](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40449769945) and [real-Dhaka browser baseline #40449769974](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40449769974) were still running at the time of this update. Re-check before claiming post-merge validation is complete.

### Branch promotion policy

Do not blindly merge the entire rakibul-hasan branch into development: branch comparison shows divergence and unrelated floor-plan/road changes outside BRF-05–07. Promote through a scoped, tested PR after post-merge CI is complete. main is not updated by this package. Promotion/publication remains blocked until the independent real-building acceptance boxes above are satisfied.



### 2026-10-27 — BRF-08 first slice: whole-building holdout integrity

- **Branch:** `feat/brf-08-independent-truth-evaluator`, created from current `development`.
- **Scope:** segmentation benchmark split integrity and reporting; this is a partial BRF-08 task, not completion of the independent-truth evaluator.
- **Changed:** `src/core/building-generation/building-segmentation-benchmark.mjs`; segmentation benchmark unit and CLI fixtures now include stable `buildingGroupId` values.
- **Contracts:** fail closed when `buildingGroupId` is missing/malformed or the same physical building is split between `development` and `held-out-evaluation`; retain capture-burst leakage checks; report held-out and total building counts; report equal-weight per-building macro foreground IoU alongside per-image averages; surface unevaluated/failed held-out sample cases; keep `acceptanceEligible: false`.
- **Regression cases:** same building across two different capture groups must fail split validation; missing/unsafe building IDs fail; unequal image counts prove per-building aggregation is not dominated by a building with more photographs; missing held-out evaluations appear as explicit failure cases; CLI test fixtures cover the new required ID.
- **Limitations / remaining BRF-08 work:** the physical identity in `buildingGroupId` still depends on curated correct metadata; no automatic identity resolver is claimed. This change does not compute independent footprint error, surface-to-surface distance or dimensional truth from real survey geometry. No real-building accuracy score, threshold pass, or publication approval is claimed. Human-reviewed truth, appropriate holdout size, survey controls, credible source-camera alignment, held-out failure review and the BRF-13 release gate remain open.
- **Validation:** pending exact-head CI on this feature branch; do not merge to `development` or promote to `main` until CI is green and the code/manifest migration is reviewed.

**Next task after this slice:** add independent-truth geometry evidence checks (footprint/dimensions and optional surface-distance inputs) without relaxing the separate human-review and publication gates.
