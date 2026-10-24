import {
  cacheViewportResponse,
  getCachedViewportResponse,
} from "./viewport-response-cache.mjs";
import {
  shouldAbortViewportRequest,
  shouldContinueViewportLoad,
} from "./viewport-load-policy.mjs";
import type {
  MapPerformanceMetric,
  MapPerformanceOutcome,
} from "./performance-telemetry.mjs";

export type BuildingViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type BuildingViewportRequest = {
  bounds: BuildingViewportBounds | null;
  featureLimit: number | null;
};

type BuildingViewportPerformanceDetails = {
  cacheHit?: boolean;
  featureCount?: number;
  returnedWays?: number;
  statusCode?: number;
};

export type BuildingViewportStageContext = {
  requestedBounds: BuildingViewportBounds | null;
  requestedFeatureLimit: number | null;
  requestRevision: number;
  getIntentRevision: () => number;
};

type CesiumViewer = import("cesium").Viewer;
type CesiumModule = typeof import("cesium");
type CesiumDataSource = import("cesium").GeoJsonDataSource;

type ViewportWorkloadBenchmarkWindow = Window & {
  __MAP_ENGINE_WORKLOAD_BENCHMARK__?: boolean;
};

export type BuildingViewportManagerDependencies = {
  getViewportEndpoint: (
    bounds: BuildingViewportBounds,
    featureLimit: number,
  ) => string;
  isViewerActive: (viewer: CesiumViewer) => boolean;
  isLayerVisible: () => boolean;
  getViewportFeatureLimit: (viewer: CesiumViewer) => number;
  isCurrentDataSource: (dataSource: CesiumDataSource) => boolean;
  recordMapPerformance: (
    metric: MapPerformanceMetric,
    outcome: MapPerformanceOutcome,
    durationMs: number,
    details?: BuildingViewportPerformanceDetails,
  ) => void;
  prepareAndCommit: (
    dataSource: CesiumDataSource,
    context: BuildingViewportStageContext,
  ) => Promise<boolean>;
  reportFollowupError: (
    request: BuildingViewportRequest,
    error: unknown,
  ) => void;
};

const MAX_CACHED_VIEWPORT_RESPONSES = 2;
const FULL_DATASET_ENDPOINT = "/api/geospatial/overture-buildings";

/**
 * Owns viewport fetch/cache, cancellation, staged datasource lifetime and
 * latest-camera-intent coalescing. Geometry styling stays in the adapter as a
 * callback so this class does not couple request lifecycle to building LOD.
 */
export class BuildingViewportManager {
  private loadedBounds: BuildingViewportBounds | null = null;
  private loadedFeatureLimit: number | null = null;
  private loaded = false;
  private loadInProgress = false;
  private loadToken = 0;
  private activeEndpoint: string | null = null;
  private requestAbortController: AbortController | null = null;
  private intentRevision = 0;
  private readonly responseCache = new Map<string, unknown>();
  private pendingRequest: BuildingViewportRequest | null = null;

  getLoadedBounds(): BuildingViewportBounds | null {
    return this.loadedBounds;
  }

  getLoadedFeatureLimit(): number | null {
    return this.loadedFeatureLimit;
  }

  hasLoadedBuildings(): boolean {
    return this.loaded;
  }

  isLoadInProgress(): boolean {
    return this.loadInProgress;
  }

  getIntentRevision(): number {
    return this.intentRevision;
  }

  /**
   * Minimal, coordinate-free lifecycle state for the opt-in browser workload.
   * This does not expose active URLs or feature payloads.
   */
  getRequestLifecycleDiagnostics(): {
    intentRevision: number;
    loadInProgress: boolean;
    hasActiveEndpoint: boolean;
    hasAbortController: boolean;
    hasPendingRequest: boolean;
  } {
    return {
      intentRevision: this.intentRevision,
      loadInProgress: this.loadInProgress,
      hasActiveEndpoint: this.activeEndpoint !== null,
      hasAbortController: this.requestAbortController !== null,
      hasPendingRequest: this.pendingRequest !== null,
    };
  }

