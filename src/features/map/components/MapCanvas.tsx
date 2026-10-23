
"use client";

import { useEffect, useRef, useState } from "react";

import { CameraController } from "@/core/camera";
import { isCurrentAsyncRequest } from "@/core/geospatial/async-request-policy.mjs";
import { CesiumAdapter } from "@/core/map-engine";
import type { BuildingVisualStyle } from "@/core/buildings/building-style";
import type { BuildingSearchResult } from "@/core/geospatial/building-search.mjs";
import type { NearbyPlace } from "@/core/geospatial/nearby-places.mjs";
import type { PropertyListing } from "@/core/geospatial/property-listings.mjs";
import type { RoadFeature } from "@/core/geospatial/road-network.mjs";
import type {
  BuildingStyleAssignment,
  GeneratedModelDefinition,
  MapFeatureSelection,
  MapLayer,
  MAP_LAYER_IDS,
} from "@/core/map-engine/types";

import BuildingSearchPanel from "./BuildingSearchPanel";
import NearbyPlacesPanel from "./NearbyPlacesPanel";
import PropertyListingsPanel from "./PropertyListingsPanel";
import MapControls from "./MapControls";
import MapLayersPanel from "./MapLayersPanel";
import BuildingDetailsPanel from "./BuildingDetailsPanel";
import GeneratedModelPanel from "./GeneratedModelPanel";
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
  const nearbyServiceRequestRef = useRef<AbortController | null>(null);
  const nearbyPlacesLoadRevisionRef = useRef(0);

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
  const [orbitTourActive, setOrbitTourActive] = useState(false);

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
      if (!cancelled) {
        cancelNearbyServiceRequest();
        setSelectedProperty(property);
        if (property) {
          setSelectedRoad(null);
          focusProperty(property);
        }
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

        /* Start with a centred, target-framed view that shows the entire palace. */
        engine.focusAhsanManzil(650);

        setStatus("ready");

        console.info("[MapCanvas] Ahsan Manzil 3D map is ready.");
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

      // Stop outstanding service lookups before destroying the viewer.
      cancelNearbyServiceRequest();
      // Stop any frame-driven camera tour before destroying the viewer.
      engine.stopAhsanManzilOrbitTour();
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
    engineRef.current?.stopAhsanManzilOrbitTour();
    setOrbitTourActive(false);
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

  function stopOrbitTourForManualControl() {
    engineRef.current?.stopAhsanManzilOrbitTour();
    setOrbitTourActive(false);
  }

  function goHomeToAhsanManzil() {
    stopOrbitTourForManualControl();
    engineRef.current?.setNavigationPath(null, null);
    setSelectedRoad(null);
    setSelectedProperty(null);
    engineRef.current?.focusAhsanManzil(850);
  }

  function goToAhsanManzil() {
    const engine = engineRef.current;
    if (!engine) return;
    stopOrbitTourForManualControl();

    engine.setNavigationPath(null, null);
    engine.clearFeatureSelection();
    setSelectedFeature(null);
    onSelectedFeatureChangeRef.current?.(null);
    setSelectedRoad(null);
    setSelectedPlace(null);
    setSelectedProperty(null);
    engine.focusAhsanManzil(1100);
  }

  function goToAhsanManzilWhole() {
    const engine = engineRef.current;
    if (!engine) return;
    stopOrbitTourForManualControl();
    engine.setNavigationPath(null, null);
    engine.clearFeatureSelection();
    setSelectedFeature(null);
    onSelectedFeatureChangeRef.current?.(null);
    setSelectedRoad(null);
    setSelectedPlace(null);
    setSelectedProperty(null);
    engine.focusAhsanManzilWhole(900);
  }

  function goToAhsanManzilRear() {
    const engine = engineRef.current;
    if (!engine) return;
    stopOrbitTourForManualControl();
    engine.setNavigationPath(null, null);
    engine.clearFeatureSelection();
    setSelectedFeature(null);
    onSelectedFeatureChangeRef.current?.(null);
    setSelectedRoad(null);
    setSelectedPlace(null);
    setSelectedProperty(null);
    engine.focusAhsanManzilRear(850);
  }

  function goToAhsanManzilSide() {
    const engine = engineRef.current;
    if (!engine) return;
    stopOrbitTourForManualControl();
    engine.setNavigationPath(null, null);
    engine.clearFeatureSelection();
    setSelectedFeature(null);
    onSelectedFeatureChangeRef.current?.(null);
    setSelectedRoad(null);
    setSelectedPlace(null);
    setSelectedProperty(null);
    engine.focusAhsanManzilSide(850);
  }

  function goToAhsanManzilTopDown() {
    const engine = engineRef.current;
    if (!engine) return;
    stopOrbitTourForManualControl();
    engine.setNavigationPath(null, null);
    engine.clearFeatureSelection();
    setSelectedFeature(null);
    onSelectedFeatureChangeRef.current?.(null);
    setSelectedRoad(null);
    setSelectedPlace(null);
    setSelectedProperty(null);
    engine.focusAhsanManzilTopDown(850);
  }

  function toggleAhsanManzilOrbitTour() {
    const engine = engineRef.current;
    if (!engine) return;
    if (orbitTourActive) {
      engine.stopAhsanManzilOrbitTour();
      setOrbitTourActive(false);
      return;
    }
    engine.setNavigationPath(null, null);
    engine.clearFeatureSelection();
    setSelectedFeature(null);
    onSelectedFeatureChangeRef.current?.(null);
    setSelectedRoad(null);
    setSelectedPlace(null);
    setSelectedProperty(null);
    engine.startAhsanManzilOrbitTour(() => setOrbitTourActive(false));
    setOrbitTourActive(true);
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

    if (visible) return;

    // A hidden layer must not leave a stale details panel or building preview
    // active for a feature the user can no longer see or select.
    const hidesCurrentSelection =
      (layerId === MAP_LAYER_IDS.overtureBuildings && selectedFeature !== null) ||
      (layerId === MAP_LAYER_IDS.roads && selectedRoad !== null) ||
      (layerId === MAP_LAYER_IDS.nearbyPlaces && selectedPlace !== null) ||
      (layerId === MAP_LAYER_IDS.propertyListings && selectedProperty !== null);

    if (!hidesCurrentSelection) return;

    if (layerId === MAP_LAYER_IDS.propertyListings) {
      cancelNearbyServiceRequest();
    }
    engine.clearFeatureSelection();
    if (layerId === MAP_LAYER_IDS.overtureBuildings) {
      onSelectedFeatureChangeRef.current?.(null);
    }
  }

  function cancelNearbyServiceRequest() {
    nearbyServiceRequestRef.current?.abort();
    nearbyServiceRequestRef.current = null;
  }

  function getNearbyPlacesCenter() {
    return engineRef.current?.getGroundCenter() ?? null;
  }

  async function handleNearbyPlacesLoaded(places: NearbyPlace[]) {
    const engine = engineRef.current;
    if (!engine) return;
    const revision = ++nearbyPlacesLoadRevisionRef.current;
    await engine.setNearbyPlaces(places);
    if (
      nearbyPlacesLoadRevisionRef.current !== revision ||
      engineRef.current !== engine
    ) {
      return;
    }
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

    cancelNearbyServiceRequest();
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
    const controller = new AbortController();
    nearbyServiceRequestRef.current = controller;
    const isCurrentRequest = () => isCurrentAsyncRequest(
      controller,
      nearbyServiceRequestRef.current,
      controller.signal.aborted,
    );
    const params = new URLSearchParams({
      lat: String(property.latitude),
      lon: String(property.longitude),
      radius: "1500",
      categories: "pharmacy,hospital,medical_center,supermarket,market",
      limit: "100",
    });
    try {
      const response = await fetch("/api/geospatial/nearby-places?" + params.toString(), {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30_000),
        ]),
      });
      const payload = (await response.json()) as { error?: string; results?: NearbyPlace[] };
      if (!isCurrentRequest()) return;
      if (!response.ok) throw new Error(payload.error ?? "Could not load services around this property.");
      if (!Array.isArray(payload.results)) throw new Error("The nearby service API returned an invalid response.");
      await handleNearbyPlacesLoaded(payload.results);
    } catch (error: unknown) {
      if (!isCurrentRequest()) return;
      throw error;
    } finally {
      if (nearbyServiceRequestRef.current === controller) {
        nearbyServiceRequestRef.current = null;
      }
    }
  }

  function clearSelectedProperty() {
    cancelNearbyServiceRequest();
    engineRef.current?.setNavigationPath(null, null);
    setSelectedProperty(null);
  }

  function focusNearbyPlace(place: NearbyPlace) {
    const engine = engineRef.current;
    if (!engine) return;

    cancelNearbyServiceRequest();
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

    cancelNearbyServiceRequest();
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

  async function handleAddGeneratedModel(definition: GeneratedModelDefinition): Promise<void> {
    const engine = engineRef.current;
    if (!engine) throw new Error("The 3D map is not ready yet.");
    await engine.addGeneratedModel(definition);
  }

  function handleGeneratedModelVisibility(id: string, visible: boolean): boolean {
    return engineRef.current?.setGeneratedModelVisibility(id, visible) ?? false;
  }

  function handleRemoveGeneratedModel(id: string): boolean {
    return engineRef.current?.removeGeneratedModel(id) ?? false;
  }

  function focusGeneratedModel(definition: GeneratedModelDefinition) {
    const engine = engineRef.current;
    if (!engine) return;
    engine.flyTo({
      destination: {
        longitude: definition.position.longitude,
        latitude: definition.position.latitude,
        height: Math.max(100, (definition.position.height ?? 0) + 100),
      },
      heading: definition.headingDegrees ?? 0,
      pitch: -38,
      roll: 0,
      durationMs: 1000,
    });
  }

  return (
    <div className="relative h-full min-h-[600px] w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
      {/* This ref belongs to the same component as the initialization effect. */}
      <div
        ref={containerRef}
        data-testid="cesium-map-container"
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

      <GeneratedModelPanel
        key={retryKey}
        disabled={status !== "ready"}
        onAdd={handleAddGeneratedModel}
        onSetVisibility={handleGeneratedModelVisibility}
        onRemove={handleRemoveGeneratedModel}
        onFocus={focusGeneratedModel}
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
        onHome={goHomeToAhsanManzil}
        onAhsanManzil={goToAhsanManzil}
        onWholeModel={goToAhsanManzilWhole}
        onRearView={goToAhsanManzilRear}
        onSideView={goToAhsanManzilSide}
        onZoomIn={() => { stopOrbitTourForManualControl(); cameraRef.current?.zoomIn(); }}
        onZoomOut={() => { stopOrbitTourForManualControl(); cameraRef.current?.zoomOut(); }}
        onRotateLeft={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(-15); }}
        onRotateRight={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(15); }}
        onOrbitLeft={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(-45); }}
        onOrbitRight={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(45); }}
        onTopDown={goToAhsanManzilTopDown}
        onToggleOrbitTour={toggleAhsanManzilOrbitTour}
        orbitTourActive={orbitTourActive}
        onTiltUp={() => { stopOrbitTourForManualControl(); cameraRef.current?.tiltUp(); }}
        onTiltDown={() => { stopOrbitTourForManualControl(); cameraRef.current?.tiltDown(); }}
        onResetOrientation={goHomeToAhsanManzil}
      />

      {status === "loading" && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/20">
          <div className="rounded-2xl border border-white/10 bg-black/75 px-6 py-5 text-center shadow-2xl backdrop-blur-xl">
            <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />

            <p className="text-sm font-medium text-white">
              Loading Ahsan Manzil 3D map
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
    </div>
  );
}