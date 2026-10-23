
import { resolveBuildingVisualStyle } from "../buildings/building-style";
import type { BuildingVisualStyle } from "../buildings/building-style";
import { getViewportFeatureLimit } from "./viewport-budget.mjs";
import { getDetailedFacadeBudget } from "./lod-detail-budget.mjs";
import {
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

import { resolveBuildingHeight } from "../buildings/building-height.mjs";
import type { NearbyPlace } from "../geospatial/nearby-places.mjs";
import type { PropertyListing } from "../geospatial/property-listings.mjs";
import type { RoadFeature } from "../geospatial/road-network.mjs";
import { flattenRoadCoordinates } from "../geospatial/flatten-road-coordinates.mjs";
import {
  selectDetailedBuildingRecords,
  shouldRecomputeBuildingLod,
} from "./building-lod-policy.mjs";
import { resolveRoadVisualStyle } from "./road-visual-style.mjs";
import { BuildingLodRenderer } from "./building-lod-renderer";
import { BuildingViewportManager } from "./building-viewport-manager";
import type { BuildingViewportStageContext } from "./building-viewport-manager";
import { BuildingSelectionMaterialController } from "./building-selection-material-controller.mjs";
import { resolvePickedEntity } from "./picked-entity-resolution.mjs";
import { resolveFeaturePickRoute } from "./feature-pick-routing.mjs";
import { resolveFeaturePickGeometry } from "./feature-pick-geometry.mjs";
import { dispatchSelectionListeners } from "./dispatch-selection-listeners.mjs";
import { FeaturePickingController } from "./feature-picking-controller.mjs";
import type { BuildingHeightInfo, BuildingLodRecord } from "./building-lod-renderer";
import {
  areBuildingVisualStylesEqual,
  indexBuildingStyleAssignments,
  resolveBuildingStyleBaseline,
  resolvePreviewGeometryStyle,
  shouldReapplyBuildingStyle,
  shouldRenderDetailedForBuildingStyle,
} from "./building-style-assignment-policy.mjs";
import { MAP_LAYER_IDS } from "./types";
import { normalizeGeneratedModelDefinition } from "./generated-model-policy.mjs";
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
type CesiumCartesian3 = import("cesium").Cartesian3;

type MapPerformanceDiagnosticsHandle = {
  snapshot: () => MapPerformanceSnapshot;
  reset: () => void;
};

type PerformanceDiagnosticsWindow = Window & {
  __MAP_ENGINE_PERFORMANCE__?: MapPerformanceDiagnosticsHandle;
};

type BuildingProperties = Record<string, unknown>;

type BuildingHeight = BuildingHeightInfo;



type ViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type FeatureSelectionListener = (
  feature: MapFeatureSelection | null,
) => void;

type GeneratedModelRecord = {
  definition: GeneratedModelDefinition;
  model: import("cesium").Model | null;
  revision: number;
  visibilityRevision: number;
};

// Detail budgets adapt to camera altitude to keep distant city views lightweight.
const BATCH_SIZE = 200;
const LOD_ORIGIN_MOVE_THRESHOLD_METERS = 180;
const VIEWPORT_PADDING_FACTOR = 0.4;
const VIEWPORT_MIN_PADDING_DEGREES = 0.004;
const MAX_VIEWPORT_SPAN_DEGREES = 1.8;

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
  private readonly generatedModels = new Map<string, GeneratedModelRecord>();

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

  private featurePickingController: FeaturePickingController | null = null;

  private selectedBuilding: CesiumEntity | null = null;

  private readonly featureSelectionListeners =
    new Set<FeatureSelectionListener>();

  private readonly renderedBuildingMetadata = new Map<
    string,
    BuildingHeight
  >();

  private buildingLodRecords: BuildingLodRecord[] = [];
  private readonly buildingSelectionMaterials = new BuildingSelectionMaterialController(
    (entity) => this.selectedBuilding === entity,
  );
  private readonly buildingLodRenderer = new BuildingLodRenderer({
    isSelected: (entity) => this.selectedBuilding === entity,
    prepareSelectedBuildingForLodTransition: (record) =>
      this.buildingSelectionMaterials.prepareSelectedBuildingForLodTransition(record),
    applySelectionHighlight: (entity, Cesium) =>
      this.buildingSelectionMaterials.applySelectionHighlight(entity, Cesium),
  });
  private readonly buildingStyleAssignments = new Map<string, BuildingStyleAssignment>();
  private cameraMoveEndUnsubscribe: (() => void) | null = null;
  private lastLodOrigin: CesiumCartesian3 | null = null;
  private lastLodBudget: number | null = null;


  private readonly buildingViewportManager = new BuildingViewportManager();
  private readonly performanceTelemetry = createMapPerformanceTelemetry();
  private performanceDiagnosticsHandle: MapPerformanceDiagnosticsHandle | null = null;
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

  private loadOvertureBuildings(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
    requestedBounds: ViewportBounds | null =
      this.getPaddedViewportBounds(viewer, Cesium),
  ): Promise<void> {
    const requestedFeatureLimit = requestedBounds
      ? getViewportFeatureLimit(viewer.camera.positionCartographic.height)
      : null;

    return this.buildingViewportManager.load(
      viewer,
      Cesium,
      { bounds: requestedBounds, featureLimit: requestedFeatureLimit },
      {
        getViewportEndpoint: (bounds, featureLimit) =>
          this.getViewportEndpoint(bounds, featureLimit),
        isViewerActive: (candidate) =>
          this.viewer === candidate && !candidate.isDestroyed(),
        isLayerVisible: () => this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings),
        getViewportFeatureLimit: (candidate) =>
          getViewportFeatureLimit(candidate.camera.positionCartographic.height),
        isCurrentDataSource: (candidate) => this.overtureBuildings === candidate,
        recordMapPerformance: (metric, outcome, durationMs, details) =>
          this.recordMapPerformance(metric, outcome, durationMs, details),
        prepareAndCommit: (dataSource, context) =>
          this.stageBuildingViewport(viewer, Cesium, dataSource, context),
        reportFollowupError: (request, error) => {
          if (isAbortError(error)) return;
          console.error(
            request.bounds === null
              ? "[Overture] Follow-up full-dataset load failed."
              : "[Overture] Follow-up viewport load failed.",
            error instanceof Error ? error.message : String(error),
          );
        },
      },
    );
  }

  private async stageBuildingViewport(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
    dataSource: CesiumDataSource,
    context: BuildingViewportStageContext,
  ): Promise<boolean> {
    const isCurrent = () => shouldContinueViewportStage(
      context.requestRevision,
      context.getIntentRevision(),
      this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings),
      this.viewer === viewer && !viewer.isDestroyed(),
    );
    if (!isCurrent()) return false;

    const time = Cesium.JulianDate.now();
    const entities = [...dataSource.entities.values];
    const lodRecords: BuildingLodRecord[] = [];
    this.buildingLodRenderer.resetMetrics();

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
          context.requestRevision,
          context.getIntentRevision(),
          this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings),
          this.viewer === viewer && !viewer.isDestroyed(),
        )
      ) {
        return false;
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

          this.buildingLodRenderer.applyLightweightBuildingStyle(record, Cesium);
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
        context.requestRevision,
        context.getIntentRevision(),
        this.isLayerVisible(MAP_LAYER_IDS.overtureBuildings),
        this.viewer === viewer && !viewer.isDestroyed(),
      )
    ) {
      return false;
    }

    const previousDataSource = this.overtureBuildings;

    // Invalidate any selection owned by the outgoing viewport before swapping.
    this.restoreSelectedBuilding();
    this.selectedBuilding = null;
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
      viewport: context.requestedBounds,
      renderedBuildings,
      renderedParts,
      renderedExtrusions,
      detailedFacades: lodRecords.filter((record) => record.isDetailed).length,
      graphicsCache: this.buildingLodRenderer.getMetrics(),
      hiddenParents,
      hiddenUnderground,
      invalidPolygons,
      cameraAwareLod: true,
      visualStyleSummary,
    });

    return true;
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
        this.buildingViewportManager.hasLoadedBuildings(),
        this.buildingViewportManager.getLoadedBounds(),
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

    if (this.buildingViewportManager.isLoadInProgress()) {
      this.buildingViewportManager.queuePendingViewport(
        requestedBounds,
        requiredFeatureLimit,
        (bounds, featureLimit) => this.getViewportEndpoint(bounds, featureLimit),
      );
      return;
    }

    if (
      !this.buildingViewportManager.isViewportCoveredByLoadedData(
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

    if (!shouldRecomputeBuildingLod({
      force,
      originMoved,
      previousBudget: this.lastLodBudget,
      detailBudget,
    })) {
      return;
    }

    this.lastLodOrigin = Cesium.Cartesian3.clone(origin);
    this.lastLodBudget = detailBudget;

    // A selected building stays detailed even if it is outside the current budget.
    const selectedRecord = this.buildingLodRecords.find(
      (record) => record.entity === this.selectedBuilding,
    );

    const desiredDetailed = selectDetailedBuildingRecords(
      this.buildingLodRecords,
      detailBudget,
      (record) => (
        record.center && record.wallPositions
          ? Cesium.Cartesian3.distance(record.center, origin)
          : null
      ),
      selectedRecord,
    );

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
          this.buildingLodRenderer.applyDetailedBuildingStyle(record, Cesium);
        } else {
          this.buildingLodRenderer.applyLightweightBuildingStyle(record, Cesium);
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
      graphicsCache: this.buildingLodRenderer.getMetrics(),
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
    dispatchSelectionListeners(
      this.placeSelectionListeners,
      place,
      (error) => {
        console.error(
          "[Map] Nearby-place selection listener failed:",
          error instanceof Error ? error.message : String(error),
        );
      },
    );
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
    dispatchSelectionListeners(
      this.featureSelectionListeners,
      selection,
      (error) => {
        console.error(
          "[Map] Selection listener failed:",
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  }

  private restoreSelectedBuilding(): void {
    const building = this.selectedBuilding;
    const selectedRecord = this.buildingLodRecords.find(
      (record) => record.entity === building,
    );
    this.buildingSelectionMaterials.restoreSelectedBuilding(building);
    this.selectedBuilding = null;

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
        this.buildingLodRenderer.applyDetailedBuildingStyle(selectedRecord, this.cesium);
      } else {
        this.buildingLodRenderer.applyLightweightBuildingStyle(selectedRecord, this.cesium);
      }
      this.viewer?.scene.requestRender();
    }
  }

  setBuildingStyleAssignments(assignments: BuildingStyleAssignment[]): void {
    this.buildingStyleAssignments.clear();
    for (const [featureId, assignment] of indexBuildingStyleAssignments(assignments)) {
      this.buildingStyleAssignments.set(featureId, assignment);
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
        const nextBaseline = resolveBuildingStyleBaseline(assignment, record.sourceVisualStyle);
        const baselineChanged = !areBuildingVisualStylesEqual(nextBaseline, record.baseVisualStyle);
        const previewWasActive = !areBuildingVisualStylesEqual(record.visualStyle, record.baseVisualStyle);
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
        if (!shouldReapplyBuildingStyle({ baselineChanged, previewWasActive, heightChanged })) continue;

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

        if (shouldRenderDetailedForBuildingStyle({
          isSelected: record.entity === selectedEntity,
          isDetailed: record.isDetailed,
        })) {
          this.buildingLodRenderer.applyDetailedBuildingStyle(record, Cesium);
        } else {
          this.buildingLodRenderer.applyLightweightBuildingStyle(record, Cesium);
        }
      }
    } finally {
      dataSource?.entities.resumeEvents();
    }

    if (selectedEntity) {
      const selectedRecord = this.buildingLodRecords.find((record) => record.entity === selectedEntity);
      if (selectedRecord) this.buildingSelectionMaterials.applySelectionHighlight(selectedEntity, Cesium);
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
    const geometryStyle = resolvePreviewGeometryStyle(style, record.baseVisualStyle);
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
      this.buildingLodRenderer.applyDetailedBuildingStyle(record, Cesium);
    } else {
      this.buildingLodRenderer.applyLightweightBuildingStyle(record, Cesium);
    }
    // Geometry recreation replaces the roof material, so reapply the
    // selection tint only after the new baseline/preview material is installed.
    this.buildingSelectionMaterials.applySelectionHighlight(record.entity, Cesium);
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
    return resolvePickedEntity(
      picked,
      (candidate): candidate is CesiumEntity => candidate instanceof Cesium.Entity,
      (id) => dataSource.entities.getById(id),
    );
  }

  onRoadSelected(listener: (road: RoadFeature | null) => void): () => void {
    this.roadSelectionListeners.add(listener);
    return () => this.roadSelectionListeners.delete(listener);
  }

  private emitRoadSelection(road: RoadFeature | null): void {
    dispatchSelectionListeners(
      this.roadSelectionListeners,
      road,
      (error) => {
        console.error(
          "[Map] Road selection listener failed:",
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  }

  onPropertySelected(listener: (property: PropertyListing | null) => void): () => void {
    this.propertySelectionListeners.add(listener);
    return () => this.propertySelectionListeners.delete(listener);
  }

  private emitPropertySelection(property: PropertyListing | null): void {
    dispatchSelectionListeners(
      this.propertySelectionListeners,
      property,
      (error) => {
        console.error(
          "[Map] Property-selection listener failed:",
          error instanceof Error ? error.message : String(error),
        );
      },
    );
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
    this.featurePickingController?.destroy();
    const controller = new FeaturePickingController({
      createHandler: (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
      leftClickType: Cesium.ScreenSpaceEventType.LEFT_CLICK,
      isActive: () => !viewer.isDestroyed() && this.viewer === viewer,
      onPick: (movement) => this.handleFeaturePick(viewer, Cesium, movement),
    });
    this.featurePickingController = controller;
    controller.attach(viewer.scene.canvas);
  }

  private handleFeaturePick(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
    movement: { position: import("cesium").Cartesian2 },
  ): void {
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

    const route = resolveFeaturePickRoute({
      resolveNearbyPlace: () => {
        const source = this.nearbyPlacesDataSource;
        return source ? this.getEntityFromPick(picked, Cesium, source) : null;
      },
      resolvePropertyListing: () => {
        const source = this.propertyListingsDataSource;
        return source ? this.getEntityFromPick(picked, Cesium, source) : null;
      },
      resolveRoad: () => {
        const source = this.roadNetworkDataSource;
        const roadEntity = source ? this.getEntityFromPick(picked, Cesium, source) : null;
        return roadEntity ? this.roadByEntityId.get(roadEntity.id) ?? null : null;
      },
      resolveBuilding: () => {
        const source = this.overtureBuildings;
        return source ? this.getEntityFromPick(picked, Cesium, source) : null;
      },
    });

    if (route.kind === "nearby-place") {
      this.clearFeatureSelection();
      this.emitPlaceSelection(
        this.nearbyPlaceByEntityId.get(route.entity.id) ?? null,
      );
      return;
    }

    if (route.kind === "property-listing") {
      this.clearFeatureSelection();
      this.emitPropertySelection(
        this.propertyByEntityId.get(route.entity.id) ?? null,
      );
      return;
    }

    if (route.kind === "road") {
      this.clearFeatureSelection();
      this.emitRoadSelection(route.road);
      return;
    }

    if (route.kind !== "building") {
      this.clearFeatureSelection();
      return;
    }

    const entity = route.entity;
    // Keep the type guard at the adapter boundary as route results are
    // intentionally generic and the router must not own selection effects.
    if (!entity.polygon) {
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

    const { coordinates, focusCoordinates, footprintAreaM2 } =
      resolveFeaturePickGeometry({
        viewer,
        Cesium,
        screenPosition: movement.position,
        polygon: entity.polygon,
        baseHeight: heightInfo.baseHeight,
        heightMeters: heightInfo.meters,
      });

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
    this.buildingSelectionMaterials.applySelectionHighlight(entity, Cesium);
    viewer.scene.requestRender();

    console.info(
      "[Map] Overture building selected:",
      selectedProperties,
    );
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
    for (const record of this.generatedModels.values()) record.revision += 1;
    this.generatedModels.clear();

    // Stop requests and invalidate any payload still being staged.
    this.buildingViewportManager.destroy();

    this.featurePickingController?.destroy();
    this.featurePickingController = null;

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
    const origin = Cesium.Cartesian3.fromDegrees(definition.position.longitude, definition.position.latitude, definition.position.height ?? 0);
    const orientation = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians(definition.headingDegrees ?? 0),
      Cesium.Math.toRadians(definition.pitchDegrees ?? 0),
      Cesium.Math.toRadians(definition.rollDegrees ?? 0),
    );
    return Cesium.Transforms.headingPitchRollToFixedFrame(origin, orientation, Cesium.Ellipsoid.WGS84, Cesium.Transforms.eastNorthUpToFixedFrame);
  }

  private resolveGeneratedModelAxis(axis: "X" | "Y" | "Z", Cesium: CesiumModule) {
    if (axis === "X") return Cesium.Axis.X;
    if (axis === "Z") return Cesium.Axis.Z;
    return Cesium.Axis.Y;
  }

  private async createGeneratedModelInstance(definition: GeneratedModelDefinition, viewer: CesiumViewer, Cesium: CesiumModule): Promise<import("cesium").Model> {
    const options = {
      url: definition.url,
      modelMatrix: this.createGeneratedModelMatrix(definition, Cesium),
      scale: definition.scale ?? 1,
      minimumPixelSize: definition.minimumPixelSize ?? 0,
      upAxis: this.resolveGeneratedModelAxis(definition.upAxis ?? "Y", Cesium),
      forwardAxis: this.resolveGeneratedModelAxis(definition.forwardAxis ?? "Z", Cesium),
      ...(definition.maximumScale === undefined ? {} : { maximumScale: definition.maximumScale }),
    };
    const model = await Cesium.Model.fromGltfAsync(options);
    if (this.viewer !== viewer || viewer.isDestroyed()) {
      if (!model.isDestroyed()) model.destroy();
      throw new Error("The map was destroyed while the generated model was loading.");
    }
    return model;
  }

  /** Add one validated GLB model to the existing Cesium map. */
  async addGeneratedModel(definition: GeneratedModelDefinition): Promise<void> {
    const normalized = normalizeGeneratedModelDefinition(definition);
    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (!viewer || !Cesium || viewer.isDestroyed()) throw new Error("The map must be initialized before adding a generated model.");
    if (this.generatedModels.has(normalized.id)) throw new Error("A generated model with ID \"" + normalized.id + "\" already exists.");

    const record: GeneratedModelRecord = { definition: normalized, model: null, revision: 1, visibilityRevision: 0 };
    const revision = record.revision;
    this.generatedModels.set(normalized.id, record);
    let model: import("cesium").Model | null = null;
    try {
      model = await this.createGeneratedModelInstance(normalized, viewer, Cesium);
      if (this.viewer !== viewer || viewer.isDestroyed() || this.generatedModels.get(normalized.id) !== record || record.revision !== revision) {
        if (!model.isDestroyed()) model.destroy();
        return;
      }
      model.show = record.definition.show ?? true;
      viewer.scene.primitives.add(model);
      record.model = model;
      viewer.scene.requestRender();
    } catch (error: unknown) {
      if (model && !model.isDestroyed() && record.model !== model) model.destroy();
      if (this.generatedModels.get(normalized.id) === record && record.model === null) this.generatedModels.delete(normalized.id);
      throw error;
    }
  }

  /** Update placement or stage a replacement before removing the old asset. */
  async updateGeneratedModel(id: string, patch: GeneratedModelUpdate): Promise<void> {
    const record = this.generatedModels.get(id);
    if (!record) throw new Error("Generated model not found: " + id);
    const viewer = this.viewer;
    const Cesium = this.cesium;
    if (!viewer || !Cesium || viewer.isDestroyed()) throw new Error("The map must be initialized before updating a generated model.");
    const nextDefinition = normalizeGeneratedModelDefinition({ ...record.definition, ...patch, id });
    const visibilityRevision = record.visibilityRevision;
    const revision = ++record.revision;

    if (record.model && nextDefinition.url === record.definition.url) {
      record.model.modelMatrix = this.createGeneratedModelMatrix(nextDefinition, Cesium);
      record.model.scale = nextDefinition.scale ?? 1;
      record.model.minimumPixelSize = nextDefinition.minimumPixelSize ?? 0;
      if (nextDefinition.maximumScale !== undefined) record.model.maximumScale = nextDefinition.maximumScale;
      record.model.show = nextDefinition.show ?? true;
      record.definition = nextDefinition;
      viewer.scene.requestRender();
      return;
    }

    let replacement: import("cesium").Model | null = null;
    try {
      replacement = await this.createGeneratedModelInstance(nextDefinition, viewer, Cesium);
      if (this.viewer !== viewer || viewer.isDestroyed() || this.generatedModels.get(id) !== record || record.revision !== revision) {
        if (!replacement.isDestroyed()) replacement.destroy();
        return;
      }
      replacement.show = false;
      viewer.scene.primitives.add(replacement);
      const previous = record.model;
      const desiredShow = record.visibilityRevision !== visibilityRevision
        ? (record.definition.show ?? true)
        : (nextDefinition.show ?? true);
      record.model = replacement;
      record.definition = normalizeGeneratedModelDefinition({ ...nextDefinition, show: desiredShow });
      replacement.show = desiredShow;
      if (previous && !previous.isDestroyed()) viewer.scene.primitives.remove(previous);
      viewer.scene.requestRender();
    } catch (error: unknown) {
      if (replacement && !replacement.isDestroyed() && record.model !== replacement) replacement.destroy();
      throw error;
    }
  }

  setGeneratedModelVisibility(id: string, visible: boolean): boolean {
    const record = this.generatedModels.get(id);
    if (!record) return false;
    if (typeof visible !== "boolean") throw new TypeError("Model visibility must be a boolean.");
    record.visibilityRevision += 1;
    record.definition = normalizeGeneratedModelDefinition({ ...record.definition, show: visible });
    if (record.model && !record.model.isDestroyed()) record.model.show = visible;
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.scene.requestRender();
    return true;
  }

  removeGeneratedModel(id: string): boolean {
    const record = this.generatedModels.get(id);
    if (!record) return false;
    record.revision += 1;
    this.generatedModels.delete(id);
    const viewer = this.viewer;
    if (record.model && !record.model.isDestroyed() && viewer && !viewer.isDestroyed()) {
      viewer.scene.primitives.remove(record.model);
      viewer.scene.requestRender();
    }
    return true;
  }

  getGeneratedModelIds(): string[] {
    return [...this.generatedModels.keys()];
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
        // Stop network work and invalidate any GeoJSON stage already in progress.
        this.buildingViewportManager.invalidateLayer();
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