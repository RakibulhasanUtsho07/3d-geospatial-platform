
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
import {
  shouldAbortViewportRequest,
  shouldContinueViewportLoad,
  shouldContinueViewportStage,
  shouldLoadFullDatasetForWideViewport,
} from "./viewport-load-policy.mjs";
import { shouldCancelRoadRequestForCachedViewport } from "./road-network-request-policy.mjs";
import { shouldContinueMapInitialization } from "./map-initialization-policy.mjs";
import { createMapPerformanceTelemetry } from "./performance-telemetry.mjs";
import type {
  MapPerformanceMetric,
  MapPerformanceOutcome,
  MapPerformanceSnapshot,
} from "./performance-telemetry.mjs";
import {
  SHAT_GOMBUJ_CAMERA,
  AHSAN_MANZIL_CAMERA_TARGET,
  AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET,
  AHSAN_MANZIL_CAMERA_RANGE_METERS,
  AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS,
  AHSAN_MANZIL_ORBIT_PITCH_DEGREES,
  AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND,
  AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS,
  AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS,
  AHSAN_MANZIL_GEOREFERENCE,
  selectAhsanManzilLod,
} from "../geospatial/heritage-landmarks.mjs";

import { calculateFootprintAreaM2 } from "../geospatial/footprint-area.mjs";
import { resolveBuildingHeight } from "../buildings/building-height.mjs";
import type { NearbyPlace } from "../geospatial/nearby-places.mjs";
import type { PropertyListing } from "../geospatial/property-listings.mjs";
import type { RoadFeature } from "../geospatial/road-network.mjs";
import { flattenRoadCoordinates } from "../geospatial/flatten-road-coordinates.mjs";
import { selectNearestLodRecords } from "./lod-record-selection.mjs";
import { resolveRoadVisualStyle } from "./road-visual-style.mjs";
import { MAP_LAYER_IDS } from "./types";
import { GeneratedModelLayer } from "./generated-model-layer";
import type {
  BuildingStyleAssignment,
  CameraTarget,
  MapEngine,
  MapEngineCapabilities,
  MapEngineState,
  MapLayer,
  MapLayerId,
  MapFeatureSelection,
  GeneratedModelDefinition,
  GeneratedModelUpdate,
} from "./types";

type CesiumModule = typeof import("cesium");
type CesiumViewer = import("cesium").Viewer;
type CesiumEntity = import("cesium").Entity;
type CesiumDataSource = import("cesium").GeoJsonDataSource;
type CesiumMaterialProperty = import("cesium").MaterialProperty;
type CesiumCartesian3 = import("cesium").Cartesian3;
type CesiumCartesian2 = import("cesium").Cartesian2;

type MapPerformanceDiagnosticsHandle = {
  snapshot: () => MapPerformanceSnapshot;
  reset: () => void;
};

type PerformanceDiagnosticsWindow = Window & {
  __MAP_ENGINE_PERFORMANCE__?: MapPerformanceDiagnosticsHandle;
};

type BuildingProperties = Record<string, unknown>;

