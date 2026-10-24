import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterUrl = new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url);
const rendererUrl = new URL("../src/core/map-engine/building-lod-renderer.ts", import.meta.url);

const [adapter, renderer] = await Promise.all([
  readFile(adapterUrl, "utf8"),
  readFile(rendererUrl, "utf8"),
]);

test("CesiumAdapter delegates building facade graphics transitions to BuildingLodRenderer", () => {
  assert.match(adapter, /new BuildingLodRenderer\(/);
  assert.match(adapter, /this\.buildingLodRenderer\.applyDetailedBuildingStyle\(/);
  assert.match(adapter, /this\.buildingLodRenderer\.applyLightweightBuildingStyle\(/);
  assert.match(adapter, /this\.buildingLodRenderer\.resetMetrics\(/);
  assert.match(adapter, /this\.buildingLodRenderer\.getMetrics\(\)/);

  for (const method of [
    "getBuildingPolygonLodStyleCache",
    "applyLightweightBuildingStyle",
    "applyDetailedBuildingStyle",
    "getFacadeRepeat",
    "hashEntityId",
  ]) {
    assert.doesNotMatch(
      adapter,
      new RegExp("private\\s+" + method + "\\s*\\("),
      "adapter must not own renderer method " + method,
    );
  }
});

test("renderer owns facade materials, wall/roof graphics and bounded cache telemetry", () => {
  for (const contract of [
    "createBuildingFacadeTexture",
    "new Cesium.ConstantProperty(record.baseHeight)",
    "new Cesium.WallGraphics",
    "new Cesium.BoxGraphics",
    "this.metrics.detailedWallCacheHits",
    "this.metrics.roofEquipmentCacheHits",
    "resetMetrics(): void",
    "getMetrics(): LodGraphicsCacheMetrics",
    "this.dependencies.prepareSelectedBuildingForLodTransition(record)",
    "this.dependencies.applySelectionHighlight(entity, Cesium)",
  ]) {
    assert.ok(renderer.includes(contract), "renderer contract missing: " + contract);
  }

  assert.match(renderer, /if \(!polygon \|\| !wallPositions \|\| wallPositions\.length < 4\)/);
  assert.match(renderer, /if \(!facadeTexture\)/);
  assert.match(renderer, /fullHeightTexture: false/);
  assert.match(renderer, /this\.dependencies\.isSelected\(record\.entity\)/);
});

test("renderer does not own datasource fetching, camera scheduling or layer visibility", () => {
  assert.doesNotMatch(renderer, /fetch\(/);
  assert.doesNotMatch(renderer, /Viewer/);
  assert.doesNotMatch(renderer, /requestAnimationFrame/);
  assert.doesNotMatch(renderer, /MAP_LAYER_IDS/);
});
