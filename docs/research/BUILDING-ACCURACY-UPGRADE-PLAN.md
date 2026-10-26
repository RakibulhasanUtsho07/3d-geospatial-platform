# 3D Geospatial Platform — Building Accuracy Upgrade Plan

**Document ID:** BAUP-001  
**Version:** 1.0  
**Date:** 26 October 2026  
**Status:** Proposed plan for approval — no engine code changes included  
**Repository snapshot reviewed:** `RakibulhasanUtsho07/3d-geospatial-platform`, branch `rakibul-hasan`, commit `f78355af01d70b11a56e7926243497111cc73293`  
**Scope:** The building-generation path only: source intake → per-image architectural understanding → multi-view fusion → materials/textures → accuracy evaluation → bounded correction and release gate.

> **Core rule:** A generated GLB is a candidate, not proof of an accurate building. A building must not be added to the map as an approved/high-confidence model unless its mandatory evidence and accuracy gates pass. Missing or unsupported facts stay `MISSING`, `unknown`, or `inferred`; they are never silently promoted to verified facts.

## 1. Executive summary

The engine already has useful building-generation foundations: a versioned `BuildingSpec`, deterministic procedural GLB generation, media intake and rights metadata, image-quality preflight, video-frame extraction, a COLMAP multi-view worker, a single-image AI preview route, geometry QA, a separate architectural-geometry workflow, texture atlas/binding QA, deterministic model renders, ground-control registration, review reports and publication gates.

The main gap is **integration and evidence-driven architectural understanding**, not the total absence of 3D tooling. The default media-to-model workflow currently orchestrates four stages: media ingestion, BuildingSpec sync, model generation, and report finalization. The more advanced sketch → wireframe → mesh repair → texture route is in a separate workflow and is not guaranteed to run in the default path. The per-view edge-preview tool does not identify building pixels; manual masks are needed for the mask-guided route. Multi-view wireframe triangulation requires calibrated camera matrices and manually verified matching observations; it does not calibrate cameras or match the observations itself. The current image-similarity diagnostics are deliberately triage-only and do not align camera pose, compensate lighting/crop, segment the building or identify semantic building parts. These limitations are described in the repository documents linked in Section 10.

### Highest-priority upgrades

1. **P0 — A reliable capture/evidence contract:** record source identity, rights, view/facade, camera metadata/pose confidence, visibility/occlusion, and independent dimensions/control points.
2. **P0 — Per-image building understanding:** separate building pixels from trees, cars, signs, wires, sky and background; extract roofline, corners, floor bands, openings and other features with confidence and source-pixel provenance.
3. **P0 — Confidence-aware fusion:** align shared corners and facade planes in a common frame, reject conflicting observations, and mark unseen sides as unknown/inferred rather than verified.
4. **P0 — Same-camera, part-aware evaluation:** render the candidate from the source photo's camera pose; compare silhouette, edges and named facade parts and tie each discrepancy to the exact view/reference/model hash.
5. **P0 — Bounded, measured correction and fail-closed acceptance:** each supported defect type maps to an explicit fix and re-test; stop after a limited number of attempts or if quality regresses; route unresolved cases to human review.
6. **P1 — Consistent material and texture reconstruction:** after geometry passes, select visible source views, mask occluders, normalise lighting/colour where justified, bake UVs and inspect seams/background contamination.

**Expected improvement:** the plan should reduce measurable dimension, footprint, projection, facade-feature and texture errors and make failures explainable. The amount of improvement is **MISSING** until a real-building benchmark with independent measurements and held-out buildings has been run. No single overall accuracy percentage should be claimed without a defined, validated metric.

## 2. Repository audit: what is actually present

The following are code/documentation observations from the reviewed repository snapshot, not assumptions about uninspected local files.

