
"use client";

import { useEffect, useRef, useState } from "react";

import { CameraController } from "@/core/camera";
import { CesiumAdapter } from "@/core/map-engine";
import type { BuildingSearchResult } from "@/core/geospatial/building-search.mjs";
import type { NearbyPlace } from "@/core/geospatial/nearby-places.mjs";
import type {
  MapFeatureSelection,
  MapLayer,
} from "@/core/map-engine/types";

import BuildingSearchPanel from "./BuildingSearchPanel";
import NearbyPlacesPanel from "./NearbyPlacesPanel";
import MapControls from "./MapControls";
import MapLayersPanel from "./MapLayersPanel";
import BuildingDetailsPanel from "./BuildingDetailsPanel";

type MapStatus = "loading" | "ready" | "error";

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

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const engineRef = useRef<CesiumAdapter | null>(null);

  const [status, setStatus] = useState<MapStatus>("loading");
  const [errorMessage, setErrorMessage] =
    useState<string | null>(null);
  const [selectedFeature, setSelectedFeature] =
    useState<MapFeatureSelection | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<NearbyPlace | null>(null);
  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [retryKey, setRetryKey] = useState(0);

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
          if (feature) setSelectedPlace(null);
        }
      },
    );
    const unsubscribePlaceSelection = engine.onPlaceSelected((place) => {
      if (!cancelled) {
        setSelectedPlace(place);
        if (place) setSelectedFeature(null);
      }
    });

    async function initialize(container: HTMLDivElement) {
      try {
        setStatus("loading");
        setErrorMessage(null);
        setSelectedFeature(null);
        setSelectedPlace(null);

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
      unsubscribePlaceSelection();

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

  function retryMap() {
    setErrorMessage(null);
    setStatus("loading");
    setSelectedFeature(null);
    setSelectedPlace(null);
    setRetryKey((previous) => previous + 1);
  }

  function closeBuildingDetails() {
    engineRef.current?.clearFeatureSelection();
    setSelectedFeature(null);
  }

  function goHomeToDhaka() {
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
    setLayers(engine.getLayers());
  }

  function focusNearbyPlace(place: NearbyPlace) {
    const engine = engineRef.current;
    if (!engine) return;

    engine.clearFeatureSelection();
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
    setSelectedFeature(null);

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
        onPlacesLoaded={handleNearbyPlacesLoaded}
        selectedPlace={selectedPlace}
        onSelectPlace={focusNearbyPlace}
        onClearSelectedPlace={() => setSelectedPlace(null)}
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
    </div>
  );
}