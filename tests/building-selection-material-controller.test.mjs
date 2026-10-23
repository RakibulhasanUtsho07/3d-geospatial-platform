import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterUrl = new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url);
const controllerUrl = new URL("../src/core/map-engine/building-selection-material-controller.mjs", import.meta.url);
const [adapter, controllerSource] = await Promise.all([
  readFile(adapterUrl, "utf8"),
  readFile(controllerUrl, "utf8"),
]);
const { BuildingSelectionMaterialController } = await import(
  "../src/core/map-engine/building-selection-material-controller.mjs"
);

class FakeColorMaterialProperty {
  constructor(color) {
    this.color = color;
  }
}

function createFakeCesium() {
  return {
    Color: {
      CYAN: {
        withAlpha(alpha) {
          return { kind: "cyan", alpha };
        },
      },
    },
    ColorMaterialProperty: FakeColorMaterialProperty,
  };
}

function createEntity(id, { polygon = true, wall = true } = {}) {
  const entity = { id };
  if (polygon) entity.polygon = { material: { kind: "roof-base", id } };
  if (wall) entity.wall = { material: { kind: "wall-base", id } };
  return entity;
}

test("highlight snapshots the original polygon material once and restore is idempotent", () => {
  const Cesium = createFakeCesium();
  const entity = createEntity("building-a");
  const originalRoof = entity.polygon.material;
  const originalWall = entity.wall.material;
  const controller = new BuildingSelectionMaterialController(
    (candidate) => candidate === entity,
  );

  controller.applySelectionHighlight(entity, Cesium);
  const firstHighlight = entity.polygon.material;

  assert.ok(firstHighlight instanceof FakeColorMaterialProperty);
  assert.deepEqual(firstHighlight.color, { kind: "cyan", alpha: 0.42 });
  assert.strictEqual(entity.wall.material, originalWall);

  controller.applySelectionHighlight(entity, Cesium);
  assert.strictEqual(
    entity.polygon.material,
    firstHighlight,
    "a repeated highlight must not snapshot the cyan material as the base",
  );

  controller.restoreSelectedBuilding(entity);
  assert.strictEqual(entity.polygon.material, originalRoof);
  assert.strictEqual(entity.wall.material, originalWall);

  controller.restoreSelectedBuilding(entity);
  assert.strictEqual(entity.polygon.material, originalRoof);
});

test("unselected entities and entities without polygon graphics are left untouched", () => {
  const Cesium = createFakeCesium();
  const selected = createEntity("selected");
  const unselected = createEntity("unselected");
  const noPolygon = createEntity("no-polygon", { polygon: false });
  const unselectedBase = unselected.polygon.material;
  const controller = new BuildingSelectionMaterialController(
    (candidate) => candidate === selected || candidate === noPolygon,
  );

  controller.applySelectionHighlight(unselected, Cesium);
  assert.strictEqual(unselected.polygon.material, unselectedBase);

  assert.doesNotThrow(() => controller.applySelectionHighlight(noPolygon, Cesium));
  controller.applySelectionHighlight(selected, Cesium);
  assert.ok(selected.polygon.material instanceof FakeColorMaterialProperty);
});

test("a stale snapshot owner is restored before a newly selected entity is highlighted", () => {
  const Cesium = createFakeCesium();
  const first = createEntity("first");
  const second = createEntity("second");
  const firstBase = first.polygon.material;
  const secondBase = second.polygon.material;
  let selected = first;
  const controller = new BuildingSelectionMaterialController(
    (candidate) => candidate === selected,
  );

  controller.applySelectionHighlight(first, Cesium);
  assert.ok(first.polygon.material instanceof FakeColorMaterialProperty);

  // Defensive path: an upstream caller changed selection without restoring first.
  selected = second;
  controller.applySelectionHighlight(second, Cesium);

  assert.strictEqual(first.polygon.material, firstBase);
  assert.ok(second.polygon.material instanceof FakeColorMaterialProperty);

  // Restore must follow the actual snapshot owner rather than a stale argument.
  controller.restoreSelectedBuilding(first);
  assert.strictEqual(second.polygon.material, secondBase);
});