| Area | Observed repository capability | Current limitation relevant to accuracy |
|---|---|---|
| Generation route selection | `generation-pipeline.mjs` supports `auto`, `procedural`, `photogrammetry`, and `single-image-ai`. | `auto` does not mean an image-understanding model automatically interprets all inputs. The procedural route uses the spec; photogrammetry needs explicit selection/confirmations. |
| Default media orchestration | `media-to-model-workflow.mjs` persists four resumable stages: intake, BuildingSpec sync, model generation and report finalisation. | The complete sketch-to-texture geometric workflow is not guaranteed to run in this default orchestration. |
| Procedural geometry | `procedural-glb.mjs` creates deterministic geometry and reports that image/video visual analysis has not run. | Rules/parameters can make plausible models, but source images do not automatically correct dimensions or facade details. Unsupported roof types can fall back to a flat cap with a warning. |
| Per-view sketches | `PER-VIEW-ARCHITECTURAL-SKETCHES.md` describes deterministic edge previews. | Edge maps include tree branches, sky boundaries, roads and other non-building edges; an edge map is not an architectural drawing. |
| Masks | `MASK-GUIDED-BUILDING-SKETCHES.md` accepts human-reviewed building masks. | Masks are supplied by a person and are not automatically validated for semantic correctness. |
| Multi-view wireframe | `MULTI-VIEW-WIREFRAME-REGISTRATION.md` triangulates explicitly matched features and reports reprojection error. | Camera calibration and feature matching are not performed by this stage. It produces a sparse candidate, not a complete architectural mesh, and its documented automatic repair count is zero. |
| COLMAP | `colmap-worker.mjs` performs image preflight, reconstruction and diagnostics; it records whether scale was calibrated. | Worker success does not certify a strong reconstruction, architectural fidelity, true scale or georeferencing. A known distance/independent control evidence is still required. |
| Single-image AI | `single-image-3d-worker.mjs` generates an AI-proposed preview. | Hidden surfaces, metric scale, front direction and georeference remain unverified from a single photo. |
| Architecture workflow | `architectural-geometry-workflow.mjs` connects wireframe QA/repair, mesh creation/review, texture projection/selection, atlas export, and render QA as a separate staged route. | This useful pipeline is not yet the guaranteed default path from every media-to-model request. Human review and independent measurements remain necessary. |
| Render/compare | `render-building-review-views.mjs` calls a Blender render script; 13-view manifests and image diagnostics exist. | The renderer currently includes Rangmahal-specific node-name assumptions. The Bangabhaban 13-view workflow failed because those nodes were absent. Similarity diagnostics do not camera-register or identify semantic parts. |
| Correction backlog | `RENDER-CORRECTION-TASKS.md` turns human review outcomes into evidence-linked tasks. | It does not automatically infer a precise defect from pixels or edit the mesh/GLB/UVs. |
| Scale/georeference | `ground-control-registration.mjs` estimates a horizontal similarity transform from non-collinear ground-control points. | It does not solve vertical datum; operator-provided points must truly identify corresponding physical features on the exact GLB. |
| Map release | Repository reports and published-model workflow include fail-closed readiness/publication gates. | These gates need to be tied to a real end-to-end accuracy report, not only valid GLB structure or successful CI. |

### Audit conclusion

Do not replace the existing stack blindly. Reuse and integrate the current stage artifacts, COLMAP diagnostics, wireframe/mesh utilities, UV/texture tools, ground-control registration, report hashes and publication gates. The principal upgrades are (a) missing image-semantic/camera evidence, (b) robust confidence-aware fusion, (c) same-view semantic evaluation, (d) defect-specific repair integration, and (e) enforced end-to-end release criteria.

## 3. Six-step upgrade summary

