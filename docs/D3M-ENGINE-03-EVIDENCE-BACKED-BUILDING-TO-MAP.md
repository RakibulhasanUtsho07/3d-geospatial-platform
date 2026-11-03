# D3M-ENGINE-03 — Evidence-backed building-to-map vertical slice

**Repository:** `RakibulhasanUtsho07/3d-geospatial-platform`  
**Implementation branch:** `feat/facade-selection-insert-placement-20261103`  
**Baseline:** `main@bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`  
**Status:** implementation candidate; exact-head CI and independent visual review required

## Reused systems

This milestone composes already-implemented D3M-01–07, BRF-05–07 source-bound evidence, multi-view camera/geometry/texture workflow, GLB topology QA, independent dimension/ground-control benchmark, signed review package, reviewed WGS84 placement, publication catalog and Cesium rendering. It does not create parallel replacements.

## Delivered implementation in this branch

- Real through-wall door/window apertures replace the former decorative overlays on solid procedural wall boxes.
- A scanline contour tessellator removes rectangular and faceted-arch loops from front/back wall faces and bridges reveal surfaces across the wall depth.
- BuildingSpec and its JSON Schema accept `rectangular` or `arched` profile selection. Rectangular remains the default.
- The exact GLB extras, generation report and architecture-placement report carry opening count/area and procedural/review-required confidence.
- Overlapping, duplicate, out-of-panel and malformed openings are rejected.
- The BRF-04 controlled synthetic non-manifold edge-injection regression from PR #349 is reconciled into this branch.

Opening location and dimensions remain procedural; these are not extracted from real source photos or independent measurements.

## Full evidence-to-map sequence

1. Rights-scoped source media intake and source-byte hash validation.
2. Image quality, view coverage and source-bound manual masks/observations.
3. Camera calibration/correspondence review.
4. Multi-view registration, wireframe proposal and mesh construction/repair.
5. Texture projection, atlas bake and GLB binding/topology QA.
6. Exact candidate/source/evidence hashes and review render packet.
7. Independent dimensions, held-out ground controls, human reference review and authorized signature.
8. Immutable WGS84 placement binding to the approved GLB hash.
9. Catalog publication and browser/Cesium load by exact model id/version/SHA.

Single-image AI remains a preview candidate, not a substitute for multi-view architectural evidence.

## Validation

```bash
npm run test:building-generation
npm run test:building-baseline-defect-injection
npm run test:glb-geometry-qa
npm run test:architectural-geometry-workflow
npm run test:building-candidate-evidence-manifest
npm run test:building-accuracy-benchmark
npm run test:building-accuracy-evidence-pack
npm run test:generation-queue
npm run test:generation-review
npm run test:published-model-catalog
npm run test:publish-approved-generation-job
npm run test:map-browser
npm run lint
npm run build
```

Require exact-head Full CI and Generic Renderer Smoke. Inspect the hash-pinned Blender artifact and required views; rendering is not actual-building visual acceptance.

## External gates that remain blocked

- Real TripoSR/rembg inference on the provisioned worker host with fresh source/job IDs, selected model weights, device/runtime and independent evidence verifier.
- Exact source-image and model-weight rights for intended use.
- Production trusted reviewer public-key registry and reviewer onboarding.
- Rights-cleared same-building multi-view source, independent surveyed dimensions, held-out control points and a declared vertical datum.
- Human review of the exact source-bound render/reference packet and signed decision.
- Cesium publication only after these gates pass.

CI fakes do not prove real inference. A benchmark with missing survey inputs remains incomplete. No ground-truth, universal accuracy, or publication claim may be inferred from synthetic tests.

Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false until exact candidate evidence and all release gates are independently satisfied.

## Resume protocol

For the next execution, refresh branch/main SHA, PR state, latest exact-head CI and renderer artifact first; inspect any failed logs before changing code. Do not merge main without explicit instruction.
