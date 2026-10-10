
export type GeoCoordinate = {
  longitude: number;
  latitude: number;
  height?: number;
};

export type CameraTarget = {
  destination: GeoCoordinate;
  heading?: number;
  pitch?: number;
  roll?: number;
  durationMs?: number;
};

export interface MapFeatureSelection {
  source:
    | "cesium-ion-osm-buildings"
    | "overture-local-buildings";

  properties: Record<string, unknown>;

  coordinates: {
    longitude: number;
    latitude: number;
    height: number;
  } | null;
}

export type MapEngineCapabilities = {
  globe: boolean;
  terrain: boolean;
  imagery: boolean;
  threeDTiles: boolean;
  vectorLayers: boolean;
  modelLayers: boolean;
  featurePicking: boolean;
};

export type MapLayer = {
  id: string;
  name: string;
  visible: boolean;
};

export type MapEngineState = {
  center: GeoCoordinate;
  heading: number;
  pitch: number;
  roll: number;
};

export interface MapEngine {
  initialize(container: HTMLElement): Promise<void> | void;

  onFeatureSelected(
    listener: (
      feature: MapFeatureSelection | null,
    ) => void,
  ): () => void;

  clearFeatureSelection(): void;
  destroy(): void;
  resize(): void;

  flyTo(target: CameraTarget): Promise<void> | void;
  getState(): MapEngineState;

  zoomIn(): void;
  zoomOut(): void;

  rotateLeft(stepDegrees?: number): void;
  rotateRight(stepDegrees?: number): void;

  tiltUp(stepDegrees?: number): void;
  tiltDown(stepDegrees?: number): void;

  resetOrientation(): void;

  getCapabilities(): MapEngineCapabilities;

  addLayer(layer: MapLayer): void;
  removeLayer(layerId: string): void;

  setLayerVisibility(
    layerId: string,
    visible: boolean,
  ): void;

  pickFeature(
    screenX: number,
    screenY: number,
  ): unknown | null;
}