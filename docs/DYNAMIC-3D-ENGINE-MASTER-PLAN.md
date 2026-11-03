# Dynamic 3D Engine — Master Audit & Execution Plan

> **Canonical continuation document.** For any new chat, start here: `docs/DYNAMIC-3D-ENGINE-MASTER-PLAN.md`. Do not resume from an old D3M/engine roadmap without first checking this document against the current repository head.

| Field | Value |
|---|---|
| Audit date | 2026-11-03 |
| Repository | `RakibulhasanUtsho07/3d-geospatial-platform` |
| Audited branch baseline | `main = dev = ff5f2fed0182e8551f4f77d2ad84178a1906f7ee` |
| Source code validation SHA | `d626fdec10c73e50ba9f9f1eaafce0faea643f4e` (the tree promoted by PR #336; final main merge is a merge-only commit) |
| Audit type | GitHub source/docs/PR/branch/CI inspection; not a production-host or real-building accuracy test |
| Current verdict | **Foundation implemented; end-to-end accurate image-to-building-to-map engine not yet demonstrated.** |
| Next engineering task | **D3M-ENGINE-01 — selectively port and integrate BRF-01–04 evidence infrastructure on current main.** |

---

## 1. Executive decision

The repository now has meaningful pieces of a dynamic 3D map and a building-generation system:

- A Cesium map with viewport-aware Overture-derived building data, road layers, search, LOD/viewport management and a generated-GLB layer.
- A bounded Dhaka OGC 3D Tiles 1.1 pilot with independently addressable GLB contents and lazy viewport loading.
- A media intake and source-provenance pipeline, strategy selection, a resumable local workflow, a file-backed generation queue, a single worker process, worker readiness/status APIs, model QA, human review and explicit publication.
- Separate COLMAP multi-view and TripoSR single-image worker implementations.
- Many downstream reconstruction/QA components: image quality, camera/ground-control utilities, wireframe registration and repair, mesh construction, texture projection/atlas export, fixed-camera renders, geometry QA and evidence/release checkers.
- A browser-local floor-plan review/calibration flow that can create a private review candidate.

**What is not yet established:** a normal map-side upload does not automatically run the full architectural reconstruction process from original photos through per-view semantic interpretation, calibrated camera/feature registration, evidence-backed wireframe, converged geometry repair, accurate textured GLB, independent dimension/survey verification and final map placement. The full architectural workflow exists as a separate operator-supplied geometry workflow; it is not the same as the four-stage media-to-model queue path.

Therefore, the requested product behavior — “give the engine images of an arbitrary Dhaka building; it reconstructs the real building accurately, knows where it belongs, and places it on the dynamic map” — remains a **target**, not a verified current capability. No defensible overall accuracy percentage (including 90%) can be claimed from the current evidence.

The work should proceed evidence-first. A task is complete only when its exact current-main candidate has passed the required tests, its output artifacts have been inspected where relevant, and the next integration has been verified. A green CI run proves software contracts; it does not prove real-world building fidelity, source rights, metric truth, survey placement or live production readiness.

## 2. Current repository baseline and audit confidence

### 2.1 Branch/merge baseline

At the audit snapshot, `main` and `dev` resolve to:

```text
ff5f2fed0182e8551f4f77d2ad84178a1906f7ee
```

The merge path is complete:

- PR #334 integrated the validated P3.4 map-panel/Dhaka Home/imagery-diagnostics work plus the `rakibul-hasan` road-network refresh into `dev`, merge SHA `d626fdec10c73e50ba9f9f1eaafce0faea643f4e`.
- PR #336 promoted `dev` to `main`, merge SHA `ff5f2fed0182e8551f4f77d2ad84178a1906f7ee`.
- `dev` was non-force fast-forwarded to the same `main` SHA.
- The road refresh source commit was `651c33aacac9d07c4ca948109393219609bcb435`.

The final main commit is the release merge commit; the validated application tree is the `d626fdec...` dev integration tree. Before any future work, verify both refs again. Never assume these SHAs are still current in a later chat.

### 2.2 Validation already available

The exact `d626fdec...` source tree passed:

| Check | Run | Recorded result |
|---|---:|---|
| Full CI | [#41599626180](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41599626180) | 202/202 steps, success |
| Real-Dhaka Browser Baseline | [#41599626237](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41599626237) | 16/16 steps, success |
| P3.6 Dhaka 3D Tiles | [#41599626212](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41599626212) | success |
| P3.7 floor-plan calibration | [#41599626286](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41599626286) | success |
| BRF-14 multi-view source intake | [#41599626241](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41599626241) | success |
| BRF-35 linkage/metric-frame gate | [#41599626142](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41599626142) | success |
| BRF-05–07 real-reference intake | [#41599626140](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41599626140) | success |
| BRF-45 exact-asset rights admission | [#41599626141](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41599626141) | success; the 16-view example remained blocked, as expected, without asset-specific approval |

The six Real-Dhaka cold/warm captures each staged 3,000 Overture building features and rendered 478 local road features. The report recorded zero imagery tile errors and zero red-outlier flags. The six screenshot hashes were identical: this is deterministic CI evidence, not six independent real-world visual observations. The baseline is not a building-accuracy score or proof that the live imagery provider is fault-free.

### 2.3 Documents that must not be treated as the current status by themselves

The following historical documents remain useful for design details, but contain dated branch/PR snapshots and must be checked against this master plan and current source before resuming:

- `docs/D3M-00-07-DEPENDENCY-RECONCILIATION-2026-11-02.md`
- `docs/ENGINE-REMAINING-WORK-ROADMAP.md`
- `docs/BUILDING-GENERATION-ENGINE.md`
- `docs/DYNAMIC-MAP-RELEASE-CHECKLIST.md`
- `docs/RECONSTRUCTION-JOB-STATE.md`
- `docs/STAGED-ARCHITECTURAL-RECONSTRUCTION.md`
- `docs/D3M-02-GENERATION-JOB-TO-MAP-PUBLISH.md`
- `docs/D3M-03-MAP-IMAGE-INTAKE-AND-JOB-TRACKING.md`
- `docs/D3M-05-SINGLE-IMAGE-RUNTIME-SMOKE.md`
- `docs/PUBLISHED-GENERATED-MODEL-WORKFLOW.md`
- `docs/BUILDING-ACCURACY-BENCHMARK.md`
- `docs/BUILDING-ACCURACY-EVIDENCE-PACK.md`
- `docs/BUILDING-RELEASE-READINESS.md`
- `docs/D3M-01F-TRUSTED-REVIEWER-REGISTRY-OPERATIONS.md`
- `docs/research/P3-6-DHAKA-3D-TILES-PACKAGE.md`
- `docs/research/P3-8-DHAKA-OVERTURE-ARCHITECTURE-COVERAGE.md)

The old PR #279 documentation stack targets a historical `development@98b2fa56...` base. Do not merge that PR wholesale to update the docs; its status should be re-authored on current main when needed.

---

## 3. What the engine can do today

The labels below intentionally separate code from evidence.

| Area | Current status | What is actually present | What it does not prove |
|---|---|---|---|
| Dynamic map runtime | **Integrated / CI-tested** | Cesium map, viewport-aware loading/caching/cancellation, Overture building footprints/extrusions, road layers, search and controls | Surveyed building geometry, exact real facade/roof detail or city-wide live-data completeness |
| Dhaka Overture data | **Integrated / source-audited** | Local Dhaka FeatureCollection and generated spatial tiles; source metadata audit | That sparse architectural metadata is enough to reconstruct real facade/roof geometry |
| OGC 3D Tiles pilot | **Integrated / bounded pilot tested** | P3.6 creates a bounded package (up to 128 features; usual pilot 32) with per-feature GLBs, integrity manifest and Cesium lazy-load browser harness | City-scale production conversion, roof/facade correctness, surveyed elevation or architecture accuracy |
| Overture architectural metadata | **Audited, sparse** | P3.8 inspected 17,008 features: 16,986 building roles, 7 parents, 15 parts; 15/15 parts linked to parents | A source-driven roof/facade mesh. Roof shape plus positive roof height was reported on only 1/17,008 features |
| Generated GLB map layer | **Integrated / CI-tested** | `GeneratedModelLayer` loads/updates/removes a GLB at an explicitly supplied WGS84 placement; catalog can load a reviewed/published version | Automatic location discovery, camera solving or independently correct model alignment |
| Media upload and intake | **Integrated / CI-tested** | Authenticated private uploads, file hashes, source metadata, explicit operation scopes, image/video-frame intake, map UI and job tracking | Independent legal clearance: operator rights checkboxes are attestations, not external permission verification |
| Procedural generation | **Integrated / CI-tested** | Parameter/BuildingSpec-based procedural GLB and geometry QA | Image-driven architectural inference. The procedural path does not infer facade geometry from submitted images |
| COLMAP photogrammetry worker | **Implemented; real-host execution not demonstrated by CI** | Multi-view source validation, licence/scope checks, overlap/same-building/up-axis confirmations, COLMAP invocation, point/mesh diagnostics, PLY-to-GLB path | A real Dhaka building reconstruction quality pass, correct texture, independent scale or survey placement |
| TripoSR single-image worker | **Implemented; actual runtime smoke remains an operator task** | External TripoSR runner integration, source/hash checks, model QA and explicit single-view inference confirmation | Unseen facade/roof geometry, trustworthy scale, WGS84 placement or accurate architecture from one photo |
| Queue and worker | **Implemented / contract-tested** | Authenticated file-backed queue, one worker loop, status heartbeat, retries, interrupted-job recovery and capability probes | Distributed/multi-worker production scheduling, database-grade queue durability or real GPU/ML readiness from a mocked CI probe |
| Review and publication | **Implemented as explicit gates** | Candidate GLB/QA review, placement-bound approval, content-addressed catalog publishing and explicit load to Cesium | Automatic trust, multi-user identity management, independent survey truth or automatic publication approval |
| Signed source-bound review | **Code integrated; production trust provisioning incomplete** | Ed25519 review-signature verification and public-key registry schema/validator | A real reviewer’s identity/authority or live production registry: no reviewer has been onboarded and no production registry secret is proven deployed |
| Floor-plan workflow | **Private/manual candidate path integrated** | Browser review of a source-bound raster, complete line decisions, explicit scale/placement, room/wall boundary validation and private GLB candidate path | Automatic PDF/CAD/IFC/BIM import, automatic room understanding, independently verified scale or real-plan visual acceptance |
| Full architectural reconstruction | **Partially implemented as separate evidence-driven workflow** | Wireframe, correction, mesh, texture and render/QA building blocks; resumable stage-state infrastructure | An automatic source-image-to-per-view-sketch-to-accurate-building pipeline connected to the normal job queue |

### 3.1 Map and 3D Tiles: distinguish footprint extrusion from building reconstruction

The map's normal building representation is based on footprint and available height/metadata. That is useful for geographic discovery and broad massing; it is not a surveyed LOD3 architectural model. The bounded P3.6 tile builder triangulates simple exterior footprints and emits walls/roofs from those footprints. It deliberately excludes unsupported polygons/holes and records provenance. The P3.6 live browser harness proves selective lazy fetching of a small tile package, not that a roof, window, facade or height matches a real building.

P3.8 metadata coverage is a data audit, not a mesh generator. Its report found very sparse roof metadata (roof shape plus positive roof height on 1 of 17,008 features). Do not present the P3.6/P3.8 work as automatically reconstructed city-wide architecture.

### 3.2 The current normal generation route is four stages, not the target eleven

`media-to-model-workflow.mjs` runs a truthful four-stage CLI/job profile:

1. `media-ingestion`: validate/copy/hash input; record operator-supplied rights and operation-scope assertions; extract bounded video frames when configured.
2. `building-spec-sync`: verify selected views and bind source metadata into BuildingSpec.
3. `model-generation`: execute the selected procedural, COLMAP or TripoSR worker.
4. `report-finalization`: write the candidate/report; keep map/publication flags false.

The job/state code also describes a longer architectural reconstruction stage profile (ingest, image analysis, tiled analysis, per-view sketch, registration, wireframe, iterative repair, volume/facade, geometry repair, texture, final acceptance). The presence of these stage IDs and individual modules does not mean the four-stage job runner executes the full profile.

### 3.3 A critical manual-input boundary in the longer geometry pipeline

`architectural-geometry-workflow.mjs` currently requires a workspace JSON input containing calibrated cameras, manually verified cross-view feature identities, edges, explicit reviewed triangular faces and texture-candidate assignments. It also requires explicit operator attestations for camera calibration, correspondences, face definitions and texture evidence. It then runs real wireframe, bounded QA/repair, mesh, texture projection/atlas, GLB export, texture QA and optional fixed-camera rendering components.

This is valuable, but the upstream step that automatically derives trusted camera/feature/semantic geometry from arbitrary building images is not yet connected. The engine should not silently invent those inputs.

### 3.4 Worker and deployment limits

The current queue is file-backed under a shared private `BUILDING_ENGINE_WORKSPACE`. The documented worker model uses one workspace-wide worker lock and a single worker loop; the state contract explicitly says it does not provide distributed locking. The API and worker must share the same persistent filesystem. A serverless deployment with isolated/ephemeral filesystems is not an appropriate backend for this queue design.

COLMAP readiness probes inspect configured executables/subcommands; that does not execute a reconstruction. The TripoSR preflight checks package imports, configured device and locally cached model weights, and syntax-compiles the runner; it deliberately does not execute inference. D3M-05 real runtime smoke must be performed on the actual worker host with the real TripoSR/rembg weights and chosen CPU/CUDA/MPS device. CI's fake/stub runtime contract is not that smoke.

### 3.5 Rights and reviewer identity remain separate release dependencies

Two different boundaries must not be conflated:

- The media intake UI/operator token and `confirmRights`/operation-scope flags capture an operator's declared permission basis. They do not independently prove copyright rights.
- The D3M-01 signed-review path can verify an Ed25519 signature against a trusted public-key registry. The registry code and preflight exist on main, but the operations document explicitly says no real reviewer has been onboarded and no production secret has been configured/proven. The organisation must establish reviewer identity/authority outside the codebase.

The BRF-45 example 16-view manifest was still blocked with zero asset approvals and 16 missing asset-specific decisions in CI. This is the correct fail-closed behavior; a successful workflow means the blocked result was correctly enforced, not that the photos became usable.

---

## 4. The real remaining gaps

### G1 — Evidence contract and repeatable visual validation are not consolidated

Main already contains a capture-manifest and many render/geometry QA tools, but the open stacked PRs #187–#190 add potentially useful generalisation and evidence work that is not present on current main:

- BRF-01: generic render review profiles rather than a renderer tied to one heritage building.
- BRF-02: a shared candidate evidence manifest binding GLB, BuildingSpec, run config/report, capture manifest, source/reference images, camera/measurement/GCP records, renders, QA, comparison and release evidence by exact bytes/hashes.
- BRF-03: capture quality and coverage preflight tied to actual image bytes/dimensions, not only declarations.
- BRF-04: a controlled synthetic baseline and deliberately injected defects (such as wrong scale/degenerate triangles) that verify the QA gates really reject defects.

Those PRs are a stack rooted in an old Bangabhaban branch, not a current-main-ready merge chain. The first implementation task is to port their unique useful code to a fresh current-main branch, preserving main's latest CI, workflow triggers, D3M/P3.6/P3.7 code and scripts. Do not merge #187/#188/#189/#190 wholesale or independently.

### G2 — Actual ML/photogrammetry execution on a rights-cleared worker is not evidenced

Need a real host record for:
- exact worker commit and OS/runtime/device;
- COLMAP version and actual command execution or TripoSR runner/checkpoint/rembg model/device;
- source-manifest hashes and per-source use scopes/rights evidence;
- registered views, camera/feature diagnostics and reconstruction output hashes;
- actual generated GLB + QA report;
- timeouts, memory/GPU use, retries and reproducibility;
- screenshots/fixed-camera renders independently inspected.

A readiness probe or green synthetic CI suite is not a substitute.

### G3 — Automatic image understanding and architectural sketch/registration pipeline is not wired end-to-end

The target engine still needs an integrated, bounded sequence:

```text
Rights-cleared photos/video
  -> image-quality / duplicate / view coverage
  -> building-vs-background segmentation
  -> overlapping multi-scale tiles with coordinate provenance
  -> per-view architectural edge/region/silhouette sketches
  -> camera pose + same-building feature registration
  -> provenance-linked 3D wireframe
  -> bounded 3–4 pass repair with explicit convergence
  -> volume/facade geometry
  -> geometry repair and topology QA
  -> calibrated texture projection / atlas
  -> exact-hash GLB + fixed-camera renders
  -> independent dimension / GCP / vertical datum checks
  -> human acceptance and separately authorised map publication
```

Every stage needs a versioned immutable artifact, exact input hash, software/model version, failure reason and a bounded retry/resume rule. Unknown/occluded geometry must remain unknown or explicitly marked inferred; no silent fabrication.

### G4 — Real-building accuracy baseline is not yet available

The documented Parliament photogrammetry pilot recorded 4/8 registered views, 96 sparse points, around 15,154 dense points and a mesh around 5,474 vertices / 10,846 faces, but the recorded visual review found slab/block-like surfaces, stretched bands, holes, spikes/wings and background contamination. Its verdict was qualitative visual-fidelity FAIL; independent dimensions were not measured and surveyed placement was not verified. The exact GLB/COLMAP workspace/report needed to rerun that old pilot were not in the repository snapshot audited.

A proper benchmark must separately report:
- view coverage/registration and reprojection residuals;
- silhouette/edge agreement against independent reference views;
- geometry/topology integrity and unresolved findings;
- independently measured width/depth/height and error per axis;
- horizontal GCP residuals from points tied to the exact GLB;
- vertical datum and elevation reference;
- texture/view consistency and background contamination;
- human architectural review with explicit unknown/inferred areas.

Do not combine these into an invented “90% accuracy” number.

### G5 — WGS84 placement is an explicit input/gate, not an automatic image solution

The map layer can load a GLB when given longitude/latitude/height/orientation/scale/axes. The job review/publish APIs bind an exact placement to an approval. Ground-control registration can compute a horizontal fit from at least three non-collinear model-vs-survey correspondences. But images alone do not currently provide reliable WGS84 origin, heading, scale and vertical datum. Surveyed control is still required for a real map-ready claim.

### G6 — Production trust, persistence and operations are not complete

Before a public multi-operator production service, the deployment needs:
- real reviewer onboarding/change-control and a provisioned, expiring/rotatable Ed25519 public-key registry;
- secret-manager configuration for distinct API/session/evidence review tokens, with no secrets in Git/CI output;
- persistent object/model/source storage shared safely by API and worker, backup/restore and retention policy;
- database-backed or otherwise robust multi-worker queue/lease/locking semantics if more than one worker is required;
- idempotency, cancellation, retry/dead-letter handling and worker health monitoring;
- resource/time/size quotas and GPU concurrency policy;
- deploy/rollback discipline for content-addressed GLB and catalog manifest;
- public/private asset boundary review.

### G7 — Floor-plan/interior pipeline is a separate track

The browser floor-plan tool is a hash-bound manual review and calibration helper. It expects a raster proposal report, explicit acceptance/rejection for each detected line, reviewed room polygons, two-point scale evidence, origin and placement values. It produces a private candidate; it is not an automatic PDF-to-BIM or CAD/IFC parser. Rights-cleared real plan fixtures, real-drawing false-line/split-wall checks, render-review linkage, independently measured dimensions and survey controls remain necessary. Furniture/interior modelling and indoor navigation are later separate products, not a substitute for core exterior building reconstruction.

---

## 5. Prioritised execution roadmap

The roadmap is dependency ordered. A phase is not complete merely because its files exist or a branch has a green historical CI run. The next phase opens only when the exit conditions below are satisfied on the current-main integration candidate.

### Phase 0 — Re-baseline and change-control guard (required at the start of every task)

**Goal:** prevent stale-branch, stale-CI and duplicated integration mistakes.

Actions:
1. Read this master plan, then query current `main`, `dev`, open PRs, relevant branches and exact-head CI.
2. Record the current SHA and compare each candidate against current main.
3. Inspect actual file diffs, package scripts, workflow triggers and exact-head jobs; identify any already-merged subset by blob SHA/content, not by PR title.
4. Create a new branch based on the verified current main for the next scoped task.
5. Keep model rights/truth/release gates false unless independently evidenced.

Exit: repository state and selected candidate are recorded before code changes. Any branch that is behind/diverged must be selectively ported; do not force-merge it.

### Phase 1 — D3M-ENGINE-01: BRF-01–04 current-main evidence foundation (**NEXT TASK**)

**Why first:** this creates a reusable evidence/QA contract for every model-producing worker and prevents later tasks from relying on building-specific screenshots or informal JSON declarations.

Source stack to inspect selectively:
- PR #187 / branch `feat/brf-01-generic-renderer` head `5ec16ed677019c28c8380362b56de4062c683e4a` — generic renderer and review-profile work; based on #185.
- PR #188 / branch `feat/brf-02-candidate-evidence-manifest` head `21b0df2fc527f6e9adbe70f2918c9a690fa3cbd7` — candidate evidence manifest; based on #187.
- PR #189 / branch `feat/brf-03-capture-quality-coverage` head `69eb71ec90d60f49f0913ddf25533a074fa3cbd7` — capture image-quality/coverage preflight; based on #188.
- PR #190 / branch `feat/brf-04-baseline-defect-benchmarks` head `dce0d4f92e6e30feb9cff2880c3175dc2feeaf13` — controlled baseline and deliberate defect injection; based on #189.
- A cleaner renderer-only current-base candidate also exists at `feat/brf-01-generic-renderer-current-base`; compare its exact latest head and changed files before using it.

Implementation approach:
1. Read the current main renderer, render manifest, capture manifest, geometry/texture QA and all relevant package scripts.
2. Compare every BRF stack file against main. Keep already integrated capture-manifest functionality; do not duplicate it.
3. Port only the missing generic render profile and shared candidate-evidence binding needed by the engine. Require exact GLB/source/render/reference hashes, byte counts, safe workspace-relative paths and stable artifact IDs.
4. Add capture quality and coverage checks on actual image bytes. A declaration without an actual file/hash remains incomplete.
5. Add a controlled known-shape synthetic baseline and defect injectors (wrong scale, degenerate triangles and at least one geometry/topology defect). Demonstrate that valid-looking but defective GLBs fail the intended gates.
6. Reconcile `package.json`, `package-lock.json` and CI/workflow registration against current main without replacing unrelated D3M/P3.6/P3.7 workflows.
7. Add a single current-main PR and run exact-head focused tests, Full CI and required renderer/benchmark workflow. Inspect generated artifacts.

Exit criteria:
- one current-main-based PR; no duplicate parent/child stack PRs merged separately;
- all four BRF capabilities on current main with tests;
- actual-byte evidence and exact-GLB-hash consistency are enforced;
- injected defects are rejected, controlled baseline passes;
- Full CI/renderer checks pass on the exact final SHA;
- no acceptance/publication/map-ready flag changes.

### Phase 2 — D3M-ENGINE-02: real worker host and runtime proof

**Goal:** prove one genuine reconstruction worker can run; do not start by promising accuracy.

Preferred first route: a rights-cleared multi-view photo set for one building, because multi-view coverage can be reviewed and compared. Single-image TripoSR remains a preview route for unseen surfaces.

Actions:
1. Choose one building and a small rights-cleared image set with exact source identity, permissions and operation scope. Do not use public images just because they are downloadable.
2. Confirm building identity, unique views, sufficient overlap and JPEG/PNG source bytes; preserve originals and SHA-256.
3. On the actual worker host, record OS, CPU, RAM, GPU/VRAM, Python, COLMAP, FFmpeg, TripoSR, PyTorch, ONNX Runtime, rembg, model/checkpoint revision/licences and environment status without leaking secrets.
4. Run the actual D3M-05 single-image smoke only if that path is selected, on its real host with the exact cached model weights, device and fresh job ID. Or run a real COLMAP job with pinned tools and exact views.
5. Capture a full private run bundle: request/config/source manifest, worker logs, model parameters, runtime/device, attempts, stage hashes, GLB/report hashes, diagnostics and failure reasons.
6. Re-run the same frozen inputs/config in a fresh job to check reproducibility and compare outputs.

Exit criteria:
- an actual external process ran, not just `--help`, imports, syntax compilation or faked CI;
- actual GLB 2.0 output exists and hash is verified;
- no worker warning is hidden; memory/timeouts/retries are recorded;
- output stays private and all map/publication flags remain false;
- an independent reviewer opens the GLB and fixed-camera render set.

### Phase 3 — D3M-ENGINE-03: connect architectural reconstruction stages to the real job path

**Goal:** turn the manually supplied geometry workflow into a staged, source-derived and reviewable pipeline without inventing missing observations.

Work packages (keep each bounded and testable):
1. **Image analysis:** actual image decoding, orientation/EXIF, blur/exposure, duplicate/near-duplicate analysis, source-to-image coordinate system and quality report.
2. **Building/background segmentation:** distinguish building pixels from sky, trees, roads, vehicles and other clutter; bind masks to the exact image bytes; keep human correction available.
3. **Overlapping tiling:** multi-scale/overlapping crop plan with source pixel transforms and stable tile IDs; merge proposals back in original coordinates without treating tile seams as architectural edges.
4. **Per-view architectural sketch:** silhouette, roofline, facade edges, corners, floor bands, openings/columns and unknown/occluded regions, each with pixel provenance and confidence. Human review needed for semantic labels.
5. **Camera and view registration:** bind calibrated intrinsics/extrinsics and cross-view feature IDs; reject weak/inconsistent correspondence; write common-frame diagnostics.
6. **3D wireframe:** create provenance-linked vertices/edges/planes; project back into every source image and record residuals.
7. **Bounded repair loop:** 3–4 configurable passes maximum; detect duplicates, self-intersections, incompatible planes, unsupported lines and projection mismatches; repair only when supported by observations/constraints. Persist before/after artifacts and unresolved findings. Stop with review-required if not converged.
8. **Volume/facade geometry:** build coarse massing before details; distinguish observed vs inferred vs unknown geometry; record method and confidence.
9. **Geometry repair:** use existing mesh QA as a detector and bounded repair as a separate worker; require rerun after each change; do not close architectural openings blindly.
10. **Texture:** select views using calibrated camera visibility, image quality and occlusion; mask backgrounds; bake and bind texture atlas; inspect UV seams/materials and source-view provenance.
11. **Final package:** exact-GLB-bound geometry/texture reports, generic 13-view renders, reference comparison, unresolved defects, evidence manifest and explicit human decision.

Integration rule: extend the current durable job state/runner with truthful stages. Do not mark an existing stage completed when the underlying worker did not execute. If a stage is still manually supplied, say so in the report. Preserve idempotency, artifact hashes, resume/invalidation and bounded resource budgets.

Exit criteria:
- one real rights-cleared multi-view dataset runs through the integrated job to a candidate GLB;
- every stage has an actual immutable artifact and truthful status;
- source-to-tile-to-sketch-to-camera-to-wireframe-to-mesh-to-texture-to-GLB lineage is verifiable;
- all unknown/inferred regions remain labelled;
- failures stop at the responsible stage and do not generate fake completed artifacts;
- exact-head CI, production-server browser tests and actual worker evidence pass.

### Phase 4 — D3M-ENGINE-04: independent accuracy benchmark and held-out validation

**Goal:** prove where the engine is accurate, where it is not, and how it fails.

Pilot set:
- one ordinary low-rise building;
- one multi-storey/high-rise building;
- one architecturally complex building.

For each building, require:
- source images with documented rights, building identity and coverage;
- reference photos not used to train/tune the same candidate;
- independent surveyed or authoritative dimensions (width/depth/height) with provenance and uncertainty;
- at least three non-collinear horizontal ground-control correspondences tied to the exact GLB;
- separate height/vertical-datum evidence;
- fixed-camera renders and a human comparison decision for every required view.

Report separate measurements: per-view coverage/registration, silhouette/edge residual, dimension error per axis, GCP RMS and max residual, vertical datum, topology/geometry warnings, texture contamination/seams and human visual findings. Use held-out checkpoints for independent scoring. Do not collapse these into one accuracy percentage unless a documented, defensible metric specifically defines it.

Exit criteria:
- real held-out evidence pack passes its declared acceptance thresholds;
- results are reproducible from exact hashed source/config/model/tool versions;
- human reviewer signs the exact candidate hash;
- false positives/false passes are tested with defect-injected controls;
- publication remains disabled until the separate release policy passes.

### Phase 5 — D3M-ENGINE-05: geospatial placement and map integration

**Goal:** place a measured candidate correctly without confusing a camera guess or approximate footprint with survey truth.

Actions:
1. Fit horizontal WGS84 transformation from surveyed control points that correspond to identifiable features on the exact candidate GLB.
2. Report residuals, scale, rotation/heading, local frame and coordinate transform.
3. Validate height reference/datum, ground elevation and building base separately. Explicitly convert orthometric/local height where needed; Cesium's current layer uses WGS84 ellipsoid height.
4. Verify footprint/model alignment and tile transforms in a browser at multiple zoom levels. Do not load duplicate building footprints plus generated GLBs without a deliberate representation policy.
5. Bind the exact approved placement into the review record; publication must reject any changed placement hash.
6. Decide between an individual reviewed GLB catalog entry and city/tile-set packaging based on measured scale and lifecycle needs.

Exit criteria:
- independently validated horizontal and vertical placement;
- exact model/placement/catalog hashes agree;
- Cesium browser review shows no offset/orientation/scale regression;
- separate explicit human publication approval;
- production catalog and rollback tested.

### Phase 6 — D3M-ENGINE-06: production operations and scale

**Goal:** make the engine service reliable, safe and operable, not merely executable on one developer workstation.

Actions:
- Define deployment topology and supported GPU/CPU worker matrix.
- Replace/augment the single-workspace file queue with a durable queue/store and distributed lease if multi-worker scale is required; document exactly-once/idempotent stage and artifact semantics.
- Use durable private object storage for source images, stage artifacts and candidates; separate it from public catalog assets.
- Add per-tenant/building access control, quota/size/time limits, cancellation, dead-letter handling, retry budgets, observability and redacted logs.
- Provision reviewer keys through a secret manager with onboarding, expiry, rotation, revocation, renewal and audit. Never store private keys in Git/CI.
- Add backup/restore, retention and public-asset rollback runbooks; validate the deploy target supports persistent writes or move publishing into a dedicated deployment/object-store pipeline.
- Add operational dashboards for queue depth, worker heartbeat, strategy readiness, timeouts, GPU memory, stage duration and artifact integrity.

Exit criteria:
- failure/restart/retry/duplicate submission/worker replacement tests pass;
- private assets never become public before review/publish;
- multi-worker locking and concurrency are race-tested;
- production secrets/reviewer registry are present and validated without logging secret values;
- rollback and restore are demonstrated.

### Separate track — P3.7 floor plan and indoor geometry

Do not mix this with the exterior multi-view image-to-building work. Continue separately:
- rights-cleared real plans and real-drawing line/room review;
- source hash/byte binding and false-line/split-wall cases on real plans;
- independent scale and surveyed placement;
- PDF rasterization if required, followed by exact derived-raster provenance;
- explicit CAD/IFC/BIM importer research/implementation (not currently present);
- private candidate render/geometry QA before any interior/furniture or indoor map use.

---

## 6. Open PR/branch handling rules

At the audit snapshot these PRs remained open. They are **not** approved to merge just because they have code or historical green CI:

| PR | Scope | Audit disposition |
|---:|---|---|
| #187 | BRF-01 generic renderer | Keep as source/reference; clean-port unique renderer work to current main |
| #188 | BRF-02 candidate evidence manifest | Stacked on #187; port selectively after BRF-01 |
| #189 | BRF-03 capture quality/coverage | Stacked on #188; compare against current main capture manifest first |
| #190 | BRF-04 defect injection benchmark | Stacked on #189; port synthetic baseline/test/fixtures, not stale workflows wholesale |
| #103 | engine mismatch/Ahsan model changes | Old-base, mixed engine and heritage changes; separate code audit |
| #104 | Ahsan Manzil P1.4 model | Building-specific provisional model; human visual/reference sign-off still required |
| #169 | Bangabhaban P3.3 correction loop | Building-specific; existing report lists topology/texture/dimension blockers |
| #185 | Bangabhaban facade/dome alignment | Old-base source for the BRF-01–04 stack; not a general-engine integration PR |
| #279 | older D3M docs/gap-audit stack | Historical development base; do not merge wholesale |

The D3M-04 through D3M-07 feature branches are also old-base/diverged candidates. Much of their code is already represented on main (generation worker readiness, TripoSR smoke/preflight, placement-bound publication). Reuse current-main implementations; inspect file hashes and current tests before deciding whether any genuinely unique delta is missing. Do not cherry-pick a whole old branch or overwrite main CI/package files.

For every future PR:
- compare `base=main` and `head=feature`;
- read every unique code file and test;
- identify the merge base and current-main-only files;
- port only unique intent onto a fresh current-main integration branch;
- rerun final exact-head Full CI and relevant dedicated workflows;
- inspect uploaded model/render/evidence artifacts;
- update this document with head SHA, run IDs, pass/fail, remaining blocker and next task;
- only then promote to `dev` and `main` via verified PRs.

---

## 7. Definition of done for the Dynamic 3D Engine

The product should not be called complete until all required rows below are evidenced on a real, rights-cleared building dataset:

- [ ] User can submit source images/video and see source hashes, rights basis and view coverage.
- [ ] System can detect/flag poor/duplicate/unusable images and preserve originals.
- [ ] The selected multi-view worker actually runs on the supported host and records pinned versions/config.
- [ ] The system automatically produces reviewable per-view segmentation/sketch artifacts, with pixel/source provenance.
- [ ] Camera calibration and cross-view correspondences are computed/validated or explicitly reviewed; failure stops rather than guessing.
- [ ] A provenance-linked 3D wireframe and bounded repair/convergence report are generated from the selected views.
- [ ] Coarse massing, facade geometry and mesh are derived from supported observations; unobserved detail is clearly inferred/unknown.
- [ ] Geometry repair, UV/material/texture and fixed-camera render review are integrated and hash-bound to the same GLB.
- [ ] Independent dimensions, held-out visual evidence, horizontal survey controls and vertical datum are checked against the exact model.
- [ ] Trusted reviewer identity/signature, source-use scope and approval are configured in the actual deployment.
- [ ] Exact reviewed placement is bound to the model hash, and publication is a separate explicit action.
- [ ] Published/catalogued GLB loads in Cesium at the validated location/orientation/scale with rollback available.
- [ ] Operational recovery, queue concurrency, persistence, secrets, backup/restore and monitoring are tested.
- [ ] All acceptance/release gates are set only by the defined evidence and reviewer policy, never by CI success alone.

Until then, report the engine as **experimental, partially implemented and evidence-gated**. Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `publishable`, `mapReady`, `automaticApproval` and `dispatchAllowed` false whenever their evidence requirements are absent or blocked.

---

## 8. The next chat must resume from exactly one task

### Immediate next task: D3M-ENGINE-01 — BRF-01–04 selective current-main integration

Do not start another unrelated feature first. The next chat should:

1. Read this document and verify live `main/dev` heads; if the SHA changed, refresh this plan's current baseline before coding.
2. Open PR #187–#190 and `feat/brf-01-generic-renderer-current-base`; inspect their current heads and all unique diffs.
3. Fetch current-main renderer/capture-manifest/QA/package/CI files and build a file-by-file matrix: already present, genuinely missing, conflicting/stale.
4. Create a new branch from the latest current `main` and selectively port BRF-01, then BRF-02, BRF-03, BRF-04 in one dependency-aware integration (or sequential PRs if tests need a boundary).
5. Do not merge old PRs, do not copy stale CI workflows wholesale, and do not alter release flags.
6. Run focused tests, synthetic defect tests, Full CI and any dedicated renderer workflow on the final exact head. Inspect the generated contact sheets and JSON manifests.
7. Update this master plan with exact branch/PR/head SHA, CI run IDs, output artifact digests, what actually passed, and the next one task.

### Copy/paste prompt for any future chat

```text
Read docs/DYNAMIC-3D-ENGINE-MASTER-PLAN.md on the current main branch first. Treat it as the single source of truth, but verify live main/dev SHAs, open PRs, source diffs and exact-head CI before doing anything. Resume only the Immediate next task: D3M-ENGINE-01, the selective BRF-01–04 current-main integration. Do not merge stale stacked PRs or overwrite main workflows. Work from a fresh branch based on the current main SHA, read all changed files, add regression tests, run focused and full CI, inspect artifacts, keep all truth/acceptance/publication/map-ready flags fail-closed, and update the master plan with exact SHAs/run IDs/results before promoting. Do not start the next phase until the exit criteria in the plan are met.
```

---

## 9. Mandatory rules for every follow-up task

1. **Read before change:** inspect the current source and actual file diff; a task title or old branch description is not evidence.
2. **One canonical integration:** use a fresh current-main branch; no parallel merge of stacked parent/child PRs.
3. **Exact-head validation:** CI for an older SHA does not validate a later commit. Rerun on the final SHA.
4. **Inspect real artifacts:** a test saying “upload passed” is not the same as visually inspecting the actual GLB, PNG, manifest and hashes.
5. **No invented evidence:** missing rights, image, dimension, survey, device, model weights, reviewer registry or screenshot must be marked missing/blocked.
6. **Keep stages truthful:** a manually entered camera/face/scale value must be labelled as operator input; a preflight must not be reported as model inference.
7. **Fail closed:** never relax rights, geometry, reviewer, scale, georeference or publication gates merely to make CI green.
8. **Preserve rollback:** never force-push or rewrite shared branches; use expected-head checks and non-force fast-forward for branch sync.
9. **Update the plan:** every meaningful task ends by recording exact source SHA, changed paths, tests, CI runs, artifacts, limitations, release-gate state and the next task.
10. **Never claim universal accuracy:** results apply only to the tested building, source views, environment and benchmark protocol.

**Audit conclusion:** substantial map, ingestion, generation, worker, QA and publication foundations exist. The highest-value next work is to unify exact-byte evidence and repeatable defect-detection first, then prove one real worker run, wire the architectural reconstruction stages into the durable job path, benchmark against independent building truth, and only then expand map placement and production operations.
