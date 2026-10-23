import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterUrl = new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url);
const controllerUrl = new URL("../src/core/map-engine/building-selection-material-controller.ts", import.meta.url);
const [adapter, controller] = await Promise.all([
  readFile(adapterUrl, "utf8"),
  readFile(controllerUrl, "utf8"),
]);

test("CesiumAdapter delegates selected-building material snapshots and highlighting", () => {
  assert.match(adapter, /new BuildingSelectionMaterialController\(/);
  assert.match(adapter, /buildingSelectionMaterials\.prepareSelectedBuildingForLodTransition\(record\)/);
  assert.match(adapter, /buildingSelectionMaterials\.applySelectionHighlight\(entity, Cesium\)/);
  assert.match(adapter, /buildingSelectionMaterials\.restoreSelectedBuilding\(building\)/);

  for (const method of [
    "prepareSelectedBuildingForLodTransition",
    "applySelectionHighlight",
  ]) {
    assert.doesNotMatch(
      adapter,
      new RegExp("private\\s+" + method + "\\s*\\("),
      "adapter must not implement " + method,
    );
  }

  assert.doesNotMatch(adapter, /selectedBuildingOriginalMaterial/);
  assert.doesNotMatch(adapter, /selectedBuildingOriginalWallMaterial/);
});

test("material controller preserves one-time snapshot, selected-only highlight and restore contracts", () => {
  for (const contract of [
    "this.originalPolygonMaterial: CesiumMaterialProperty | null = null",
    "this.originalWallMaterial: CesiumMaterialProperty | null = null",
    "if (!this.isSelected(entity)) return",
    "this.originalPolygonMaterial !== null",
    "this.originalPolygonMaterial = entity.polygon.material",
    "this.originalWallMaterial = null",
    "Cesium.Color.CYAN.withAlpha(0.42)",
    "record.detailedWall.material = originalWallMaterial",
    "building.polygon.material = originalPolygonMaterial",
    "this.clearSnapshots()",
  ]) {
    assert.ok(controller.includes(contract), "material controller contract missing: " + contract);
  }
});

test("selection material controller does not own camera, layers, fetching or LOD choice", () => {
  assert.doesNotMatch(controller, /fetch\(/);
  assert.doesNotMatch(controller, /MAP_LAYER_IDS/);
  assert.doesNotMatch(controller, /requestRender/);
  assert.doesNotMatch(controller, /selectDetailedBuildingRecords/);
  assert.doesNotMatch(controller, /handleCameraMoveEnd/);
});
