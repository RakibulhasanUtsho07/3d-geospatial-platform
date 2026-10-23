import { createBuildingFacadeTexture } from "../buildings/building-style";
import type { BuildingVisualStyle } from "../buildings/building-style";

const WALL_OUTLINE_COLOR = "#526575";
const ROOF_OUTLINE_COLOR = "#586978";

export type BuildingHeightInfo = {
  meters: number;
  baseHeight: number;
  source:
    | "overture-height"
    | "floor-estimate"
    | "fallback-estimate"
    | "reference-reported-height"
    | "reference-reported-floors";
  unclampedMeters: number;
  heightWasClamped: boolean;
  unclampedBaseHeight: number;
  baseHeightWasClamped: boolean;
};

type BuildingPolygonLodStyleCache = {
  lightweightHeight: import("cesium").ConstantProperty;
  lightweightExtrudedHeight: import("cesium").ConstantProperty;
  detailedHeight: import("cesium").ConstantProperty | null;
  perPositionHeight: import("cesium").ConstantProperty;
  lightweightMaterial: import("cesium").MaterialProperty;
  detailedRoofMaterial: import("cesium").MaterialProperty | null;
  outline: import("cesium").ConstantProperty;
  wallOutlineColor: import("cesium").ConstantProperty;
  roofOutlineColor: import("cesium").ConstantProperty | null;
  closeTop: import("cesium").ConstantProperty;
  closeBottom: import("cesium").ConstantProperty;
};

export type BuildingLodRecord = {
  entity: import("cesium").Entity;
  heightInfo: BuildingHeightInfo;
  sourceHeightInfo: BuildingHeightInfo;
  baseHeight: number;
  topHeight: number;
  visualStyle: BuildingVisualStyle;
  /** Baseline render style, which may be an explicitly saved research profile. */
  baseVisualStyle: BuildingVisualStyle;
  /** Source metadata-driven style to return to when a saved assignment is removed. */
  sourceVisualStyle: BuildingVisualStyle;
  wallPositions: import("cesium").Cartesian3[] | null;
  center: import("cesium").Cartesian3 | null;
  isPart: boolean;
  isDetailed: boolean;
  polygonStyleCache: BuildingPolygonLodStyleCache | null;
  detailedWall: import("cesium").WallGraphics | null;
  roofEquipmentBox: import("cesium").BoxGraphics | null;
  roofEquipmentPosition: import("cesium").ConstantPositionProperty | null;
};

export type LodGraphicsCacheMetrics = {
  polygonStyleCachesCreated: number;
  detailedWallsCreated: number;
  detailedWallCacheHits: number;
  roofEquipmentCreated: number;
  roofEquipmentCacheHits: number;
};

type CesiumModule = typeof import("cesium");
type CesiumCartesian2 = import("cesium").Cartesian2;
type CesiumCartesian3 = import("cesium").Cartesian3;
type CesiumEntity = import("cesium").Entity;

type BuildingLodRendererDependencies = {
  isSelected: (entity: CesiumEntity) => boolean;
  prepareSelectedBuildingForLodTransition: (record: BuildingLodRecord) => void;
  applySelectionHighlight: (entity: CesiumEntity, Cesium: CesiumModule) => void;
};

function emptyMetrics(): LodGraphicsCacheMetrics {
  return {
    polygonStyleCachesCreated: 0,
    detailedWallsCreated: 0,
    detailedWallCacheHits: 0,
    roofEquipmentCreated: 0,
    roofEquipmentCacheHits: 0,
  };
}

/**
 * Owns cached Cesium facade/roof graphics and the transitions between
 * lightweight extrusion and detailed facade rendering. Selection/highlight
 * state remains adapter-owned and is injected through narrow callbacks.
 */
export class BuildingLodRenderer {
  private metrics: LodGraphicsCacheMetrics = emptyMetrics();

  constructor(private readonly dependencies: BuildingLodRendererDependencies) {}

  resetMetrics(): void {
    this.metrics = emptyMetrics();
  }

  getMetrics(): LodGraphicsCacheMetrics {
    return { ...this.metrics };
  }

