# Feature picking controller

`FeaturePickingController` owns the lifecycle of the Cesium left-click handler:
attaching it to the map canvas, replacing an existing handler, and destroying it
during adapter teardown. It rejects callbacks after its handler was replaced,
after teardown, or while the owning viewer is no longer active.

The controller does not know about data sources, pick priority, selected
entities, feature metadata, panel state, or rendering. The `CesiumAdapter`
continues to own those responsibilities through its pick callback. The current
viewer guard is passed in as a predicate so delayed events from an old Cesium
viewer cannot mutate the new map instance.

Run `npm run test:feature-picking-controller` for lifecycle and stale-callback
regressions. The existing Playwright map-browser suite continues to verify the
real Cesium building/road selection lifecycle.
