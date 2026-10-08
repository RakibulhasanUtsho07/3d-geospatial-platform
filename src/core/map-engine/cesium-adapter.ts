import type {
  CameraTarget,
  MapEngine,
  MapEngineCapabilities,
  MapEngineState,
  MapLayer,
} from "./types";

import { getCesiumIonToken } from "@/config/cesium";

type CesiumModule = typeof import("cesium");

export class CesiumAdapter implements MapEngine {
  private viewer: import("cesium").Viewer | null = null;

  private cesium: CesiumModule | null = null;

  private baseImageryLayer:
    | import("cesium").ImageryLayer
    | null = null;

  private osmBuildings:
    | import("cesium").Cesium3DTileset
    | null = null;

  async initialize(container: HTMLElement): Promise<void> {
    if (this.viewer) {
      return;
    }

    if (typeof window === "undefined") {
      throw new Error(
        "CesiumAdapter can only be initialized in the browser.",
      );
    }

    // Cesium static assets are served from /public/cesium.
    // This MUST be configured before importing Cesium.
    window.CESIUM_BASE_URL = "/cesium/";

    const Cesium = await import("cesium");

    this.cesium = Cesium;

    const token = getCesiumIonToken();

    Cesium.Ion.defaultAccessToken = token;

    /*
     * IMPORTANT:
     * We intentionally do NOT use:
     *
     * baseLayer: Cesium.ImageryLayer.fromWorldImagery()
     *
     * inside the Viewer constructor.
     *
     * Instead, imagery is added explicitly after Viewer creation.
     * This keeps the imagery layer lifecycle independent from Viewer
     * initialization and avoids the TypeScript issue you encountered.
     */
    const viewer = new Cesium.Viewer(container, {
      terrain: Cesium.Terrain.fromWorldTerrain({}),

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

    /*
     * World imagery
     *
     * fromWorldImagery({}) returns an ImageryLayer.
     * We add it manually to the imagery collection.
     */
    this.baseImageryLayer =
      Cesium.ImageryLayer.fromWorldImagery({});

    viewer.imageryLayers.add(
      this.baseImageryLayer,
    );

    /*
     * Better terrain interaction.
     */
    viewer.scene.globe.depthTestAgainstTerrain = true;

    /*
     * Load global OSM 3D Buildings.
     *
     * Cesium 1.146 typings expect an options object,
     * so we explicitly pass {}.
     */
    try {
      const buildings =
        await Cesium.createOsmBuildingsAsync({});

      if (!this.viewer || viewer.isDestroyed()) {
        buildings.destroy();
        return;
      }

      this.osmBuildings = buildings;

      viewer.scene.primitives.add(
        buildings,
      );
    } catch (error) {
      console.error(
        "Failed to load Cesium OSM Buildings:",
        error,
      );

      /*
       * OSM Buildings failure should not destroy
       * the entire map experience.
       */
    }
  }

  destroy(): void {
    this.osmBuildings = null;
    this.baseImageryLayer = null;

    if (
      this.viewer &&
      !this.viewer.isDestroyed()
    ) {
      this.viewer.destroy();
    }

    this.viewer = null;
    this.cesium = null;
  }

  resize(): void {
    if (
      !this.viewer ||
      this.viewer.isDestroyed()
    ) {
      return;
    }

    this.viewer.resize();
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
      destination:
        this.cesium.Cartesian3.fromDegrees(
          destination.longitude,
          destination.latitude,
          destination.height ?? 1000,
        ),

      orientation: {
        heading:
          this.cesium.Math.toRadians(
            heading,
          ),

        pitch:
          this.cesium.Math.toRadians(
            pitch,
          ),

        roll:
          this.cesium.Math.toRadians(
            roll,
          ),
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
        longitude:
          this.cesium.Math.toDegrees(
            cartographic.longitude,
          ),

        latitude:
          this.cesium.Math.toDegrees(
            cartographic.latitude,
          ),

        height: cartographic.height,
      },

      heading:
        this.viewer.camera.heading,

      pitch:
        this.viewer.camera.pitch,

      roll:
        this.viewer.camera.roll,
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
    /*
     * Layer registry will be implemented
     * in the map-layer subsystem.
     */
    void layer;
  }

  removeLayer(layerId: string): void {
    /*
     * Layer registry will be implemented
     * in the map-layer subsystem.
     */
    void layerId;
  }

  setLayerVisibility(
    layerId: string,
    visible: boolean,
  ): void {
    /*
     * Layer registry will be implemented
     * in the map-layer subsystem.
     */
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

    const position =
      new this.cesium.Cartesian2(
        screenX,
        screenY,
      );

    return (
      this.viewer.scene.pick(position) ??
      null
    );
  }
}