| Step | Today | Main gap | Upgrade | Priority / effort | Evidence/metric |
|---|---|---|---|---|---|
| **1. Intake** | BuildingSpec, source hashes/rights, quality preflight and resumable intake exist. | Source/camera/coverage/dimension evidence is not guaranteed complete. | Versioned Building Capture Manifest; validate identity, rights, facade/view, camera metadata, occlusion, independent measurements and coverage before routing. | **P0 / M** | Manifest completeness; usable views; four-side/corner coverage; percentage of critical dimensions with independent source and uncertainty. |
| **2. Per-image architecture** | Edge preview, manual masks, COLMAP and single-image AI exist. | Edges include clutter; camera tilt/perspective, depth/scale and architectural semantic labels are not consistently solved per view. | Building/occluder segmentation; facade labels; camera calibration/pose confidence; rectified facade cues; occlusion masks; feature-level confidence/provenance. | **P0 / XL** | Segmentation precision/recall; occluder contamination; silhouette/roofline IoU; window/door position error; floor-line/corner reprojection residual. |
| **3. Merge views** | COLMAP and a sparse calibrated wireframe triangulator exist. | Corner alignment, conflicting observations, confidence arbitration and missing-side policy are not an integrated automatic architectural fusion stage. | Common frame; camera-aware correspondences; robust outlier rejection; shared corner/plane constraints; per-feature provenance; explicit unknown/inferred surfaces. | **P0 / XL** | Registered-view coverage; median/p95 reprojection error; corner displacement; facade silhouette/edge residuals; unsupported-surface coverage; unresolved conflicts. |
| **4. Colours/details** | Procedural PBR materials, UV projection, atlas baking and texture-binding QA exist. | Inconsistent light/colour and wrong camera-to-face assignment can cause seams, stretched surfaces and background texture. | Apply texture only after geometry review; choose source view per visible face; mask occluders; normalise exposure/colour only where justified; seam-aware baking; preserve source per face. | **P1 / L** | Texture coverage; UV/binding errors; seam discontinuity; background contamination; sharpness; controlled-reference ΔE00 distribution. |
| **5. Compare** | Fixed-view render, manifest hashing and low-resolution grayscale diagnostics exist. | The renderer is model-name dependent; comparison does not align source camera/crop/lighting or assign errors to wall/window/roof parts. | Generic GLB renderer; source-camera re-render; building-mask/crop alignment; semantic part and silhouette/edge metrics; discrepancy objects linked to view/hash/part. | **P0 / L** | Camera/pose residual; silhouette IoU; edge distance; visible window/door precision-recall; floor-count match; independent dimension errors; defect traceability coverage. |
| **6. Fix** | Bounded wireframe repair and human-led correction tasks exist. | A detected mismatch does not automatically imply a safe modelling action; correction backlog does not edit geometry. | Defect-to-action registry; preconditions; max 3 proposed automatic repair passes initially; re-test after each; stop on no improvement/regression; human review for unresolved defects. | **P0 / L–XL** | Per-defect metric improvement; critical unresolved count; regression rate; retry count; auto-fix verification rate; human-review routing; repeat-defect rate. |

## 4. Detailed requirements by step

### Step 1 — Building information and image intake

**Weak or missing today**
- Existing intake validates/stores sources and rights metadata but cannot prove that the chosen images depict the same building or that required facade/corner coverage exists.
- A file checksum proves the exact bytes, not source identity, measurement correctness, camera calibration or photo permission truth.
- A four-side set with no overlaps may leave too little shared evidence for reliable multi-view reconstruction.

**Required upgrade**
1. Add a versioned Building Capture Manifest with: building ID; original source hash; licence/attribution/reuse status; photo/video-frame ID; image dimensions/orientation; facade/view label; capture time/location when available; camera intrinsics/distortion/pose with source and confidence; overlap/occlusion/blur status; independent dimensions and measurement source; ground-control point IDs; declared model front/up-axis; unknown fields.
2. Run preflight before route selection: file validity, orientation, blur/exposure/clipping, duplicate/near-duplicate detection, source-rights completeness, same-building review and view/corner coverage.
3. Require overlap and oblique/corner coverage adequate for the selected reconstruction route. If coverage is not adequate, request evidence or use a clearly labelled lower-fidelity route; do not claim measured reconstruction.
4. Keep independent reference dimensions separate from dimensions inferred by the candidate model.

**Acceptance metrics**
- 100% of selected source files have stable IDs and recorded SHA-256 hashes.
- Every required view is marked usable, excluded with a reason, or missing.
- Every critical dimension has value, unit, reference and uncertainty, or status `MISSING`.
- Route selection refuses to call an incomplete capture set “verified reconstruction”.

### Step 2 — Per-image architectural understanding

**Weak or missing today**
- The current edge preview is not building-only: tree branches, sky, road markings, people, vehicles and textures can produce false architecture edges.
- The mask-guided stage depends on manually reviewed masks; it is not an automatic occluder detector.
- A tilted/perspective photo changes apparent lengths and angles. An uncalibrated photograph does not independently establish real depth or scale.
- Windows, doors and floor bands need explicit semantic observations; raw edges alone cannot tell which lines are architectural openings versus shadows or clutter.

**Required upgrade**
1. Produce a per-image artifact with building mask, occluder masks, visibility/unknown regions, facade plane(s), silhouette, corners, roofline, floor lines, window/door/column/balcony labels, and confidence for each feature.
2. Preserve a raster overlay and vector feature representation in the original image coordinate system, linked to source pixel coordinates and processing version.
3. Estimate or import camera intrinsics and pose; record whether values are calibrated, estimated by SfM, operator-supplied or unknown. Correct lens distortion if parameters are available. Use facade rectification only where a defensible plane model exists.
4. Use independent known distances, measured footprint/control points or a calibrated capture to establish metric scale. Do not infer scale from image size or a single-image AI mesh alone.
5. Make occlusion first-class: partially covered features carry partial visibility; fully occluded regions are not scored as observed architecture.

