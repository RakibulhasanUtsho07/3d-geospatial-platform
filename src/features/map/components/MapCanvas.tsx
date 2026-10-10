
"use client";

import { useEffect, useRef, useState } from "react";

import { CameraController } from "@/core/camera";
import { CesiumAdapter } from "@/core/map-engine";
import type { MapFeatureSelection } from "@/core/map-engine/types";

import MapControls from "./MapControls";
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

    let cancelled = false;

    const unsubscribeSelection = engine.onFeatureSelected(
      (feature) => {
        if (!cancelled) {
          setSelectedFeature(feature);
        }
      },
    );

    async function initialize(container: HTMLDivElement) {
      try {
        setStatus("loading");
        setErrorMessage(null);
        setSelectedFeature(null);

        await engine.initialize(container);

        if (cancelled) {
          engine.destroy();
          return;
        }

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

  return (
    <div className="relative h-full min-h-[600px] w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
      {/* This ref belongs to the same component as the initialization effect. */}
      <div
        ref={containerRef}
        className="absolute inset-0"
      />

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
        />
      )}
    </div>
  );
}