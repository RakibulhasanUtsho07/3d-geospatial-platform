import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterUrl = new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url);
const managerUrl = new URL("../src/core/map-engine/road-layer-manager.ts", import.meta.url);

const [adapter, manager] = await Promise.all([
  readFile(adapterUrl, "utf8"),
  readFile(managerUrl, "utf8"),
]);

test("CesiumAdapter delegates road request and render ownership to RoadLayerManager", () => {
  assert.match(adapter, /private readonly roadLayerManager = new RoadLayerManager\(\)/);
  assert.match(adapter, /return this\.roadLayerManager\.load\(viewer, Cesium/);
  assert.match(adapter, /this\.roadLayerManager\.setVisible\(visible\)/);
  assert.match(adapter, /this\.roadLayerManager\.destroy\(\)/);
  assert.match(adapter, /this\.roadLayerManager\.getDataSource\(\)/);
  assert.match(adapter, /this\.roadLayerManager\.getRoadByEntityId\(roadEntity\.id\)/);

  for (const field of [
    "roadNetworkDataSource",
    "roadByEntityId",
    "roadRequestAbortController",
    "activeRoadRequestKey",
    "loadedRoadBounds",
  ]) {
    assert.doesNotMatch(adapter, new RegExp("private[^\\n]*" + field));
    assert.doesNotMatch(adapter, new RegExp("this\\." + field));
  }

  assert.doesNotMatch(adapter, /private async loadRoadNetwork\(/);
});

test("RoadLayerManager owns cache, cancellation, rendering and request telemetry", () => {
  for (const contract of [
    "loadedRoadBounds",
    "roadRequestAbortController",
    "activeRoadRequestKey",
    "shouldCancelRoadRequestForCachedViewport",
    "AbortSignal.timeout(25_000)",
    "flattenRoadCoordinates",
    "resolveRoadVisualStyle",
    '"roads.fetch"',
    '"roads.render"',
    '"roads.coverage"',
  ]) {
    assert.ok(manager.includes(contract), "manager contract missing: " + contract);
  }
  assert.match(manager, /dependencies\.isViewerActive\(\)/);
  assert.match(manager, /this\.roadRequestAbortController === controller/);
});

test("road lifecycle APIs abort stale work and clear per-viewport state", () => {
  assert.match(manager, /setVisible\(visible: boolean\)[\s\S]*?if \(!visible\) this\.cancelPendingRequest\(\)/);
  assert.match(manager, /cancelPendingRequest\(\): void[\s\S]*?this\.roadRequestAbortController\?\.abort\(\)/);
  assert.match(manager, /destroy\(\): void[\s\S]*?this\.roadByEntityId\.clear\(\)[\s\S]*?this\.loadedRoadBounds = null/);
});
