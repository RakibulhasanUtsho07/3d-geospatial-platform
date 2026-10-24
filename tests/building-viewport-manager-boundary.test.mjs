import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterUrl = new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url);
const managerUrl = new URL("../src/core/map-engine/building-viewport-manager.ts", import.meta.url);

const [adapter, manager] = await Promise.all([
  readFile(adapterUrl, "utf8"),
  readFile(managerUrl, "utf8"),
]);

test("CesiumAdapter delegates building viewport request lifecycle to its manager", () => {
  assert.match(adapter, /private readonly buildingViewportManager = new BuildingViewportManager\(\)/);
  assert.match(adapter, /return this\.buildingViewportManager\.load\(/);
  assert.match(adapter, /this\.buildingViewportManager\.queuePendingViewport\(/);
  assert.match(adapter, /this\.buildingViewportManager\.invalidateLayer\(\)/);
  assert.match(adapter, /this\.buildingViewportManager\.destroy\(\)/);
  assert.match(adapter, /this\.buildingViewportManager\.isViewportCoveredByLoadedData\(/);
  assert.match(adapter, /private async stageBuildingViewport\(/);

  for (const stateField of [
    "viewportLoadToken",
    "activeViewportEndpoint",
    "viewportRequestAbortController",
    "viewportIntentRevision",
    "viewportResponseCache",
    "pendingViewportRequest",
    "loadedViewportBounds",
    "loadedViewportFeatureLimit",
    "hasLoadedBuildings",
    "viewportLoadInProgress",
  ]) {
    assert.doesNotMatch(adapter, new RegExp("private[^\\n]*" + stateField));
    assert.doesNotMatch(adapter, new RegExp("this\\." + stateField));
  }
  assert.doesNotMatch(adapter, /shouldContinueViewportLoad|shouldAbortViewportRequest/);
});

test("manager owns fetch/cache/staging and performance telemetry", () => {
  for (const contract of [
    "getCachedViewportResponse",
    "cacheViewportResponse",
    "shouldContinueViewportLoad",
    "shouldAbortViewportRequest",
    "AbortController",
    "GeoJsonDataSource.load",
    "viewer.dataSources.add(dataSource)",
    "dataSource.show = false",
    "this.responseCache.clear()",
    '"viewport.fetch"',
    '"viewport.stage"',
    "stagedDataSource",
    "requestAbortController",
    "activeEndpoint",
    "intentRevision",
    "pendingRequest",
  ]) {
    assert.ok(manager.includes(contract), "manager contract missing: " + contract);
  }
  assert.ok(manager.indexOf("dataSource.show = false") < manager.indexOf("viewer.dataSources.add(dataSource)"));
  assert.ok(manager.indexOf("viewer.dataSources.add(dataSource)") < manager.indexOf("dependencies.prepareAndCommit"));
});

test("current-request checks guard fetch response, datasource staging and commit", () => {
  const checks = [...manager.matchAll(/this\.isRequestCurrent\(requestRevision, dependencies\)/g)];
  assert.ok(checks.length >= 4, "expected request freshness checks before and after asynchronous boundaries");
  assert.match(manager, /if \(this\.loadToken === loadToken\)[\s\S]*?this\.loadInProgress = false/);
  assert.match(manager, /dependencies\.isCurrentDataSource\(stagedDataSource\)/);
  assert.match(manager, /if \(this\.requestAbortController === requestController\)/);
});

test("coverage state survives failed request and is updated only after commit", () => {
  const commitIndex = manager.indexOf("const committed = await dependencies.prepareAndCommit");
  const loadedIndex = manager.indexOf("this.loadedBounds = requestedBounds", commitIndex);
  assert.ok(commitIndex >= 0 && loadedIndex > commitIndex);
  assert.match(manager, /isViewportCoveredByLoadedData\(/);
  assert.match(manager, /invalidateLayer\(\): void[\s\S]*?this\.intentRevision \+= 1[\s\S]*?this\.pendingRequest = null[\s\S]*?this\.requestAbortController\?\.abort\(\)/);
});
