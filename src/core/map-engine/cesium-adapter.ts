
import {
  createBuildingFacadeTexture,
  resolveBuildingVisualStyle,
} from "../buildings/building-style";
import type { BuildingVisualStyle } from "../buildings/building-style";
import { getViewportFeatureLimit } from "./viewport-budget.mjs";
import { getDetailedFacadeBudget } from "./lod-detail-budget.mjs";
import {
  cacheViewportResponse,
  getCachedViewportResponse,
} from "./viewport-response-cache.mjs";
import { shouldAbortViewportRequest } from "./viewport-load-policy.mjs";

import { calculateFootprintAreaM2 } from "../geospatial/footprint-area.mjs";
import type { NearbyPlace } from "../geospatial/nearby-places.mjs";
import { MAP_LAYER_IDS } from "./types";
import type {
  CameraTarget,
  MapEngine,
  MapEngineCapabilities,
  MapEngineState,
  MapLayer,
  MapLayerId,
  MapFeatureSelection,
} from "./types";

type CesiumModule = typeof import("cesium");
type CesiumViewer = import("cesium").Viewer;
type CesiumEntity = import("cesium").Entity;
type CesiumDataSource = import("cesium").GeoJsonDataSource;
type CesiumMaterialProperty = import("cesium").MaterialProperty;
type CesiumCartesian3 = import("cesium").Cartesian3;
type CesiumCartesian2 = import("cesium").Cartesian2;

type BuildingProperties = Record<string, unknown>;

type BuildingHeight = {
  meters: number;
  baseHeight: number;
  source:
    | "overture-height"
    | "floor-estimate"
    | "fallback-estimate";
};

type BuildingPolygonLodStyleCache = {
  lightweightHeight: import("cesium").ConstantProperty;
  lightweightExtrudedHeight: import("cesium").ConstantProperty;
  detailedHeight: import("cesium").ConstantProperty | null;
  perPositionHeight: import("cesium").ConstantProperty;
  lightweightMaterial: CesiumMaterialProperty;
  detailedRoofMaterial: CesiumMaterialProperty | null;
  outline: import("cesium").ConstantProperty;
  wallOutlineColor: import("cesium").ConstantProperty;
  roofOutlineColor: import("cesium").ConstantProperty | null;
  closeTop: import("cesium").ConstantProperty;
  closeBottom: import("cesium").ConstantProperty;
};

type BuildingLodRecord = {
  entity: CesiumEntity;
  heightInfo: BuildingHeight;
  baseHeight: number;
  topHeight: number;
  visualStyle: BuildingVisualStyle;
  wallPositions: CesiumCartesian3[] | null;
  center: CesiumCartesian3 | null;
  isPart: boolean;
  isDetailed: boolean;
  polygonStyleCache: BuildingPolygonLodStyleCache | null;
  detailedWall: import("cesium").WallGraphics | null;
  roofEquipmentBox: import("cesium").BoxGraphics | null;
  roofEquipmentPosition: import("cesium").ConstantPositionProperty | null;
};

type LodGraphicsCacheMetrics = {
  polygonStyleCachesCreated: number;
  detailedWallsCreated: number;
  detailedWallCacheHits: number;
  roofEquipmentCreated: number;
  roofEquipmentCacheHits: number;
};

type ViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type FeatureSelectionListener = (
  feature: MapFeatureSelection | null,
) => void;

const DHAKA_CAMERA = {
  longitude: 90.41,
  latitude: 23.78,
  height: 950,
  heading: 0,
  pitch: -55,
  roll: 0,
};

const WALL_OUTLINE_COLOR = "#526575";
const ROOF_OUTLINE_COLOR = "#586978";

