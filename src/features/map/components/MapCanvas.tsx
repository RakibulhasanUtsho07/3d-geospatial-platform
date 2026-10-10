
"use client";

import { useEffect, useRef, useState } from "react";

import { CameraController } from "@/core/camera";
import { CesiumAdapter } from "@/core/map-engine";
import type { BuildingVisualStyle } from "@/core/buildings/building-style";
import type { BuildingSearchResult } from "@/core/geospatial/building-search.mjs";
import type { NearbyPlace } from "@/core/geospatial/nearby-places.mjs";
import type { PropertyListing } from "@/core/geospatial/property-listings.mjs";
import type { RoadFeature } from "@/core/geospatial/road-network.mjs";
import type {
  BuildingStyleAssignment,
  MapFeatureSelection,
  MapLayer,
} from "@/core/map-engine/types";

import BuildingSearchPanel from "./BuildingSearchPanel";
import NearbyPlacesPanel from "./NearbyPlacesPanel";
import PropertyListingsPanel from "./PropertyListingsPanel";
import MapControls from "./MapControls";
import MapLayersPanel from "./MapLayersPanel";
import BuildingDetailsPanel from "./BuildingDetailsPanel";
import RoadDetailsPanel from "./RoadDetailsPanel";

type MapStatus = "loading" | "ready" | "error";

const EMPTY_STYLE_ASSIGNMENTS: BuildingStyleAssignment[] = [];

interface StylePreviewRequest {
  revision: number;
  style: BuildingVisualStyle | null;
  title?: string;
}

interface MapCanvasProps {
  onSelectedFeatureChange?: (feature: MapFeatureSelection | null) => void;
  stylePreviewRequest?: StylePreviewRequest | null;
  styleAssignments?: BuildingStyleAssignment[];
  onStylePreviewResult?: (applied: boolean, request: StylePreviewRequest) => void;
}

const DHAKA_CAMERA_TARGET = {
  longitude: 90.41,
  latitude: 23.78,
  height: 950,
};

const DHAKA_CAMERA_ORIENTATION = {
  heading: 0,
  pitch: -55,
  roll: 0,
};