  isViewportCoveredByLoadedData(
    bounds: BuildingViewportBounds,
    requiredFeatureLimit: number,
  ): boolean {
    if (!this.loaded) return false;
    // Null loaded bounds mean the uncapped full pilot dataset is active.
    if (this.loadedBounds === null) return true;
    if (!this.boundsContain(this.loadedBounds, bounds)) return false;
    // A closer camera needs a response whose feature budget is at least as high.
    return this.loadedFeatureLimit !== null
      && this.loadedFeatureLimit >= requiredFeatureLimit;
  }

  private boundsContain(
    outer: BuildingViewportBounds,
    inner: BuildingViewportBounds,
  ): boolean {
    const epsilon = 0.00002;
    return inner.west >= outer.west - epsilon
      && inner.south >= outer.south - epsilon
      && inner.east <= outer.east + epsilon
      && inner.north <= outer.north + epsilon;
  }

  private isRequestCurrent(
    requestRevision: number,
    dependencies: BuildingViewportManagerDependencies,
  ): boolean {
    return shouldContinueViewportLoad(
      requestRevision,
      this.intentRevision,
      dependencies.isLayerVisible(),
    );
  }

  queuePendingViewport(
    bounds: BuildingViewportBounds,
    featureLimit: number,
    getEndpoint: BuildingViewportManagerDependencies["getViewportEndpoint"],
  ): void {
    this.pendingRequest = { bounds, featureLimit };
    const nextEndpoint = getEndpoint(bounds, featureLimit);
    if (shouldAbortViewportRequest(this.activeEndpoint, nextEndpoint)) {
      this.intentRevision += 1;
      this.requestAbortController?.abort();
    }
  }

  queuePendingFullDataset(): void {
    this.pendingRequest = { bounds: null, featureLimit: null };
    if (shouldAbortViewportRequest(this.activeEndpoint, FULL_DATASET_ENDPOINT)) {
      this.intentRevision += 1;
      this.requestAbortController?.abort();
    }
  }

  /** Stop network work and invalidate any payload that is already staging. */
  invalidateLayer(): void {
    this.intentRevision += 1;
    this.pendingRequest = null;
    this.requestAbortController?.abort();
  }

  destroy(): void {
    this.intentRevision += 1;
    this.loadToken += 1;
    this.requestAbortController?.abort();
    this.requestAbortController = null;
    this.activeEndpoint = null;
    this.responseCache.clear();
    this.loadedBounds = null;
    this.loadedFeatureLimit = null;
    this.loaded = false;
    this.loadInProgress = false;
    this.pendingRequest = null;
  }