**Acceptance metrics**
- Segmentation precision/recall against labelled validation views.
- Building-mask overlap (IoU) and false-positive area from non-building objects.
- Silhouette/roofline edge distance and corner reprojection error.
- Window/door detection precision, recall, positional error and visible floor-line localisation error.
- Camera calibration residual and whether metric scale is independently grounded.

### Step 3 — Confidence-aware multi-view merge

**Weak or missing today**
- COLMAP estimates camera poses and 3D structure; the separate wireframe tool requires already calibrated matrices and explicitly matched physical features.
- A successful SfM/MVS run does not guarantee all facades are complete, corner positions are consistent, or the output matches architectural structure.
- Blindly averaging conflicting detections can create doubled corners and warped walls. A missing side cannot be treated as observed.

**Required upgrade**
1. Bring all camera observations into one explicit coordinate frame and keep the camera model/uncertainty for every source.
2. Link corresponding architectural features across images. Reject outliers using robust estimation and report the evidence behind each accepted correspondence.
3. Enforce shared-corner and facade-plane/intersection constraints where supported by multiple views or measured footprint evidence.
4. Resolve disagreement using visibility, image sharpness, viewing angle, occlusion, calibration/reprojection residual and number/independence of observations. Store the chosen observation and rejected alternatives; never just average unexplained conflicts.
5. Require two or more independent supporting views for high-confidence features when they are observable in multiple photos. Where the side is absent, carry `unknown` or explicitly `inferred` provenance and lower confidence.
6. Preserve per-element provenance: 3D part/feature → contributing image IDs → source pixel observations → camera model → residuals.

**Acceptance metrics**
- Registered views and spatial/camera coverage, not registration ratio alone.
- Per-view reprojection residual median, p95 and worst outliers.
- Corner-to-corner alignment and facade-plane intersection discrepancy.
- Footprint overlap against an independently traced footprint.
- Percent of output surface supported by observations vs inferred/unobserved.
- Count/severity of cross-view conflicts remaining at termination.

### Step 4 — Colour, materials and texture

**Weak or missing today**
- Procedural material colours are hand/spec driven; they do not automatically infer a consistent real facade colour from multiple photos.
- Texture-atlas generation depends on the correctness of upstream face/camera associations and UV inputs.
- Exposure/shadows, reflections, occluders and perspective changes can create seams or paste background pixels onto the facade.

**Required upgrade**
1. Do not bake final appearance until geometry and camera registrations have passed required checks.
2. Select source images for each face according to visibility, angle, sharpness, projected resolution and occlusion; record why a view was chosen.
3. Mask non-building pixels and avoid texture assignment where the surface is not visible.
4. Apply bounded exposure/white-balance normalisation only when supported; record transformations so raw sources remain auditable. Avoid comparing unnormalised raw RGB as a material truth metric.
5. Add seam-aware multi-view blending, texture stretch and texel-density checks, and face/source attribution. Re-run binding and seam QA after each rebake.
6. Separate observed texture from procedural/inferred materials. Do not texture hidden sides with false “photo evidence”.

**Acceptance metrics**
- Percentage of visible surface textured from valid source views; percentage inferred/procedural.
- UV/material binding failures and texture stretch indicators.
- Per-seam colour discontinuity and detected background contamination.
- Resolution/sharpness by face; view-selection provenance completeness.
- ΔE00 or other perceptual colour comparison only when images have controlled or defensibly normalised conditions.

### Step 5 — Same-camera, part-aware accuracy check

**Weak or missing today**
- The deterministic renderer exists but contains an Ahsan Manzil/Rangmahal node-name allowlist. The current Bangabhaban fixed-view workflow failed when those names were absent; therefore this renderer path is not generic yet.
- Existing grayscale MAE/RMSE/SSIM/hash metrics compare 64×64 normalised previews. They do not estimate camera pose, compensate for crop/lighting, segment the building or identify which architectural part differs.
- A large pixel difference can be caused by different camera, exposure or background, not geometry. Similar pixels can also hide wrong depth/scale.

