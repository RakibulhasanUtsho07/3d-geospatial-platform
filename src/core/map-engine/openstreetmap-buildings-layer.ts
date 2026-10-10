
type CesiumModule = typeof import("cesium");
type CesiumViewer = import("cesium").Viewer;

interface GeographicBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

interface OverpassBuilding {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  geometry?: Array<{
    lat: number;
    lon: number;
  }>;
}

interface BuildingsResponse {
  elements?: OverpassBuilding[];
  error?: string;
}

const MAX_QUERY_HALF_SPAN = 0.01;
const MAX_CAMERA_HEIGHT = 50_000;
const REQUEST_COOLDOWN_MS = 4_000;

export class OpenStreetMapBuildingsLayer {
  private readonly viewer: CesiumViewer;
  private readonly cesium: CesiumModule;

  private removeMoveEndListener:
    | (() => void)
    | null = null;

  private debounceTimer:
    | ReturnType<typeof setTimeout>
    | null = null;

  private activeController: AbortController | null = null;

  private currentRequestKey: string | null = null;
  private lastSuccessfulKey: string | null = null;
  private lastRequestAt = 0;

  private disposed = false;

  private readonly buildingEntityIds = new Set<string>();

  constructor(
    viewer: CesiumViewer,
    cesium: CesiumModule,
  ) {
    this.viewer = viewer;
    this.cesium = cesium;
  }

  /**
   * Begin watching camera movement.
   */
  start(): void {
    if (this.disposed || this.removeMoveEndListener) {
      return;
    }

    this.removeMoveEndListener =
      this.viewer.camera.moveEnd.addEventListener(() => {
        this.scheduleLoad();
      });
  }

