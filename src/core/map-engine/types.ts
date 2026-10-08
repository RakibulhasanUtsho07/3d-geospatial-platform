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

  destroy(): void;

  resize(): void;

  flyTo(target: CameraTarget): Promise<void> | void;

  getState(): MapEngineState;

  getCapabilities(): MapEngineCapabilities;

  addLayer(layer: MapLayer): void;

  removeLayer(layerId: string): void;

  setLayerVisibility(layerId: string, visible: boolean): void;

  pickFeature(screenX: number, screenY: number): unknown | null;
}