// Detail budgets adapt to camera altitude to keep distant city views lightweight.
const BATCH_SIZE = 200;
const LOD_ORIGIN_MOVE_THRESHOLD_METERS = 180;
const VIEWPORT_PADDING_FACTOR = 0.4;
const VIEWPORT_MIN_PADDING_DEGREES = 0.004;
const MAX_VIEWPORT_SPAN_DEGREES = 1.8;
const MAX_CACHED_VIEWPORT_RESPONSES = 2;

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export class CesiumAdapter implements MapEngine {
  private viewer: CesiumViewer | null = null;
  private cesium: CesiumModule | null = null;

  private baseImageryLayer:
    | import("cesium").ImageryLayer
    | null = null;

  private overtureBuildings: CesiumDataSource | null = null;
  private nearbyPlacesDataSource: import("cesium").CustomDataSource | null = null;
  private readonly nearbyPlaceByEntityId = new Map<string, NearbyPlace>();
  private readonly placeSelectionListeners = new Set<
    (place: NearbyPlace | null) => void
  >();

  private readonly layerVisibility = new Map<MapLayerId, boolean>([
    [MAP_LAYER_IDS.baseImagery, true],
    [MAP_LAYER_IDS.overtureBuildings, true],
    [MAP_LAYER_IDS.nearbyPlaces, false],
  ]);

  private clickHandler:
    | import("cesium").ScreenSpaceEventHandler
    | null = null;

  private selectedBuilding: CesiumEntity | null = null;

  private selectedBuildingOriginalMaterial:
    | CesiumMaterialProperty
    | null = null;

  private selectedBuildingOriginalWallMaterial:
    | CesiumMaterialProperty
    | null = null;

  private readonly featureSelectionListeners =
    new Set<FeatureSelectionListener>();

  private readonly renderedBuildingMetadata = new Map<
    string,
    BuildingHeight
  >();

  private buildingLodRecords: BuildingLodRecord[] = [];
  private cameraMoveEndUnsubscribe: (() => void) | null = null;
  private lastLodOrigin: CesiumCartesian3 | null = null;
  private lastLodBudget: number | null = null;
  private lodGraphicsCacheMetrics: LodGraphicsCacheMetrics = {
    polygonStyleCachesCreated: 0,
    detailedWallsCreated: 0,
    detailedWallCacheHits: 0,
    roofEquipmentCreated: 0,
    roofEquipmentCacheHits: 0,
  };

  private loadedViewportBounds: ViewportBounds | null = null;
  // null means the uncapped full pilot dataset is loaded.
  private loadedViewportFeatureLimit: number | null = null;
  private hasLoadedBuildings = false;
  private viewportLoadInProgress = false;
  private activeViewportEndpoint: string | null = null;
  private viewportRequestAbortController: AbortController | null = null;
  private readonly viewportResponseCache = new Map<string, unknown>();
  private pendingViewportBounds: ViewportBounds | null = null;
  private pendingViewportFeatureLimit: number | null = null;

  async initialize(container: HTMLElement): Promise<void> {
    if (this.viewer && !this.viewer.isDestroyed()) {
      return;
    }

    if (typeof window === "undefined") {
      throw new Error(
        "CesiumAdapter can only be initialized in the browser.",
      );
    }

    window.CESIUM_BASE_URL = "/cesium/";

    const Cesium = await import("cesium");
    this.cesium = Cesium;

    const viewer = new Cesium.Viewer(container, {
      terrainProvider: new Cesium.EllipsoidTerrainProvider({}),
      baseLayer: false,
      baseLayerPicker: false,
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      scene3DOnly: true,
      // Avoid continuous idle rendering; camera moves and our layer updates
      // still request frames through Cesium's scene lifecycle.
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      shouldAnimate: false,
    });

    this.viewer = viewer;

    // Set Dhaka immediately. Do not wait for any building data.
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        DHAKA_CAMERA.longitude,
        DHAKA_CAMERA.latitude,
        DHAKA_CAMERA.height,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(DHAKA_CAMERA.heading),
        pitch: Cesium.Math.toRadians(DHAKA_CAMERA.pitch),
        roll: Cesium.Math.toRadians(DHAKA_CAMERA.roll),
      },
    });

    try {
      const imageryProvider =
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://tile.openstreetmap.org/",
          credit: "© OpenStreetMap contributors",
        });

      this.baseImageryLayer =
        viewer.imageryLayers.addImageryProvider(
          imageryProvider,
        );
      this.baseImageryLayer.show = this.isLayerVisible(
        MAP_LAYER_IDS.baseImagery,
      );

      console.info("[Map] OpenStreetMap basemap initialized.");
    } catch (error: unknown) {
      console.error(
        "[Map] Basemap initialization failed:",
        error instanceof Error
          ? error.message
          : String(error),
      );
    }

    viewer.scene.globe.depthTestAgainstTerrain = true;

    this.installFeaturePicking(viewer, Cesium);

    this.cameraMoveEndUnsubscribe?.();
    this.cameraMoveEndUnsubscribe =
      viewer.camera.moveEnd.addEventListener(() => {
        this.handleCameraMoveEnd(viewer, Cesium);
      });

    viewer.scene.requestRender();

    /*
     * IMPORTANT:
     * Do not await this operation here.
     * Let the map initialize while the building layer loads.
     */
    void this.loadOvertureBuildings(viewer, Cesium).catch(
      (error: unknown) => {
        if (isAbortError(error)) return;

        if (
          this.viewer === viewer &&
          !viewer.isDestroyed()
        ) {
          console.error(
            "[Overture] Background building load failed:",
            error instanceof Error
              ? error.message
              : String(error),
          );
        }
      },
    );
  }

  private async loadOvertureBuildings(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
    requestedBounds: ViewportBounds | null =
      this.getPaddedViewportBounds(viewer, Cesium),
  ): Promise<void> {
    const requestedFeatureLimit = requestedBounds
      ? getViewportFeatureLimit(viewer.camera.positionCartographic.height)
      : null;

    if (this.viewportLoadInProgress) {
      if (requestedBounds) {
        this.queuePendingViewport(
          requestedBounds,
          requestedFeatureLimit ??
            getViewportFeatureLimit(
              viewer.camera.positionCartographic.height,
            ),
        );
      }
      return;
    }

    this.viewportLoadInProgress = true;
    let stagedDataSource: CesiumDataSource | null = null;
    let activeEndpoint: string | null = null;
    let requestController: AbortController | null = null;

    try {
      const endpoint = requestedBounds
        ? this.getViewportEndpoint(
            requestedBounds,
            requestedFeatureLimit ??
              getViewportFeatureLimit(
                viewer.camera.positionCartographic.height,
              ),
          )
        : "/api/geospatial/overture-buildings";

      activeEndpoint = endpoint;
      this.activeViewportEndpoint = endpoint;
      requestController = new AbortController();
      this.viewportRequestAbortController = requestController;

      console.info("[Overture] Fetching building viewport...", {
        endpoint,
        viewport: requestedBounds,
      });

      let geoJson: unknown;
      let responseHeaders: Headers | null = null;
      const cachedGeoJson = getCachedViewportResponse(
        this.viewportResponseCache,
        endpoint,
      );

      if (cachedGeoJson !== undefined) {
        geoJson = cachedGeoJson;
        console.info("[Overture] Reusing cached viewport payload.", {
          endpoint,
          cacheEntries: this.viewportResponseCache.size,
        });
      } else {
        const response = await fetch(endpoint, {
          signal: requestController.signal,
        });
        responseHeaders = response.headers;

        if (!response.ok) {
          const result = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;

          throw new Error(
            result?.error ??
              `Building API returned HTTP ${response.status}.`,
          );
        }

        geoJson = await response.json();
        cacheViewportResponse(
          this.viewportResponseCache,
          endpoint,
          geoJson,
          MAX_CACHED_VIEWPORT_RESPONSES,
        );
      }

      // Cancel network work only until the payload is ready. After that, stage
      // the data source and coalesce later camera moves into a single follow-up.
      if (this.viewportRequestAbortController === requestController) {
        this.viewportRequestAbortController = null;
      }

      console.info("[Overture] Viewport API response received.", {
        dataSource: responseHeaders?.get("X-Building-Data-Source"),
        selectedTiles: responseHeaders?.get("X-Building-Tile-Count"),
        candidateFeatures: responseHeaders?.get(
          "X-Building-Candidate-Feature-Count",
        ),
        matchedFeatures: responseHeaders?.get(
          "X-Building-Matched-Feature-Count",
        ),
        returnedFeatures: responseHeaders?.get("X-Building-Feature-Count"),
        featureLimit: responseHeaders?.get("X-Building-Feature-Limit"),
        truncated: responseHeaders?.get("X-Building-Truncated"),
        tileCacheHits: responseHeaders?.get("X-Building-Tile-Cache-Hits"),
      });

      if (
        !this.viewer ||
        this.viewer !== viewer ||
        viewer.isDestroyed()
      ) {
        return;
      }

      const dataSource = await Cesium.GeoJsonDataSource.load(
        geoJson as Parameters<
          typeof Cesium.GeoJsonDataSource.load
        >[0],
        {
          clampToGround: false,
          stroke: Cesium.Color.fromCssColorString(
            WALL_OUTLINE_COLOR,
          ),
          strokeWidth: 1,
          fill: Cesium.Color.fromCssColorString("#d2d8dc"),
        },
      );

      if (
        !this.viewer ||
        this.viewer !== viewer ||
        viewer.isDestroyed()
      ) {
        return;
      }

      dataSource.name = requestedBounds
        ? "Overture 3D Viewport Buildings"
        : "Overture 3D Pilot Buildings";
      // Stage the next viewport invisibly so the current view stays usable.
      dataSource.show = false;
      await viewer.dataSources.add(dataSource);
      stagedDataSource = dataSource;

      if (
        !this.viewer ||
        this.viewer !== viewer ||
        viewer.isDestroyed()
      ) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }

      const time = Cesium.JulianDate.now();
      const entities = [...dataSource.entities.values];
      const lodRecords: BuildingLodRecord[] = [];
      this.lodGraphicsCacheMetrics = {
        polygonStyleCachesCreated: 0,
        detailedWallsCreated: 0,
        detailedWallCacheHits: 0,
        roofEquipmentCreated: 0,
        roofEquipmentCacheHits: 0,
      };

      let renderedBuildings = 0;
      let renderedParts = 0;
      let renderedExtrusions = 0;
      let hiddenParents = 0;
      let hiddenUnderground = 0;
      let invalidPolygons = 0;

      console.info(
        "[Overture] Building features loaded; preparing lightweight geometry...",
        { totalFeatures: entities.length },
      );

      for (
        let start = 0;
        start < entities.length;
        start += BATCH_SIZE
      ) {
        if (
          !this.viewer ||
          this.viewer !== viewer ||
          viewer.isDestroyed()
        ) {
          return;
        }

        const batch = entities.slice(start, start + BATCH_SIZE);
        dataSource.entities.suspendEvents();

        try {
          for (const entity of batch) {
            const polygon = entity.polygon;

            if (!polygon) {
              continue;
            }

            const properties = this.readProperties(entity, time);

            if (this.isUnderground(properties)) {
              entity.show = false;
              hiddenUnderground += 1;
              continue;
            }

            const role =
              typeof properties._renderRole === "string"
                ? properties._renderRole
                : "building";
            const partCount =
              this.getPositiveNumber(properties, ["_renderPartCount"]) ?? 0;

            // Avoid drawing a parent and its supplied building parts together.
            if (role === "building_parent" && partCount > 0) {
              entity.show = false;
              hiddenParents += 1;
              continue;
            }

            const heightInfo = this.getBuildingHeight(properties);
            const topHeight = heightInfo.baseHeight + heightInfo.meters;
            const visualStyle = resolveBuildingVisualStyle(
              properties,
              entity.id,
              heightInfo.meters,
            );
            const hierarchy = polygon.hierarchy?.getValue(time);

            let wallPositions: CesiumCartesian3[] | null = null;
            let center: CesiumCartesian3 | null = null;

            if (hierarchy && hierarchy.positions.length >= 3) {
              wallPositions = [...hierarchy.positions];

              const firstPosition = wallPositions[0];
              const lastPosition = wallPositions[wallPositions.length - 1];

              if (
                Cesium.Cartesian3.distance(firstPosition, lastPosition) > 0.05
              ) {
                wallPositions.push(
                  Cesium.Cartesian3.clone(firstPosition),
                );
              }

              const bounds = Cesium.BoundingSphere.fromPoints(
                hierarchy.positions,
              );
              center = Cesium.Cartesian3.clone(bounds.center);
            } else {
              invalidPolygons += 1;
            }

            const record: BuildingLodRecord = {
              entity,
              heightInfo,
              baseHeight: heightInfo.baseHeight,
              topHeight,
              visualStyle,
              wallPositions,
              center,
              isPart: role === "building_part",
              isDetailed: false,
              polygonStyleCache: null,
              detailedWall: null,
              roofEquipmentBox: null,
              roofEquipmentPosition: null,
            };

            this.applyLightweightBuildingStyle(record, Cesium);
            lodRecords.push(record);
            renderedExtrusions += 1;

            if (record.isPart) {
              renderedParts += 1;
            } else {
              renderedBuildings += 1;
            }
          }
        } finally {
          dataSource.entities.resumeEvents();
        }

        viewer.scene.requestRender();

        // Yield between batches so the map remains interactive during setup.
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
      }

      if (
        !this.viewer ||
        this.viewer !== viewer ||
        viewer.isDestroyed()
      ) {
        return;
      }

      const previousDataSource = this.overtureBuildings;

      // Invalidate any selection owned by the outgoing viewport before swapping.
      this.restoreSelectedBuilding();
      this.selectedBuilding = null;
      this.selectedBuildingOriginalMaterial = null;
      this.selectedBuildingOriginalWallMaterial = null;
      this.emitFeatureSelection(null);

      this.overtureBuildings = dataSource;
      this.buildingLodRecords = lodRecords;
      this.renderedBuildingMetadata.clear();

      for (const record of lodRecords) {
        this.renderedBuildingMetadata.set(
          record.entity.id,
          record.heightInfo,
        );
      }

      this.loadedViewportBounds = requestedBounds;
      this.loadedViewportFeatureLimit = requestedFeatureLimit;
      this.hasLoadedBuildings = true;
      this.lastLodOrigin = null;
      this.lastLodBudget = null;

      // Choose facade detail from the live camera, rather than a fixed Dhaka sort.
      this.updateBuildingLod(viewer, Cesium, true);

      dataSource.show = this.isLayerVisible(
        MAP_LAYER_IDS.overtureBuildings,
      );
      viewer.scene.requestRender();

      if (previousDataSource && previousDataSource !== dataSource) {
        viewer.dataSources.remove(previousDataSource, true);
      }

      stagedDataSource = null;

      console.info("[Overture] Building viewport rendered.", {
        returnedFeatures: entities.length,
        viewport: requestedBounds,
        renderedBuildings,
        renderedParts,
        renderedExtrusions,
        detailedFacades: lodRecords.filter((record) => record.isDetailed).length,
        graphicsCache: { ...this.lodGraphicsCacheMetrics },
        hiddenParents,
        hiddenUnderground,
        invalidPolygons,
        cameraAwareLod: true,
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        console.info("[Overture] Cancelled an obsolete viewport request.", {
          endpoint: activeEndpoint,
        });
      } else {
        console.error(
          "[Overture] Building rendering failed:",
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
              }
            : String(error),
        );
      }

      if (
        stagedDataSource &&
        this.viewer === viewer &&
        !viewer.isDestroyed() &&
        this.overtureBuildings !== stagedDataSource
      ) {
        viewer.dataSources.remove(stagedDataSource, true);
        stagedDataSource = null;
      }

      if (!isAbortError(error)) {
        throw error;
      }
    } finally {
      // Clean hidden staging data even when setup exits through an early return.
      if (
        stagedDataSource &&
        this.viewer === viewer &&
        !viewer.isDestroyed() &&
        this.overtureBuildings !== stagedDataSource
      ) {
        viewer.dataSources.remove(stagedDataSource, true);
        stagedDataSource = null;
      }

      if (this.viewportRequestAbortController === requestController) {
        this.viewportRequestAbortController = null;
      }
      if (this.activeViewportEndpoint === activeEndpoint) {
        this.activeViewportEndpoint = null;
      }

      this.viewportLoadInProgress = false;

      const pendingBounds = this.pendingViewportBounds;
      const pendingFeatureLimit = this.pendingViewportFeatureLimit;
      this.pendingViewportBounds = null;
      this.pendingViewportFeatureLimit = null;
      const requiredFeatureLimit =
        pendingFeatureLimit ??
        getViewportFeatureLimit(viewer.camera.positionCartographic.height);

      // Always service the latest queued viewport, even if its predecessor was
      // cancelled or failed. The coverage check prevents redundant reloads.
      if (
        pendingBounds &&
        !this.isViewportCoveredByLoadedData(
          pendingBounds,
          requiredFeatureLimit,
        )
      ) {
        void this.loadOvertureBuildings(
          viewer,
          Cesium,
          pendingBounds,
        ).catch((error: unknown) => {
          if (isAbortError(error)) return;
          console.error(
            "[Overture] Follow-up viewport load failed:",
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    }
  }

  private getPaddedViewportBounds(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): ViewportBounds | null {
    let rectangle: import("cesium").Rectangle | undefined;

    try {
      rectangle = viewer.camera.computeViewRectangle(
        viewer.scene.globe.ellipsoid,
      );
    } catch {
      return null;
    }

    if (!rectangle) {
      return null;
    }

    const west = Cesium.Math.toDegrees(rectangle.west);
    const south = Cesium.Math.toDegrees(rectangle.south);
    const east = Cesium.Math.toDegrees(rectangle.east);
    const north = Cesium.Math.toDegrees(rectangle.north);

    // A rectangle crossing the antimeridian cannot be expressed by this
    // viewport endpoint's simple west < east contract; use the full fallback.
    if (
      ![west, south, east, north].every(Number.isFinite) ||
      west >= east ||
      south >= north
    ) {
      return null;
    }

    const longitudePadding = Math.max(
      (east - west) * VIEWPORT_PADDING_FACTOR,
      VIEWPORT_MIN_PADDING_DEGREES,
    );
    const latitudePadding = Math.max(
      (north - south) * VIEWPORT_PADDING_FACTOR,
      VIEWPORT_MIN_PADDING_DEGREES,
    );

    const padded: ViewportBounds = {
      west: Math.max(-180, west - longitudePadding),
      south: Math.max(-85, south - latitudePadding),
      east: Math.min(180, east + longitudePadding),
      north: Math.min(85, north + latitudePadding),
    };

    if (
      padded.east - padded.west > MAX_VIEWPORT_SPAN_DEGREES ||
      padded.north - padded.south > MAX_VIEWPORT_SPAN_DEGREES
    ) {
      return null;
    }

    return padded;
  }

  private getViewportEndpoint(
    bounds: ViewportBounds,
    featureLimit: number,
  ): string {
    const params = new URLSearchParams({
      west: bounds.west.toFixed(6),
      south: bounds.south.toFixed(6),
      east: bounds.east.toFixed(6),
      north: bounds.north.toFixed(6),
      limit: String(featureLimit),
    });

    return `/api/geospatial/overture-buildings/viewport?${params.toString()}`;
  }

  private boundsContain(
    outer: ViewportBounds,
    inner: ViewportBounds,
  ): boolean {
    const epsilon = 0.00002;

    return (
      inner.west >= outer.west - epsilon &&
      inner.south >= outer.south - epsilon &&
      inner.east <= outer.east + epsilon &&
      inner.north <= outer.north + epsilon
    );
  }

  private isViewportCoveredByLoadedData(
    bounds: ViewportBounds,
    requiredFeatureLimit: number,
  ): boolean {
    if (!this.hasLoadedBuildings) {
      return false;
    }

    // A null loaded bound means the full pilot dataset is active.
    if (this.loadedViewportBounds === null) {
      return true;
    }

    if (!this.boundsContain(this.loadedViewportBounds, bounds)) {
      return false;
    }

    // Re-fetch when a closer camera view needs a larger response budget.
    return (
      this.loadedViewportFeatureLimit !== null &&
      this.loadedViewportFeatureLimit >= requiredFeatureLimit
    );
  }

  private queuePendingViewport(
    bounds: ViewportBounds,
    featureLimit: number,
  ): void {
    this.pendingViewportBounds = bounds;
    this.pendingViewportFeatureLimit = featureLimit;

    const nextEndpoint = this.getViewportEndpoint(bounds, featureLimit);
    if (
      shouldAbortViewportRequest(
        this.activeViewportEndpoint,
        nextEndpoint,
      )
    ) {
      this.viewportRequestAbortController?.abort();
    }
  }

  private handleCameraMoveEnd(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): void {
    if (
      this.viewer !== viewer ||
      viewer.isDestroyed() ||
      !this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings)
    ) {
      return;
    }

    const requestedBounds = this.getPaddedViewportBounds(viewer, Cesium);

    if (!requestedBounds) {
      // Very wide views use the compatible full-dataset fallback.
      this.updateBuildingLod(viewer, Cesium);
      return;
    }

    const requiredFeatureLimit = getViewportFeatureLimit(
      viewer.camera.positionCartographic.height,
    );

    if (this.viewportLoadInProgress) {
      this.queuePendingViewport(requestedBounds, requiredFeatureLimit);
      return;
    }

    if (
      !this.isViewportCoveredByLoadedData(
        requestedBounds,
        requiredFeatureLimit,
      )
    ) {
      void this.loadOvertureBuildings(
        viewer,
        Cesium,
        requestedBounds,
      ).catch((error: unknown) => {
        if (isAbortError(error)) return;
        console.error(
          "[Overture] Viewport refresh failed:",
          error instanceof Error ? error.message : String(error),
        );
      });

      return;
    }

    this.updateBuildingLod(viewer, Cesium);
  }

  private getLodOrigin(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): CesiumCartesian3 {
    const canvas = viewer.scene.canvas;

    try {
      const screenCenter = new Cesium.Cartesian2(
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
      const centerGroundPosition = viewer.camera.pickEllipsoid(
        screenCenter,
        viewer.scene.globe.ellipsoid,
      );

      if (centerGroundPosition) {
        return centerGroundPosition;
      }
    } catch (error: unknown) {
      console.debug(
        "[Overture] Could not pick the camera center for LOD:",
        error instanceof Error ? error.message : String(error),
      );
    }

    const cameraPosition = viewer.camera.positionCartographic;
    return Cesium.Cartesian3.fromRadians(
      cameraPosition.longitude,
      cameraPosition.latitude,
      0,
    );
  }

  private updateBuildingLod(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
    force = false,
  ): void {
    if (
      !this.viewer ||
      this.viewer !== viewer ||
      viewer.isDestroyed() ||
      this.buildingLodRecords.length === 0
    ) {
      return;
    }

    const cameraHeightMeters = Math.max(
      0,
      viewer.camera.positionCartographic.height,
    );
    const detailBudget = getDetailedFacadeBudget(cameraHeightMeters);
    const origin = this.getLodOrigin(viewer, Cesium);
    const originMoved =
      this.lastLodOrigin === null ||
      Cesium.Cartesian3.distance(this.lastLodOrigin, origin) >=
        LOD_ORIGIN_MOVE_THRESHOLD_METERS;

    if (
      !force &&
      !originMoved &&
      this.lastLodBudget === detailBudget
    ) {
      return;
    }

    this.lastLodOrigin = Cesium.Cartesian3.clone(origin);
    this.lastLodBudget = detailBudget;

    const nearestBuildings = this.buildingLodRecords
      .filter((record) => record.center && record.wallPositions)
      .map((record) => ({
        record,
        distance: Cesium.Cartesian3.distance(record.center!, origin),
      }))
      .sort((left, right) => {
        // Keep real building parts detailed before complete building shells.
        if (left.record.isPart !== right.record.isPart) {
          return left.record.isPart ? -1 : 1;
        }

        return left.distance - right.distance;
      });

    const desiredDetailed = new Set(
      nearestBuildings
        .slice(0, detailBudget)
        .map((entry) => entry.record),
    );

    // A selected building stays detailed even if it is outside the current budget.
    const selectedRecord = this.buildingLodRecords.find(
      (record) => record.entity === this.selectedBuilding,
    );

    if (selectedRecord?.center && selectedRecord.wallPositions) {
      desiredDetailed.add(selectedRecord);
    }

    const dataSource = this.overtureBuildings;
    dataSource?.entities.suspendEvents();

    try {
      for (const record of this.buildingLodRecords) {
        const shouldBeDetailed =
          Boolean(record.wallPositions) && desiredDetailed.has(record);

        if (record.isDetailed === shouldBeDetailed) {
          continue;
        }

        if (shouldBeDetailed) {
          this.applyDetailedBuildingStyle(record, Cesium);
        } else {
          this.applyLightweightBuildingStyle(record, Cesium);
        }
      }
    } finally {
      dataSource?.entities.resumeEvents();
    }

    viewer.scene.requestRender();

    console.info("[Overture] Camera LOD updated.", {
      cameraHeightMeters: Math.round(cameraHeightMeters),
      detailedFacadeBudget: detailBudget,
      detailedBuildings: this.buildingLodRecords.filter(
        (record) => record.isDetailed,
      ).length,
      graphicsCache: { ...this.lodGraphicsCacheMetrics },
      viewCenter: {
        longitude: Number(
          Cesium.Math.toDegrees(
            Cesium.Cartographic.fromCartesian(origin).longitude,
          ).toFixed(5),
        ),
        latitude: Number(
          Cesium.Math.toDegrees(
            Cesium.Cartographic.fromCartesian(origin).latitude,
          ).toFixed(5),
        ),
      },
    });
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

    this.lodGraphicsCacheMetrics.polygonStyleCachesCreated += 1;
    return record.polygonStyleCache;
  }

  private prepareSelectedBuildingForLodTransition(
    record: BuildingLodRecord,
  ): void {
    const entity = record.entity;

    if (this.selectedBuilding !== entity) {
      return;
    }

    const originalPolygonMaterial = this.selectedBuildingOriginalMaterial;
    const originalWallMaterial = this.selectedBuildingOriginalWallMaterial;

    // The detailed wall may be detached while the selected building is in
    // lightweight mode. Restore the cached object's original material too.
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

    this.selectedBuildingOriginalMaterial = null;
    this.selectedBuildingOriginalWallMaterial = null;
  }

  private applyLightweightBuildingStyle(
    record: BuildingLodRecord,
    Cesium: CesiumModule,
  ): void {
    const entity = record.entity;
    const polygon = entity.polygon;

    if (!polygon) {
      return;
    }

    this.prepareSelectedBuildingForLodTransition(record);

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
    this.applySelectionHighlight(entity, Cesium);
  }

  private applyDetailedBuildingStyle(
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

    this.prepareSelectedBuildingForLodTransition(record);

    if (!record.detailedWall) {
      const facadeTexture = createBuildingFacadeTexture(record.visualStyle);
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
            record.visualStyle.repeatWidthMeters,
          ),
          // The canvas already carries the palette; avoid tinting its glass.
          color: Cesium.Color.WHITE,
          transparent: false,
        }),
      });
      this.lodGraphicsCacheMetrics.detailedWallsCreated += 1;
    } else {
      this.lodGraphicsCacheMetrics.detailedWallCacheHits += 1;
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

    const shouldShowRoofEquipment =
      record.visualStyle.roofDetail !== "none" &&
      (this.hashEntityId(entity.id) % 5 === 0 || record.isPart);

    if (shouldShowRoofEquipment) {
      if (!record.roofEquipmentBox || !record.roofEquipmentPosition) {
        const centerCartographic = Cesium.Cartographic.fromCartesian(
          record.center ?? wallPositions[0],
        );
        const equipmentHeight =
          record.visualStyle.roofDetail === "water-tank" ? 1.8 : 1.2;
        const equipmentWidth =
          record.visualStyle.roofDetail === "water-tank" ? 1.6 : 2.4;
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
              record.visualStyle.roofDetail === "water-tank"
                ? "#657b89"
                : "#aeb8bf",
            ) ?? Cesium.Color.GRAY,
          outline: new Cesium.ConstantProperty(true),
          outlineColor: new Cesium.ConstantProperty(
            Cesium.Color.fromCssColorString("#4d5b64") ??
              Cesium.Color.DARKGRAY,
          ),
        });
        this.lodGraphicsCacheMetrics.roofEquipmentCreated += 1;
      } else {
        this.lodGraphicsCacheMetrics.roofEquipmentCacheHits += 1;
      }

      entity.position = record.roofEquipmentPosition;
      entity.box = record.roofEquipmentBox;
    }

    record.isDetailed = true;
    this.applySelectionHighlight(entity, Cesium);
  }

  private applySelectionHighlight(
    entity: CesiumEntity,
    Cesium: CesiumModule,
  ): void {
    if (
      this.selectedBuilding !== entity ||
      !entity.polygon ||
      this.selectedBuildingOriginalMaterial !== null
    ) {
      return;
    }

    // Capture the unhighlighted materials only once per selection. LOD
    // transitions must not accidentally save the cyan highlight as original.
    this.selectedBuildingOriginalMaterial = entity.polygon.material;
    this.selectedBuildingOriginalWallMaterial =
      entity.wall?.material ?? null;

    entity.polygon.material = new Cesium.ColorMaterialProperty(
      Cesium.Color.CYAN.withAlpha(0.98),
    );

    if (entity.wall) {
      entity.wall.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.CYAN.withAlpha(0.98),
      );
    }
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
      Math.min(80, Math.max(1, height / 3)),
    );
  }

  private readProperties(
    entity: CesiumEntity,
    time: import("cesium").JulianDate,
  ): BuildingProperties {
    const result = entity.properties?.getValue(time);

    if (!result || typeof result !== "object") {
      return {};
    }

    return result as BuildingProperties;
  }

  private getPositiveNumber(
    properties: BuildingProperties,
    keys: string[],
  ): number | null {
    for (const key of keys) {
      const value = properties[key];

      const numeric =
        typeof value === "number"
          ? value
          : typeof value === "string"
            ? Number.parseFloat(value)
            : Number.NaN;

      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
      }
    }

    return null;
  }

  private getBuildingHeight(
    properties: BuildingProperties,
  ): BuildingHeight {
    const height = this.getPositiveNumber(properties, [
      "height",
      "height_m",
      "heightMeters",
    ]);

    const minHeight =
      this.getPositiveNumber(properties, [
        "min_height",
        "minHeight",
      ]) ?? 0;

    if (height !== null) {
      return {
        meters: Math.min(Math.max(height, 3), 300),
        baseHeight: Math.min(minHeight, 100),
        source: "overture-height",
      };
    }

    const floors = this.getPositiveNumber(properties, [
      "num_floors",
      "numFloors",
      "building:levels",
      "levels",
    ]);

    if (floors !== null) {
      return {
        meters: Math.min(Math.max(floors * 3, 3), 300),
        baseHeight: Math.min(minHeight, 100),
        source: "floor-estimate",
      };
    }

    return {
      meters: 9,
      baseHeight: Math.min(minHeight, 100),
      source: "fallback-estimate",
    };
  }

  private isUnderground(
    properties: BuildingProperties,
  ): boolean {
    const value = properties.is_underground;
    return value === true || value === "true";
  }

  onFeatureSelected(
    listener: FeatureSelectionListener,
  ): () => void {
    this.featureSelectionListeners.add(listener);

    return () => {
      this.featureSelectionListeners.delete(listener);
    };
  }

  onPlaceSelected(
    listener: (place: NearbyPlace | null) => void,
  ): () => void {
    this.placeSelectionListeners.add(listener);
    return () => this.placeSelectionListeners.delete(listener);
  }

  private emitPlaceSelection(place: NearbyPlace | null): void {
    for (const listener of this.placeSelectionListeners) {
      try {
        listener(place);
      } catch (error: unknown) {
        console.error(
          "[Map] Nearby-place selection listener failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  getGroundCenter(): import("./types").GeoCoordinate | null {
    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (!viewer || !Cesium || viewer.isDestroyed()) return null;

    const screenCenter = new Cesium.Cartesian2(
      viewer.scene.canvas.clientWidth / 2,
      viewer.scene.canvas.clientHeight / 2,
    );
    const ray = viewer.camera.getPickRay(screenCenter);
    const groundPosition =
      (ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined) ??
      viewer.camera.pickEllipsoid(screenCenter, viewer.scene.globe.ellipsoid);
    if (!groundPosition) return null;

    const cartographic = Cesium.Cartographic.fromCartesian(groundPosition);
    const latitude = Cesium.Math.toDegrees(cartographic.latitude);
    const longitude = Cesium.Math.toDegrees(cartographic.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    return { latitude, longitude, height: 0 };
  }

  async setNearbyPlaces(places: NearbyPlace[]): Promise<void> {
    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (!viewer || !Cesium || viewer.isDestroyed()) return;

    let dataSource = this.nearbyPlacesDataSource;
    if (!dataSource) {
      dataSource = new Cesium.CustomDataSource("OpenStreetMap Nearby Places");
      await viewer.dataSources.add(dataSource);
      if (this.viewer !== viewer || viewer.isDestroyed()) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }
      this.nearbyPlacesDataSource = dataSource;
    }

    dataSource.entities.removeAll();
    this.nearbyPlaceByEntityId.clear();

    const categoryColors: Record<NearbyPlace["category"], string> = {
      pharmacy: "#22c55e",
      hospital: "#ef4444",
      medical_center: "#fb923c",
      supermarket: "#38bdf8",
      market: "#c084fc",
    };

    for (const place of places) {
      const entityId = place.id;
      const color = Cesium.Color.fromCssColorString(
        categoryColors[place.category],
      ) ?? Cesium.Color.CYAN;

      dataSource.entities.add({
        id: entityId,
        name: place.name,
        position: Cesium.Cartesian3.fromDegrees(
          place.longitude,
          place.latitude,
          3,
        ),
        point: {
          pixelSize: 11,
          color: color.withAlpha(0.98),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 1200,
        },
        label: {
          text: place.name,
          font: "12px sans-serif",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.72),
          pixelOffset: new Cesium.Cartesian2(0, -18),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(100, 1, 2600, 0.2),
          disableDepthTestDistance: 1200,
        },
      });
      this.nearbyPlaceByEntityId.set(entityId, place);
    }

    dataSource.show = this.isLayerVisible(MAP_LAYER_IDS.nearbyPlaces);
    viewer.scene.requestRender();
  }

  private emitFeatureSelection(
    selection: MapFeatureSelection | null,
  ): void {
    for (const listener of this.featureSelectionListeners) {
      try {
        listener(selection);
      } catch (error: unknown) {
        console.error(
          "[Map] Selection listener failed:",
          error instanceof Error
            ? error.message
            : String(error),
        );
      }
    }
  }

  private restoreSelectedBuilding(): void {
    const building = this.selectedBuilding;

    const originalRoof = this.selectedBuildingOriginalMaterial;
    const originalWall =
      this.selectedBuildingOriginalWallMaterial;

    if (building?.polygon && originalRoof !== null) {
      building.polygon.material = originalRoof;
    }

    if (building?.wall && originalWall !== null) {
      building.wall.material = originalWall;
    }

    this.selectedBuilding = null;
    this.selectedBuildingOriginalMaterial = null;
    this.selectedBuildingOriginalWallMaterial = null;
  }

  clearFeatureSelection(): void {
    const hadSelection = this.selectedBuilding !== null;
    this.restoreSelectedBuilding();
    this.emitFeatureSelection(null);
    this.emitPlaceSelection(null);

    if (
      hadSelection &&
      this.viewer &&
      this.cesium &&
      !this.viewer.isDestroyed()
    ) {
      this.updateBuildingLod(this.viewer, this.cesium, true);
    }
  }

  private getEntityFromPick(
    picked: unknown,
    Cesium: CesiumModule,
    dataSource: CesiumDataSource,
  ): CesiumEntity | null {
    if (!picked || typeof picked !== "object") {
      return null;
    }

    if (picked instanceof Cesium.Entity) {
      return dataSource.entities.getById(picked.id) ?? null;
    }

    const pickedObject = picked as {
      id?: unknown;
      primitive?: { id?: unknown };
    };

    for (const candidate of [
      pickedObject.id,
      pickedObject.primitive?.id,
    ]) {
      if (candidate instanceof Cesium.Entity) {
        return dataSource.entities.getById(candidate.id) ?? null;
      }

      if (typeof candidate === "string") {
        const entity = dataSource.entities.getById(candidate);

        if (entity) {
          return entity;
        }
      }
    }

    return null;
  }

  private installFeaturePicking(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): void {
    this.clickHandler?.destroy();

    const handler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );

    handler.setInputAction(
      (movement: {
        position: import("cesium").Cartesian2;
      }) => {
        if (
          viewer.isDestroyed() ||
          this.viewer !== viewer
        ) {
          return;
        }

        const picked = viewer.scene.pick(movement.position);
        if (!picked) {
          this.clearFeatureSelection();
          return;
        }

        const nearbySource = this.nearbyPlacesDataSource;
        const nearbyEntity = nearbySource
          ? this.getEntityFromPick(picked, Cesium, nearbySource)
          : null;

        if (nearbyEntity?.point) {
          this.clearFeatureSelection();
          this.emitPlaceSelection(
            this.nearbyPlaceByEntityId.get(nearbyEntity.id) ?? null,
          );
          return;
        }

        const dataSource = this.overtureBuildings;
        if (!dataSource) {
          this.clearFeatureSelection();
          return;
        }

        const entity = this.getEntityFromPick(
          picked,
          Cesium,
          dataSource,
        );

        if (!entity?.polygon) {
          this.clearFeatureSelection();
          return;
        }

        this.restoreSelectedBuilding();
        this.emitPlaceSelection(null);

        this.selectedBuilding = entity;

        const properties = this.readProperties(
          entity,
          Cesium.JulianDate.now(),
        );

        const heightInfo =
          this.renderedBuildingMetadata.get(entity.id) ??
          this.getBuildingHeight(properties);

        const selectedProperties: Record<string, unknown> = {
          ...properties,
          overture_feature_id: entity.id,
          rendered_height_m: heightInfo.meters,
          height_source: heightInfo.source,
        };

        const names = properties.names;

        if (
          names &&
          typeof names === "object" &&
          "primary" in names &&
          typeof names.primary === "string"
        ) {
          selectedProperties.display_name = names.primary;
        } else if (typeof properties.name === "string") {
          selectedProperties.display_name = properties.name;
        }

        let coordinates: MapFeatureSelection["coordinates"] = null;

        try {
          const worldPosition =
            viewer.scene.pickPositionSupported
              ? viewer.scene.pickPosition(movement.position)
              : undefined;

          const position =
            worldPosition ??
            viewer.camera.pickEllipsoid(
              movement.position,
              viewer.scene.globe.ellipsoid,
            );

          if (position) {
            const cartographic =
              Cesium.Cartographic.fromCartesian(position);

            coordinates = {
              longitude: Cesium.Math.toDegrees(
                cartographic.longitude,
              ),
              latitude: Cesium.Math.toDegrees(
                cartographic.latitude,
              ),
              height: cartographic.height,
            };
          }
        } catch (error: unknown) {
          console.debug(
            "[Map] Could not determine click coordinates:",
            error instanceof Error
              ? error.message
              : String(error),
          );
        }

        let focusCoordinates: MapFeatureSelection["focusCoordinates"] = null;
        let footprintAreaM2: number | null = null;

        try {
          const hierarchy = entity.polygon.hierarchy?.getValue(
            Cesium.JulianDate.now(),
          );

          if (hierarchy && hierarchy.positions.length >= 3) {
            const bounds = Cesium.BoundingSphere.fromPoints(
              hierarchy.positions,
            );
            const center = Cesium.Cartographic.fromCartesian(
              bounds.center,
            );

            focusCoordinates = {
              longitude: Cesium.Math.toDegrees(center.longitude),
              latitude: Cesium.Math.toDegrees(center.latitude),
              height: heightInfo.baseHeight + heightInfo.meters,
            };

            const toDegreesRing = (positions: CesiumCartesian3[]) =>
              positions.map((position) => {
                const cartographic = Cesium.Cartographic.fromCartesian(position);
                return {
                  longitude: Cesium.Math.toDegrees(cartographic.longitude),
                  latitude: Cesium.Math.toDegrees(cartographic.latitude),
                };
              });
            const rings = [
              toDegreesRing(hierarchy.positions),
              ...(hierarchy.holes ?? []).map(
                (hole: { positions: CesiumCartesian3[] }) =>
                  toDegreesRing(hole.positions),
              ),
            ];
            footprintAreaM2 = calculateFootprintAreaM2(rings);
          }
        } catch (error: unknown) {
          console.debug(
            "[Map] Could not calculate building footprint measurements:",
            error instanceof Error ? error.message : String(error),
          );
        }

        this.emitFeatureSelection({
          source: "overture-local-buildings",
          properties: selectedProperties,
          coordinates,
          focusCoordinates,
          footprintAreaM2,
        });

        // Promote the selected building to the detailed tier immediately,
        // then highlight it if its LOD did not need to change.
        this.updateBuildingLod(viewer, Cesium, true);
        this.applySelectionHighlight(entity, Cesium);
        viewer.scene.requestRender();

        console.info(
          "[Map] Overture building selected:",
          selectedProperties,
        );
      },
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );

    this.clickHandler = handler;
  }

  destroy(): void {
    this.restoreSelectedBuilding();

    // Prevent requests from surviving a retry or component unmount.
    this.viewportRequestAbortController?.abort();
    this.viewportRequestAbortController = null;
    this.activeViewportEndpoint = null;
    this.viewportResponseCache.clear();

    this.clickHandler?.destroy();
    this.clickHandler = null;

    this.cameraMoveEndUnsubscribe?.();
    this.cameraMoveEndUnsubscribe = null;

    this.featureSelectionListeners.clear();
    this.placeSelectionListeners.clear();
    this.nearbyPlaceByEntityId.clear();
    this.renderedBuildingMetadata.clear();
    this.buildingLodRecords = [];
    this.loadedViewportBounds = null;
    this.loadedViewportFeatureLimit = null;
    this.hasLoadedBuildings = false;
    this.viewportLoadInProgress = false;
    this.pendingViewportBounds = null;
    this.pendingViewportFeatureLimit = null;
    this.lastLodOrigin = null;
    this.lastLodBudget = null;

    this.baseImageryLayer = null;
    this.overtureBuildings = null;
    this.nearbyPlacesDataSource = null;

    if (this.viewer && !this.viewer.isDestroyed()) {
      this.viewer.destroy();
    }

    this.viewer = null;
    this.cesium = null;
  }

  resize(): void {
    if (!this.viewer || this.viewer.isDestroyed()) {
      return;
    }

    this.viewer.resize();
  }

  private getZoomDistance(): number {
    if (!this.viewer) {
      return 0;
    }

    const height =
      this.viewer.camera.positionCartographic.height;

    return Math.max(
      10,
      Math.min(height * 0.2, 1_000_000),
    );
  }

  zoomIn(): void {
    if (!this.viewer || this.viewer.isDestroyed()) return;
    this.viewer.camera.zoomIn(this.getZoomDistance());
  }

  zoomOut(): void {
    if (!this.viewer || this.viewer.isDestroyed()) return;
    this.viewer.camera.zoomOut(this.getZoomDistance());
  }

  rotateLeft(stepDegrees = 15): void {
    if (
      !this.viewer ||
      !this.cesium ||
      this.viewer.isDestroyed()
    ) {
      return;
    }

    this.viewer.camera.rotateLeft(
      this.cesium.Math.toRadians(stepDegrees),
    );
  }

  rotateRight(stepDegrees = 15): void {
    if (
      !this.viewer ||
      !this.cesium ||
      this.viewer.isDestroyed()
    ) {
      return;
    }

    this.viewer.camera.rotateRight(
      this.cesium.Math.toRadians(stepDegrees),
    );
  }

  tiltUp(stepDegrees = 8): void {
    this.adjustPitch(stepDegrees);
  }

  tiltDown(stepDegrees = 8): void {
    this.adjustPitch(-stepDegrees);
  }

  private adjustPitch(deltaDegrees: number): void {
    if (
      !this.viewer ||
      !this.cesium ||
      this.viewer.isDestroyed()
    ) {
      return;
    }

    const camera = this.viewer.camera;

    const currentPitch =
      this.cesium.Math.toDegrees(camera.pitch);

    const nextPitch = Math.max(
      -85,
      Math.min(-5, currentPitch + deltaDegrees),
    );

    const destination =
      this.cesium.Cartesian3.clone(camera.positionWC);

    camera.setView({
      destination,
      orientation: {
        heading: camera.heading,
        pitch: this.cesium.Math.toRadians(nextPitch),
        roll: camera.roll,
      },
    });
  }

  resetOrientation(): void {
    if (
      !this.viewer ||
      !this.cesium ||
      this.viewer.isDestroyed()
    ) {
      return;
    }

    const camera = this.viewer.camera;

    const destination =
      this.cesium.Cartesian3.clone(camera.positionWC);

    camera.setView({
      destination,
      orientation: {
        heading: 0,
        pitch: this.cesium.Math.toRadians(-40),
        roll: 0,
      },
    });
  }

  flyTo(target: CameraTarget): void {
    if (
      !this.viewer ||
      !this.cesium ||
      this.viewer.isDestroyed()
    ) {
      return;
    }

    const {
      destination,
      heading = 0,
      pitch = -40,
      roll = 0,
      durationMs = 2000,
    } = target;

    this.viewer.camera.flyTo({
      destination: this.cesium.Cartesian3.fromDegrees(
        destination.longitude,
        destination.latitude,
        destination.height ?? 1000,
      ),
      orientation: {
        heading: this.cesium.Math.toRadians(heading),
        pitch: this.cesium.Math.toRadians(pitch),
        roll: this.cesium.Math.toRadians(roll),
      },
      duration: durationMs / 1000,
    });
  }

  getState(): MapEngineState {
    if (
      !this.viewer ||
      !this.cesium ||
      this.viewer.isDestroyed()
    ) {
      return {
        center: {
          longitude: 0,
          latitude: 0,
          height: 0,
        },
        heading: 0,
        pitch: 0,
        roll: 0,
      };
    }

    const cartographic =
      this.viewer.camera.positionCartographic;

    return {
      center: {
        longitude: this.cesium.Math.toDegrees(
          cartographic.longitude,
        ),
        latitude: this.cesium.Math.toDegrees(
          cartographic.latitude,
        ),
        height: cartographic.height,
      },
      heading: this.viewer.camera.heading,
      pitch: this.viewer.camera.pitch,
      roll: this.viewer.camera.roll,
    };
  }

  getCapabilities(): MapEngineCapabilities {
    return {
      globe: true,
      terrain: true,
      imagery: true,
      threeDTiles: true,
      vectorLayers: true,
      modelLayers: true,
      featurePicking: true,
    };
  }

  private isLayerVisible(layerId: MapLayerId): boolean {
    return this.layerVisibility.get(layerId) ?? true;
  }

  getLayers(): MapLayer[] {
    return [
      {
        id: MAP_LAYER_IDS.baseImagery,
        name: "Street map imagery",
        visible: this.isLayerVisible(MAP_LAYER_IDS.baseImagery),
      },
      {
        id: MAP_LAYER_IDS.overtureBuildings,
        name: "Overture 3D buildings",
        visible: this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings),
      },
      {
        id: MAP_LAYER_IDS.nearbyPlaces,
        name: "Nearby places",
        visible: this.isLayerVisible(MAP_LAYER_IDS.nearbyPlaces),
      },
    ];
  }

  setLayerVisibility(layerId: MapLayerId, visible: boolean): void {
    this.layerVisibility.set(layerId, visible);

    if (layerId === MAP_LAYER_IDS.baseImagery) {
      if (this.baseImageryLayer) {
        this.baseImageryLayer.show = visible;
      }
    } else if (layerId === MAP_LAYER_IDS.overtureBuildings) {
      if (this.overtureBuildings) {
        this.overtureBuildings.show = visible;
      }

      if (!visible) {
        // Do not keep fetching obsolete viewports while the building layer is hidden.
        this.pendingViewportBounds = null;
        this.pendingViewportFeatureLimit = null;
        this.viewportRequestAbortController?.abort();
      }
    } else if (layerId === MAP_LAYER_IDS.nearbyPlaces) {
      if (this.nearbyPlacesDataSource) {
        this.nearbyPlacesDataSource.show = visible;
      }
    }

    const viewer = this.viewer;
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    if (
      layerId === MAP_LAYER_IDS.overtureBuildings &&
      visible &&
      this.cesium
    ) {
      // The camera may have moved while the layer was disabled.
      this.handleCameraMoveEnd(viewer, this.cesium);
      return;
    }

    viewer.scene.requestRender();
  }

  pickFeature(
    screenX: number,
    screenY: number,
  ): unknown | null {
    if (
      !this.viewer ||
      !this.cesium ||
      this.viewer.isDestroyed()
    ) {
      return null;
    }

    return (
      this.viewer.scene.pick(
        new this.cesium.Cartesian2(screenX, screenY),
      ) ?? null
    );
  }
}