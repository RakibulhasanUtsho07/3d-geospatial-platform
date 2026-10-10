
import {
  createBuildingFacadeTexture,
  resolveBuildingVisualStyle,
} from "../buildings/building-style";

import type {
  CameraTarget,
  MapEngine,
  MapEngineCapabilities,
  MapEngineState,
  MapLayer,
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

// Detailed facade rendering is deliberately limited for performance.
const BATCH_SIZE = 200;
const MAX_DETAILED_FACADES = 650;

export class CesiumAdapter implements MapEngine {
  private viewer: CesiumViewer | null = null;
  private cesium: CesiumModule | null = null;

  private baseImageryLayer:
    | import("cesium").ImageryLayer
    | null = null;

  private overtureBuildings: CesiumDataSource | null = null;

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

    viewer.scene.requestRender();

    /*
     * IMPORTANT:
     * Do not await this operation here.
     * Let the map initialize while the building layer loads.
     */
    void this.loadOvertureBuildings(viewer, Cesium).catch(
      (error: unknown) => {
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
  ): Promise<void> {
    try {
      console.info("[Overture] Fetching pilot dataset...");

      const response = await fetch(
        "/api/geospatial/overture-buildings",
        { cache: "no-store" },
      );

      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;

        throw new Error(
          result?.error ??
            `Building API returned HTTP ${response.status}.`,
        );
      }

      const geoJson: unknown = await response.json();

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

      dataSource.name = "Overture 3D Pilot Buildings";

      // Keep the layer hidden until its styles have been prepared.
      dataSource.show = false;
      await viewer.dataSources.add(dataSource);

      if (
        !this.viewer ||
        this.viewer !== viewer ||
        viewer.isDestroyed()
      ) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }

      this.overtureBuildings = dataSource;

      const time = Cesium.JulianDate.now();
      const detailOrigin = Cesium.Cartesian3.fromDegrees(
        DHAKA_CAMERA.longitude,
        DHAKA_CAMERA.latitude,
        0,
      );
      const entities = [...dataSource.entities.values]
        .map((entity) => {
          const hierarchy = entity.polygon?.hierarchy?.getValue(time);
          if (!hierarchy || hierarchy.positions.length < 3) {
            return { entity, distance: Number.POSITIVE_INFINITY };
          }
          const bounds = Cesium.BoundingSphere.fromPoints(hierarchy.positions);
          return {
            entity,
            distance: Cesium.Cartesian3.distance(bounds.center, detailOrigin),
          };
        })
        .sort((left, right) => left.distance - right.distance)
        .map((item) => item.entity);

      let renderedBuildings = 0;
      let renderedParts = 0;
      let renderedWalls = 0;
      let renderedExtrusions = 0;
      let detailedFacades = 0;
      let hiddenParents = 0;
      let hiddenUnderground = 0;
      let invalidPolygons = 0;

      console.info(
        "[Overture] Building features loaded; styling in batches...",
        { totalFeatures: entities.length },
      );

      for (
        let start = 0;
        start < entities.length;
        start += BATCH_SIZE
      ) {
        // A component may have unmounted while this batch was running.
        if (
          !this.viewer ||
          this.viewer !== viewer ||
          viewer.isDestroyed()
        ) {
          return;
        }

        const batch = entities.slice(
          start,
          start + BATCH_SIZE,
        );

        dataSource.entities.suspendEvents();

        try {
          for (const entity of batch) {
            const polygon = entity.polygon;

            if (!polygon) {
              continue;
            }

            const properties = this.readProperties(
              entity,
              time,
            );

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
              this.getPositiveNumber(properties, [
                "_renderPartCount",
              ]) ?? 0;

            // Do not display a full parent and its parts together.
            if (
              role === "building_parent" &&
              partCount > 0
            ) {
              entity.show = false;
              hiddenParents += 1;
              continue;
            }

            const heightInfo =
              this.getBuildingHeight(properties);

            const topHeight =
              heightInfo.baseHeight + heightInfo.meters;

            const visualStyle = resolveBuildingVisualStyle(
              properties,
              entity.id,
              heightInfo.meters,
            );
            const facadeColor =
              Cesium.Color.fromCssColorString(visualStyle.facadeColor) ??
              Cesium.Color.LIGHTGRAY;
            const roofColor =
              Cesium.Color.fromCssColorString(visualStyle.roofColor) ??
              Cesium.Color.GRAY;
            const facadeTexture = createBuildingFacadeTexture(visualStyle);

            const hierarchy =
              polygon.hierarchy?.getValue(time);

            /*
             * The fallback keeps unusual or invalid hierarchy cases
             * visible as ordinary extruded polygons.
             */
            if (
              !hierarchy ||
              hierarchy.positions.length < 3
            ) {
              polygon.height = new Cesium.ConstantProperty(
                heightInfo.baseHeight,
              );

              polygon.extrudedHeight =
                new Cesium.ConstantProperty(topHeight);

              polygon.perPositionHeight =
                new Cesium.ConstantProperty(false);

              polygon.material =
                new Cesium.ColorMaterialProperty(facadeColor);

              polygon.outline =
                new Cesium.ConstantProperty(true);

              polygon.outlineColor =
                new Cesium.ConstantProperty(
                  Cesium.Color.fromCssColorString(
                    WALL_OUTLINE_COLOR,
                  ),
                );

              polygon.closeTop =
                new Cesium.ConstantProperty(true);

              polygon.closeBottom =
                new Cesium.ConstantProperty(true);

              this.renderedBuildingMetadata.set(
                entity.id,
                heightInfo,
              );

              renderedExtrusions += 1;
              invalidPolygons += 1;
              continue;
            }

            const isPart = role === "building_part";

            /*
             * The pilot file places the original core buildings first.
             * Detail those first, plus all supplied building parts.
             */
            const useDetailedFacade =
              facadeTexture !== null &&
              (isPart ||
                detailedFacades < MAX_DETAILED_FACADES);

            if (!useDetailedFacade) {
              // Lightweight extrusion for the remaining buildings.
              polygon.height = new Cesium.ConstantProperty(
                heightInfo.baseHeight,
              );

              polygon.extrudedHeight =
                new Cesium.ConstantProperty(topHeight);

              polygon.perPositionHeight =
                new Cesium.ConstantProperty(false);

              polygon.material =
                new Cesium.ColorMaterialProperty(facadeColor);

              polygon.outline =
                new Cesium.ConstantProperty(true);

              polygon.outlineColor =
                new Cesium.ConstantProperty(
                  Cesium.Color.fromCssColorString(
                    WALL_OUTLINE_COLOR,
                  ),
                );

              polygon.closeTop =
                new Cesium.ConstantProperty(true);

              polygon.closeBottom =
                new Cesium.ConstantProperty(true);

              this.renderedBuildingMetadata.set(
                entity.id,
                heightInfo,
              );

              renderedExtrusions += 1;

              if (isPart) {
                renderedParts += 1;
              } else {
                renderedBuildings += 1;
              }

              continue;
            }

            // Build a closed exterior wall ring.
            const wallPositions: CesiumCartesian3[] = [
              ...hierarchy.positions,
            ];

            const firstPosition = wallPositions[0];
            const lastPosition =
              wallPositions[wallPositions.length - 1];

            if (
              Cesium.Cartesian3.distance(
                firstPosition,
                lastPosition,
              ) > 0.05
            ) {
              wallPositions.push(
                Cesium.Cartesian3.clone(firstPosition),
              );
            }

            const minimumHeights = wallPositions.map(
              () => heightInfo.baseHeight,
            );

            const maximumHeights = wallPositions.map(
              () => topHeight,
            );

            entity.wall = new Cesium.WallGraphics({
              positions: wallPositions,
              minimumHeights,
              maximumHeights,
              fill: new Cesium.ConstantProperty(true),
              outline: new Cesium.ConstantProperty(false),
              material: new Cesium.ImageMaterialProperty({
                image: facadeTexture,
                repeat: this.getFacadeRepeat(
                  wallPositions,
                  heightInfo.meters,
                  Cesium,
                  visualStyle.repeatWidthMeters,
                ),
                // The canvas already contains the chosen facade palette.
                // White avoids tinting the dark window glass with facade paint.
                color: Cesium.Color.WHITE,
                transparent: false,
              }),
            });

            // Keep the polygon as the roof instead of another extrusion.
            polygon.height =
              new Cesium.ConstantProperty(topHeight);

            polygon.extrudedHeight = undefined;

            polygon.perPositionHeight =
              new Cesium.ConstantProperty(false);

            polygon.material =
              new Cesium.ColorMaterialProperty(roofColor);

            polygon.outline =
              new Cesium.ConstantProperty(true);

            polygon.outlineColor =
              new Cesium.ConstantProperty(
                Cesium.Color.fromCssColorString(
                  ROOF_OUTLINE_COLOR,
                ),
              );

            this.renderedBuildingMetadata.set(
              entity.id,
              heightInfo,
            );

            detailedFacades += 1;
            renderedWalls += 1;

            if (isPart) {
              renderedParts += 1;
            } else {
              renderedBuildings += 1;
            }
          }
        } finally {
          dataSource.entities.resumeEvents();
        }

        viewer.scene.requestRender();

        // Yield so the browser can paint and respond to interaction.
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

      // Reveal the fully styled layer.
      dataSource.show = true;
      viewer.scene.requestRender();

      console.info("[Overture] Pilot dataset rendered.", {
        totalFeatures: entities.length,
        renderedBuildings,
        renderedParts,
        renderedWalls,
        detailedFacades,
        renderedExtrusions,
        hiddenParents,
        hiddenUnderground,
        invalidPolygons,
        cameraPrioritized: true,
      });
    } catch (error: unknown) {
      console.error(
        "[Overture] Building rendering failed:",
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
            }
          : String(error),
      );

      throw error;
    }
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
    this.restoreSelectedBuilding();
    this.emitFeatureSelection(null);
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
        const dataSource = this.overtureBuildings;

        if (!picked || !dataSource) {
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

        this.selectedBuilding = entity;
        this.selectedBuildingOriginalMaterial =
          entity.polygon.material;

        this.selectedBuildingOriginalWallMaterial =
          entity.wall?.material ?? null;

        entity.polygon.material =
          new Cesium.ColorMaterialProperty(
            Cesium.Color.CYAN.withAlpha(0.98),
          );

        if (entity.wall) {
          entity.wall.material =
            new Cesium.ColorMaterialProperty(
              Cesium.Color.CYAN.withAlpha(0.98),
            );
        }

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

        this.emitFeatureSelection({
          source: "overture-local-buildings",
          properties: selectedProperties,
          coordinates,
        });

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

    this.clickHandler?.destroy();
    this.clickHandler = null;

    this.featureSelectionListeners.clear();
    this.renderedBuildingMetadata.clear();

    this.baseImageryLayer = null;
    this.overtureBuildings = null;

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

  addLayer(layer: MapLayer): void {
    void layer;
  }

  removeLayer(layerId: string): void {
    void layerId;
  }

  setLayerVisibility(
    layerId: string,
    visible: boolean,
  ): void {
    void layerId;
    void visible;
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