test("selected LOD transition restores the old material and permits a fresh snapshot", () => {
  const Cesium = createFakeCesium();
  const entity = createEntity("lod-building");
  const originalRoof = entity.polygon.material;
  const originalWall = entity.wall.material;
  const detailedWall = { material: { kind: "detailed-wall-base" } };
  const detailedWallBase = detailedWall.material;
  const controller = new BuildingSelectionMaterialController(
    (candidate) => candidate === entity,
  );

  controller.applySelectionHighlight(entity, Cesium);
  controller.prepareSelectedBuildingForLodTransition({ entity, detailedWall });

  assert.strictEqual(entity.polygon.material, originalRoof);
  assert.strictEqual(entity.wall.material, originalWall);
  assert.strictEqual(detailedWall.material, detailedWallBase);

  // A fresh LOD may install a different base material before highlighting again.
  const nextLodBase = { kind: "next-lod-roof-base" };
  entity.polygon.material = nextLodBase;
  controller.applySelectionHighlight(entity, Cesium);
  assert.ok(entity.polygon.material instanceof FakeColorMaterialProperty);
  controller.restoreSelectedBuilding(entity);
  assert.strictEqual(entity.polygon.material, nextLodBase);
});

test("LOD transition for a non-selected record does not clear the active highlight", () => {
  const Cesium = createFakeCesium();
  const selected = createEntity("selected-lod");
  const other = createEntity("other-lod");
  const selectedBase = selected.polygon.material;
  const controller = new BuildingSelectionMaterialController(
    (candidate) => candidate === selected,
  );

  controller.applySelectionHighlight(selected, Cesium);
  const activeHighlight = selected.polygon.material;

  controller.prepareSelectedBuildingForLodTransition({
    entity: other,
    detailedWall: { material: { kind: "other-wall" } },
  });

  assert.strictEqual(selected.polygon.material, activeHighlight);
  controller.prepareSelectedBuildingForLodTransition({ entity: selected });
  assert.strictEqual(selected.polygon.material, selectedBase);
});

