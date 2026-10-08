"use client";

import { useEffect, useRef, useState } from "react";

import { CesiumAdapter } from "@/core/map-engine";

type MapStatus = "loading" | "ready" | "error";

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] =
    useState<MapStatus>("loading");

  const [errorMessage, setErrorMessage] =
    useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const engine = new CesiumAdapter();

    let cancelled = false;

    async function initialize(
      mapContainer: HTMLElement,
    ) {
      try {
        await engine.initialize(mapContainer);

        if (cancelled) {
          engine.destroy();
          return;
        }

        engine.flyTo({
          destination: {
            longitude: 90.4125,
            latitude: 23.8103,
            height: 15000,
          },
          heading: 0,
          pitch: -40,
          roll: 0,
          durationMs: 2500,
        });

        setStatus("ready");
      } catch (error) {
        console.error(
          "Failed to initialize Cesium:",
          error,
        );

        if (!cancelled) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Failed to initialize 3D map.",
          );

          setStatus("error");
        }
      }
    }

    void initialize(container);

    return () => {
      cancelled = true;
      engine.destroy();
    };
  }, []);

  return (
    <div className="relative h-full min-h-[600px] w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
      <div
        ref={containerRef}
        className="absolute inset-0"
      />

      {status === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
          <div className="rounded-xl border border-white/10 bg-black/70 px-5 py-4 text-center backdrop-blur">
            <p className="text-sm font-medium text-white">
              Loading 3D world...
            </p>

            <p className="mt-1 text-xs text-zinc-400">
              Terrain and buildings are being streamed.
            </p>
          </div>
        </div>
      )}

      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <div className="max-w-lg rounded-xl border border-red-500/20 bg-black/80 p-5 text-center backdrop-blur">
            <p className="text-sm font-medium text-red-300">
              3D map failed to initialize
            </p>

            <p className="mt-2 break-words text-xs leading-6 text-zinc-400">
              {errorMessage}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}