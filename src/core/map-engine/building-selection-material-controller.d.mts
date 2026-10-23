import type { BuildingLodRecord } from "./building-lod-renderer";

type CesiumModule = typeof import("cesium");
type CesiumEntity = import("cesium").Entity;
type CesiumMaterialProperty = import("cesium").MaterialProperty;

/** Owns highlight material snapshots; does not own selection identity or LOD. */
export declare class BuildingSelectionMaterialController {
  private readonly isSelected: (entity: CesiumEntity) => boolean;
  private originalPolygonMaterial: CesiumMaterialProperty | null;
  private originalWallMaterial: CesiumMaterialProperty | null;
  private originalMaterialEntity: CesiumEntity | null;

  constructor(isSelected: (entity: CesiumEntity) => boolean);

  prepareSelectedBuildingForLodTransition(record: BuildingLodRecord): void;
  applySelectionHighlight(entity: CesiumEntity, Cesium: CesiumModule): void;
  restoreSelectedBuilding(building: CesiumEntity | null): void;
  clearSnapshots(): void;
}