  async load(
    viewer: CesiumViewer,
    Cesium: CesiumModule,
    request: BuildingViewportRequest,
    dependencies: BuildingViewportManagerDependencies,
  ): Promise<void> {
    const requestedBounds = request.bounds;
    const requestedFeatureLimit = requestedBounds
      ? request.featureLimit ?? dependencies.getViewportFeatureLimit(viewer)
      : null;

    if (!dependencies.isViewerActive(viewer) || !dependencies.isLayerVisible()) {
      return;
    }

    if (this.loadInProgress) {
      if (requestedBounds) {
        this.queuePendingViewport(
          requestedBounds,
          requestedFeatureLimit ?? dependencies.getViewportFeatureLimit(viewer),
          dependencies.getViewportEndpoint,
        );
      } else {
        this.queuePendingFullDataset();
      }
      return;
    }

    this.loadInProgress = true;
    const fetchStartedAt = performance.now();
    let fetchTelemetryRecorded = false;
    let cacheHit = false;
    let viewportFeatureCount: number | undefined;
    let stageStartedAt: number | null = null;
    let stageTelemetryRecorded = false;
    const loadToken = ++this.loadToken;
    const requestRevision = this.intentRevision;
    let stagedDataSource: CesiumDataSource | null = null;
    let activeEndpoint: string | null = null;
    let requestController: AbortController | null = null;

    try {
      const endpoint = requestedBounds
        ? dependencies.getViewportEndpoint(
            requestedBounds,
            requestedFeatureLimit ?? dependencies.getViewportFeatureLimit(viewer),
          )
        : FULL_DATASET_ENDPOINT;

      activeEndpoint = endpoint;
      this.activeEndpoint = endpoint;
      requestController = new AbortController();
      this.requestAbortController = requestController;

      // Observe the actual controller owned by this manager only when the
      // browser workload benchmark opts in. The event is coordinate-free at
      // the report boundary: tests hash the endpoint before persisting evidence.
      if (
        typeof window !== "undefined" &&
        (window as ViewportWorkloadBenchmarkWindow).__MAP_ENGINE_WORKLOAD_BENCHMARK__ === true
      ) {
        const diagnosticEndpoint = activeEndpoint;
        requestController.signal.addEventListener("abort", () => {
          window.dispatchEvent(new CustomEvent("map:viewport-request-aborted", {
            detail: {
              atMs: performance.now(),
              endpoint: diagnosticEndpoint,
            },
          }));
        }, { once: true });
      }

      console.info("[Overture] Fetching building viewport...", {
        endpoint,
        viewport: requestedBounds,
      });

      let geoJson: unknown;
      let responseHeaders: Headers | null = null;
      const cachedGeoJson = getCachedViewportResponse(this.responseCache, endpoint);

      if (cachedGeoJson !== undefined) {
        cacheHit = true;
        geoJson = cachedGeoJson;
        console.info("[Overture] Reusing cached viewport payload.", {
          endpoint,
          cacheEntries: this.responseCache.size,
        });
      } else {
        const response = await fetch(endpoint, { signal: requestController.signal });
        responseHeaders = response.headers;
        if (!response.ok) {
          const result = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(result?.error ?? `Building API returned HTTP ${response.status}.`);
        }
        geoJson = await response.json();
        if (!this.isRequestCurrent(requestRevision, dependencies)) return;
        cacheViewportResponse(
          this.responseCache,
          endpoint,
          geoJson,
          MAX_CACHED_VIEWPORT_RESPONSES,
        );
      }

      const featureCollection = geoJson as { features?: unknown[] } | null;
      viewportFeatureCount = featureCollection && Array.isArray(featureCollection.features)
        ? featureCollection.features.length
        : undefined;
      dependencies.recordMapPerformance(
        "viewport.fetch",
        cacheHit ? "cache-hit" : "success",
        performance.now() - fetchStartedAt,
        {
          cacheHit,
          ...(viewportFeatureCount === undefined ? {} : { featureCount: viewportFeatureCount }),
        },
      );
      fetchTelemetryRecorded = true;

      if (!this.isRequestCurrent(requestRevision, dependencies)) return;
      if (this.requestAbortController === requestController) {
        this.requestAbortController = null;
      }
      if (!dependencies.isViewerActive(viewer)) return;

      console.info("[Overture] Viewport API response received.", {
        dataSource: responseHeaders?.get("X-Building-Data-Source"),
        selectedTiles: responseHeaders?.get("X-Building-Tile-Count"),
        candidateFeatures: responseHeaders?.get("X-Building-Candidate-Feature-Count"),
        matchedFeatures: responseHeaders?.get("X-Building-Matched-Feature-Count"),
        returnedFeatures: responseHeaders?.get("X-Building-Feature-Count"),
        featureLimit: responseHeaders?.get("X-Building-Feature-Limit"),
        truncated: responseHeaders?.get("X-Building-Truncated"),
        tileCacheHits: responseHeaders?.get("X-Building-Tile-Cache-Hits"),
      });

      stageStartedAt = performance.now();
      const dataSource = await Cesium.GeoJsonDataSource.load(
        geoJson as Parameters<typeof Cesium.GeoJsonDataSource.load>[0],
        {
          clampToGround: false,
          stroke: Cesium.Color.fromCssColorString("#526575"),
          strokeWidth: 1,
          fill: Cesium.Color.fromCssColorString("#d2d8dc"),
        },
      );

      if (!this.isRequestCurrent(requestRevision, dependencies)) return;
      if (!dependencies.isViewerActive(viewer)) return;

      dataSource.name = requestedBounds
        ? "Overture 3D Viewport Buildings"
        : "Overture 3D Pilot Buildings";
      dataSource.show = false;
      await viewer.dataSources.add(dataSource);
      stagedDataSource = dataSource;

      if (!this.isRequestCurrent(requestRevision, dependencies)) return;
      if (!dependencies.isViewerActive(viewer)) return;

      const committed = await dependencies.prepareAndCommit(dataSource, {
        requestedBounds,
        requestedFeatureLimit,
        requestRevision,
        getIntentRevision: () => this.intentRevision,
      });

      if (!committed || !this.isRequestCurrent(requestRevision, dependencies)) return;

      this.loadedBounds = requestedBounds;
      this.loadedFeatureLimit = requestedFeatureLimit;
      this.loaded = true;
      stagedDataSource = null;
      dependencies.recordMapPerformance(
        "viewport.stage",
        "success",
        performance.now() - (stageStartedAt ?? performance.now()),
        viewportFeatureCount === undefined ? {} : { featureCount: viewportFeatureCount },
      );
      stageTelemetryRecorded = true;
    } catch (error: unknown) {
      const aborted = typeof error === "object" && error !== null
        && "name" in error && error.name === "AbortError";
      if (!fetchTelemetryRecorded) {
        dependencies.recordMapPerformance(
          "viewport.fetch",
          aborted ? "cancelled" : "error",
          performance.now() - fetchStartedAt,
          { cacheHit },
        );
        fetchTelemetryRecorded = true;
      }
      if (stageStartedAt !== null && !stageTelemetryRecorded) {
        dependencies.recordMapPerformance(
          "viewport.stage",
          aborted ? "cancelled" : "error",
          performance.now() - stageStartedAt,
          viewportFeatureCount === undefined ? {} : { featureCount: viewportFeatureCount },
        );
        stageTelemetryRecorded = true;
      }

      if (aborted) {
        console.info("[Overture] Cancelled an obsolete viewport request.", {
          endpoint: activeEndpoint,
        });
      } else {
        console.error(
          "[Overture] Building rendering failed:",
          error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
        );
      }

      if (!aborted) throw error;
    } finally {
      if (!fetchTelemetryRecorded) {
        dependencies.recordMapPerformance(
          "viewport.fetch",
          "cancelled",
          performance.now() - fetchStartedAt,
          { cacheHit },
        );
        fetchTelemetryRecorded = true;
      }
      if (stageStartedAt !== null && !stageTelemetryRecorded) {
        dependencies.recordMapPerformance(
          "viewport.stage",
          "cancelled",
          performance.now() - stageStartedAt,
          viewportFeatureCount === undefined ? {} : { featureCount: viewportFeatureCount },
        );
        stageTelemetryRecorded = true;
      }

      if (
        stagedDataSource &&
        dependencies.isViewerActive(viewer) &&
        !dependencies.isCurrentDataSource(stagedDataSource)
      ) {
        viewer.dataSources.remove(stagedDataSource, true);
      }

      if (this.loadToken === loadToken) {
        if (this.requestAbortController === requestController) {
          this.requestAbortController = null;
        }
        if (this.activeEndpoint === activeEndpoint) {
          this.activeEndpoint = null;
        }
        this.loadInProgress = false;

        const pendingRequest = this.pendingRequest;
        this.pendingRequest = null;

        if (
          pendingRequest &&
          pendingRequest.bounds === null &&
          (!this.loaded || this.loadedBounds !== null)
        ) {
          const nextRequest: BuildingViewportRequest = {
            bounds: null,
            featureLimit: null,
          };
          void this.load(viewer, Cesium, nextRequest, dependencies).catch((error: unknown) =>
            dependencies.reportFollowupError(nextRequest, error)
          );
        } else if (
          pendingRequest?.bounds &&
          !this.isViewportCoveredByLoadedData(
            pendingRequest.bounds,
            pendingRequest.featureLimit ?? dependencies.getViewportFeatureLimit(viewer),
          )
        ) {
          const nextRequest: BuildingViewportRequest = pendingRequest;
          void this.load(viewer, Cesium, nextRequest, dependencies).catch((error: unknown) =>
            dependencies.reportFollowupError(nextRequest, error)
          );
        }
      }
    }
  }
}
