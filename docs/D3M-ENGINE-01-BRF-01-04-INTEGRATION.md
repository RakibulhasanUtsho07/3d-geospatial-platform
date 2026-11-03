# D3M-ENGINE-01 — BRF-01–04 Current-Main Integration

**Status:** implementation assembled; exact-head validation rerun pending; prior-head render artifact inspected; human review pending  
**Latest test repair:** profile unit fixture is now self-contained; rerun required on final commit  
**Base:** `main@ff5f2fed0182e8551f4f77d2ad84178a1906f7ee`  
**Branch:** `feat/d3m-engine-01-brf-evidence-20261103`  
**PR:** [#343](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/343)

This is a clean-base selective port. It does not merge the stale stacked PRs #187–#190 or their old workflow/package histories.

## BRF-01 — Generic render-review profiles

- Added a strict, versioned profile schema with a generic whole-model default.
- Profiles support safe exact node selectors, excluded node-name prefixes, front-view elevation and a framing label.
- Unknown fields, wildcard selectors, duplicate names, conflicting include/exclude selections, missing selected GLB nodes and out-of-range elevations fail closed.
- The Node runner validates profile JSON and hashes the exact profile bytes before Blender starts.
- Blender independently checks that pinned SHA-256 before applying the profile. The render manifest records the profile ID, source and digest.
- Legacy callers without a profile keep the prior site-context exclusion and Rangmahal-focused front-view behavior.
- The dedicated renderer workflow builds a generic GLB, renders the required 13 views, and checks built-in and explicit-profile provenance. Rendering does not imply accuracy or publication approval.

## BRF-02 — Shared candidate evidence manifest

- Added a normalized per-candidate evidence graph for the GLB, BuildingSpec, generation report/config, source/reference images, capture manifest, camera/calibration/frame evidence, independent dimensions, ground control, renders, geometry/texture QA, reference comparison, accuracy and release-readiness outputs.
- Enforces safe project-relative paths, unique artifact IDs/paths, SHA-256/byte declarations, artifact type/subject bindings and candidate-GLB hash consistency.
- Confidence labels require supporting artifact IDs; present/missing outputs are normalized explicitly.
- The assessor can compare manifest declarations with actual artifact bytes supplied by the caller.
- Evidence tiers are routing/completeness labels, not similarity scores. Publication eligibility is hard-coded false.

## BRF-03 — Capture quality and view-coverage preflight

- The capture-manifest CLI verifies path containment, rejects symlink traversal, and checks actual source-file SHA-256 and byte counts before image decoding.
- Existing bounded image-quality analysis is now connected to each eligible photo/video-frame: decoded dimensions, quality warnings and perceptual near-duplicate hints are written into `inputQuality`.
- Declared camera image dimensions must match decoded bytes; contradictions or integrity failures fail the preflight.
- Low-resolution, blur/exposure warnings, near-duplicates or missing image evidence remain incomplete/review-required rather than silently passing.
- Raw capture videos do not count as facade views; each declared video must have a linked extracted `video-frame` source record.
- Quality heuristics are screening only. They do not prove building identity, camera calibration, permissions or reconstruction suitability.

## BRF-04 — Controlled GLB baseline and deliberate defects

- Added a deterministic synthetic 10 × 8 × 6 model-space cuboid with expected mesh/triangle counts.
- Added byte-repeatability, +20% axis-scale and degenerate-triangle regression tests.
- The scale defect must fail the independent-dimension tolerance while remaining a structurally valid GLB; the degenerate triangle must be detected by geometry QA.
- The fixture explicitly disclaims real-building truth, georeference, architectural similarity and publication approval.

## Automated validation registered

The main CI workflow now runs:

- `npm run test:render-review-profile`
- `npm run test:building-candidate-evidence-manifest`
- `npm run test:building-baseline-defect-injection`
- `npm run test:building-capture-manifest`

It also includes the new feature branch in its push trigger. A separate `generic-renderer-smoke.yml` workflow renders 13 views using Blender and verifies profile hash round-trip.

## Acceptance boundary

This package establishes reusable software contracts and synthetic regression behavior. It does **not** demonstrate a real COLMAP/TripoSR reconstruction, measured architectural accuracy, survey-backed dimensions, correct WGS84 placement or a production worker. Do not claim a 90% score from these tests.

`groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady`, `automaticApproval` and `dispatchAllowed` remain fail-closed. Do not promote the branch until Full CI and the dedicated Blender renderer workflow pass on the same final head and generated render/manifest artifacts are inspected.


## Renderer artifact inspection — 2026-11-03

Prior candidate head `a2ec3bed001f64ce15996b535112c9e7b0d3c8f8` completed Full CI and the dedicated Blender smoke workflow:

- Full CI run [#41623370524](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41623370524): passed.
- Blender smoke run [#41623370467](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41623370467): passed; artifact [d3m-engine-01-generic-renderer-review-packet](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41623370467/artifacts/13224747915).
- Artifact ZIP SHA-256: `bd022af54ed5a8a7337a7ec1bdd4d5f9ee3c14c783f97485f1aa9badc4ed6f41`.
- The ZIP contains the synthetic `demo.glb`, two render directories, two manifests and 26 PNG views (13 per render set).
- Both manifests report 13/13 views, zero render errors and warnings, and `publicationEligible: false`.
- Both manifests bind the same GLB SHA-256: `a641b52b4981bb9448b0f4e235a240be9c9d9ae4f0a8e77a8a955aaa526bd1fa`. The explicit profile records `generic-whole-model-explicit-v1` and SHA-256 `998eb07d7c228ce4203b9dd9f0beacfad7369df2d6a2b1274a26e45ea2d10c3e`.
- The synthetic model has 7 meshes/materials and no texture images or UV accessors. Texture QA is therefore `review-recommended`; all five human-review checklist items remain unchecked.
- Imported model dimensions are 13.7459 × 10.2231 × 16.05 model units and explicitly unverified. The renderer cannot infer real facade compass direction, metric scale, georeferencing or building identity.

The PNG montage was visually inspected. It is a simple synthetic rectangular building and demonstrates multi-view rendering only. No real-building similarity or architecture score was assigned.

## Follow-up validation repair

A manual `workflow_dispatch` run exposed an event-provenance assertion that only accepted `push` and `pull_request`. The browser evidence test now also accepts `workflow_dispatch`, while still requiring a non-empty supported event name and the source/workflow commit hashes. This is a test-only compatibility repair; exact-head PR CI, P3.6 browser workflow and renderer smoke have been triggered again for the updated head `739778056c543696ee46a9c855e013f046b5e343`.

Do not treat the prior-head artifact as final-head evidence. Re-inspect the new smoke artifact and retain all release flags as false until independent human review and real-building validation are complete.