test("adapter delegates material work while retaining entity-selection ownership", () => {
  assert.match(adapter, /from "\.\/building-selection-material-controller\.mjs"/);
  assert.match(adapter, /new BuildingSelectionMaterialController\(/);
  assert.match(adapter, /buildingSelectionMaterials\.prepareSelectedBuildingForLodTransition\(record\)/);
  assert.match(adapter, /buildingSelectionMaterials\.applySelectionHighlight\(entity, Cesium\)/);
  assert.match(adapter, /buildingSelectionMaterials\.restoreSelectedBuilding\(building\)/);
  assert.doesNotMatch(adapter, /private\s+prepareSelectedBuildingForLodTransition\s*\(/);
  assert.doesNotMatch(adapter, /private\s+applySelectionHighlight\s*\(/);
  assert.doesNotMatch(adapter, /selectedBuildingOriginalMaterial/);
  assert.doesNotMatch(adapter, /selectedBuildingOriginalWallMaterial/);
});

test("selection clear restores highlight before emitting clear events and recomputing LOD", () => {
  const start = adapter.indexOf("clearFeatureSelection(): void {");
  const end = adapter.indexOf("private getEntityFromPick(", start);
  assert.ok(start >= 0 && end > start, "selection clear method should be present");
  const method = adapter.slice(start, end);

  const restore = method.indexOf("this.restoreSelectedBuilding();");
  const emitClear = method.indexOf("this.emitFeatureSelection(null);");
  const refreshLod = method.indexOf("this.updateBuildingLod(");
  assert.ok(restore >= 0 && emitClear > restore);
  assert.ok(refreshLod > emitClear);
});

test("preview and assignment reset restore selection before invalidating cached geometry", () => {
  const previewStart = adapter.indexOf(
    "previewSelectedBuildingStyle(style: BuildingVisualStyle | null): boolean {",
  );
  const previewEnd = adapter.indexOf("clearFeatureSelection(): void {", previewStart);
  assert.ok(previewStart >= 0 && previewEnd > previewStart);
  const preview = adapter.slice(previewStart, previewEnd);
  assert.ok(preview.indexOf("this.restoreSelectedBuilding();") < preview.indexOf("record.visualStyle = style ?? record.baseVisualStyle;"));
  assert.ok(preview.indexOf("this.selectedBuilding = record.entity;") < preview.indexOf("this.buildingLodRenderer.applyDetailedBuildingStyle"));
  const previewRenderEnd = preview.indexOf("viewer.scene.requestRender();");
  assert.ok(
    preview.indexOf("this.buildingSelectionMaterials.applySelectionHighlight(record.entity, Cesium);") > preview.indexOf("this.buildingLodRenderer.applyLightweightBuildingStyle"),
    "preview must reapply selection highlight after refreshing the base/preview roof material",
  );
  assert.ok(previewRenderEnd > preview.indexOf("this.buildingSelectionMaterials.applySelectionHighlight(record.entity, Cesium);"));

  const assignmentStart = adapter.indexOf("setBuildingStyleAssignments(assignments: BuildingStyleAssignment[]): void {");
  const assignmentEnd = adapter.indexOf("previewSelectedBuildingStyle(", assignmentStart);
  assert.ok(assignmentStart >= 0 && assignmentEnd > assignmentStart);
  const assignments = adapter.slice(assignmentStart, assignmentEnd);
  assert.ok(assignments.indexOf("const selectedEntity = this.selectedBuilding;") < assignments.indexOf("this.restoreSelectedBuilding();"));
  assert.ok(assignments.indexOf("this.restoreSelectedBuilding();") < assignments.indexOf("this.selectedBuilding = selectedEntity;"));
});

test("viewport data-source replacement clears selected material state before swapping entities", () => {
  // The staging/commit transaction may be owned by the adapter directly or
  // delegated to BuildingViewportManager through stageBuildingViewport.
  const stageStart = adapter.indexOf("private async stageBuildingViewport(");
  const loadStart = adapter.indexOf("private async loadOvertureBuildings(");
  const methodStart = stageStart >= 0 ? stageStart : loadStart;
  assert.ok(methodStart >= 0, "viewport staging implementation should exist");

  const methodEnd = adapter.indexOf("\n  private getRoadViewportBounds(", methodStart);
  assert.ok(methodEnd > methodStart, "viewport staging method boundary should exist");
  const viewportStage = adapter.slice(methodStart, methodEnd);
  const restore = viewportStage.indexOf("this.restoreSelectedBuilding();");
  const clearSelection = viewportStage.indexOf("this.selectedBuilding = null;", restore);
  const emitClear = viewportStage.indexOf("this.emitFeatureSelection(null);", clearSelection);
  const swap = viewportStage.indexOf("this.overtureBuildings = dataSource;", emitClear);

  assert.ok(
    restore >= 0 && clearSelection > restore && emitClear > clearSelection && swap > emitClear,
    "viewport staging must restore material, clear selection, emit the clear event, then swap datasources",
  );
  assert.ok(controllerSource.includes("this.originalMaterialEntity"));
  assert.doesNotMatch(controllerSource, /fetch\s*\(/);
  assert.doesNotMatch(controllerSource, /MAP_LAYER_IDS/);
  assert.doesNotMatch(controllerSource, /requestRender/);
  assert.doesNotMatch(controllerSource, /selectDetailedBuildingRecords/);
  assert.doesNotMatch(controllerSource, /handleCameraMoveEnd/);
});