  /**
   * Debounce map movement so a drag or zoom
   * does not trigger an API call for every event.
   */
  private scheduleLoad(): void {
    if (this.disposed) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.loadForCurrentView();
    }, 900);
  }

  /**
   * Get a bounded query area around the visible map.
   */
  private getQueryBounds(): GeographicBounds | null {
    const cameraHeight =
      this.viewer.camera.positionCartographic.height;

    // Avoid requesting city-building details while viewing the globe.
    if (cameraHeight > MAX_CAMERA_HEIGHT) {
      return null;
    }

    const rectangle =
      this.viewer.camera.computeViewRectangle(
        this.cesium.Ellipsoid.WGS84,
      );

    if (!rectangle) {
      return null;
    }

    const toDegrees = this.cesium.Math.toDegrees;

    const west = toDegrees(rectangle.west);
    const east = toDegrees(rectangle.east);
    const south = toDegrees(rectangle.south);
    const north = toDegrees(rectangle.north);

    // This first implementation skips views crossing the antimeridian.
    if (
      ![west, east, south, north].every(Number.isFinite) ||
      east <= west ||
      north <= south
    ) {
      return null;
    }

    const centerLongitude = (west + east) / 2;
    const centerLatitude = (south + north) / 2;

    // Restrict query sizes to protect the public data service.
    const longitudeHalfSpan = Math.max(
      0.001,
      Math.min(
        (east - west) / 2,
        MAX_QUERY_HALF_SPAN,
      ),
    );

    const latitudeHalfSpan = Math.max(
      0.001,
      Math.min(
        (north - south) / 2,
        MAX_QUERY_HALF_SPAN,
      ),
    );

    return {
      west: Math.max(
        -180,
        centerLongitude - longitudeHalfSpan,
      ),
      east: Math.min(
        180,
        centerLongitude + longitudeHalfSpan,
      ),
      south: Math.max(
        -85,
        centerLatitude - latitudeHalfSpan,
      ),
      north: Math.min(
        85,
        centerLatitude + latitudeHalfSpan,
      ),
    };
  }

  /**
   * Rounded bounds let nearby view positions reuse loaded data.
   */
  private getBoundsKey(
    bounds: GeographicBounds,
  ): string {
    return [
      bounds.south,
      bounds.west,
      bounds.north,
      bounds.east,
    ]
      .map((value) => value.toFixed(3))
      .join(":");
  }

  /**
   * Fetch building footprints for the current camera view.
   */
  async loadForCurrentView(): Promise<void> {
    if (
      this.disposed ||
      this.viewer.isDestroyed()
    ) {
      return;
    }

    const bounds = this.getQueryBounds();

    if (!bounds) {
      return;
    }

    const key = this.getBoundsKey(bounds);

    if (
      key === this.lastSuccessfulKey ||
      key === this.currentRequestKey
    ) {
      return;
    }

    const now = Date.now();

    if (
      now - this.lastRequestAt <
      REQUEST_COOLDOWN_MS
    ) {
      return;
    }

    // Cancel an older request when a newer viewport is needed.
    this.activeController?.abort();

    const controller = new AbortController();

    this.activeController = controller;
    this.currentRequestKey = key;
    this.lastRequestAt = now;

    try {
      const response = await fetch(
        "/api/geospatial/buildings",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bounds),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const errorBody =
          (await response.json().catch(() => null)) as
            | BuildingsResponse
            | null;

        throw new Error(
          errorBody?.error ??
            `Building API returned HTTP ${response.status}`,
        );
      }

      const result =
        (await response.json()) as BuildingsResponse;

      if (
        controller.signal.aborted ||
        this.disposed ||
        this.viewer.isDestroyed()
      ) {
        return;
      }

      const elements = Array.isArray(result.elements)
        ? result.elements
        : [];

      this.replaceBuildings(elements);
      this.lastSuccessfulKey = key;

      console.info(
        `Loaded ${this.buildingEntityIds.size} OSM 3D buildings.`,
      );
    } catch (error: unknown) {
      if (controller.signal.aborted || this.disposed) {
        return;
      }

      console.warn(
        "OSM building layer could not load:",
        error instanceof Error
          ? error.message
          : String(error),
      );
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }

      if (this.currentRequestKey === key) {
        this.currentRequestKey = null;
      }
    }
  }

  /**
   * Replace previous building entities with the latest result.
   */
  private replaceBuildings(
    elements: OverpassBuilding[],
  ): void {
    this.clearBuildings();

    for (const element of elements) {
      try {
        this.addBuilding(element);
      } catch (error: unknown) {
        // One malformed polygon should not break the whole layer.
        console.warn(
          `Skipped invalid OSM building ${element.id ?? "unknown"}.`,
          error instanceof Error
            ? error.message
            : String(error),
        );
      }
    }
  }

  /**
   * Add one OSM polygon as an extruded Cesium building.
   */
  private addBuilding(
    element: OverpassBuilding,
  ): void {
    const id = element.id;
    const geometry = element.geometry;
    const tags = element.tags;

    if (
      typeof id !== "number" ||
      !Array.isArray(geometry) ||
      geometry.length < 3 ||
      !tags
    ) {
      return;
    }

    const coordinates: Array<{
      lat: number;
      lon: number;
    }> = [];

    for (const point of geometry) {
      if (
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lon) ||
        point.lat < -90 ||
        point.lat > 90 ||
        point.lon < -180 ||
        point.lon > 180
      ) {
        return;
      }

      coordinates.push({
        lat: point.lat,
        lon: point.lon,
      });
    }

    // A polygon ring must close at its first position.
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];

    const isClosed =
      first.lat === last.lat &&
      first.lon === last.lon;

    if (!isClosed) {
      coordinates.push({ ...first });
    }

    if (coordinates.length < 4) {
      return;
    }

    const Cesium = this.cesium;

    const positions = Cesium.Cartesian3.fromDegreesArray(
      coordinates.flatMap((point) => [
        point.lon,
        point.lat,
      ]),
    );

    const heightMeters = this.getBuildingHeight(tags);
    const buildingType = tags.building ?? "yes";

    const color = this.getBuildingColor(buildingType);

    const entityId = `osm-building-footprint-${id}`;

    this.viewer.entities.add({
      id: entityId,

      name:
        tags.name ??
        `OSM Building ${id}`,

      properties: {
        osmId: String(id),
        source: "OpenStreetMap",
        buildingType,
        heightMeters,
        buildingLevels:
          tags["building:levels"] ?? "",
        attribution:
          "© OpenStreetMap contributors",
      },

      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          positions,
        ),

        // The current fallback terrain is an ellipsoid.
        height: 0,
        extrudedHeight: heightMeters,

        material: Cesium.Color
          .fromCssColorString(color)
          .withAlpha(0.92),

        outline: true,

        outlineColor: Cesium.Color
          .fromCssColorString("#344457")
          .withAlpha(0.85),

        closeTop: true,
        closeBottom: true,
      },
    });

    this.buildingEntityIds.add(entityId);
  }

  /**
   * Prefer explicit height, then floor count.
   * A 3-meter floor height is only an estimate.
   */
  private getBuildingHeight(
    tags: Record<string, string>,
  ): number {
    const explicitHeight =
      this.parseHeight(tags.height) ??
      this.parseHeight(tags["building:height"]);

    if (explicitHeight !== null) {
      return this.clampHeight(explicitHeight);
    }

    const levels = Number.parseFloat(
      tags["building:levels"] ?? "",
    );

    if (Number.isFinite(levels) && levels > 0) {
      return this.clampHeight(levels * 3);
    }

    const type = (tags.building ?? "").toLowerCase();

    if (
      type === "garage" ||
      type === "shed" ||
      type === "hut"
    ) {
      return 4;
    }

    // Placeholder height where OSM contains no height information.
    return 9;
  }

  /**
   * Supports plain meters and simple feet values.
   */
  private parseHeight(
    rawValue: string | undefined,
  ): number | null {
    if (!rawValue) {
      return null;
    }

    const value = rawValue
      .trim()
      .toLowerCase()
      .replace(",", ".");

    const match = value.match(
      /^(\d+(?:\.\d+)?)\s*(m|meter|meters|metre|metres|ft|feet|foot)?$/,
    );

    if (!match) {
      return null;
    }

    const numeric = Number.parseFloat(match[1]);
    const unit = match[2];

    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }

    const meters =
      unit === "ft" ||
      unit === "feet" ||
      unit === "foot"
        ? numeric * 0.3048
        : numeric;

    return meters;
  }

  private clampHeight(height: number): number {
    return Math.max(3, Math.min(height, 300));
  }

  private getBuildingColor(
    buildingType: string,
  ): string {
    const type = buildingType.toLowerCase();

    if (
      type.includes("industrial") ||
      type.includes("warehouse")
    ) {
      return "#a8b5c4";
    }

    if (
      type.includes("commercial") ||
      type.includes("retail") ||
      type.includes("office")
    ) {
      return "#8eafc8";
    }

    if (
      type.includes("hospital") ||
      type.includes("school") ||
      type.includes("university")
    ) {
      return "#b8b7d7";
    }

    return "#c3ccd5";
  }

  private clearBuildings(): void {
    if (this.viewer.isDestroyed()) {
      this.buildingEntityIds.clear();
      return;
    }

    for (const id of this.buildingEntityIds) {
      this.viewer.entities.removeById(id);
    }

    this.buildingEntityIds.clear();
  }

  /**
   * Remove listeners, cancel outstanding requests and clean up entities.
   */
  destroy(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.removeMoveEndListener?.();
    this.removeMoveEndListener = null;

    this.activeController?.abort();
    this.activeController = null;

    this.currentRequestKey = null;

    this.clearBuildings();
  }
}