export default function MapCanvas({
  onSelectedFeatureChange,
  stylePreviewRequest,
  styleAssignments = EMPTY_STYLE_ASSIGNMENTS,
  onStylePreviewResult,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onSelectedFeatureChangeRef = useRef(onSelectedFeatureChange);
  const onStylePreviewResultRef = useRef(onStylePreviewResult);
  const cameraRef = useRef<CameraController | null>(null);
  const engineRef = useRef<CesiumAdapter | null>(null);

  const [status, setStatus] = useState<MapStatus>("loading");
  const [errorMessage, setErrorMessage] =
    useState<string | null>(null);
  const [selectedFeature, setSelectedFeature] =
    useState<MapFeatureSelection | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<NearbyPlace | null>(null);
  const [selectedRoad, setSelectedRoad] = useState<RoadFeature | null>(null);
  const [selectedProperty, setSelectedProperty] = useState<PropertyListing | null>(null);
  const [nearbyPlaces, setNearbyPlaces] = useState<NearbyPlace[] | null>(null);
  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    onSelectedFeatureChangeRef.current = onSelectedFeatureChange;
  }, [onSelectedFeatureChange]);

  useEffect(() => {
    onStylePreviewResultRef.current = onStylePreviewResult;
  }, [onStylePreviewResult]);

  useEffect(() => {
    const mapContainer = containerRef.current;

    if (!mapContainer) {
      setErrorMessage(
        "The map container is unavailable. Please retry.",
      );
      setStatus("error");
      return;
    }

    const engine = new CesiumAdapter();
    const camera = new CameraController(engine);

    engineRef.current = engine;
    cameraRef.current = camera;
    setLayers(engine.getLayers());

    let cancelled = false;

    const unsubscribeSelection = engine.onFeatureSelected(
      (feature) => {
        if (!cancelled) {
          setSelectedFeature(feature);
          onSelectedFeatureChangeRef.current?.(feature);
          if (feature) {
            setSelectedRoad(null);
            setSelectedPlace(null);
            setSelectedProperty(null);
            engine.setNavigationPath(null, null);
          }
        }
      },
    );
    const unsubscribeRoadSelection = engine.onRoadSelected((road) => {
      if (!cancelled) {
        setSelectedRoad(road);
        if (road) {
          setSelectedFeature(null);
          onSelectedFeatureChangeRef.current?.(null);
          setSelectedPlace(null);
          setSelectedProperty(null);
          engine.setNavigationPath(null, null);
        }
      }
    });
    const unsubscribePlaceSelection = engine.onPlaceSelected((place) => {
      if (!cancelled) {
        setSelectedPlace(place);
        if (place) {
          setSelectedRoad(null);
          setSelectedFeature(null);
          onSelectedFeatureChangeRef.current?.(null);
          setSelectedProperty(null);
          engine.setNavigationPath(null, null);
        }
      }
    });
    const unsubscribePropertySelection = engine.onPropertySelected((property) => {
      if (!cancelled && property) {
        setSelectedRoad(null);
        focusProperty(property);
      }
    });

    async function initialize(container: HTMLDivElement) {
      try {
        setStatus("loading");
        setErrorMessage(null);
        setSelectedFeature(null);
        onSelectedFeatureChangeRef.current?.(null);
        setSelectedRoad(null);
        setSelectedPlace(null);
        setSelectedProperty(null);
        setNearbyPlaces(null);

        await engine.initialize(container);

        if (cancelled) {
          engine.destroy();
          return;
        }

        setLayers(engine.getLayers());

        /*
         * Explicitly position the camera over Dhaka after
         * initialization. No San Francisco/debug target remains.
         */
        engine.flyTo({
          destination: DHAKA_CAMERA_TARGET,
          ...DHAKA_CAMERA_ORIENTATION,
          durationMs: 800,
        });

        setStatus("ready");

        console.info("[MapCanvas] Dhaka map is ready.");
      } catch (error: unknown) {
        console.error(
          "[MapCanvas] Map initialization failed:",
          error,
        );

        if (!cancelled) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Failed to initialize the 3D map.",
          );
          setStatus("error");
        }

        engine.destroy();
      }
    }

    void initialize(mapContainer);

    return () => {
      cancelled = true;

      unsubscribeSelection();
      unsubscribeRoadSelection();
      unsubscribePlaceSelection();
      unsubscribePropertySelection();

      if (cameraRef.current === camera) {
        cameraRef.current = null;
      }

      if (engineRef.current === engine) {
        engineRef.current = null;
      }

      // Destroy the viewer before retry or component unmount.
      engine.destroy();
    };
  }, [retryKey]);

  useEffect(() => {
    engineRef.current?.setBuildingStyleAssignments(styleAssignments);

    setSelectedFeature((current) => {
      if (!current) return current;
      const featureId = current.properties.overture_feature_id;
      const selectedId = typeof featureId === "string" ? featureId : String(featureId ?? "");
      const assignment = styleAssignments.find((item) => item.featureId === selectedId);
      const properties = { ...current.properties };
      const previousAssignmentId = typeof properties.architecture_profile_id === "string"
        ? properties.architecture_profile_id
        : null;

      if (assignment) {
        // Keep the original mapped height/provenance across profile swaps and
        // browser reloads, so removing a profile can restore the baseline.
        if (typeof properties.source_rendered_height_m !== "number") {
          properties.source_rendered_height_m = current.properties.source_rendered_height_m
            ?? current.properties.rendered_height_m;
        }
        if (typeof properties.source_height_source !== "string") {
          properties.source_height_source = current.properties.source_height_source
            ?? current.properties.height_source;
        }
      }

      for (const key of [
        "architecture_profile_id",
        "architecture_profile_title",
        "architecture_profile_source",
        "architecture_profile_license",
        "architecture_profile_confidence",
        "architecture_profile_reported_floor_count",
        "architecture_profile_reported_height_m",
        "architecture_profile_reported_building_area_sqm",
        "architecture_profile_reported_metadata",
      ]) {
        delete properties[key];
      }

      if (assignment) {
        properties.architecture_profile_id = assignment.referenceId;
        properties.architecture_profile_title = assignment.referenceTitle;
        properties.architecture_profile_source = assignment.sourceUrl;
        properties.architecture_profile_license = assignment.license ?? "Not recorded";
        properties.architecture_profile_confidence = "User-confirmed visual association; not survey-verified";
        properties.architecture_profile_reported_floor_count = assignment.style.reportedFloorCount;
        properties.architecture_profile_reported_height_m = assignment.style.reportedHeightMeters;
        properties.architecture_profile_reported_building_area_sqm = assignment.style.reportedBuildingAreaSqM;
        properties.architecture_profile_reported_metadata = assignment.reportedBuildingMetadata ?? {};

        if (typeof assignment.style.reportedHeightMeters === "number") {
          properties.rendered_height_m = assignment.style.reportedHeightMeters;
          properties.height_source = "reference-reported-height";
        } else if (typeof assignment.style.reportedFloorCount === "number") {
          properties.rendered_height_m = assignment.style.reportedFloorCount * 3;
          properties.height_source = "reference-reported-floors";
        } else {
          if (typeof properties.source_rendered_height_m === "number") {
            properties.rendered_height_m = properties.source_rendered_height_m;
          }
          if (typeof properties.source_height_source === "string") {
            properties.height_source = properties.source_height_source;
          }
        }
      } else if (previousAssignmentId) {
        if (typeof properties.source_rendered_height_m === "number") {
          properties.rendered_height_m = properties.source_rendered_height_m;
        }
        if (typeof properties.source_height_source === "string") {
          properties.height_source = properties.source_height_source;
        }
        delete properties.source_rendered_height_m;
        delete properties.source_height_source;
      }

      const updated = { ...current, properties };
      onSelectedFeatureChangeRef.current?.(updated);
      return updated;
    });
  }, [styleAssignments]);

  useEffect(() => {
    if (!stylePreviewRequest) return;
    const applied = engineRef.current?.previewSelectedBuildingStyle(stylePreviewRequest.style) ?? false;
    onStylePreviewResultRef.current?.(applied, stylePreviewRequest);
  }, [stylePreviewRequest]);

  function retryMap() {
    setErrorMessage(null);
    setStatus("loading");
    setSelectedFeature(null);
    onSelectedFeatureChangeRef.current?.(null);
    setSelectedRoad(null);
    setSelectedPlace(null);
    setSelectedProperty(null);
    setNearbyPlaces(null);
    engineRef.current?.setNavigationPath(null, null);
    setRetryKey((previous) => previous + 1);
  }

  function closeBuildingDetails() {
    engineRef.current?.clearFeatureSelection();
    setSelectedFeature(null);
    onSelectedFeatureChangeRef.current?.(null);
  }

  function closeRoadDetails() {
    setSelectedRoad(null);
    engineRef.current?.clearFeatureSelection();
  }

  function focusSelectedRoad() {
    if (!selectedRoad || selectedRoad.coordinates.length === 0) return;
    const middle = selectedRoad.coordinates[Math.floor(selectedRoad.coordinates.length / 2)];
    if (!middle || middle.length < 2) return;
    engineRef.current?.flyTo({
      destination: { longitude: middle[0], latitude: middle[1], height: 190 },
      heading: 0,
      pitch: -48,
      roll: 0,
      durationMs: 850,
    });
  }

  function goHomeToDhaka() {
    engineRef.current?.setNavigationPath(null, null);
    setSelectedRoad(null);
    setSelectedProperty(null);
    engineRef.current?.flyTo({
      destination: DHAKA_CAMERA_TARGET,
      ...DHAKA_CAMERA_ORIENTATION,
      durationMs: 1000,
    });
  }

  function focusSelectedBuilding() {
    if (!selectedFeature) {
      return;
    }

    const target =
      selectedFeature.focusCoordinates ?? selectedFeature.coordinates;

    if (!target) {
      return;
    }

    const rawHeight = selectedFeature.properties.rendered_height_m;
    const parsedHeight =
      typeof rawHeight === "number"
        ? rawHeight
        : typeof rawHeight === "string"
          ? Number.parseFloat(rawHeight)
          : Number.NaN;
    const buildingHeight = Number.isFinite(parsedHeight)
      ? parsedHeight
      : 24;
    const clearance = Math.max(
      120,
      Math.min(buildingHeight * 1.5, 900),
    );

    cameraRef.current?.focus({
      destination: {
        longitude: target.longitude,
        latitude: target.latitude,
        height: (target.height ?? 0) + clearance,
      },
      heading: 0,
      pitch: -48,
      roll: 0,
      durationMs: 1000,
    });
  }

  function toggleLayerVisibility(
    layerId: MapLayer["id"],
    visible: boolean,
  ) {
    const engine = engineRef.current;
    if (!engine) {
      return;
    }

    engine.setLayerVisibility(layerId, visible);
    setLayers(engine.getLayers());
  }

  function getNearbyPlacesCenter() {
    return engineRef.current?.getGroundCenter() ?? null;
  }

  async function handleNearbyPlacesLoaded(places: NearbyPlace[]) {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.setNearbyPlaces(places);
    setNearbyPlaces(places);
    setLayers(engine.getLayers());
  }

  async function handlePropertiesLoaded(properties: PropertyListing[]) {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.setPropertyListings(properties);
    setLayers(engine.getLayers());
  }

  function focusProperty(property: PropertyListing) {
    const engine = engineRef.current;
    if (!engine) return;

    const origin = engine.getGroundCenter();
    const destination = { longitude: property.longitude, latitude: property.latitude, height: 0 };
    engine.clearFeatureSelection();
    engine.setNavigationPath(origin, destination);
    setSelectedFeature(null);
    setSelectedPlace(null);
    setSelectedProperty(property);
    engine.flyTo({
      destination: { longitude: property.longitude, latitude: property.latitude, height: 190 },
      heading: 0,
      pitch: -48,
      roll: 0,
      durationMs: 1000,
    });
  }

  async function checkNearbyServicesForProperty(property: PropertyListing) {
    focusProperty(property);
    const params = new URLSearchParams({
      lat: String(property.latitude),
      lon: String(property.longitude),
      radius: "1500",
      categories: "pharmacy,hospital,medical_center,supermarket,market",
      limit: "100",
    });
    const response = await fetch("/api/geospatial/nearby-places?" + params.toString(), {
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json()) as { error?: string; results?: NearbyPlace[] };
    if (!response.ok) throw new Error(payload.error ?? "Could not load services around this property.");
    if (!Array.isArray(payload.results)) throw new Error("The nearby service API returned an invalid response.");
    await handleNearbyPlacesLoaded(payload.results);
  }

  function clearSelectedProperty() {
    engineRef.current?.setNavigationPath(null, null);
    setSelectedProperty(null);
  }

  function focusNearbyPlace(place: NearbyPlace) {
    const engine = engineRef.current;
    if (!engine) return;

    engine.clearFeatureSelection();
    engine.setNavigationPath(null, null);
    setSelectedProperty(null);
    setSelectedFeature(null);
    setSelectedPlace(place);
    engine.flyTo({
      destination: {
        longitude: place.longitude,
        latitude: place.latitude,
        height: 180,
      },
      heading: 0,
      pitch: -48,
      roll: 0,
      durationMs: 900,
    });
  }

  function focusSearchResult(result: BuildingSearchResult) {
    const engine = engineRef.current;
    if (!engine) {
      return;
    }

    engine.clearFeatureSelection();
    engine.setNavigationPath(null, null);
    setSelectedProperty(null);
    setSelectedRoad(null);
    setSelectedFeature(null);
    onSelectedFeatureChangeRef.current?.(null);

    engine.flyTo({
      destination: {
        longitude: result.longitude,
        latitude: result.latitude,
        height: Math.max(
          180,
          Math.min((result.heightMeters ?? 24) * 8, 1400),
        ),
      },
      heading: 0,
      pitch: -42,
      roll: 0,
      durationMs: 1200,
    });
  }

  return (
    <div className="relative h-full min-h-[600px] w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
      {/* This ref belongs to the same component as the initialization effect. */}
      <div
        ref={containerRef}
        className="absolute inset-0"
      />

      <BuildingSearchPanel
        disabled={status !== "ready"}
        onSelect={focusSearchResult}
      />

      <NearbyPlacesPanel
        disabled={status !== "ready"}
        getCenter={getNearbyPlacesCenter}
        loadedPlaces={nearbyPlaces}
        onPlacesLoaded={handleNearbyPlacesLoaded}
        selectedPlace={selectedPlace}
        onSelectPlace={focusNearbyPlace}
        onClearSelectedPlace={() => setSelectedPlace(null)}
      />

      <PropertyListingsPanel
        disabled={status !== "ready"}
        getCenter={getNearbyPlacesCenter}
        onPropertiesLoaded={handlePropertiesLoaded}
        nearbyPlaces={nearbyPlaces}
        selectedProperty={selectedProperty}
        onSelectProperty={focusProperty}
        onCheckNearbyServices={checkNearbyServicesForProperty}
        onClearSelectedProperty={clearSelectedProperty}
      />

      {layers.length > 0 && (
        <MapLayersPanel
          layers={layers}
          disabled={status !== "ready"}
          onToggle={toggleLayerVisibility}
        />
      )}

      <MapControls
        disabled={status !== "ready"}
        onHome={goHomeToDhaka}
        onZoomIn={() => cameraRef.current?.zoomIn()}
        onZoomOut={() => cameraRef.current?.zoomOut()}
        onRotateLeft={() => cameraRef.current?.rotateLeft()}
        onRotateRight={() => cameraRef.current?.rotateRight()}
        onTiltUp={() => cameraRef.current?.tiltUp()}
        onTiltDown={() => cameraRef.current?.tiltDown()}
        onResetOrientation={() =>
          cameraRef.current?.resetOrientation()
        }
      />

      {status === "loading" && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/20">
          <div className="rounded-2xl border border-white/10 bg-black/75 px-6 py-5 text-center shadow-2xl backdrop-blur-xl">
            <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />

            <p className="text-sm font-medium text-white">
              Loading Dhaka 3D map
            </p>

            <p className="mt-1 text-xs text-zinc-400">
              Loading map imagery and local Overture buildings…
            </p>
          </div>
        </div>
      )}

      {status === "error" && (
        <div className="absolute inset-0 z-30 flex items-center justify-center px-6">
          <div className="w-full max-w-lg rounded-2xl border border-red-500/20 bg-black/90 p-6 text-center">
            <p className="text-sm font-semibold text-red-300">
              3D map initialization failed
            </p>

            <p className="mt-3 break-words text-xs leading-6 text-zinc-400">
              {errorMessage}
            </p>

            <button
              type="button"
              onClick={retryMap}
              className="mt-5 rounded-xl bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200"
            >
              Retry map
            </button>
          </div>
        </div>
      )}

      {status === "ready" && (
        <BuildingDetailsPanel
          feature={selectedFeature}
          onClose={closeBuildingDetails}
          onFocus={focusSelectedBuilding}
        />
      )}

      {status === "ready" && selectedRoad && (
        <RoadDetailsPanel
          road={selectedRoad}
          onClose={closeRoadDetails}
          onFocus={focusSelectedRoad}
        />
      )}

      {status === "ready" && selectedRoad && (
        <RoadDetailsPanel
          road={selectedRoad}
          onClose={closeRoadDetails}
          onFocus={focusSelectedRoad}
        />
      )}
    </div>
  );
}