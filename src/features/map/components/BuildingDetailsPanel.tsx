
"use client";

import type { MapFeatureSelection } from "@/core/map-engine/types";

interface BuildingDetailsPanelProps {
  feature: MapFeatureSelection | null;
  onClose: () => void;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "Not available";
  }

  if (typeof value === "string") {
    return value.trim() || "Not available";
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function findProperty(
  properties: Record<string, unknown>,
  candidates: string[],
): string | null {
  const entry = Object.entries(properties).find(
    ([key, value]) =>
      candidates.includes(key.toLowerCase()) &&
      typeof value === "string" &&
      value.trim().length > 0,
  );

  return entry ? String(entry[1]) : null;
}

export default function BuildingDetailsPanel({
  feature,
  onClose,
}: BuildingDetailsPanelProps) {
  if (!feature) {
    return null;
  }

  const name =
    findProperty(feature.properties, [
      "name",
      "building_name",
      "buildingname",
    ]) ?? "Selected 3D Building";

  const entries = Object.entries(feature.properties)
    .filter(([, value]) => value !== undefined)
    .slice(0, 16);

  return (
    <aside
      aria-label="Building details"
      className="absolute right-4 top-4 z-30 flex max-h-[calc(100%-2rem)] w-[min(370px,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-950/95 text-white shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-start justify-between gap-3 border-b border-white/10 p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-cyan-300">
            Cesium · 3D Buildings
          </p>

          <h2 className="mt-2 break-words text-lg font-semibold">
            {name}
          </h2>

          <p className="mt-1 text-xs text-slate-400">
            Building metadata from the selected 3D Tiles feature
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close building details"
          className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {feature.coordinates && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">
              Geographic location
            </h3>

            <div className="grid grid-cols-2 gap-2">
              <CoordinateCard
                label="Latitude"
                value={feature.coordinates.latitude}
              />

              <CoordinateCard
                label="Longitude"
                value={feature.coordinates.longitude}
              />
            </div>

            <p className="mt-2 text-xs text-slate-400">
              Picked height:{" "}
              {feature.coordinates.height.toFixed(2)} m
            </p>
          </section>
        )}

        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-200">
              Available properties
            </h3>

            <span className="rounded-full bg-white/10 px-2 py-1 text-xs text-slate-300">
              {Object.keys(feature.properties).length}
            </span>
          </div>

          {entries.length > 0 ? (
            <dl className="divide-y divide-white/10 rounded-xl border border-white/10">
              {entries.map(([key, value]) => (
                <div
                  key={key}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3 p-3"
                >
                  <dt className="break-words text-xs text-slate-400">
                    {key}
                  </dt>

                  <dd className="break-words text-right text-xs text-slate-100">
                    {formatValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="rounded-xl border border-white/10 p-3 text-sm text-slate-400">
              This feature does not expose any readable properties.
            </p>
          )}

          {Object.keys(feature.properties).length > 16 && (
            <p className="mt-2 text-xs text-slate-400">
              Showing the first 16 properties.
            </p>
          )}
        </section>

        <p className="text-xs leading-5 text-slate-500">
          Building attributes depend on the available Cesium ion
          dataset. Missing metadata does not mean the building
          does not exist.
        </p>
      </div>

      <footer className="border-t border-white/10 px-4 py-3 text-xs text-slate-400">
        3D building data · Cesium ion
      </footer>
    </aside>
  );
}

function CoordinateCard({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 break-all font-mono text-sm text-cyan-200">
        {value.toFixed(5)}°
      </p>
    </div>
  );
}