**Required upgrade**
1. Make the render harness generic: work with any valid GLB using explicit optional part IDs/metadata; never assume a building-specific node name. Generate five orthographic inspection views plus a fixed turntable set as generic structural review, and source-camera renders for image comparison.
2. Store full source camera parameters when known. Render the exact candidate from the same pose/intrinsics and match the source crop/resolution; if pose is unknown, report `not-comparable` or use a documented, human-confirmed alignment.
3. Compare within building masks: silhouette IoU, architectural edge distance, visible opening locations/counts, floor bands and feature labels. Use pixel SSIM/MAE only as secondary triage metrics.
4. Give every discrepancy a stable structure: `viewId`, reference SHA-256, model SHA-256, render SHA-256, part ID/class, image region, metric and threshold, severity, confidence, cause hypothesis, source evidence and review state.
5. Keep visual review, independent dimensions, structural mesh QA and geospatial registration as distinct evidence categories. Do not combine them into one arbitrary “accuracy score”.

**Acceptance metrics**
- Required comparable views coverage and exact source/render hash linkage.
- Silhouette IoU; edge distance; per-part window/door precision/recall; visible floor-count match.
- Per-dimension error using independent measurements.
- Percentage of critical discrepancies linked to a specific part and reference view.
- No render/reference comparisons counted as a pass when camera or facade is incomparable.

### Step 6 — Defect-specific repair and final decision

**Weak or missing today**
- The correction-task pipeline is a human-led, evidence-linked backlog; it does not edit geometry or textures automatically.
- QA warnings and image differences do not alone prove their cause. An untyped automatic fix could destroy legitimate openings or improve one view while damaging another.

**Required upgrade**
1. Create a typed defect-to-action registry with preconditions and validation: camera mismatch → recalibrate/re-register; occlusion contamination → repair mask/re-run affected stage; corner/plane mismatch → revise supported geometry constraints; dimension error → request independent scale/measurement; window/floor error → edit affected facade component; texture seam → reselect source and rebake; missing side → request evidence or mark inferred.
2. Every action must declare the metric it should improve, side effects to re-check, eligible evidence, and when it is unsafe to auto-apply.
3. Set a maximum of **3 proposed automatic repair passes per candidate** as the initial policy. A pass counts only when an approved automated action actually ran; a report/task alone does not count as a repair.
4. Stop early if no relevant metric improves, a critical metric regresses, the same defect repeats, the evidence is insufficient, or the retry budget is exhausted. Save immutable before/after GLB, report, hashes, changes and per-pass metrics.
5. Route critical unresolved defects to `LOW_CONFIDENCE_REVIEW` or `FAIL`; require recorded human decisions for architectural interpretation that is not safely inferable.

**Acceptance metrics**
- Per-defect target metric improves by a declared amount or the action reports `no-improvement`.
- No mandatory global/other-facade metric regresses beyond its allowed tolerance.
- Retry count never exceeds the configured limit.
- Critical unresolved findings cannot result in `PASS`.
- Track repair success, regression, human-review routing and repeat-defect rates across model versions.

## 5. Proposed evaluation metrics and starting targets

The following thresholds are **proposed pilot starting points only**. They are not current repository results or proven universal tolerances. Freeze or revise them after analysing measurement precision and reviewer agreement on the actual pilot dataset.

| Metric | Proposed starting target | Conditions/caveats |
|---|---:|---|
| Width/depth/height relative error | ≤ 5% | Compare to independent, traceable dimensions; report each axis and source uncertainty separately. |
| Footprint intersection-over-union | ≥ 0.90 | Requires independent footprint tracing and common coordinate frame. |
| Reprojection error | median ≤ 2 px; p95 ≤ 5 px | Only after credible camera calibration and verified correspondences; do not interpret as a real-world metre error. |
| Visible window/door precision/recall/F1 | F1 ≥ 0.90 | Must define occluded/partially visible feature handling and compare with human-labelled references. |
| Visible floor count | Exact match on reviewed visible facades | Do not mark a hidden floor as measured evidence. |
| Corner alignment | Report model-space/metre error and image residual | Universal metre tolerance is `MISSING` until scale/reference precision is known. |
| Surface mesh-to-ground-truth distance | Chamfer, Hausdorff and thresholded F-score where reference mesh/point cloud exists | Select the distance threshold from task and survey precision; otherwise `MISSING`. |
| Texture seams/colour | Report seam discontinuity and ΔE00 distribution where appropriate | Numeric acceptance threshold is `MISSING` until capture/lighting normalisation and human validation exist. |
| Geospatial placement | Report fit-point and independent check-point residuals; resolve vertical datum separately | Horizontal fit is not architectural fidelity or verified elevation. |
| Release outcome | `PASS`, `LOW_CONFIDENCE_REVIEW`, `FAIL` | A weighted average must not override a failed hard gate. |

