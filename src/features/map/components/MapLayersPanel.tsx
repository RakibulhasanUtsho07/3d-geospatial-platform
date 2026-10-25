"use client";

import { useState } from "react";

import type { MapLayer, MapLayerId } from "@/core/map-engine/types";

interface MapLayersPanelProps {
  layers: MapLayer[];
  disabled: boolean;
  onToggle: (layerId: MapLayerId, visible: boolean) => void;
}

function getLayerDescription(layerId: MapLayerId): string {
  switch (layerId) {
    case "base-imagery":
      return "OpenStreetMap raster map and place labels";
    case "roads":
      return "Detailed OpenStreetMap road centerlines, tagged names and estimated-width ground corridors";
    case "overture-buildings":
      return "Extruded building footprints with adaptive detail";
    case "nearby-places":
      return "Pharmacies, hospitals, markets and supermarkets";
    case "property-listings":
      return "Illustrative rental markers from the demo listing data";
  }
}

export default function MapLayersPanel({
  layers,
  disabled,
  onToggle,
}: MapLayersPanelProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <aside
      aria-label="Map layers"
      className="absolute bottom-4 left-4 z-20 w-[min(290px,calc(100%-5.5rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/90 text-white shadow-2xl backdrop-blur-xl"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="map-layers-list"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
      >
        <span>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
            Map layers
          </span>
          <span className="mt-1 block text-xs text-zinc-400">
            {expanded ? "Choose which data appears on the map" : "Manage visible data"}
          </span>
        </span>
        <span aria-hidden="true" className="text-zinc-300">{expanded ? "−" : "+"}</span>
      </button>

      <ul id="map-layers-list" className={expanded ? "space-y-1 border-t border-white/10 p-2" : "hidden"}>
        {layers.map((layer) => (
          <li key={layer.id}>
            <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl px-2 py-3 transition hover:bg-white/5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-100">
                  {layer.name}
                </span>
                <span className="mt-1 block text-xs leading-5 text-zinc-400">
                  {getLayerDescription(layer.id)}
                </span>
              </span>
              <input
                type="checkbox"
                aria-label={layer.name}
                checked={layer.visible}
                disabled={disabled}
                onChange={(event) =>
                  onToggle(layer.id, event.target.checked)
                }
                className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              />
            </label>
          </li>
        ))}
      </ul>
    </aside>
  );
}
