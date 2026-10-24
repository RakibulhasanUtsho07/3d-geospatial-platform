# Building Viewport Manager — P1.4

## Purpose

BuildingViewportManager owns viewport-scoped building fetch and staging lifecycle. CesiumAdapter continues to own building-specific geometry styling, facade LOD, selection state and the existing MapEngine API.

## Extracted responsibilities

- Request endpoint selection between viewport tiles and the full pilot dataset.
- Two-entry viewport-response cache and fetch telemetry.
- Abort controller, active endpoint, load token, intent revision and latest-request coalescing.
- GeoJsonDataSource loading, invisible staging, stale-request checks, hidden-datasource cleanup and stage telemetry.
- Loaded viewport coverage/feature-budget state and cancellation when the layer is disabled or the adapter is destroyed.

## Preserved adapter responsibilities

- Convert staged building entities to lightweight geometry and LOD records.
- Apply source-derived building height/style, parent/part and underground filtering.
- Clear selection safely, atomically swap the active datasource, and update visible building metadata.
- Preserve existing camera-driven viewport policy and public MapEngine methods.

## Lifecycle contract

1. A request must match the current intent revision and visible layer before its response is cached and before its stage is attached.
2. New GeoJSON is loaded/attached invisibly; the current datasource remains active while geometry is prepared.
3. The adapter callback returns success only after the replacement datasource is committed; only then does the manager update loaded coverage.
4. Hidden/stale stages are removed when the viewer is still active and the stage did not become the current datasource.
5. Only the load owning the latest load token may reset shared request state or dispatch the coalesced follow-up request.

## Verification

Run `npm run test:building-viewport-manager`. CI also executes the existing viewport cache/policy, building feature-budget, optimization, browser integration, API smoke and production-build steps. This is a code-ownership and race-safety refactor; no live latency/FPS gain is claimed without a real-data benchmark.
