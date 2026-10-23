import type { BuildingLodRecord } from "./building-lod-renderer";

type CesiumModule = typeof import("cesium");
type CesiumEntity = import("cesium").Entity;
type CesiumMaterialProperty = import("cesium").MaterialProperty;

/**
 * Owns the original material snapshots used by the selected-building highlight.
 * The adapter remains the source of truth for which entity is selected.
 */
export class BuildingSelectionMaterialController {
  private originalPolygonMaterial: CesiumMaterialProperty | null = null;
  private originalWallMaterial: CesiumMaterialProperty | null = null;

  constructor(
    private readonly isSelected: (entity: CesiumEntity) => boolean,
  ) {}

  prepareSelectedBuildingForLodTransition(record: BuildingLodRecord): void {
    const entity = record.entity;
    if (!this.isSelected(entity)) return;

    const originalPolygonMaterial = this.originalPolygonMaterial;
    const originalWallMaterial = this.originalWallMaterial;

    // Detailed walls are cached separately and may be detached during LOD changes.
    if (originalPolygonMaterial !== null && entity.polygon) {
      entity.polygon.material = originalPolygonMaterial;
    }

    if (originalWallMaterial !== null) {
      if (entity.wall) {
        entity.wall.material = originalWallMaterial;
      }
      if (record.detailedWall) {
        record.detailedWall.material = originalWallMaterial;
      }
    }

    this.clearSnapshots();
  }

  applySelectionHighlight(
    entity: CesiumEntity,
    Cesium: CesiumModule,
  ): void {
    if (
      !this.isSelected(entity) ||
      !entity.polygon ||
      this.originalPolygonMaterial !== null
    ) {
      return;
    }

    // Capture the unhighlighted roof material only once per selection/transition.
    // Do not tint the facade wall; researched textures must remain visible.
    this.originalPolygonMaterial = entity.polygon.material;
    this.originalWallMaterial = null;
    entity.polygon.material = new Cesium.ColorMaterialProperty(
      Cesium.Color.CYAN.withAlpha(0.42),
    );
  }

  restoreSelectedBuilding(building: CesiumEntity | null): void {
    const originalPolygonMaterial = this.originalPolygonMaterial;
    const originalWallMaterial = this.originalWallMaterial;

    if (building?.polygon && originalPolygonMaterial !== null) {
      building.polygon.material = originalPolygonMaterial;
    }

    if (building?.wall && originalWallMaterial !== null) {
      building.wall.material = originalWallMaterial;
    }

    this.clearSnapshots();
  }

  private clearSnapshots(): void {
    this.originalPolygonMaterial = null;
    this.originalWallMaterial = null;
  }
}