  private getBuildingPolygonLodStyleCache(
    record: BuildingLodRecord,
    Cesium: CesiumModule,
  ): BuildingPolygonLodStyleCache {
    if (record.polygonStyleCache) {
      return record.polygonStyleCache;
    }
  
    const facadeColor =
      Cesium.Color.fromCssColorString(record.visualStyle.facadeColor) ??
      Cesium.Color.LIGHTGRAY;
  
    record.polygonStyleCache = {
      lightweightHeight: new Cesium.ConstantProperty(record.baseHeight),
      lightweightExtrudedHeight: new Cesium.ConstantProperty(record.topHeight),
      detailedHeight: null,
      perPositionHeight: new Cesium.ConstantProperty(false),
      lightweightMaterial: new Cesium.ColorMaterialProperty(facadeColor),
      detailedRoofMaterial: null,
      outline: new Cesium.ConstantProperty(true),
      wallOutlineColor: new Cesium.ConstantProperty(
        Cesium.Color.fromCssColorString(WALL_OUTLINE_COLOR),
      ),
      roofOutlineColor: null,
      closeTop: new Cesium.ConstantProperty(true),
      closeBottom: new Cesium.ConstantProperty(true),
    };
  
    this.metrics.polygonStyleCachesCreated += 1;
    return record.polygonStyleCache;
  }

  applyLightweightBuildingStyle(
    record: BuildingLodRecord,
    Cesium: CesiumModule,
  ): void {
    const entity = record.entity;
    const polygon = entity.polygon;
  
    if (!polygon) {
      return;
    }
  
    this.dependencies.prepareSelectedBuildingForLodTransition(record);
  
    // Keep expensive detailed graphics cached on the record while detached.
    entity.wall = undefined;
    entity.box = undefined;
    entity.position = undefined;
  
    const styleCache = this.getBuildingPolygonLodStyleCache(record, Cesium);
    polygon.height = styleCache.lightweightHeight;
    polygon.extrudedHeight = styleCache.lightweightExtrudedHeight;
    polygon.perPositionHeight = styleCache.perPositionHeight;
    polygon.material = styleCache.lightweightMaterial;
    polygon.outline = styleCache.outline;
    polygon.outlineColor = styleCache.wallOutlineColor;
    polygon.closeTop = styleCache.closeTop;
    polygon.closeBottom = styleCache.closeBottom;
  
    record.isDetailed = false;
    this.dependencies.applySelectionHighlight(entity, Cesium);
  }

