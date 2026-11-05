# D3M-ENGINE-14 — Independent held-out 3D checkpoint validation

## Purpose

D3M-ENGINE-13 estimates a horizontal similarity transform and an ellipsoidal vertical offset from fitting control points. Residuals on those same observations describe fit consistency; they are not a held-out estimate of candidate placement error.

D3M-ENGINE-14 adds a separate checkpoint set. The evaluator applies the already-fitted D3M-13 transforms to held-out model coordinates and compares predicted WGS 84 longitude/latitude and EPSG:4979 ellipsoidal height with the declared checkpoint observations. Held-out points never enter either fit.

## Manifest schema 1.2.0

Schema 1.2.0 requires all D3M-13 horizontal and vertical fitting controls plus a `heldOutCheckpoints` object. Schemas 1.0.0 and 1.1.0 retain their prior compatibility.

Schema 1.2.0 fitting horizontal controls each carry a unique `observationId`. Each matching vertical fitting measurement must repeat that exact ID. The held-out set declares:

- CRS `EPSG:4979`, ellipsoidal heights, metres;
- the exact WGS 84 realization and coordinate epoch used by the vertical fitting controls;
- an independent survey method/reference/timestamp and declared horizontal/vertical accuracy;
- 6–100 checkpoints, each with a unique checkpoint ID, unique observation ID, declared observation-record SHA-256, exact candidate GLB model X/Y/Z and surveyed longitude/latitude/ellipsoidal height.

Checkpoint IDs cannot overlap with fitting control IDs. Held-out observation IDs cannot overlap with fitting observation IDs or duplicate each other. Fitting horizontal/vertical observation IDs must match exactly. Coordinates, frame and epoch are strictly validated. Held-out model X/Z must cover a non-collinear two-dimensional area and model Y must span at least one metre using the exact D3M-13 scale.

The observation-record SHA-256 is a declaration embedded in the manifest. This increment does not fetch or byte-verify original field-book/GNSS observation files.

## Calculation

No transform is re-estimated from held-out points. Horizontal prediction reuses the exact D3M-13 similarity scale, rotation, translation and local tangent-plane reference origin:

```text
east  = s * (cos(theta) * modelX - sin(theta) * modelZ) + translationEast
north = s * (sin(theta) * modelX + cos(theta) * modelZ) + translationNorth
```

Vertical prediction reuses the exact D3M-13 scale and offset:

```text
predictedEllipsoidalHeight = heightOffsetM + s * modelY
verticalResidual = predictedEllipsoidalHeight - surveyedEllipsoidalHeight
spatial3dError = sqrt(horizontalError^2 + verticalResidual^2)
```

Per-point evidence contains predictions, east/north residuals, horizontal error, vertical residual and combined 3D error. Summary metrics include RMS and maximum horizontal, vertical and combined spatial errors. Horizontal and vertical limits are inherited from the corresponding fit configuration; combined 3D limits are the Euclidean combination of those limits. A requested run passes only if every metric threshold passes.

## Smoke and review package

When schema 1.2.0 held-out checkpoints are present, single-image smoke requires `independentCheckpointEvidence.status = validated-needs-human-review`. A failed/blocked evaluation fails the smoke. No checkpoint section means `not-requested`, never a pass.

Georeference evidence advances to schema 1.2.0. The existing generation receipt binds the full georeference evidence. Workspace/offline smoke verification recomputes the result from exact manifest bytes and exact GLB hash. Review-package preparation requires passing held-out validation and records a canonical evidence digest and summary. Offline package integrity verification recomputes the evidence and cross-checks the exact candidate, smoke, receipt, workflow, manifest and package metadata.

Historical manifest and evidence schemas remain supported without retroactively claiming held-out validation.

## Trust boundary

This stage validates deterministic calculations and internal evidence binding. It does not authenticate the surveyor or receiver, prove raw observation-record bytes, prove physical feature correspondence between candidate and building, or prove that the operator did not use held-out points during modelling. These require independent records and human adjudication.

Synthetic tests prove only software behavior. They are not real-world accuracy, architectural fidelity, TripoSR/rembg inference, source rights or permission to publish.

Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false. No Cesium publication is authorized by this increment.

## Software validation — 2026-11-05

- Validated code/test head: `66ae2f03f5bc9303d2734e7641039f4afa06c95b`.
- Push Full CI [#41978812826](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41978812826) and PR Full CI [#41978818407](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41978818407) both completed successfully: 214/214 steps each, zero failures.
- The offline review-package integrity suite passed 22/22 tests, including the end-to-end held-out 3D checkpoint package test. Both workflows also passed ESLint, production build, Chromium install, production viewport API checks, Dhaka tile/viewport benchmark suites and evidence uploads.
- PR #363 remains Draft/open/unmerged, stacked on D3M-ENGINE-13 PR #362 at base `bc3b1d8242718f25250581819c9cc23d975d9581`. No promotion to `development` or `main`.

This exact-head validation proves software behavior and evidence-byte binding only. It does not authenticate real GNSS/field-book records, surveyor identity or physical feature correspondence, and it is not real-world building accuracy evidence. Keep all release/publication flags false.
