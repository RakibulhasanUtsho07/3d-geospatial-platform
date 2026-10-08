"use client";

import { useEffect, useRef } from "react";

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    // The actual map engine will be mounted here
    // after the engine adapter is implemented.

    return () => {
      // Engine cleanup will live here later.
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-[600px] w-full overflow-hidden rounded-2xl border border-white/10 bg-zinc-950"
      aria-label="3D map viewport"
    >
      <div className="flex h-full min-h-[600px] items-center justify-center">
        <div className="text-center">
          <p className="text-sm font-medium text-white">
            3D Map Engine
          </p>

          <p className="mt-2 text-sm text-zinc-400">
            Geospatial rendering foundation is ready.
          </p>
        </div>
      </div>
    </div>
  );
}