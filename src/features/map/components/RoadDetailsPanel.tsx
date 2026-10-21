"use client";

import type { RoadFeature } from "@/core/geospatial/road-network.mjs";

interface RoadDetailsPanelProps {
  road: RoadFeature;
  onClose: () => void;
  onFocus: () => void;
}

function roadClassLabel(roadClass: RoadFeature["roadClass"]): string {
  switch (roadClass) {
    case "arterial": return "Arterial / main road";
    case "collector": return "Collector road";
    case "local": return "Local / residential road";
    case "path": return "Path / pedestrian route";
  }
}

function widthSourceLabel(source: RoadFeature["widthSource"]): string {
  switch (source) {
    case "tagged": return "Explicit OSM width tag";
    case "lanes-estimate": return "Estimated from lane count";
    case "highway-class-estimate": return "Estimated from road class";
  }
}

export default function RoadDetailsPanel({
  road,
  onClose,
  onFocus,
}: RoadDetailsPanelProps) {
  return (
    <aside
      aria-label="Selected road details"
      className="absolute right-4 top-4 z-30 flex max-h-[calc(100%-2rem)] w-[min(370px,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-950/95 text-white shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-start justify-between gap-3 border-b border-white/10 p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber-300">
            OpenStreetMap · selected way
          </p>
          <h2 className="mt-2 break-words text-lg font-semibold">
            {road.name ?? "Unnamed road"}
          </h2>
          <p className="mt-1 text-xs text-slate-400">{roadClassLabel(road.roadClass)}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close road details"
          className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <section className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3">
            <p className="text-xs text-slate-400">Rendered corridor width</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-amber-100">{road.widthMeters.toFixed(1)} m</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-400">{widthSourceLabel(road.widthSource)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-xs text-slate-400">Surface tag</p>
            <p className="mt-1 break-words text-sm font-semibold">{road.surface ?? "Not mapped"}</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-500">OSM property, when available</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-xs text-slate-400">Lane count</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{road.lanes ?? "Unknown"}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-xs text-slate-400">Max speed tag</p>
            <p className="mt-1 text-lg font-semibold">{road.maxSpeed ?? "Not mapped"}</p>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Road attributes</h3>
          <dl className="divide-y divide-white/10 rounded-xl border border-white/10">
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 p-3">
              <dt className="text-xs text-slate-400">Highway tag</dt>
              <dd className="break-words text-right text-xs text-slate-100">{road.highway}</dd>
            </div>
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 p-3">
              <dt className="text-xs text-slate-400">Direction</dt>
              <dd className="text-right text-xs text-slate-100">{road.oneway ? "One way" : "Not tagged one-way"}</dd>
            </div>
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 p-3">
              <dt className="text-xs text-slate-400">Bridge</dt>
              <dd className="text-right text-xs text-slate-100">{road.bridge ? "Yes · deck height estimated" : "No bridge tag"}</dd>
            </div>
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 p-3">
              <dt className="text-xs text-slate-400">Tunnel</dt>
              <dd className="text-right text-xs text-slate-100">{road.tunnel ? "Yes · underpass level estimated" : "No tunnel tag"}</dd>
            </div>
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 p-3">
              <dt className="text-xs text-slate-400">OSM way ID</dt>
              <dd className="break-all text-right font-mono text-xs text-slate-100">{road.osmWayId}</dd>
            </div>
          </dl>
        </section>

        <button
          type="button"
          onClick={onFocus}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-100 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
        >
          <span aria-hidden="true">◎</span>
          Focus on road
        </button>

        <p className="text-xs leading-5 text-slate-500">
          Road line geometry and tags come from OpenStreetMap. A width explicitly tagged by OSM is displayed as source data; where the width is missing, this app estimates the rendered corridor from lane count or highway class. Bridge/tunnel vertical offset is illustrative unless mapped elevation data is available.
        </p>
      </div>
      <footer className="border-t border-white/10 px-4 py-3 text-xs text-slate-400">
        © OpenStreetMap contributors · ODbL 1.0
      </footer>
    </aside>
  );
}