## 6. Research notes and rationale

### Overlap, camera poses and SfM/MVS

COLMAP's official tutorial describes SfM as feature detection, matching/geometric verification and camera/structure reconstruction from overlapping images; it advises distinct viewpoints, consistent illumination and visual overlap, with a physical point visible in at least three images as a useful capture guideline. MVS uses the SfM output to derive dense depth/normal evidence. This supports capturing overlapping corner/oblique views rather than only isolated front/back/left/right photos. [R1]

### Camera calibration and image distortion

Camera intrinsics, distortion coefficients, extrinsics and reprojection error should be explicit evidence. OpenCV's camera-calibration tutorial explains undistortion and computing reprojection error by projecting known object points back to the image. Reprojection error is useful but cannot prove that a camera model or the underlying corresponding points are semantically correct. [R2]

### Segmentation and occluders

Meta's SAM 2 supports promptable object segmentation in images and video and can help produce/refine masks. It should be treated as a candidate segmentation component rather than a complete semantic facade parser: roofline, floor bands, windows, doors and architectural class labels still require a dedicated model/label schema and validation. A segmentation model must not be allowed to convert its confidence score into proof of architectural truth. [R3]

### Surface geometry evaluation

Open3D documents Chamfer distance, Hausdorff distance and threshold-based F-score for comparing point clouds/triangle meshes. Use multiple metrics because average proximity, worst-case error and completeness are different properties. These metrics need an independent reference surface and an explicit distance threshold. [R4]

### Texture and colour

The CIE identifies CIEDE2000 (ΔE00) as the standardised colour-difference formula in ISO/CIE 11664-6:2022. Its use is meaningful only when the two colour samples are comparable; illumination, exposure, shadow and white balance must be accounted for before treating colour distance as material error. [R5]

### 3D asset units and coordinate conventions

Khronos glTF defines a right-handed coordinate system with +Y up and linear distances in metres. The engine still must explicitly validate its own axes, scale and front direction for every pipeline route; format validity does not show that a GLB's values correspond to a survey. [R6]

### Repository-specific interpretation