type BuildingHeight = {
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
  sourceHeightInfo: BuildingHeight;
  baseHeight: number;
  topHeight: number;
  visualStyle: BuildingVisualStyle;
  /** Baseline render style, which may be an explicitly saved research profile. */
  baseVisualStyle: BuildingVisualStyle;
  /** Source metadata-driven style to return to when a saved assignment is removed. */
  sourceVisualStyle: BuildingVisualStyle;
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
  private initializationRevision = 0;
  private viewer: CesiumViewer | null = null;
  private cesium: CesiumModule | null = null;
  private heritageModel: import("cesium").Model | null = null;
  private heritageModelLod: 1 | 2 | 3 | null = null;
  private heritageModelLoadingLod: 1 | 2 | 3 | null = null;
  private heritageModelLoadToken = 0;
  // Heading 157 approaches from the south-east, matching the reference HTML hero view.
  private ahsanManzilOrbitHeadingDegrees = 157;
  private ahsanManzilOrbitPitchDegrees = AHSAN_MANZIL_ORBIT_PITCH_DEGREES;
  private ahsanManzilOrbitRangeMeters = AHSAN_MANZIL_CAMERA_RANGE_METERS;
  private ahsanManzilOrbitFrame: number | null = null;
  private ahsanManzilOrbitTourActive = false;
  private ahsanManzilOrbitLastTimestamp: number | null = null;
  private ahsanManzilOrbitInputUnsubscribe: (() => void) | null = null;
  private ahsanManzilOrbitStoppedCallback: (() => void) | null = null;
  private heritageManifestAssets: Record<string, string> | null = null;
  private heritageManifestPromise: Promise<Record<string, string>> | null = null;
  private readonly generatedModelLayer = new GeneratedModelLayer(() => this.viewer, () => this.cesium);

  private baseImageryLayer:
    | import("cesium").ImageryLayer
    | null = null;

  private roadNetworkDataSource: import("cesium").CustomDataSource | null = null;
  private readonly roadByEntityId = new Map<string, RoadFeature>();
  private readonly roadSelectionListeners = new Set<(road: RoadFeature | null) => void>();
  private roadRequestAbortController: AbortController | null = null;
  private activeRoadRequestKey: string | null = null;
  private loadedRoadBounds: ViewportBounds | null = null;

  private overtureBuildings: CesiumDataSource | null = null;
  private nearbyPlacesDataSource: import("cesium").CustomDataSource | null = null;
  private nearbyPlacesRevision = 0;
  private readonly nearbyPlaceByEntityId = new Map<string, NearbyPlace>();
  private readonly placeSelectionListeners = new Set<
    (place: NearbyPlace | null) => void
  >();
  private propertyListingsDataSource: import("cesium").CustomDataSource | null = null;
  private readonly propertyByEntityId = new Map<string, PropertyListing>();
  private readonly propertySelectionListeners = new Set<
    (property: PropertyListing | null) => void
  >();
  private propertyNavigationEntity: CesiumEntity | null = null;

  private readonly layerVisibility = new Map<MapLayerId, boolean>([
    [MAP_LAYER_IDS.baseImagery, true],
    [MAP_LAYER_IDS.roads, true],
    [MAP_LAYER_IDS.overtureBuildings, true],
    [MAP_LAYER_IDS.nearbyPlaces, false],
    [MAP_LAYER_IDS.propertyListings, false],
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
  private readonly buildingStyleAssignments = new Map<string, BuildingStyleAssignment>();
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
  private viewportLoadToken = 0;
  private activeViewportEndpoint: string | null = null;
  private viewportRequestAbortController: AbortController | null = null;
  // Invalidates payloads that have left fetch but are still staging as Cesium entities.
  private viewportIntentRevision = 0;
  private readonly viewportResponseCache = new Map<string, unknown>();
  private readonly performanceTelemetry = createMapPerformanceTelemetry();
  private performanceDiagnosticsHandle: MapPerformanceDiagnosticsHandle | null = null;
  // The pending request is the latest camera intent. Null bounds means the
  // full pilot dataset; a null request means no work is queued.
  private pendingViewportRequest: {
    bounds: ViewportBounds | null;
    featureLimit: number | null;
  } | null = null;

  private installMapPerformanceDiagnostics(): void {
    if (typeof window === "undefined" || process.env.NODE_ENV === "production") {
      return;
    }

    const target = window as PerformanceDiagnosticsWindow;
    const handle: MapPerformanceDiagnosticsHandle = {
      snapshot: () => this.performanceTelemetry.getSnapshot(),
      reset: () => this.performanceTelemetry.reset(),
    };
    target.__MAP_ENGINE_PERFORMANCE__ = handle;
    this.performanceDiagnosticsHandle = handle;
  }

  private recordMapPerformance(
    metric: MapPerformanceMetric,
    outcome: MapPerformanceOutcome,
    durationMs: number,
    details: {
      cacheHit?: boolean;
      featureCount?: number;
      returnedWays?: number;
      statusCode?: number;
    } = {},
  ): void {
    const event = this.performanceTelemetry.record(metric, outcome, durationMs, details);
    if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
      window.dispatchEvent(new CustomEvent("map:performance", { detail: event }));
    }
  }

  async initialize(container: HTMLElement): Promise<void> {
    if (this.viewer && !this.viewer.isDestroyed()) {
      return;
    }

    if (typeof window === "undefined") {
      throw new Error(
        "CesiumAdapter can only be initialized in the browser.",
      );
    }

    this.installMapPerformanceDiagnostics();

    // Invalidate overlapping initialize() calls and allow destroy() to cancel
    // an import that has not resolved yet.
    const initializationRevision = ++this.initializationRevision;
    window.CESIUM_BASE_URL = "/cesium/";

    const Cesium = await import("cesium");
    if (!shouldContinueMapInitialization(
      initializationRevision,
      this.initializationRevision,
    )) {
      return;
    }
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
    this.addHeritageLandmarkMarkers(viewer, Cesium);

    // Start directly on the river-facing Rangmahal facade. The separate
    // Full model / Top view presets frame the entire stepped footprint.
    const ahsanManzilCenter = Cesium.Cartesian3.fromDegrees(
      AHSAN_MANZIL_CAMERA_TARGET.longitude,
      AHSAN_MANZIL_CAMERA_TARGET.latitude,
      AHSAN_MANZIL_CAMERA_TARGET.height,
    );
    viewer.camera.lookAt(
      ahsanManzilCenter,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(this.ahsanManzilOrbitHeadingDegrees),
        Cesium.Math.toRadians(this.ahsanManzilOrbitPitchDegrees),
        this.ahsanManzilOrbitRangeMeters,
      ),
    );
    // Release lookAt's local transform so regular Cesium navigation remains free.
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

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

    // Start without the distant Old Dhaka mesh; evaluate it against the current view.
    this.updateHeritageModelLod(viewer, Cesium);
    void this.loadRoadNetwork(viewer, Cesium);

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


  private addHeritageLandmarkMarkers(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): void {
    viewer.entities.add({
      id: "heritage-shat-gombuj-mosque",
      position: Cesium.Cartesian3.fromDegrees(
        SHAT_GOMBUJ_CAMERA.longitude,
        SHAT_GOMBUJ_CAMERA.latitude,
        4,
      ),
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString("#F59E0B"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: "Shat Gombuj Mosque · ষাট গম্বুজ মসজিদ",
        font: "14px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 50000),
      },
      properties: {
        heritageLandmarkId: "shat-gombuj-mosque",
        confidence: "[V]",
        source: "UNESCO published location",
      },
    });

    viewer.entities.add({
      id: "heritage-ahsan-manzil-model-anchor",
      position: Cesium.Cartesian3.fromDegrees(
        AHSAN_MANZIL_GEOREFERENCE.longitude,
        AHSAN_MANZIL_GEOREFERENCE.latitude,
        1,
      ),
      label: {
        text: "Ahsan Manzil · provisional model anchor",
        font: "13px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        fillColor: Cesium.Color.fromCssColorString("#FFF7F7"),
        outlineColor: Cesium.Color.fromCssColorString("#7F1D1D"),
        outlineWidth: 3,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 35000),
      },
      properties: {
        heritageLandmarkId: "ahsan-manzil",
        confidence: AHSAN_MANZIL_GEOREFERENCE.anchorConfidence,
      },
    });
  }


  private getHeritageModelLod(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): 1 | 2 | 3 | null {
    const groundCenter = this.getGroundCenter();
    const cameraPosition = viewer.camera.positionCartographic;
    const center = groundCenter ?? {
      longitude: Cesium.Math.toDegrees(cameraPosition.longitude),
      latitude: Cesium.Math.toDegrees(cameraPosition.latitude),
      height: 0,
    };
    const height = cameraPosition.height;

    const viewPoint = Cesium.Cartesian3.fromDegrees(
      center.longitude,
      center.latitude,
      0,
    );
    const anchor = Cesium.Cartesian3.fromDegrees(
      AHSAN_MANZIL_GEOREFERENCE.longitude,
      AHSAN_MANZIL_GEOREFERENCE.latitude,
      0,
    );
    const distanceMeters = Cesium.Cartesian3.distance(viewPoint, anchor);

    return selectAhsanManzilLod(distanceMeters, height);
  }

  private updateHeritageModelLod(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): void {
    if (this.viewer !== viewer || viewer.isDestroyed()) return;

    const desiredLod = this.getHeritageModelLod(viewer, Cesium);
    if (desiredLod === null) {
      // Invalidate in-flight loads before removing the currently visible model.
      this.heritageModelLoadToken += 1;
      this.heritageModelLoadingLod = null;
      if (this.heritageModel) {
        viewer.scene.primitives.remove(this.heritageModel);
        this.heritageModel = null;
        this.heritageModelLod = null;
        viewer.scene.requestRender();
      }
      return;
    }

    if (this.heritageModelLod === desiredLod && this.heritageModel) {
      if (this.heritageModelLoadingLod !== null) {
        this.heritageModelLoadToken += 1;
        this.heritageModelLoadingLod = null;
      }
      return;
    }
    if (this.heritageModelLoadingLod === desiredLod) return;

    const loadToken = ++this.heritageModelLoadToken;
    this.heritageModelLoadingLod = desiredLod;
    void this.loadAhsanManzilModel(viewer, Cesium, desiredLod, loadToken);
  }

  private async getHeritageManifestAssets(): Promise<Record<string, string>> {
    if (this.heritageManifestAssets) return this.heritageManifestAssets;
    if (this.heritageManifestPromise) return this.heritageManifestPromise;

    this.heritageManifestPromise = (async () => {
      const fallback: Record<string, string> = {
        "1": "/models/ahsan-manzil-lod1.glb",
        "2": "/models/ahsan-manzil-lod2.glb",
        "3": "/models/ahsan-manzil-lod3.glb",
      };
      try {
        const response = await fetch("/models/ahsan-manzil.manifest.json");
        if (!response.ok) return fallback;
        const manifest = await response.json() as {
          entries?: Array<{
            id?: string;
            assets?: Record<string, { uri?: unknown; lod?: unknown }>;
          }>;
        };
        const entry = manifest.entries?.find(
          (item) => item.id === "ahsan-manzil-kumartuli-dhaka",
        );
        if (!entry?.assets) return fallback;

        const result = { ...fallback };
        for (const key of ["lod1", "lod2", "lod3", "default"]) {
          const asset = entry.assets[key];
          if (
            asset &&
            typeof asset.uri === "string" &&
            asset.uri.startsWith("/models/") &&
            !asset.uri.includes("..")
          ) {
            const lod = key === "default" ? 3 : Number(key.slice(3));
            result[String(lod)] = asset.uri;
          }
        }
        this.heritageManifestAssets = result;
        return result;
      } catch {
        return fallback;
      }
    })();

    try {
      const assets = await this.heritageManifestPromise;
      this.heritageManifestAssets = assets;
      return assets;
    } finally {
      this.heritageManifestPromise = null;
    }
  }

  private async loadAhsanManzilModel(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
    lod: 1 | 2 | 3,
    loadToken: number,
  ): Promise<void> {
    let model: import("cesium").Model | null = null;
    try {
      const assets = await this.getHeritageManifestAssets();
      const modelUrl = assets[String(lod)] ?? "/models/ahsan-manzil-lod3.glb";

      const origin = Cesium.Cartesian3.fromDegrees(
        AHSAN_MANZIL_GEOREFERENCE.longitude,
        AHSAN_MANZIL_GEOREFERENCE.latitude,
        0,
      );
      const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
      model = await Cesium.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        // The procedural GLB is Y-up, with +X along the east-west long axis
        // and +Z toward the south / river-front facade.
        upAxis: Cesium.Axis.Y,
        forwardAxis: Cesium.Axis.Z,
      });

      if (
        this.viewer !== viewer ||
        viewer.isDestroyed() ||
        loadToken !== this.heritageModelLoadToken
      ) {
        if (model && !model.isDestroyed()) model.destroy();
        return;
      }

      if (this.heritageModel) {
        viewer.scene.primitives.remove(this.heritageModel);
      }
      viewer.scene.primitives.add(model);
      this.heritageModel = model;
      this.heritageModelLod = lod;
      this.heritageModelLoadingLod = null;
      viewer.scene.requestRender();
      console.info("[Heritage] Ahsan Manzil LOD loaded at provisional [C] anchor.", {
        lod,
        modelUrl,
        latitude: AHSAN_MANZIL_GEOREFERENCE.latitude,
        longitude: AHSAN_MANZIL_GEOREFERENCE.longitude,
        axisConfidence: AHSAN_MANZIL_GEOREFERENCE.axisConfidence,
      });
    } catch (error: unknown) {
      if (loadToken === this.heritageModelLoadToken) {
        this.heritageModelLoadingLod = null;
      }
      if (model && !model.isDestroyed()) model.destroy();
      console.warn(
        "[Heritage] Ahsan Manzil model could not be loaded; the map remains usable.",
        error instanceof Error ? error.message : String(error),
      );
    }
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
      } else {
        this.queuePendingFullDataset();
      }
      return;
    }

    this.viewportLoadInProgress = true;
    const fetchStartedAt = performance.now();
    let fetchTelemetryRecorded = false;
    let cacheHit = false;
    let viewportFeatureCount: number | undefined;
    let stageStartedAt: number | null = null;
    let stageTelemetryRecorded = false;
    const loadToken = ++this.viewportLoadToken;
    const requestRevision = this.viewportIntentRevision;
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
        cacheHit = true;
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
        if (!this.isViewportLoadCurrent(requestRevision)) return;
        cacheViewportResponse(
          this.viewportResponseCache,
          endpoint,
          geoJson,
          MAX_CACHED_VIEWPORT_RESPONSES,
        );
      }

      const featureCollection = geoJson as { features?: unknown[] } | null;
      viewportFeatureCount = featureCollection && Array.isArray(featureCollection.features)
        ? featureCollection.features.length
        : undefined;
      this.recordMapPerformance(
        "viewport.fetch",
        cacheHit ? "cache-hit" : "success",
        performance.now() - fetchStartedAt,
        {
          cacheHit,
          ...(viewportFeatureCount === undefined ? {} : { featureCount: viewportFeatureCount }),
        },
      );
      fetchTelemetryRecorded = true;

      if (!this.isViewportLoadCurrent(requestRevision)) return;

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

      stageStartedAt = performance.now();
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

      if (!this.isViewportLoadCurrent(requestRevision)) return;

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

      // Hiding the layer or queuing a different viewport while Cesium was
      // staging this datasource makes it obsolete; finally removes it safely.
      if (!this.isViewportLoadCurrent(requestRevision)) return;

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
        // Camera movement or a layer toggle can invalidate a staged viewport
        // after the network request has completed. Stop before preparing more
        // geometry rather than spending CPU on a viewport that cannot commit.
        if (
          !shouldContinueViewportStage(
            requestRevision,
            this.viewportIntentRevision,
            this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings),
            this.viewer === viewer && !viewer.isDestroyed(),
          )
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

            const sourceHeightInfo = this.getBuildingHeight(properties);
            const savedStyleAssignment = this.buildingStyleAssignments.get(entity.id);
            const sourceVisualStyle = resolveBuildingVisualStyle(
              properties,
              entity.id,
              sourceHeightInfo.meters,
            );
            const visualStyle = savedStyleAssignment?.style ?? sourceVisualStyle;
            const heightInfo = this.getResearchAdjustedBuildingHeight(
              sourceHeightInfo,
              savedStyleAssignment?.style,
            );
            const topHeight = heightInfo.baseHeight + heightInfo.meters;
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
              sourceHeightInfo,
              baseHeight: heightInfo.baseHeight,
              topHeight,
              visualStyle,
              baseVisualStyle: visualStyle,
              sourceVisualStyle,
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

      // Re-check after the final animation-frame yield and before replacing the
      // current datasource: an obsolete viewport must never become the active map.
      if (
        !shouldContinueViewportStage(
          requestRevision,
          this.viewportIntentRevision,
          this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings),
          this.viewer === viewer && !viewer.isDestroyed(),
        )
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
      this.recordMapPerformance(
        "viewport.stage",
        "success",
        performance.now() - (stageStartedAt ?? performance.now()),
        { featureCount: entities.length },
      );
      stageTelemetryRecorded = true;

      const facadeColors = [...new Set(lodRecords.map((record) => record.visualStyle.facadeColor.toLowerCase()))].sort();
      const roofColors = [...new Set(lodRecords.map((record) => record.visualStyle.roofColor.toLowerCase()))].sort();
      const visualStyleSummary = {
        facadePatterns: [...new Set(lodRecords.map((record) => record.visualStyle.pattern))].sort(),
        facadeColors: facadeColors.slice(0, 8),
        roofColors: roofColors.slice(0, 8),
        uniqueFacadeColors: facadeColors.length,
        uniqueRoofColors: roofColors.length,
      };

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
        visualStyleSummary,
      });
    } catch (error: unknown) {
      if (!fetchTelemetryRecorded) {
        this.recordMapPerformance(
          "viewport.fetch",
          isAbortError(error) ? "cancelled" : "error",
          performance.now() - fetchStartedAt,
          { cacheHit },
        );
        fetchTelemetryRecorded = true;
      }
      if (stageStartedAt !== null && !stageTelemetryRecorded) {
        this.recordMapPerformance(
          "viewport.stage",
          isAbortError(error) ? "cancelled" : "error",
          performance.now() - stageStartedAt,
          viewportFeatureCount === undefined ? {} : { featureCount: viewportFeatureCount },
        );
        stageTelemetryRecorded = true;
      }

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
      if (!fetchTelemetryRecorded) {
        this.recordMapPerformance(
          "viewport.fetch",
          "cancelled",
          performance.now() - fetchStartedAt,
          { cacheHit },
        );
        fetchTelemetryRecorded = true;
      }
      if (stageStartedAt !== null && !stageTelemetryRecorded) {
        this.recordMapPerformance(
          "viewport.stage",
          "cancelled",
          performance.now() - stageStartedAt,
          viewportFeatureCount === undefined ? {} : { featureCount: viewportFeatureCount },
        );
        stageTelemetryRecorded = true;
      }

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

      // An old load may finish after destroy() and a re-initialize on the same
      // adapter instance. Only the load that still owns this token may mutate
      // shared in-flight state or dispatch the newest queued viewport.
      if (this.viewportLoadToken === loadToken) {
        if (this.viewportRequestAbortController === requestController) {
          this.viewportRequestAbortController = null;
        }
        if (this.activeViewportEndpoint === activeEndpoint) {
          this.activeViewportEndpoint = null;
        }

        this.viewportLoadInProgress = false;

        const pendingRequest = this.pendingViewportRequest;
        this.pendingViewportRequest = null;

        // Always service the latest queued camera intent, even if its predecessor
        // was cancelled or failed. A null-bounds request means the wide view needs
        // the full pilot dataset; never downgrade it to a bounded viewport.
        if (
          pendingRequest &&
          pendingRequest.bounds === null &&
          (!this.hasLoadedBuildings || this.loadedViewportBounds !== null)
        ) {
          void this.loadOvertureBuildings(viewer, Cesium, null).catch(
            (error: unknown) => {
              if (isAbortError(error)) return;
              console.error(
                "[Overture] Follow-up full-dataset load failed.",
                error instanceof Error ? error.message : String(error),
              );
            },
          );
        } else if (
          pendingRequest?.bounds &&
          !this.isViewportCoveredByLoadedData(
            pendingRequest.bounds,
            pendingRequest.featureLimit ??
              getViewportFeatureLimit(viewer.camera.positionCartographic.height),
          )
        ) {
          void this.loadOvertureBuildings(
            viewer,
            Cesium,
            pendingRequest.bounds,
          ).catch((error: unknown) => {
            if (isAbortError(error)) return;
            console.error(
              "[Overture] Follow-up viewport load failed.",
              error instanceof Error ? error.message : String(error),
            );
          });
        }
      }
    }
  }

  private getRoadViewportBounds(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): ViewportBounds {
    const viewBounds = this.getPaddedViewportBounds(viewer, Cesium);
    let west: number;
    let south: number;
    let east: number;
    let north: number;

    if (viewBounds) {
      ({ west, south, east, north } = viewBounds);
    } else {
      const centre = this.getGroundCenter() ?? {
        longitude: AHSAN_MANZIL_GEOREFERENCE.longitude,
        latitude: AHSAN_MANZIL_GEOREFERENCE.latitude,
        height: 0,
      };
      west = centre.longitude - 0.015;
      east = centre.longitude + 0.015;
      south = centre.latitude - 0.012;
      north = centre.latitude + 0.012;
    }

    // Bound the public Overpass request to a local view. Wide city views still
    // show a detailed central road window; zoom in to progressively load more.
    const centreLon = (west + east) / 2;
    const centreLat = (south + north) / 2;
    const halfLon = Math.min((east - west) / 2, 0.017);
    const halfLat = Math.min((north - south) / 2, 0.017);
    return {
      west: Number((centreLon - halfLon).toFixed(6)),
      south: Number((centreLat - halfLat).toFixed(6)),
      east: Number((centreLon + halfLon).toFixed(6)),
      north: Number((centreLat + halfLat).toFixed(6)),
    };
  }

  private roadBoundsContain(
    outer: ViewportBounds,
    inner: ViewportBounds,
  ): boolean {
    const padding = 0.0008;
    return inner.west >= outer.west - padding
      && inner.south >= outer.south - padding
      && inner.east <= outer.east + padding
      && inner.north <= outer.north + padding;
  }

  private async loadRoadNetwork(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): Promise<void> {
    if (
      this.viewer !== viewer ||
      viewer.isDestroyed() ||
      !this.isLayerVisible(MAP_LAYER_IDS.roads)
    ) {
      return;
    }

    const bounds = this.getRoadViewportBounds(viewer, Cesium);
    if (
      this.loadedRoadBounds &&
      this.roadBoundsContain(this.loadedRoadBounds, bounds)
    ) {
      this.recordMapPerformance("roads.coverage", "cache-hit", 0, { cacheHit: true });
      // Reusing rendered geometry is also a new camera intent. Cancel a
      // different viewport request so its late response cannot replace these
      // roads after the camera has returned to the already-covered area.
      const hasActiveRoadRequest =
        this.roadRequestAbortController !== null ||
        this.activeRoadRequestKey !== null;
      if (shouldCancelRoadRequestForCachedViewport(true, hasActiveRoadRequest)) {
        this.roadRequestAbortController?.abort();
        this.roadRequestAbortController = null;
        this.activeRoadRequestKey = null;
      }
      return;
    }

    const requestKey = [
      bounds.west.toFixed(4),
      bounds.south.toFixed(4),
      bounds.east.toFixed(4),
      bounds.north.toFixed(4),
    ].join("|");
    if (this.activeRoadRequestKey === requestKey) return;

    // Camera moves can supersede an in-flight public road query; keep only the
    // newest viewport request and retain the old rendered roads until success.
    this.roadRequestAbortController?.abort();
    const controller = new AbortController();
    this.roadRequestAbortController = controller;
    this.activeRoadRequestKey = requestKey;

    const params = new URLSearchParams({
      west: String(bounds.west),
      south: String(bounds.south),
      east: String(bounds.east),
      north: String(bounds.north),
      limit: "1000",
    });
    const roadFetchStartedAt = performance.now();
    let roadFetchTelemetryRecorded = false;
    let roadRenderStartedAt: number | null = null;
    let roadRenderTelemetryRecorded = false;
    let roadWaysCount: number | undefined;
    let roadCacheHit = false;

    try {
      const response = await fetch(
        "/api/geospatial/roads?" + params.toString(),
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(25_000),
          ]),
        },
      );

      const payload = await response.json() as {
        error?: string;
        results?: RoadFeature[];
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Road network query failed.");
      }
      if (!Array.isArray(payload.results)) {
        throw new Error("Road network API returned invalid GeoJSON-like results.");
      }
      roadWaysCount = payload.results.length;
      const roadCacheStatus = response.headers.get("X-Road-Network-Cache");
      roadCacheHit = roadCacheStatus === "HIT" || roadCacheStatus === "COALESCED";
      this.recordMapPerformance("roads.fetch", "success", performance.now() - roadFetchStartedAt, {
        cacheHit: roadCacheHit,
        returnedWays: roadWaysCount,
        statusCode: response.status,
      });
      roadFetchTelemetryRecorded = true;

      if (
        this.viewer !== viewer ||
        viewer.isDestroyed() ||
        this.roadRequestAbortController !== controller ||
        !this.isLayerVisible(MAP_LAYER_IDS.roads)
      ) {
        return;
      }

      roadRenderStartedAt = performance.now();
      let dataSource = this.roadNetworkDataSource;
      if (!dataSource) {
        dataSource = new Cesium.CustomDataSource("OpenStreetMap detailed road network");
        await viewer.dataSources.add(dataSource);
        if (
          this.viewer !== viewer ||
          viewer.isDestroyed() ||
          this.roadRequestAbortController !== controller
        ) {
          viewer.dataSources.remove(dataSource, true);
          return;
        }
        this.roadNetworkDataSource = dataSource;
      }

      // Suspend Cesium collection events while replacing a whole viewport.
      // This coalesces many entity add/remove notifications into one flush.
      dataSource.entities.suspendEvents();
      let renderedRoads = 0;
      const roadStyleSummary = {
        byClass: { arterial: 0, collector: 0, local: 0, path: 0 },
        centreLineRoads: 0,
        taggedSurfaceRoads: 0,
        elevatedRoads: 0,
        tunnelRoads: 0,
      };
      const roadStyleColors = new Set<string>();
      let minimumRoadWidthMeters = Number.POSITIVE_INFINITY;
      let maximumRoadWidthMeters = 0;
      try {
        dataSource.entities.removeAll();
        this.roadByEntityId.clear();
        const labelCandidates = payload.results
          .filter((road) => road.name && (road.roadClass === "arterial" || road.roadClass === "collector"))
          .slice(0, 40);
        const labelIds = new Set(labelCandidates.map((road) => road.id));

        for (const road of payload.results) {
          if (
            !road ||
            !Array.isArray(road.coordinates) ||
            road.coordinates.length < 2 ||
            !Number.isFinite(road.widthMeters)
          ) {
            continue;
          }

          // A preallocated flat buffer avoids one intermediate [lon, lat]
          // array allocation per vertex on large road ways.
          const flattenedCoordinates = flattenRoadCoordinates(road.coordinates);
          if (flattenedCoordinates.length < 4) continue;
          const positions = Cesium.Cartesian3.fromDegreesArray(flattenedCoordinates);
          if (positions.length < 2) continue;

          const visualStyle = resolveRoadVisualStyle(road);
          if (visualStyle.roadClass === "arterial") roadStyleSummary.byClass.arterial += 1;
          else if (visualStyle.roadClass === "collector") roadStyleSummary.byClass.collector += 1;
          else if (visualStyle.roadClass === "local") roadStyleSummary.byClass.local += 1;
          else roadStyleSummary.byClass.path += 1;
          if (visualStyle.hasCentreLine) roadStyleSummary.centreLineRoads += 1;
          if (typeof road.surface === "string" && road.surface.trim()) roadStyleSummary.taggedSurfaceRoads += 1;
          if (visualStyle.renderHeight > 0) roadStyleSummary.elevatedRoads += 1;
          if (visualStyle.renderHeight < 0) roadStyleSummary.tunnelRoads += 1;
          roadStyleColors.add(visualStyle.color.toLowerCase());
          minimumRoadWidthMeters = Math.min(minimumRoadWidthMeters, visualStyle.widthMeters);
          maximumRoadWidthMeters = Math.max(maximumRoadWidthMeters, visualStyle.widthMeters);

          const centerIndex = Math.min(
            road.coordinates.length - 1,
            Math.floor(road.coordinates.length / 2),
          );
          const [labelLongitude, labelLatitude] = road.coordinates[centerIndex];
          const roadColor = Cesium.Color.fromCssColorString(visualStyle.color) ?? Cesium.Color.LIGHTGRAY;
          const roadwayWidth = visualStyle.widthMeters;
          const safeName = road.name
            ? road.name.replace(/[<>\u0000-\u001f\u007f]/g, "").slice(0, 140)
            : null;

          this.roadByEntityId.set(road.id, road);
          dataSource.entities.add({
            id: road.id,
            name: safeName ?? road.highway + " road",
            position: labelIds.has(road.id)
              ? Cesium.Cartesian3.fromDegrees(labelLongitude, labelLatitude, 1)
              : undefined,
            corridor: {
              positions,
              width: roadwayWidth,
              height: visualStyle.renderHeight,
              cornerType: Cesium.CornerType.ROUNDED,
              material: new Cesium.ColorMaterialProperty(
                roadColor.withAlpha(visualStyle.opacity),
              ),
              outline: true,
              outlineColor: new Cesium.ConstantProperty(
                Cesium.Color.fromCssColorString("#344653")?.withAlpha(visualStyle.outlineOpacity) ?? Cesium.Color.GRAY,
              ),
              outlineWidth: 1,
            },
            label: labelIds.has(road.id) && safeName
              ? {
                  text: safeName,
                  font: "11px sans-serif",
                  fillColor: Cesium.Color.WHITE,
                  outlineColor: Cesium.Color.fromCssColorString("#25313D") ?? Cesium.Color.BLACK,
                  outlineWidth: 3,
                  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                  showBackground: true,
                  backgroundColor: Cesium.Color.fromCssColorString("#293746")?.withAlpha(0.82) ?? Cesium.Color.BLACK,
                  pixelOffset: new Cesium.Cartesian2(0, -4),
                  scaleByDistance: new Cesium.NearFarScalar(150, 1, 1800, 0.35),
                  distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5500),
                  disableDepthTestDistance: 1800,
                }
              : undefined,
          });
          renderedRoads += 1;

          // Arterials get a fine centre highlight without adding a thick second road.
          if (visualStyle.hasCentreLine) {
            this.roadByEntityId.set(road.id + "-centre-line", road);
            dataSource.entities.add({
              id: road.id + "-centre-line",
              name: (safeName ?? "Road") + " centre detail",
              polyline: {
                positions,
                width: 1.2,
                material: Cesium.Color.fromCssColorString("#F2F6F8")?.withAlpha(0.64) ?? Cesium.Color.WHITE,
                clampToGround: true,
              },
            });
          }
        }
      } finally {
        dataSource.entities.resumeEvents();
      }

      dataSource.show = this.isLayerVisible(MAP_LAYER_IDS.roads);
      this.loadedRoadBounds = bounds;
      viewer.scene.requestRender();
      this.recordMapPerformance("roads.render", "success", performance.now() - (roadRenderStartedAt ?? performance.now()), {
        returnedWays: payload.results.length,
      });
      roadRenderTelemetryRecorded = true;
      console.info("[Roads] Vector road viewport rendered.", {
        requested: bounds,
        returnedWays: payload.results.length,
        renderedWays: renderedRoads,
        labelledRoads: Math.min(40, payload.results.filter((road) =>
          road.name && (road.roadClass === "arterial" || road.roadClass === "collector")
        ).length),
        styleSummary: {
          ...roadStyleSummary,
          uniqueColors: roadStyleColors.size,
          minWidthMeters: renderedRoads > 0 ? Number(minimumRoadWidthMeters.toFixed(2)) : null,
          maxWidthMeters: renderedRoads > 0 ? Number(maximumRoadWidthMeters.toFixed(2)) : null,
        },
        attribution: "© OpenStreetMap contributors",
      });
    } catch (error: unknown) {
      const roadWasCancelled = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
      if (!roadFetchTelemetryRecorded) {
        this.recordMapPerformance(
          "roads.fetch",
          roadWasCancelled ? "cancelled" : "error",
          performance.now() - roadFetchStartedAt,
          { cacheHit: roadCacheHit },
        );
        roadFetchTelemetryRecorded = true;
      }
      if (roadRenderStartedAt !== null && !roadRenderTelemetryRecorded) {
        this.recordMapPerformance(
          "roads.render",
          roadWasCancelled ? "cancelled" : "error",
          performance.now() - roadRenderStartedAt,
          roadWaysCount === undefined ? {} : { returnedWays: roadWaysCount },
        );
        roadRenderTelemetryRecorded = true;
      }
      if (
        !roadWasCancelled &&
        this.viewer === viewer &&
        !viewer.isDestroyed()
      ) {
        console.warn("[Roads] Detailed road layer could not refresh.", error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!roadFetchTelemetryRecorded) {
        this.recordMapPerformance(
          "roads.fetch",
          "cancelled",
          performance.now() - roadFetchStartedAt,
          { cacheHit: roadCacheHit },
        );
        roadFetchTelemetryRecorded = true;
      }
      if (roadRenderStartedAt !== null && !roadRenderTelemetryRecorded) {
        this.recordMapPerformance(
          "roads.render",
          "cancelled",
          performance.now() - roadRenderStartedAt,
          roadWaysCount === undefined ? {} : { returnedWays: roadWaysCount },
        );
        roadRenderTelemetryRecorded = true;
      }
      if (this.roadRequestAbortController === controller) {
        this.roadRequestAbortController = null;
        this.activeRoadRequestKey = null;
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

  private isViewportLoadCurrent(requestRevision: number): boolean {
    return shouldContinueViewportLoad(
      requestRevision,
      this.viewportIntentRevision,
      this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings),
    );
  }

  private queuePendingViewport(
    bounds: ViewportBounds,
    featureLimit: number,
  ): void {
    this.pendingViewportRequest = { bounds, featureLimit };

    const nextEndpoint = this.getViewportEndpoint(bounds, featureLimit);
    if (
      shouldAbortViewportRequest(
        this.activeViewportEndpoint,
        nextEndpoint,
      )
    ) {
      this.viewportIntentRevision += 1;
      this.viewportRequestAbortController?.abort();
    }
  }

  private queuePendingFullDataset(): void {
    this.pendingViewportRequest = { bounds: null, featureLimit: null };

    const nextEndpoint = "/api/geospatial/overture-buildings";
    if (
      shouldAbortViewportRequest(
        this.activeViewportEndpoint,
        nextEndpoint,
      )
    ) {
      this.viewportIntentRevision += 1;
      this.viewportRequestAbortController?.abort();
    }
  }

  private handleCameraMoveEnd(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
  ): void {
    if (this.viewer !== viewer || viewer.isDestroyed()) return;

    this.updateHeritageModelLod(viewer, Cesium);

    if (this.isLayerVisible(MAP_LAYER_IDS.roads)) {
      void this.loadRoadNetwork(viewer, Cesium);
    }

    if (!this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings)) return;

    const requestedBounds = this.getPaddedViewportBounds(viewer, Cesium);

    if (!requestedBounds) {
      // A wide view needs all pilot buildings unless the full dataset is active.
      if (!shouldLoadFullDatasetForWideViewport(
        this.hasLoadedBuildings,
        this.loadedViewportBounds,
      )) {
        this.updateBuildingLod(viewer, Cesium);
        return;
      }

      void this.loadOvertureBuildings(viewer, Cesium, null).catch(
        (error: unknown) => {
          if (isAbortError(error)) return;
          console.error(
            "[Overture] Full-dataset fallback failed.",
            error instanceof Error ? error.message : String(error),
          );
        },
      );
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

    const desiredDetailed = new Set(
      selectNearestLodRecords(
        this.buildingLodRecords,
        detailBudget,
        (record) => (
          record.center && record.wallPositions
            ? Cesium.Cartesian3.distance(record.center, origin)
            : null
        ),
      ),
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

    // Full-height multi-floor textures are expensive. Keep saved profiles
    // lightweight while not selected; render ground/upper-floor separation
    // only for the actively selected building.
    const renderStyle = record.entity === this.selectedBuilding
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
    // Preserve the facade texture so researched source/material colours and
    // temporary design previews remain visible while the building is selected.
    this.selectedBuildingOriginalWallMaterial = null;

    // A translucent roof tint signals selection without replacing the facade.
    entity.polygon.material = new Cesium.ColorMaterialProperty(
      Cesium.Color.CYAN.withAlpha(0.42),
    );
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
    return resolveBuildingHeight(properties);
  }

  private getResearchAdjustedBuildingHeight(
    sourceHeight: BuildingHeight,
    style: BuildingVisualStyle | null | undefined,
  ): BuildingHeight {
    if (
      style &&
      Number.isFinite(style.reportedHeightMeters) &&
      (style.reportedHeightMeters as number) >= 3 &&
      (style.reportedHeightMeters as number) <= 300
    ) {
      const reportedHeight = style.reportedHeightMeters as number;
      return {
        ...sourceHeight,
        meters: reportedHeight,
        source: "reference-reported-height",
        unclampedMeters: reportedHeight,
        heightWasClamped: false,
      };
    }

    if (
      style &&
      Number.isInteger(style.reportedFloorCount) &&
      (style.reportedFloorCount as number) >= 1 &&
      (style.reportedFloorCount as number) <= 100
    ) {
      const estimatedHeight = (style.reportedFloorCount as number) * 3;
      return {
        ...sourceHeight,
        meters: Math.min(300, Math.max(3, estimatedHeight)),
        source: "reference-reported-floors",
        unclampedMeters: estimatedHeight,
        heightWasClamped: estimatedHeight < 3 || estimatedHeight > 300,
      };
    }

    return sourceHeight;
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

    const requestRevision = ++this.nearbyPlacesRevision;
    let dataSource = this.nearbyPlacesDataSource;
    if (!dataSource) {
      const candidate = new Cesium.CustomDataSource("OpenStreetMap Nearby Places");
      await viewer.dataSources.add(candidate);
      if (
        this.viewer !== viewer ||
        viewer.isDestroyed() ||
        requestRevision !== this.nearbyPlacesRevision
      ) {
        viewer.dataSources.remove(candidate, true);
        return;
      }

      // Another concurrent call may have created the shared source first.
      if (this.nearbyPlacesDataSource) {
        viewer.dataSources.remove(candidate, true);
        dataSource = this.nearbyPlacesDataSource;
      } else {
        this.nearbyPlacesDataSource = candidate;
        dataSource = candidate;
      }
    }

    if (requestRevision !== this.nearbyPlacesRevision) return;

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

    // A successful search should make its markers visible immediately;
    // the layer panel can turn them off again without discarding results.
    this.layerVisibility.set(
      MAP_LAYER_IDS.nearbyPlaces,
      places.length > 0,
    );
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
    const selectedRecord = this.buildingLodRecords.find(
      (record) => record.entity === building,
    );
    const originalRoof = this.selectedBuildingOriginalMaterial;
    const originalWall = this.selectedBuildingOriginalWallMaterial;

    if (building?.polygon && originalRoof !== null) {
      building.polygon.material = originalRoof;
    }

    if (building?.wall && originalWall !== null) {
      building.wall.material = originalWall;
    }

    this.selectedBuilding = null;
    this.selectedBuildingOriginalMaterial = null;
    this.selectedBuildingOriginalWallMaterial = null;

    // A preview is a temporary visual treatment. Restore the source-driven
    // style when the selected building is cleared or another feature is picked.
    if (
      selectedRecord &&
      selectedRecord.visualStyle !== selectedRecord.baseVisualStyle &&
      this.cesium
    ) {
      selectedRecord.visualStyle = selectedRecord.baseVisualStyle;
      selectedRecord.heightInfo = this.getResearchAdjustedBuildingHeight(
        selectedRecord.sourceHeightInfo,
        selectedRecord.baseVisualStyle,
      );
      selectedRecord.baseHeight = selectedRecord.heightInfo.baseHeight;
      selectedRecord.topHeight = selectedRecord.heightInfo.baseHeight + selectedRecord.heightInfo.meters;
      this.renderedBuildingMetadata.set(selectedRecord.entity.id, selectedRecord.heightInfo);
      selectedRecord.polygonStyleCache = null;
      selectedRecord.detailedWall = null;
      selectedRecord.roofEquipmentBox = null;
      selectedRecord.roofEquipmentPosition = null;
      selectedRecord.entity.wall = undefined;
      selectedRecord.entity.box = undefined;
      selectedRecord.entity.position = undefined;

      if (selectedRecord.isDetailed) {
        this.applyDetailedBuildingStyle(selectedRecord, this.cesium);
      } else {
        this.applyLightweightBuildingStyle(selectedRecord, this.cesium);
      }
      this.viewer?.scene.requestRender();
    }
  }

  setBuildingStyleAssignments(assignments: BuildingStyleAssignment[]): void {
    this.buildingStyleAssignments.clear();
    for (const assignment of assignments) {
      if (
        !assignment ||
        typeof assignment.featureId !== "string" ||
        !assignment.featureId.trim() ||
        !assignment.style ||
        !/^#[0-9a-f]{6}$/i.test(assignment.style.facadeColor) ||
        !/^#[0-9a-f]{6}$/i.test(assignment.style.roofColor) ||
        !/^#[0-9a-f]{6}$/i.test(assignment.style.accentColor)
      ) {
        continue;
      }
      this.buildingStyleAssignments.set(assignment.featureId, assignment);
    }

    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (!viewer || !Cesium || viewer.isDestroyed()) return;

    const selectedEntity = this.selectedBuilding;
    this.restoreSelectedBuilding();
    this.selectedBuilding = selectedEntity;
    const dataSource = this.overtureBuildings;
    dataSource?.entities.suspendEvents();

    try {
      for (const record of this.buildingLodRecords) {
        const assignment = this.buildingStyleAssignments.get(record.entity.id);
        const nextBaseline = assignment?.style ?? record.sourceVisualStyle;
        const baselineChanged =
          JSON.stringify(nextBaseline) !== JSON.stringify(record.baseVisualStyle);
        const previewWasActive =
          JSON.stringify(record.visualStyle) !== JSON.stringify(record.baseVisualStyle);
        const nextHeightInfo = this.getResearchAdjustedBuildingHeight(
          record.sourceHeightInfo,
          nextBaseline,
        );
        const heightChanged =
          nextHeightInfo.meters !== record.heightInfo.meters ||
          nextHeightInfo.baseHeight !== record.heightInfo.baseHeight ||
          nextHeightInfo.source !== record.heightInfo.source;

        record.baseVisualStyle = nextBaseline;
        record.heightInfo = nextHeightInfo;
        record.baseHeight = nextHeightInfo.baseHeight;
        record.topHeight = nextHeightInfo.baseHeight + nextHeightInfo.meters;
        this.renderedBuildingMetadata.set(record.entity.id, nextHeightInfo);
        if (!baselineChanged && !previewWasActive && !heightChanged) continue;

        // A saved assignment supersedes a temporary preview. Removing it
        // returns to the source Overture height/floor estimate.
        record.visualStyle = nextBaseline;
        record.polygonStyleCache = null;
        record.detailedWall = null;
        record.roofEquipmentBox = null;
        record.roofEquipmentPosition = null;
        record.entity.wall = undefined;
        record.entity.box = undefined;
        record.entity.position = undefined;

        if (record.entity === selectedEntity || record.isDetailed) {
          this.applyDetailedBuildingStyle(record, Cesium);
        } else {
          this.applyLightweightBuildingStyle(record, Cesium);
        }
      }
    } finally {
      dataSource?.entities.resumeEvents();
    }

    if (selectedEntity) {
      const selectedRecord = this.buildingLodRecords.find((record) => record.entity === selectedEntity);
      if (selectedRecord) this.applySelectionHighlight(selectedEntity, Cesium);
    }
    viewer.scene.requestRender();
  }

  previewSelectedBuildingStyle(style: BuildingVisualStyle | null): boolean {
    const viewer = this.viewer;
    const Cesium = this.cesium;
    const selected = this.selectedBuilding;
    if (!viewer || !Cesium || viewer.isDestroyed() || !selected) return false;

    const record = this.buildingLodRecords.find((item) => item.entity === selected);
    if (!record) return false;

    // Restore any highlighted material before invalidating the cached graphics.
    this.restoreSelectedBuilding();
    record.visualStyle = style ?? record.baseVisualStyle;
    const geometryStyle = style && (
      typeof style.reportedHeightMeters === "number" ||
      typeof style.reportedFloorCount === "number"
    )
      ? style
      : record.baseVisualStyle;
    record.heightInfo = this.getResearchAdjustedBuildingHeight(
      record.sourceHeightInfo,
      geometryStyle,
    );
    record.baseHeight = record.heightInfo.baseHeight;
    record.topHeight = record.heightInfo.baseHeight + record.heightInfo.meters;
    this.renderedBuildingMetadata.set(record.entity.id, record.heightInfo);
    record.polygonStyleCache = null;
    record.detailedWall = null;
    record.roofEquipmentBox = null;
    record.roofEquipmentPosition = null;
    record.entity.wall = undefined;
    record.entity.box = undefined;
    record.entity.position = undefined;

    this.selectedBuilding = record.entity;
    if (record.wallPositions && record.wallPositions.length >= 4) {
      // A selected feature may get detail beyond the normal camera budget so
      // the previewed window/balcony/arch pattern is actually visible.
      this.applyDetailedBuildingStyle(record, Cesium);
    } else {
      this.applyLightweightBuildingStyle(record, Cesium);
    }
    viewer.scene.requestRender();
    return true;
  }

  clearFeatureSelection(): void {
    const hadSelection = this.selectedBuilding !== null;
    this.restoreSelectedBuilding();
    this.emitFeatureSelection(null);
    this.emitPlaceSelection(null);
    this.emitRoadSelection(null);
    this.emitPropertySelection(null);

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
    dataSource: Pick<CesiumDataSource, "entities">,
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

  onRoadSelected(listener: (road: RoadFeature | null) => void): () => void {
    this.roadSelectionListeners.add(listener);
    return () => this.roadSelectionListeners.delete(listener);
  }

  private emitRoadSelection(road: RoadFeature | null): void {
    for (const listener of this.roadSelectionListeners) {
      try {
        listener(road);
      } catch (error: unknown) {
        console.error("[Map] Road selection listener failed:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  onPropertySelected(listener: (property: PropertyListing | null) => void): () => void {
    this.propertySelectionListeners.add(listener);
    return () => this.propertySelectionListeners.delete(listener);
  }

  private emitPropertySelection(property: PropertyListing | null): void {
    for (const listener of this.propertySelectionListeners) {
      try {
        listener(property);
      } catch (error: unknown) {
        console.error(
          "[Map] Property-selection listener failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async setPropertyListings(properties: PropertyListing[]): Promise<void> {
    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (!viewer || !Cesium || viewer.isDestroyed()) return;

    let dataSource = this.propertyListingsDataSource;
    if (!dataSource) {
      dataSource = new Cesium.CustomDataSource("Illustrative Property Listings");
      await viewer.dataSources.add(dataSource);
      if (this.viewer !== viewer || viewer.isDestroyed()) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }
      this.propertyListingsDataSource = dataSource;
    }

    dataSource.entities.removeAll();
    this.propertyByEntityId.clear();
    const rentColor = Cesium.Color.fromCssColorString("#fbbf24") ?? Cesium.Color.YELLOW;
    const labelColor = Cesium.Color.fromCssColorString("#fde68a") ?? Cesium.Color.YELLOW;

    for (const property of properties) {
      const entityId = "property:" + property.id;
      dataSource.entities.add({
        id: entityId,
        name: property.title,
        position: Cesium.Cartesian3.fromDegrees(property.longitude, property.latitude, 3),
        point: {
          pixelSize: 13,
          color: rentColor.withAlpha(0.98),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 1500,
        },
        label: {
          text: "৳" + property.monthlyRentBdt.toLocaleString("en-BD"),
          font: "11px sans-serif",
          fillColor: labelColor,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: 1000,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.65),
        },
      });
      this.propertyByEntityId.set(entityId, property);
    }

    this.layerVisibility.set(MAP_LAYER_IDS.propertyListings, properties.length > 0);
    dataSource.show = this.isLayerVisible(MAP_LAYER_IDS.propertyListings);
    viewer.scene.requestRender();
  }

  setNavigationPath(
    origin: import("./types").GeoCoordinate | null,
    destination: import("./types").GeoCoordinate | null,
  ): void {
    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (!viewer || !Cesium || viewer.isDestroyed()) return;

    if (this.propertyNavigationEntity) {
      viewer.entities.remove(this.propertyNavigationEntity);
      this.propertyNavigationEntity = null;
    }
    if (!origin || !destination) {
      viewer.scene.requestRender();
      return;
    }

    const routeColor = Cesium.Color.fromCssColorString("#22d3ee") ?? Cesium.Color.CYAN;
    this.propertyNavigationEntity = viewer.entities.add({
      id: "selected-property-straight-line",
      name: "Selected property straight-line indicator (not road routing)",
      position: Cesium.Cartesian3.fromDegrees(destination.longitude, destination.latitude, 4),
      point: {
        pixelSize: 15,
        color: Cesium.Color.fromCssColorString("#fbbf24") ?? Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 2000,
      },
      polyline: {
        positions: [
          Cesium.Cartesian3.fromDegrees(origin.longitude, origin.latitude, 3),
          Cesium.Cartesian3.fromDegrees(destination.longitude, destination.latitude, 3),
        ],
        width: 3,
        material: routeColor,
        clampToGround: true,
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
    viewer.scene.requestRender();
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
          this.setNavigationPath(null, null);
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

        const propertySource = this.propertyListingsDataSource;
        const propertyEntity = propertySource
          ? this.getEntityFromPick(picked, Cesium, propertySource)
          : null;
        if (propertyEntity?.point) {
          this.clearFeatureSelection();
          this.emitPropertySelection(this.propertyByEntityId.get(propertyEntity.id) ?? null);
          return;
        }

        const roadSource = this.roadNetworkDataSource;
        const roadEntity = roadSource
          ? this.getEntityFromPick(picked, Cesium, roadSource)
          : null;
        const road = roadEntity ? this.roadByEntityId.get(roadEntity.id) ?? null : null;
        if (road) {
          this.clearFeatureSelection();
          this.emitRoadSelection(road);
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
        this.emitPropertySelection(null);

        this.selectedBuilding = entity;
        this.emitRoadSelection(null);

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
          rendered_height_unclamped_m: heightInfo.unclampedMeters,
          rendered_height_was_clamped: heightInfo.heightWasClamped,
          rendered_base_height_unclamped_m: heightInfo.unclampedBaseHeight,
          rendered_base_height_was_clamped: heightInfo.baseHeightWasClamped,
        };

        const savedArchitectureProfile = this.buildingStyleAssignments.get(entity.id);
        if (savedArchitectureProfile) {
          const sourceGeometryHeight = this.buildingLodRecords.find(
            (record) => record.entity === entity,
          )?.sourceHeightInfo;
          selectedProperties.source_rendered_height_m =
            sourceGeometryHeight?.meters ?? heightInfo.meters;
          selectedProperties.source_height_source =
            sourceGeometryHeight?.source ?? heightInfo.source;
          selectedProperties.architecture_profile_id = savedArchitectureProfile.referenceId;
          selectedProperties.architecture_profile_title = savedArchitectureProfile.referenceTitle;
          selectedProperties.architecture_profile_source = savedArchitectureProfile.sourceUrl;
          selectedProperties.architecture_profile_license = savedArchitectureProfile.license ?? "Not recorded";
          selectedProperties.architecture_profile_confidence =
            "User-confirmed visual association; not survey-verified";
          selectedProperties.architecture_profile_reported_floor_count =
            savedArchitectureProfile.style.reportedFloorCount;
          selectedProperties.architecture_profile_reported_height_m =
            savedArchitectureProfile.style.reportedHeightMeters;
          selectedProperties.architecture_profile_reported_building_area_sqm =
            savedArchitectureProfile.style.reportedBuildingAreaSqM;
          selectedProperties.architecture_profile_reported_metadata =
            savedArchitectureProfile.reportedBuildingMetadata ?? {};
        }

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

        // A saved research profile may use a full-height texture. Force a
        // selected-only detail rebuild so ground-floor arches and upper-floor
        // patterns become visible without keeping large textures for every LOD.
        const selectedRecord = this.buildingLodRecords.find(
          (record) => record.entity === entity,
        );
        if (selectedRecord?.visualStyle.fullHeightTexture && selectedRecord.isDetailed) {
          selectedRecord.detailedWall = null;
          selectedRecord.polygonStyleCache = null;
          selectedRecord.roofEquipmentBox = null;
          selectedRecord.roofEquipmentPosition = null;
          selectedRecord.entity.wall = undefined;
          selectedRecord.entity.box = undefined;
          selectedRecord.entity.position = undefined;
          selectedRecord.isDetailed = false;
        }

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
    if (this.performanceDiagnosticsHandle && typeof window !== "undefined") {
      const target = window as PerformanceDiagnosticsWindow;
      if (target.__MAP_ENGINE_PERFORMANCE__ === this.performanceDiagnosticsHandle) {
        delete target.__MAP_ENGINE_PERFORMANCE__;
      }
      this.performanceDiagnosticsHandle = null;
    }

    // Invalidate a pending dynamic import before it can create a new viewer.
    this.initializationRevision += 1;

    // Do not schedule React state updates during component teardown.
    this.ahsanManzilOrbitStoppedCallback = null;
    this.stopAhsanManzilOrbitTour();
    this.restoreSelectedBuilding();
    this.heritageModelLoadToken += 1;
    this.heritageModel = null;
    this.heritageModelLod = null;
    this.heritageModelLoadingLod = null;
    this.heritageManifestAssets = null;
    this.heritageManifestPromise = null;

    // Invalidate pending generated-model loads before destroying the viewer.
    this.generatedModelLayer.destroy();

    // Prevent requests and any post-fetch staging from surviving teardown.
    this.viewportIntentRevision += 1;
    this.viewportLoadToken += 1;
    this.viewportRequestAbortController?.abort();
    this.viewportRequestAbortController = null;
    this.activeViewportEndpoint = null;
    this.viewportResponseCache.clear();

    this.clickHandler?.destroy();
    this.clickHandler = null;

    this.cameraMoveEndUnsubscribe?.();
    this.cameraMoveEndUnsubscribe = null;

    this.featureSelectionListeners.clear();
    this.buildingStyleAssignments.clear();
    this.roadSelectionListeners.clear();
    this.roadByEntityId.clear();
    this.placeSelectionListeners.clear();
    this.propertySelectionListeners.clear();
    this.nearbyPlaceByEntityId.clear();
    this.propertyByEntityId.clear();
    this.renderedBuildingMetadata.clear();
    this.buildingLodRecords = [];
    this.loadedViewportBounds = null;
    this.loadedViewportFeatureLimit = null;
    this.hasLoadedBuildings = false;
    this.viewportLoadInProgress = false;
    this.pendingViewportRequest = null;
    this.lastLodOrigin = null;
    this.lastLodBudget = null;

    this.baseImageryLayer = null;
    this.roadRequestAbortController?.abort();
    this.roadRequestAbortController = null;
    this.activeRoadRequestKey = null;
    this.loadedRoadBounds = null;
    this.roadNetworkDataSource = null;
    this.overtureBuildings = null;
    this.nearbyPlacesRevision += 1;
    this.nearbyPlacesDataSource = null;
    this.propertyListingsDataSource = null;
    this.propertyNavigationEntity = null;

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

  /**
   * Smoothly frame the entire palace from its river-facing south facade.
   * A bounding sphere is much more reliable than an arbitrary camera altitude
   * for keeping the long facade, stairs, and dome in view at once.
   */
  /** Fit the complete stepped palace footprint from the river-facing side. */
  focusAhsanManzil(durationMs = 1200): void {
    this.stopAhsanManzilOrbitTour();
    this.ahsanManzilOrbitHeadingDegrees = 157;
    this.ahsanManzilOrbitPitchDegrees = AHSAN_MANZIL_ORBIT_PITCH_DEGREES;
    this.ahsanManzilOrbitRangeMeters = AHSAN_MANZIL_CAMERA_RANGE_METERS;
    this.flyToAhsanManzilOrbit(durationMs, "front");
  }

  /** Match the rear-facing camera preset in the reference HTML scene. */
  focusAhsanManzilRear(durationMs = 850): void {
    this.stopAhsanManzilOrbitTour();
    this.ahsanManzilOrbitHeadingDegrees = 9;
    this.ahsanManzilOrbitPitchDegrees = -9;
    this.ahsanManzilOrbitRangeMeters = AHSAN_MANZIL_CAMERA_RANGE_METERS;
    this.flyToAhsanManzilOrbit(durationMs, "front");
  }

  /** Match the east/west side camera preset in the reference HTML scene. */
  focusAhsanManzilSide(durationMs = 850): void {
    this.stopAhsanManzilOrbitTour();
    this.ahsanManzilOrbitHeadingDegrees = 83;
    this.ahsanManzilOrbitPitchDegrees = -10;
    this.ahsanManzilOrbitRangeMeters = AHSAN_MANZIL_CAMERA_RANGE_METERS;
    this.flyToAhsanManzilOrbit(durationMs, "front");
  }

  /**
   * Frame the entire provisional palace footprint in a 3D oblique view.
   * Use this instead of the closer facade view before orbiting the model.
   */
  focusAhsanManzilWhole(durationMs = 900): void {
    this.stopAhsanManzilOrbitTour();
    this.ahsanManzilOrbitHeadingDegrees = 145;
    this.ahsanManzilOrbitPitchDegrees = -19;
    this.ahsanManzilOrbitRangeMeters = AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS;
    this.flyToAhsanManzilOrbit(durationMs, "footprint");
  }

  /** North-up orthographic-like view for checking the full footprint and orientation. */
  focusAhsanManzilTopDown(durationMs = 850): void {
    this.stopAhsanManzilOrbitTour();
    this.ahsanManzilOrbitHeadingDegrees = 0;
    this.ahsanManzilOrbitPitchDegrees = -88.5;
    this.ahsanManzilOrbitRangeMeters = AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS;
    this.flyToAhsanManzilOrbit(durationMs, "footprint");
  }

  /** Orbit around the complete stepped footprint while keeping every wing visible. */
  orbitAhsanManzil(stepDegrees: number): void {
    if (!Number.isFinite(stepDegrees)) return;
    this.stopAhsanManzilOrbitTour();
    this.ahsanManzilOrbitHeadingDegrees =
      ((this.ahsanManzilOrbitHeadingDegrees + stepDegrees) % 360 + 360) % 360;
    this.ahsanManzilOrbitPitchDegrees = AHSAN_MANZIL_ORBIT_PITCH_DEGREES;
    this.ahsanManzilOrbitRangeMeters = AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS;
    this.flyToAhsanManzilOrbit(650, "footprint");
  }

  /** Start a smooth 360-degree guided orbit around the whole palace. */
  startAhsanManzilOrbitTour(onStopped?: () => void): void {
    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (!viewer || !Cesium || viewer.isDestroyed() || this.ahsanManzilOrbitTourActive) return;

    this.ahsanManzilOrbitTourActive = true;
    this.ahsanManzilOrbitStoppedCallback = onStopped ?? null;
    this.ahsanManzilOrbitHeadingDegrees = 157;
    this.ahsanManzilOrbitPitchDegrees = AHSAN_MANZIL_ORBIT_PITCH_DEGREES;
    this.ahsanManzilOrbitRangeMeters = AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS;
    this.ahsanManzilOrbitLastTimestamp = null;
    viewer.camera.cancelFlight();
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    const center = Cesium.Cartesian3.fromDegrees(
      AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET.longitude,
      AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET.latitude,
      AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET.height,
    );

    // Any direct mouse/touch interaction pauses the guided tour so the user
    // can take over instead of fighting an always-moving camera.
    const canvas = viewer.scene.canvas;
    const stopForUserInput = () => this.stopAhsanManzilOrbitTour();
    canvas.addEventListener("pointerdown", stopForUserInput, { passive: true });
    canvas.addEventListener("wheel", stopForUserInput, { passive: true });
    canvas.addEventListener("touchstart", stopForUserInput, { passive: true });
    this.ahsanManzilOrbitInputUnsubscribe = () => {
      canvas.removeEventListener("pointerdown", stopForUserInput);
      canvas.removeEventListener("wheel", stopForUserInput);
      canvas.removeEventListener("touchstart", stopForUserInput);
    };

    const tick = (timestamp: number) => {
      if (!this.ahsanManzilOrbitTourActive) return;
      const activeViewer = this.viewer;
      const activeCesium = this.cesium;
      if (!activeViewer || !activeCesium || activeViewer.isDestroyed()) {
        this.stopAhsanManzilOrbitTour();
        return;
      }

      if (this.ahsanManzilOrbitLastTimestamp !== null) {
        const elapsed = Math.min(50, Math.max(0, timestamp - this.ahsanManzilOrbitLastTimestamp));
        // A complete lap takes about 36 seconds: slow enough to inspect details.
        this.ahsanManzilOrbitHeadingDegrees =
          (this.ahsanManzilOrbitHeadingDegrees + elapsed * AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND / 1000) % 360;
      }
      this.ahsanManzilOrbitLastTimestamp = timestamp;

      activeViewer.camera.lookAt(
        center,
        new activeCesium.HeadingPitchRange(
          activeCesium.Math.toRadians(this.ahsanManzilOrbitHeadingDegrees),
          activeCesium.Math.toRadians(this.ahsanManzilOrbitPitchDegrees),
          this.ahsanManzilOrbitRangeMeters,
        ),
      );
      activeViewer.scene.requestRender();
      this.ahsanManzilOrbitFrame = requestAnimationFrame(tick);
    };

    this.ahsanManzilOrbitFrame = requestAnimationFrame(tick);
  }

  /** Stop guided orbit while preserving the current view. */
  stopAhsanManzilOrbitTour(): void {
    const wasActive = this.ahsanManzilOrbitTourActive;
    this.ahsanManzilOrbitTourActive = false;
    this.ahsanManzilOrbitLastTimestamp = null;
    if (this.ahsanManzilOrbitFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.ahsanManzilOrbitFrame);
    }
    this.ahsanManzilOrbitFrame = null;
    this.ahsanManzilOrbitInputUnsubscribe?.();
    this.ahsanManzilOrbitInputUnsubscribe = null;
    const onStopped = this.ahsanManzilOrbitStoppedCallback;
    this.ahsanManzilOrbitStoppedCallback = null;

    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (viewer && Cesium && !viewer.isDestroyed()) {
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      viewer.scene.requestRender();
    }
    if (wasActive) onStopped?.();
  }

  private flyToAhsanManzilOrbit(
    durationMs: number,
    target: "front" | "footprint" = "front",
  ): void {
    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (!viewer || !Cesium || viewer.isDestroyed()) return;

    const focus = target === "front"
      ? AHSAN_MANZIL_CAMERA_TARGET
      : AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET;
    const center = Cesium.Cartesian3.fromDegrees(
      focus.longitude,
      focus.latitude,
      focus.height,
    );
    // The front target is offset to the dome axis, so a wider sphere keeps
    // the west-set-back Andarmahal in the same camera composition.
    const bounds = new Cesium.BoundingSphere(
      center,
      target === "front"
        ? AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS
        : AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS,
    );
    viewer.camera.flyToBoundingSphere(bounds, {
      duration: Math.max(0, durationMs) / 1000,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(this.ahsanManzilOrbitHeadingDegrees),
        Cesium.Math.toRadians(this.ahsanManzilOrbitPitchDegrees),
        this.ahsanManzilOrbitRangeMeters,
      ),
    });
    viewer.scene.requestRender();
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

  private createGeneratedModelMatrix(definition: GeneratedModelDefinition, Cesium: CesiumModule): import("cesium").Matrix4 {
    const origin = Cesium.Cartes  /** Add one validated GLB model to the existing Cesium map. */
  async addGeneratedModel(definition: GeneratedModelDefinition): Promise<void> {
    return this.generatedModelLayer.add(definition);
  }

  /** Update placement or stage a replacement before removing the old asset. */
  async updateGeneratedModel(id: string, patch: GeneratedModelUpdate): Promise<void> {
    return this.generatedModelLayer.update(id, patch);
  }

  setGeneratedModelVisibility(id: string, visible: boolean): boolean {
    return this.generatedModelLayer.setVisibility(id, visible);
  }

  removeGeneratedModel(id: string): boolean {
    return this.generatedModelLayer.remove(id);
  }

  getGeneratedModelIds(): string[] {
    return this.generatedModelLayer.getIds();
  }

ayers: true,
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
        id: MAP_LAYER_IDS.roads,
        name: "Detailed OSM roads",
        visible: this.isLayerVisible(MAP_LAYER_IDS.roads),
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
      {
        id: MAP_LAYER_IDS.propertyListings,
        name: "Property listings (demo)",
        visible: this.isLayerVisible(MAP_LAYER_IDS.propertyListings),
      },
    ];
  }

  setLayerVisibility(layerId: MapLayerId, visible: boolean): void {
    this.layerVisibility.set(layerId, visible);

    if (layerId === MAP_LAYER_IDS.baseImagery) {
      if (this.baseImageryLayer) {
        this.baseImageryLayer.show = visible;
      }
    } else if (layerId === MAP_LAYER_IDS.roads) {
      if (this.roadNetworkDataSource) {
        this.roadNetworkDataSource.show = visible;
      }
      if (!visible) {
        this.roadRequestAbortController?.abort();
        this.roadRequestAbortController = null;
        this.activeRoadRequestKey = null;
      }
    } else if (layerId === MAP_LAYER_IDS.overtureBuildings) {
      if (this.overtureBuildings) {
        this.overtureBuildings.show = visible;
      }

      if (!visible) {
        // Stop network work and invalidate GeoJSON staging that has already left fetch.
        this.viewportIntentRevision += 1;
        this.pendingViewportRequest = null;
        this.viewportRequestAbortController?.abort();
      }
    } else if (layerId === MAP_LAYER_IDS.nearbyPlaces) {
      if (this.nearbyPlacesDataSource) {
        this.nearbyPlacesDataSource.show = visible;
      }
    } else if (layerId === MAP_LAYER_IDS.propertyListings) {
      if (this.propertyListingsDataSource) {
        this.propertyListingsDataSource.show = visible;
      }
    }

    const viewer = this.viewer;
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    if (layerId === MAP_LAYER_IDS.roads && visible && this.cesium && this.viewer) {
      void this.loadRoadNetwork(this.viewer, this.cesium);
      viewer.scene.requestRender();
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