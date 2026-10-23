# 3D Geospatial Platform — Building Engine Mismatch Fix Plan

**Prepared:** 23 October 2026  
**Status:** Plan recorded; implementation progresses in small, verifiable work packages.  
**Repository:** RakibulhasanUtsho07/3d-geospatial-platform  
**Branch:** feat/engine-mismatch-fix-plan

## লক্ষ্য

Ahsan Manzil, Jatiya Sangsad Bhaban এবং Dolonchapa-12 test-এ দেখা mismatch কমানো, real image reconstruction-কে procedural preview থেকে আলাদা রাখা, এবং ভবিষ্যতে একই defect ফিরলে automated tests/visual QA দিয়ে release-এর আগেই ধরা।

## Root-cause summary

1. Procedural generator uses explicit BuildingSpec geometry. It does not infer architectural geometry from source photos.
2. Generic primitive builder cannot by itself represent a palace dome/arches, Parliament's large openings and distinct masses, or a residential complex with multiple towers and curved balconies.
3. Window/door positions apply offsets relative to wall geometry in a way that may leave inserts floating away from exterior wall planes.
4. Side-frame offsets use global X instead of the facade's local tangent, so rotated/diagonal facades can misalign.
5. The longest footprint edge is guessed as the front; it may not match the real entrance facade.
6. The requested pitched roof is currently represented with a flat roof cap plus a warning, which is a misleading mismatch between request and output.
7. Tests verify schema/GLB structure and worker orchestration, but mocked external workers do not prove real TripoSR/COLMAP reconstruction quality.

## Principles / non-negotiable rules

- Do not call a procedural model an image reconstruction. Reports must say which strategy and worker actually ran.
- Do not claim a hidden/back facade is accurate from a single image.
- Never invent cardinal view direction, measured dimensions, licence, or survey control.
- A parseable GLB is not automatically architecturally accurate, map-ready, or publishable.
- Keep mapReady/publicationEligible false until the required geometry, visual, scale and georeference reviews pass.
- A visual similarity metric is diagnostic only unless reference and render are the same building, facade and comparable camera pose.
- Keep baseline artifacts immutable; review any visual baseline update.
- Real external-tool integration tests must be distinguished from mocked unit/orchestration tests.

## Phase 0 — Freeze baseline and define acceptance

### Work
- Preserve the existing input BuildingSpec, source image IDs/hashes/rights, selected route, GLB hash, reports and renders under a unique run ID.
- Create a manifest identifying each reference by building ID, view ID, known/unknown direction, source URL, author, licence, SHA-256 and whether camera pose is known.
- Map each reference to a specific rendered view only after same-facade/comparable-pose review.
- Keep old run artifacts and new results separate; never overwrite a baseline silently.

### Gate
- No run manifest means the output cannot be called a completed accuracy test.
- Non-comparable views get a not-comparable status, not a fabricated similarity score.

## Phase 1 — P0 procedural geometry correctness

Primary file: src/core/building-generation/procedural-glb.mjs

### 1.1 Window / door wall-plane placement
- Define the exterior wall plane and a single local coordinate frame; calculate glass, jambs, lintel, sill and door positions from that plane.
- Do not apply wall-thickness offsets twice.
- Define an explicit recess/offset value if a window is intentionally recessed.
- Test measured signed clearance from the exterior wall plane, instead of relying only on visual inspection.

### 1.2 Rotated facade frame alignment
- Calculate left/right jamb offsets along the facade tangent, not global X.
- Cover 0, 30, 45, 90, 180 and 270 degree facade orientations.
- Assert that pane and frame centers remain coplanar/aligned within a documented tolerance.

### 1.3 Explicit front facade
- Add a versioned BuildingSpec field such as frontFacade/entranceBearing or an explicit footprint edge ID.
- Where direction is not supplied, mark the selection as inferred in the report; do not silently imply it is verified.
- Preserve backward compatibility for older BuildingSpec fixtures.

### 1.4 Roof contract
- Implement true pitched geometry and test it, or reject an unsupported pitched roof request with a clear error.
- Never produce a flat cap while reporting the requested pitched roof as if it were implemented.

### Phase 1 done criteria
- Offset/frame/front/roof regression tests pass.
- Requested-but-unsupported geometry fails clearly or is explicitly marked as a non-compliant candidate.
- Existing rectangular apartment fixture still generates a valid GLB.

## Phase 2 — Strategy routing and honest reporting

Relevant files: generation-engine.mjs, generation-pipeline.mjs, media-to-model-workflow.mjs, single-image-3d-worker.mjs, colmap-worker.mjs.

### Work
- Report requestedStrategy and actualStrategy, workerStarted, worker version/exit status, selected source IDs and hashes, fallback reason, limitations, reviewRequired, mapReady and publicationEligible.
- Make auto behavior explicit: a multi-view candidate is not proof COLMAP ran. Do not silently fall back to procedural output when explicit photogrammetry/AI was requested.
- Preflight COLMAP/TripoSR dependencies, input source status, and selected views.
- Label worker-mocked tests as orchestration tests. Add optional real-tool tests that require actual installed binaries/model weights and retain evidence/logs.
- A missing external tool produces NOT RUN/blocked or an actionable failure, not a real-inference PASS.

### Gate
- Requested and actual strategy must agree, or an explicit documented fallback must be reported.
- AI single-view remains ai-proposed, mapReady=false and publicationEligible=false by default.
- COLMAP result remains review-only until geometry, scale, and georeference have separate acceptance evidence.

