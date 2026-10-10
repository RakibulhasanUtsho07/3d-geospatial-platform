
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

import type { BuildingVisualStyle } from "../buildings/building-style";
import type { NearbyPlace } from "../geospatial/nearby-places.mjs";
import type { PropertyListing } from "../geospatial/property-listings.mjs";

export interface BuildingStyleAssignment {
  featureId: string;
  referenceId: string;
  referenceTitle: string;
  sourceUrl: string;
  license?: string | null;
  usageStatus: string;
  assignedAt: string;
  reportedBuildingMetadata?: Record<string, unknown>;
  style: BuildingVisualStyle;
}

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

  /** Building-center coordinates for camera focus, when geometry permits. */
  focusCoordinates?: GeoCoordinate | null;

  /** Approximate horizontal footprint area derived from polygon geometry. */
  footprintAreaM2?: number | null;
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

export const MAP_LAYER_IDS = {
  baseImagery: "base-imagery",
  roads: "roads",
  overtureBuildings: "overture-buildings",
  nearbyPlaces: "nearby-places",
  propertyListings: "property-listings",
} as const;

export type MapLayerId =
  (typeof MAP_LAYER_IDS)[keyof typeof MAP_LAYER_IDS];

export type MapLayer = {
  id: MapLayerId;
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
  setBuildingStyleAssignments(assignments: BuildingStyleAssignment[]): void;
  previewSelectedBuildingStyle(style: BuildingVisualStyle | null): boolean;
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

  getLayers(): MapLayer[];

  setLayerVisibility(layerId: MapLayerId, visible: boolean): void;

  getGroundCenter(): GeoCoordinate | null;
  setNearbyPlaces(places: NearbyPlace[]): Promise<void>;
  onPlaceSelected(listener: (place: NearbyPlace | null) => void): () => void;

  setPropertyListings(properties: PropertyListing[]): Promise<void>;
  onPropertySelected(listener: (property: PropertyListing | null) => void): () => void;
  setNavigationPath(origin: GeoCoordinate | null, destination: GeoCoordinate | null): void;

  pickFeature(
    screenX: number,
    screenY: number,
  ): unknown | null;
}