  applyDetailedBuildingStyle(
    record: BuildingLodRecord,
    Cesium: CesiumModule,
  ): void {
    const entity = record.entity;
    const polygon = entity.polygon;
    const wallPositions = record.wallPositions;
  
    if (!polygon || !wallPositions || wallPositions.length < 4) {
      this.applyLightweightBuildingStyle(record, Cesium);
      return;
    }
  
    this.dependencies.prepareSelectedBuildingForLodTransition(record);
  
    // Full-height multi-floor textures are expensive. Keep saved profiles
    // lightweight while not selected; render ground/upper-floor separation
    // only for the actively selected building.
    const renderStyle = this.dependencies.isSelected(record.entity)
      ? record.visualStyle
      : { ...record.visualStyle, fullHeightTexture: false };
  
    if (!record.detailedWall) {
      const facadeTexture = createBuildingFacadeTexture(
        renderStyle,
        record.heightInfo.meters,
      );
      if (!facadeTexture) {
        this.applyLightweightBuildingStyle(record, Cesium);
        return;
      }
  
      record.detailedWall = new Cesium.WallGraphics({
        positions: wallPositions,
        minimumHeights: wallPositions.map(() => record.baseHeight),
        maximumHeights: wallPositions.map(() => record.topHeight),
        fill: new Cesium.ConstantProperty(true),
        outline: new Cesium.ConstantProperty(false),
        material: new Cesium.ImageMaterialProperty({
          image: facadeTexture,
          repeat: this.getFacadeRepeat(
            wallPositions,
            record.heightInfo.meters,
            Cesium,
            renderStyle.repeatWidthMeters,
            renderStyle.fullHeightTexture === true,
          ),
          // The canvas already carries the palette; avoid tinting its glass.
          color: Cesium.Color.WHITE,
          transparent: false,
        }),
      });
      this.metrics.detailedWallsCreated += 1;
    } else {
      this.metrics.detailedWallCacheHits += 1;
    }
  
    entity.wall = record.detailedWall;
  
    const styleCache = this.getBuildingPolygonLodStyleCache(record, Cesium);
    styleCache.detailedHeight ??= new Cesium.ConstantProperty(record.topHeight);
    styleCache.detailedRoofMaterial ??= new Cesium.ColorMaterialProperty(
      Cesium.Color.fromCssColorString(record.visualStyle.roofColor) ??
        Cesium.Color.GRAY,
    );
    styleCache.roofOutlineColor ??= new Cesium.ConstantProperty(
      Cesium.Color.fromCssColorString(ROOF_OUTLINE_COLOR),
    );
  
    polygon.height = styleCache.detailedHeight;
    polygon.extrudedHeight = undefined;
    polygon.perPositionHeight = styleCache.perPositionHeight;
    polygon.material = styleCache.detailedRoofMaterial;
    polygon.outline = styleCache.outline;
    polygon.outlineColor = styleCache.roofOutlineColor;
    polygon.closeTop = styleCache.closeTop;
    polygon.closeBottom = styleCache.closeBottom;
  
    // Sparse rooftop shapes are illustrative, not verified roof assets.
    entity.box = undefined;
    entity.position = undefined;
  
    const isRoofGarden = record.visualStyle.roofDetail === "roof-garden";
    const isRoofTerrace = record.visualStyle.roofDetail === "roof-terrace";
    const shouldShowRoofEquipment =
      isRoofGarden ||
      isRoofTerrace ||
      (record.visualStyle.roofDetail !== "none" &&
        (this.hashEntityId(entity.id) % 5 === 0 || record.isPart));
  
    if (shouldShowRoofEquipment) {
      if (!record.roofEquipmentBox || !record.roofEquipmentPosition) {
        const centerCartographic = Cesium.Cartographic.fromCartesian(
          record.center ?? wallPositions[0],
        );
        const roofRadius = record.center
          ? Cesium.Cartesian3.distance(record.center, wallPositions[0])
          : 4;
        const equipmentHeight = isRoofGarden ? 0.22
          : isRoofTerrace ? 0.12
            : record.visualStyle.roofDetail === "water-tank" ? 1.8 : 1.2;
        const equipmentWidth = isRoofGarden || isRoofTerrace
          ? Math.max(4, Math.min(18, roofRadius * 1.25))
          : record.visualStyle.roofDetail === "water-tank" ? 1.6 : 2.4;
        const roofPosition = Cesium.Cartesian3.fromRadians(
          centerCartographic.longitude,
          centerCartographic.latitude,
          record.topHeight + equipmentHeight / 2,
        );
  
        record.roofEquipmentPosition =
          new Cesium.ConstantPositionProperty(roofPosition);
        record.roofEquipmentBox = new Cesium.BoxGraphics({
          dimensions: new Cesium.Cartesian3(
            equipmentWidth,
            equipmentWidth,
            equipmentHeight,
          ),
          material:
            Cesium.Color.fromCssColorString(
              isRoofGarden
                ? "#47744D"
                : isRoofTerrace
                  ? "#B5B0A5"
                  : record.visualStyle.roofDetail === "water-tank"
                    ? "#657b89"
                    : "#aeb8bf",
            ) ?? Cesium.Color.GRAY,
          outline: new Cesium.ConstantProperty(true),
          outlineColor: new Cesium.ConstantProperty(
            Cesium.Color.fromCssColorString("#4d5b64") ??
              Cesium.Color.DARKGRAY,
          ),
        });
        this.metrics.roofEquipmentCreated += 1;
      } else {
        this.metrics.roofEquipmentCacheHits += 1;
      }
  
      entity.position = record.roofEquipmentPosition;
      entity.box = record.roofEquipmentBox;
    }
  
    record.isDetailed = true;
    this.dependencies.applySelectionHighlight(entity, Cesium);
  }

  private hashEntityId(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return hash;
  }

  private getFacadeRepeat(
    positions: CesiumCartesian3[],
    height: number,
    Cesium: CesiumModule,
    repeatWidthMeters = 6,
    fullHeightTexture = false,
  ): CesiumCartesian2 {
    let perimeter = 0;
  
    for (
      let index = 1;
      index < positions.length;
      index += 1
    ) {
      perimeter += Cesium.Cartesian3.distance(
        positions[index - 1],
        positions[index],
      );
    }
  
    return new Cesium.Cartesian2(
      Math.min(64, Math.max(1, perimeter / repeatWidthMeters)),
      fullHeightTexture && height <= 90
        ? 1
        : Math.min(80, Math.max(1, height / 3)),
    );
  }
}