## Phase 3 — Architecture-aware models and schema

### Ahsan Manzil
- Use the dedicated heritage builder and confidence-tagged parameter set rather than the generic residential generator.
- Review stepped/L-shaped footprint, Rangmahal/Andarmahal, dome/drum/finial, open portico, staircase, arches and balconies using matched exterior references.
- Preserve [V]/[C]/[E]/[?] confidence tags; estimated dimensions do not become verified silently.

### Jatiya Sangsad Bhaban
- Use multiple masses, explicit large geometric openings/voids, measured footprint and facade profiles; simple extrusion is insufficient.
- Name separate components so every important mass/opening can be reviewed.
- Do not claim exactness without suitable architectural drawings, dimensions or matched views.

### Dolonchapa-12
- Represent multiple site-layout tower/wing parts rather than one generic rectangle.
- Encode curved balconies, facade bay rhythms and repeated floor elements as supported by reference evidence.
- Mark unobserved/occluded facades unknown unless supported by evidence.

### BuildingSpec evolution
- Propose versioned fields for parts[], front facade/entrance bearing, openings[] (shape/size/local position/true void or surface insert), roof geometry, facade profiles, and per-feature evidence.
- Add a version migration or backward-compatibility adapter and tests before changing the schema.

## Phase 4 — Structural and visual QA

### Structural checks
- Validate GLB 2.0 buffers/accessors/indices, finite vertices/normals, degenerate triangles, bounds, expected dimensions, material/texture bindings, disconnected components, boundary/non-manifold edges and long-edge outliers.
- Do not blanket-reject architectural renders for not being watertight when separate balcony/window components are expected. Make watertightness mandatory only for solid/printable/boolean-ready profiles; classify other topology findings by severity.

### Deterministic render review
- Produce front/rear/left/right/top and two oblique views with fixed camera, resolution, lighting and background.
- Record view IDs, camera pose, render hash and source model hash.
- Compare only a known matching facade and camera pose; otherwise return not-comparable.
- Use SSIM/MAE/edge diagnostics as screening metrics, not a single invented accuracy percentage.
- Record reviewer outcomes per view: match, partial, mismatch, not-comparable or pending.

## Phase 5 — Regression prevention / CI gate

Every PR must run:
1. Geometry unit tests for window/door offsets, rotated frames, explicit front selection and roof contracts.
2. BuildingSpec schema and migration tests.
3. Strategy routing tests for procedural, TripoSR and COLMAP; missing tools must fail/skip honestly.
4. Fixtures for a simple apartment, a heritage building and a multi-mass/complex-opening building.
5. GLB QA tests for invalid indices/buffers, non-finite vertices, degenerate triangles and dimension bounds.
6. Fixed-camera visual regression on canonical views, with explicit approval required to update snapshots.
7. Report/hash integrity checks linking exact input, source IDs, selected strategy and generated output.
8. CI must distinguish mocked tests from real integration tests.

### CI policy
- Any P0 regression failure blocks merging.
- Baseline updates require before/after renders, a reason, and reviewer approval.
- No model is publishable because it merely parses as GLB.
- Publication requires the intended profile's geometry QA, visual sign-off, independent scale evidence and georeference evidence.

## Phase 6 — Per-building acceptance gate

| Gate | Required evidence |
|---|---|
| Source identity and rights | Same building confirmed; provenance and usage permission recorded |
| Coverage | Useful facade/oblique/roof views documented; missing sides explicitly listed |
| Strategy | Actual route/worker matches requested mode; no silent fallback |
| Geometry | No unexplained holes, spikes, stretched faces, missing masses or malformed buffers |
| Scale | Independent reference dimensions and declared per-axis tolerance |
| Georeference | Survey/control points and declared residual thresholds; vertical datum separately reviewed |
| Visual review | Required views reviewed; critical mismatch closed or documented |
| Publication | Approval attestation tied to exact candidate hash; otherwise keep mapReady/publicationEligible false |

## Implementation order

| Order | Work package | Definition of done |
|---|---|---|
| P0.1 | Window/door wall-plane placement and rotated frame fix | Unit tests pass across axis-aligned and diagonal facades |
| P0.2 | Explicit front facade and honest roof contract | No silent direction/roof mismatch |
| P1.1 | Strategy routing/preflight/report integrity | Real and mocked runs cannot be confused |
| P1.2 | GLB QA and deterministic render harness | Reproducible hashed renders and QA reports |
| P1.3 | Dedicated Ahsan Manzil route review | Heritage assets reviewed against matching views |
| P2.1 | Parliament / Dolonchapa specific geometry | Masses/openings/curved features represented and reviewed |
| P2.2 | CI visual regression and release gates | Regression blocks release; approved baseline updates are auditable |

## External references

- COLMAP tutorial: https://colmap.github.io/tutorial.html
- glTF 2.0 specification: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html

**Current stage (23 October 2026):** P0.1, P0.2 and P1.1 are complete. The P1.2 geometry/render-manifest and reference-hash unit suites passed in [CI run #911](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/39910848397), but that run only syntax-checked the Blender Python script; it did not execute Blender. To close that evidence gap, the current branch adds a headless-render integration step that creates a procedural fixture GLB, runs the real Blender CLI for all 13 fixed views, checks the model and render-configuration hashes, verifies all 13 PNG hashes/dimensions and validates each named camera. P1.2 remains `IN_PROGRESS` until that actual-render CI step passes. Even a clean render manifest is technical review evidence, not proof of architectural accuracy or publication approval. P1.3 follows after P1.2 is green.
