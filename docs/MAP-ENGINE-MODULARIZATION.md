# P1 — Map Engine Modularization

## First vertical slice: generated GLB models

The first extraction moves the generated-model lifecycle out of \`CesiumAdapter\` and into \`GeneratedModelLayer\`. The map adapter remains the public \`MapEngine\` implementation and delegates through the same public method names.

### Ownership after this change

- \`CesiumAdapter\`: Cesium viewer initialization/teardown, camera and feature picking, plus public facade.
- \`GeneratedModelLayer\`: validated model definitions; asynchronous GLB creation; per-model revision/visibility revisions; staged asset replacement; model visibility/removal; in-flight load invalidation.
- \`generated-model-policy.mjs\`: declarative GLB input validation and normalization (existing policy remains the single validation path).

The manager receives viewer/Cesium getters, not a long-lived copied viewer reference. This is important because React map retry can destroy one viewer and initialize another while model loads are pending.

### Compatibility constraints

- Keep \`MapEngine\` signatures unchanged.
- Reject duplicate IDs and keep the existing URL/axis/coordinate policy.
- Do not remove the old model before a replacement asset has loaded and passed revision checks.
- A visibility toggle racing an update must retain the most recent explicit visibility choice.
- When the map is destroyed, invalidate in-flight loads before Cesium destroys the scene.
- Do not change city-building/road rendering, request budgets, or default camera behavior during this extraction.

### Validation

- \`npm run test:generated-model-layer-boundary\` verifies the module boundary and key lifecycle guardrails.
- CI TypeScript compilation/production build checks type integration.
- Existing map browser integration checks cover map initialization and teardown.
- A successful build does not by itself prove a browser-level imported GLB smoke test; that should be added before refactoring more complex road or viewport lifecycles.

### Next extraction order

1. Generated GLB model lifecycle — this change.
2. Camera/heritage-camera controller, including orbit animation teardown.
3. Road layer and its request cancellation state.
4. Building viewport fetch/stage manager.
5. Feature picking and selection dispatch.
6. Shrink \`CesiumAdapter\` to composition and the stable \`MapEngine\` facade.

Do not extract the building viewport layer and road layer together: their request/cache semantics need separate before/after tests and measurable browser evidence.