The source repository is authoritative for current implementation status. Specifically, the staged reconstruction design itself says the complete per-image sketch/registration/repair stages are a target pipeline and not all are implemented as one workflow; render diagnostics say they are not an architectural-accuracy estimator; correction tasks say the task generator does not alter GLB/geometry/UVs. See [repository evidence](#10-repository-and-research-sources).

## 7. Phased roadmap

| Phase | Work package | Priority | Definition of done |
|---|---|---|---|
| **0. Baseline and renderer repair** | Remove building-name assumptions from the render harness; produce stable manifests and hashes; freeze current pipeline behaviour and failure modes. | P0 | Any valid reviewed GLB renders; source/reference/render hashes validate; missing data is surfaced; baseline report is reproducible. |
| **1. Pilot dataset** | Select 10–15 diverse Dhaka buildings for development; keep 3–5 different buildings untouched for final holdout; collect permitted multi-view sources, independent dimensions/footprints and feature labels. | P0 | Each building has a source manifest and enough independent truth for the metrics it claims; data gaps are explicitly listed. |
| **2. Capture and per-view analysis** | Add camera/coverage manifest validation; segmentation/occlusion artifacts; semantic facade features; pose/scale confidence. | P0 | Per-image overlays and structured labels can be reviewed; no occluded/unknown region is marked as observed. |
| **3. Confidence-aware fusion** | Integrate source camera poses, correspondences, robust outlier rejection, shared corners/planes and provenance into one resumable workflow. | P0 | Cross-view conflicts and unsupported surfaces are reported; dimensional and reprojection metrics are produced; insufficient evidence fails closed. |
| **4. Same-view semantic evaluation** | Render candidate from source camera; compare masks/silhouettes/edges/openings/floor lines; link each defect to part/view/hash. | P0 | Every required comparable reference has an explicit outcome; non-comparable views are not counted as passes. |
| **5. Repair actions and regression controls** | Add defect-to-action registry, bounded retries, before/after metrics, no-improvement stop and human-review state. | P0 | Deliberately injected defects trigger correct action or review; loops terminate; no critical mismatch can silently pass. |
| **6. Texture/material quality** | Run source-view selection, mask-aware texture projection, colour/lighting handling, seam checks and final bake after geometry acceptance. | P1 | Texture coverage, seam diagnostics and provenance pass the agreed thresholds; geometry gates remain unchanged. |
| **7. Held-out validation and release policy** | Freeze thresholds; run untouched holdout buildings; review errors and failure classes; apply `PASS` / `LOW_CONFIDENCE_REVIEW` / `FAIL`. | P0 release gate | All mandatory gates and evidence packages pass; no model is auto-published based only on successful generation or CI. |

### Pilot data protocol

- **Development set:** 10–15 different Dhaka buildings spanning ordinary low-rise, mid/high-rise, irregular footprints and complex/heritage forms. Use only sources whose identity/reuse status is properly reviewed.
- **Per building:** front, back, left, right plus overlapping corner/oblique views where accessible; source hashes; view/facade labels; independent dimensions/footprint; visible-feature labels; capture/occlusion notes; and camera/scale provenance.
- **Held-out set:** 3–5 separate buildings never used to tune prompts, model thresholds, repair rules or pass/fail criteria. Preserve their source evidence and ground truth for the final evaluation.
- **Reporting:** list results per building and per view, then grouped by building class. Report failures and uncertainty, not only the average. This sample is a pilot, not enough by itself to claim broad statistical generalisation to every Dhaka building.

## 8. Prevention, tests and monitoring

### Required automated tests

1. **Intake/camera:** EXIF orientation, tilted images, distortion metadata, blur, near duplicates, missing dimensions and missing camera pose.
2. **Occlusion:** trees, cars, signboards, wires, sky and background; false building pixels must be detected or flagged.
3. **Fusion:** conflicting corners/dimensions, wrong correspondences, low overlap, one missing facade and inconsistent camera poses.
4. **Scale:** no known distance, conflicting known distances, invalid/collinear ground-control points, and unverified metres-per-unit.
5. **Comparisons:** wrong facade/camera, wrong crop, exposure differences, stale hashes, missing reference and semantic part mismatch.
6. **Texture:** missing UV/material, seam, stretched face, background patch and source-view visibility failure.
7. **Repair:** no-op action, non-improving correction, oscillation/repeated defect, regression in another facade, retry exhaustion and uncertain cause.
8. **Release gate:** missing measurements, low confidence, unresolved critical mismatch, incomplete review, unknown vertical datum and corrupt/stale reports.

### Golden fixtures and CI policy

- Maintain synthetic models with known dimensions, camera poses and correct renders. Inject deliberate defects (wrong height, shifted corner, missing window row, false tree edge, wrong texture, wrong side/camera and absent facade) and assert the defect detector and state transition.
- Save a reference package per fixture: input manifest, model/worker configuration, output GLB hash, geometry report hash, camera/render manifest, per-render hashes, metrics and expected review state.
- Run deterministic geometry and renderer tests in CI; treat renderer failure as a blocker for any claim that visual review is complete. A green unrelated CI run is not model-accuracy evidence.
- Keep approved source/reference hashes immutable. A new source file, camera model, metric definition or model build creates a new evidence revision.
- Do not relax acceptance thresholds automatically when a model fails. Threshold changes require a reviewed decision, reason, and rerun of the full regression/holdout suite.

### Monitoring per candidate/model version

Record registered-view coverage; reprojection median/p95/max; footprint IoU; dimension errors; corner residuals; visible window/door precision/recall; surface error where ground truth exists; texture coverage/seams; unresolved critical findings; repair attempts; regressions; human-review routing; and final outcome. Group by source type, building class, route and failure cause. Monitor distributions over time rather than one composite score.

## 9. Mandatory final gate before map addition

The candidate is eligible for acceptance only if each applicable gate has an explicit result and evidence hash:

1. **Input/provenance:** source identity, rights, coverage, camera/model metadata and critical measurement sources are traceable.
2. **Architecture:** per-view mask/feature evidence is available; occlusions and unobserved areas are explicit.
3. **Fusion/geometry:** camera registration, shared-corner constraints and mesh QA have no unresolved critical defects; geometry is compared to independent footprint/dimensions.
4. **View validation:** required views render from matched source cameras or have an explicit `not-comparable` outcome; critical visible parts are reviewed.
5. **Scale/georeference:** metric scale is independently supported; horizontal control/check points and vertical datum are documented separately.
6. **Appearance:** texture/UV QA passes if textured output is required; no texture score can override a geometry failure.
7. **Correction:** each applied fix has before/after metrics; retry budget is respected; unresolved critical findings are routed to a reviewer.
8. **Decision/provenance:** report, model hash, reviewer decision and exact configuration/source revision are bound to the same candidate.

Use these outcomes:

- **`PASS`** — all mandatory gates pass and required human sign-off is recorded.
- **`LOW_CONFIDENCE_REVIEW`** — evidence is insufficient, views are incomplete, or an important uncertainty remains. Do not silently add or present it as an approved accurate model.
- **`FAIL`** — a mandatory gate or critical accuracy criterion fails; reject the candidate or return it for correction.

The gate should reject any candidate whose score is low and should also block a high composite score when a hard geometry/scale/view gate fails. Low-confidence previews may be retained for internal review, not quietly promoted to the approved map layer.

## 10. Repository and research sources

### Repository sources audited on 26 October 2026

- [S1] [Repository README — current capability overview and generation routes](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/README.md)
- [S2] [Building Generation Engine](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/BUILDING-GENERATION-ENGINE.md)
- [S3] [Staged Architectural Reconstruction Pipeline](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/STAGED-ARCHITECTURAL-RECONSTRUCTION.md)
- [S4] [Generation strategy router](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/src/core/building-generation/generation-pipeline.mjs)
- [S5] [Media-to-model workflow](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/src/core/building-generation/media-to-model-workflow.mjs)
- [S6] [COLMAP multi-view worker](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/src/core/building-generation/colmap-worker.mjs)
- [S7] [Multi-view wireframe registration](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/MULTI-VIEW-WIREFRAME-REGISTRATION.md)
- [S8] [Per-view architectural sketch limitations](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/PER-VIEW-ARCHITECTURAL-SKETCHES.md)
- [S9] [Mask-guided building sketches](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/MASK-GUIDED-BUILDING-SKETCHES.md)
- [S10] [Render/reference similarity diagnostics](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/RENDER-IMAGE-SIMILARITY-DIAGNOSTICS.md)
- [S11] [Evidence-linked render correction tasks](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/RENDER-CORRECTION-TASKS.md)
- [S12] [Texture atlas baking](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/TEXTURE-ATLAS-BAKING.md)
- [S13] [Blender render review](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/BLENDER-RENDER-REVIEW.md)
- [S14] [Ahsan Manzil parameter-by-parameter deviation report](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/heritage/ahsan-manzil-deviation-report.md)
- [S15] [Ground-control registration](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/src/core/building-generation/ground-control-registration.mjs)
- [S16] [Building accuracy benchmark methodology](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/docs/BUILDING-ACCURACY-BENCHMARK.md)

### External technical references

- [R1] COLMAP, *Tutorial: Structure-from-Motion and Multi-View Stereo* — https://colmap.github.io/tutorial.html
- [R2] OpenCV, *Camera Calibration* — https://docs.opencv.org/doc/doxygen/html/dc/dbb/tutorial_py_calibration.html
- [R3] Meta AI, *Segment Anything Model 2 (SAM 2)* — https://ai.meta.com/research/sam2/
- [R4] Open3D, *TriangleMesh / PointCloud distance metrics* — https://www.open3d.org/docs/latest/python_api/open3d.t.geometry.TriangleMesh.html and https://www.open3d.org/docs/latest/python_api/open3d.t.geometry.PointCloud.html
- [R5] CIE, *Colorimetry — Part 6: CIEDE2000 Colour-Difference Formula, ISO/CIE 11664-6:2022* — https://www.cie.co.at/publications/colorimetry-part-6-ciede2000-colour-difference-formula-1
- [R6] Khronos Group, *glTF 2.0 Specification* — https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html

## 11. Decision requested

Approve the plan before engine implementation begins. The first implementation package should be **Phase 0: generic renderer + reproducible baseline/evidence manifest**, followed by the pilot dataset and capture/per-image analysis. No new reconstruction model/provider should be added until the baseline demonstrates which error classes the existing stages cannot solve. Any proposed new dependency must be justified against the existing repository code, its operational requirements, source/licence implications and the measured pilot failure modes.

**Change-control:** this document adds no code, does not alter model assets, and does not approve any building for publication. Implementation changes must be made in the repository, tested and reviewed against the gates in this plan.