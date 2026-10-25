import type { RoadFeature } from "../geospatial/road-network.mjs";
import { flattenRoadCoordinates } from "../geospatial/flatten-road-coordinates.mjs";
import { resolveRoadVisualStyle } from "./road-visual-style.mjs";
import {
  shouldCancelRoadRequestForCachedViewport,
  shouldSkipFailedRoadViewportRetry,
} from "./road-network-request-policy.mjs";
import type {
  MapPerformanceMetric,
  MapPerformanceOutcome,
} from "./performance-telemetry.mjs";

type CesiumModule = typeof import("cesium");
type CesiumViewer = import("cesium").Viewer;

const ROAD_FAILURE_COOLDOWN_MS = 60_000;

export type RoadViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type RoadPerformanceDetails = {
  cacheHit?: boolean;
  featureCount?: number;
  returnedWays?: number;
  statusCode?: number;
};

export type RoadLayerManagerDependencies = {
  getRoadViewportBounds: () => RoadViewportBounds;
  isViewerActive: () => boolean;
  isLayerVisible: () => boolean;
  recordMapPerformance: (
    metric: MapPerformanceMetric,
    outcome: MapPerformanceOutcome,
    durationMs: number,
    details?: RoadPerformanceDetails,
  ) => void;
};

/**
 * Owns the rendered road data source and viewport-scoped road requests.
 *
 * The adapter supplies live viewer/layer callbacks; the manager never captures
 * a viewer during construction, so re-initialization cannot revive stale work.
 */
export class RoadLayerManager {
  private roadNetworkDataSource: import("cesium").CustomDataSource | null = null;
  private readonly roadByEntityId = new Map<string, RoadFeature>();
  private roadRequestAbortController: AbortController | null = null;
  private activeRoadRequestKey: string | null = null;
  private loadedRoadBounds: RoadViewportBounds | null = null;
  private lastFailedRoadRequestKey: string | null = null;
  private failedRoadRetryAfterMs = 0;

  getDataSource(): import("cesium").CustomDataSource | null {
    return this.roadNetworkDataSource;
  }

  getRoadByEntityId(entityId: string): RoadFeature | null {
    return this.roadByEntityId.get(entityId) ?? null;
  }

  setVisible(visible: boolean): void {
    if (this.roadNetworkDataSource) {
      this.roadNetworkDataSource.show = visible;
    }
    if (!visible) {
      this.cancelPendingRequest();
      this.clearFailedRequestCooldown();
    }
  }

  private clearFailedRequestCooldown(): void {
    this.lastFailedRoadRequestKey = null;
    this.failedRoadRetryAfterMs = 0;
  }

  cancelPendingRequest(): void {
    this.roadRequestAbortController?.abort();
    this.roadRequestAbortController = null;
    this.activeRoadRequestKey = null;
  }

  destroy(): void {
    this.cancelPendingRequest();
    this.clearFailedRequestCooldown();
    this.roadByEntityId.clear();
    this.loadedRoadBounds = null;
    this.roadNetworkDataSource = null;
  }

  private roadBoundsContain(
    outer: RoadViewportBounds,
    inner: RoadViewportBounds,
  ): boolean {
    const padding = 0.0008;
    return inner.west >= outer.west - padding
      && inner.south >= outer.south - padding
      && inner.east <= outer.east + padding
      && inner.north <= outer.north + padding;
  }

  async load(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
    dependencies: RoadLayerManagerDependencies,
  ): Promise<void> {
    if (
      !dependencies.isViewerActive() ||
      !dependencies.isLayerVisible()
    ) {
      return;
    }

    const bounds = dependencies.getRoadViewportBounds();
    if (
      this.loadedRoadBounds &&
      this.roadBoundsContain(this.loadedRoadBounds, bounds)
    ) {
      dependencies.recordMapPerformance("roads.coverage", "cache-hit", 0, { cacheHit: true });
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
    if (shouldSkipFailedRoadViewportRetry(
      requestKey,
      this.lastFailedRoadRequestKey,
      this.failedRoadRetryAfterMs,
      performance.now(),
    )) {
      console.info("[Roads] Skipping repeated failed viewport request during cooldown.", {
        retryInMs: Math.max(0, Math.ceil(this.failedRoadRetryAfterMs - performance.now())),
      });
      return;
    }

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
      dependencies.recordMapPerformance("roads.fetch", "success", performance.now() - roadFetchStartedAt, {
        cacheHit: roadCacheHit,
        returnedWays: roadWaysCount,
        statusCode: response.status,
      });
      roadFetchTelemetryRecorded = true;

      if (
        !dependencies.isViewerActive() ||
        this.roadRequestAbortController !== controller ||
        !dependencies.isLayerVisible()
      ) {
        return;
      }

      roadRenderStartedAt = performance.now();
      let dataSource = this.roadNetworkDataSource;
      if (!dataSource) {
        dataSource = new Cesium.CustomDataSource("OpenStreetMap detailed road network");
        await viewer.dataSources.add(dataSource);
        if (
          !dependencies.isViewerActive() ||
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

      dataSource.show = dependencies.isLayerVisible();
      this.loadedRoadBounds = bounds;
      this.clearFailedRequestCooldown();
      viewer.scene.requestRender();
      dependencies.recordMapPerformance("roads.render", "success", performance.now() - (roadRenderStartedAt ?? performance.now()), {
        featureCount: renderedRoads,
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
        dependencies.recordMapPerformance(
          "roads.fetch",
          roadWasCancelled ? "cancelled" : "error",
          performance.now() - roadFetchStartedAt,
          { cacheHit: roadCacheHit },
        );
        roadFetchTelemetryRecorded = true;
      }
      if (roadRenderStartedAt !== null && !roadRenderTelemetryRecorded) {
        dependencies.recordMapPerformance(
          "roads.render",
          roadWasCancelled ? "cancelled" : "error",
          performance.now() - roadRenderStartedAt,
          roadWaysCount === undefined ? {} : { returnedWays: roadWaysCount },
        );
        roadRenderTelemetryRecorded = true;
      }
      if (!roadWasCancelled && dependencies.isViewerActive()) {
        this.lastFailedRoadRequestKey = requestKey;
        this.failedRoadRetryAfterMs = performance.now() + ROAD_FAILURE_COOLDOWN_MS;
        console.warn("[Roads] Detailed road layer could not refresh; same-viewport retry is cooling down.", {
          retryCooldownMs: ROAD_FAILURE_COOLDOWN_MS,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (!roadFetchTelemetryRecorded) {
        dependencies.recordMapPerformance(
          "roads.fetch",
          "cancelled",
          performance.now() - roadFetchStartedAt,
          { cacheHit: roadCacheHit },
        );
        roadFetchTelemetryRecorded = true;
      }
      if (roadRenderStartedAt !== null && !roadRenderTelemetryRecorded) {
        dependencies.recordMapPerformance(
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
}
