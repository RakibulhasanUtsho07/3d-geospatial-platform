# Road Layer Manager — P1.3

## Purpose

RoadLayerManager owns the viewport-scoped OSM road request and the corresponding Cesium CustomDataSource. The change separates lifecycle state from CesiumAdapter without changing the public MapEngine API.

## Ownership boundary

- Road data source, road entity-to-feature index, active request key, abort controller and loaded viewport coverage live in RoadLayerManager.
- Network fetch, timeout/abort handling, road geometry conversion, visual styling, labelled arterials/collectors, centre-line details and road fetch/render/coverage telemetry stay together in the manager.
- The adapter computes road bounds from its existing camera helpers and supplies callbacks for active-viewer validation, layer visibility and performance telemetry.
- Feature picking asks the manager for the datasource and selected road record. Existing road-selection subscriptions remain in the adapter.

## Lifecycle and safety

1. A request for a covered viewport reuses rendered geometry and cancels an obsolete in-flight request for another viewport.
2. A new viewport request cancels the prior request; the existing roads remain visible until the replacement request is safe to stage.
3. After asynchronous fetch/datasource insertion, the manager verifies that its request is still current and that the adapter's viewer callback remains active.
4. Turning the roads layer off hides the datasource and aborts outstanding work. Destroy clears request state, the entity index and coverage state.
5. RoadLayerManager is constructed without capturing a viewer, so an old viewer is not retained across map teardown/reinitialization.

## Verification

Run: npm run test:road-layer-manager

The CI job also runs the existing road request policy, road-network normalization, map telemetry, map optimization, browser map tests, and the production build. The boundary test checks module ownership and stale-request guards; it does not claim live Overpass latency or FPS improvement.
