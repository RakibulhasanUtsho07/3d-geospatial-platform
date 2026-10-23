/**
 * Owns the material snapshot lifecycle for selected-building highlighting.
 * The adapter remains the source of truth for the active selected entity.
 */
export class BuildingSelectionMaterialController {
  constructor(isSelected) {
    this.isSelected = isSelected;
    this.originalPolygonMaterial = null;
    this.originalWallMaterial = null;
    this.originalMaterialEntity = null;
  }

  prepareSelectedBuildingForLodTransition(record) {
    const entity = record.entity;
    if (!this.isSelected(entity)) return;

    // A stale snapshot must never be applied to a different entity.
    if (
      this.originalMaterialEntity !== null &&
      this.originalMaterialEntity !== entity
    ) {
      this.restoreSelectedBuilding(this.originalMaterialEntity);
      return;
    }

    const snapshotEntity = this.originalMaterialEntity ?? entity;
    const originalPolygonMaterial = this.originalPolygonMaterial;
    const originalWallMaterial = this.originalWallMaterial;

    // Detailed walls may be detached during an LOD transition.
    if (this.originalMaterialEntity === entity && snapshotEntity.polygon) {
      snapshotEntity.polygon.material = originalPolygonMaterial;
    }

    if (originalWallMaterial !== null) {
      if (snapshotEntity.wall) {
        snapshotEntity.wall.material = originalWallMaterial;
      }
      if (record.detailedWall) {
        record.detailedWall.material = originalWallMaterial;
      }
    }

    this.clearSnapshots();
  }

  applySelectionHighlight(entity, Cesium) {
    if (!this.isSelected(entity) || !entity.polygon) return;

    // If a caller missed the normal restore-before-selection-change sequence,
    // first restore the actual snapshot owner rather than tinting over a tint.
    if (this.originalMaterialEntity === entity) return;
    if (this.originalMaterialEntity !== null) {
      this.restoreSelectedBuilding(this.originalMaterialEntity);
    }

    this.originalMaterialEntity = entity;
    this.originalPolygonMaterial = entity.polygon.material;
    this.originalWallMaterial = null;

    // Keep facade material untouched so reviewed textures remain visible.
    entity.polygon.material = new Cesium.ColorMaterialProperty(
      Cesium.Color.CYAN.withAlpha(0.42),
    );
  }

  restoreSelectedBuilding(building) {
    // The captured owner is authoritative if selection changed unexpectedly.
    const snapshotEntity = this.originalMaterialEntity ?? building;

    if (snapshotEntity?.polygon && this.originalMaterialEntity !== null) {
      snapshotEntity.polygon.material = this.originalPolygonMaterial;
    }

    if (snapshotEntity?.wall && this.originalWallMaterial !== null) {
      snapshotEntity.wall.material = this.originalWallMaterial;
    }

    this.clearSnapshots();
  }

  clearSnapshots() {
    this.originalPolygonMaterial = null;
    this.originalWallMaterial = null;
    this.originalMaterialEntity = null;
  }
}
