"use client";

import type { MapFeatureSelection } from "@/core/map-engine/types";

interface BuildingDetailsPanelProps {
  feature: MapFeatureSelection | null;
  onClose: () => void;
  onFocus: () => void;
}

function truncateText(value: string, maxLength = 180): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 1)}…`
    : value;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "Not available";
  }

  if (typeof value === "string") {
    return truncateText(value.trim() || "Not available");
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return truncateText(JSON.stringify(value) ?? String(value));
  } catch {
    return truncateText(String(value));
  }
}

function findProperty(
  properties: Record<string, unknown>,
  candidates: string[],
): string | null {
  const candidateKeys = new Set(candidates.map((key) => key.toLowerCase()));
  const entry = Object.entries(properties).find(
    ([key, value]) =>
      candidateKeys.has(key.toLowerCase()) &&
      typeof value === "string" &&
      value.trim().length > 0,
  );

  return entry ? String(entry[1]).trim() : null;
}

function findNumericProperty(
  properties: Record<string, unknown>,
  candidates: string[],
): number | null {
  const candidateKeys = new Set(candidates.map((key) => key.toLowerCase()));

  for (const [key, value] of Object.entries(properties)) {
    if (!candidateKeys.has(key.toLowerCase())) {
      continue;
    }

    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number.parseFloat(value)
          : Number.NaN;

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function getHeightSourceLabel(value: string | null): string {
  switch (value) {
    case "overture-height":
      return "Source height";
    case "floor-estimate":
      return "Estimated from floors";
    case "fallback-estimate":
      return "Fallback estimate";
    default:
      return "Rendered estimate";
  }
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export default function BuildingDetailsPanel({
  feature,
  onClose,
  onFocus,
}: BuildingDetailsPanelProps) {
  if (!feature) {
    return null;
  }

  const name =
    findProperty(feature.properties, [
      "display_name",
      "name",
      "building_name",
      "buildingname",
    ]) ?? "Selected 3D Building";

  const height = findNumericProperty(feature.properties, [
    "rendered_height_m",
    "height_m",
    "height",
  ]);
  const floorCount = findNumericProperty(feature.properties, [
    "num_floors",
    "numfloors",
    "building:levels",
    "levels",
  ]);
  const heightSource = findProperty(feature.properties, ["height_source"]);
  const sourceLabel =
    feature.source === "overture-local-buildings"
      ? "Local Overture pilot"
      : "Cesium OSM buildings";
  const hasFocusCoordinates = Boolean(
    feature.focusCoordinates ?? feature.coordinates,
  );

  const preferredProperties = [
    "class",
    "subtype",
    "building",
    "building_use",
    "use",
    "height",
    "height_m",
    "num_floors",
    "building:levels",
    "levels",
    "area",
    "confidence",
    "sources",
  ];
  const allEntries = Object.entries(feature.properties)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        key !== "display_name" &&
        !key.startsWith("_render"),
    )
    .sort(([leftKey], [rightKey]) => {
      const left = preferredProperties.indexOf(leftKey.toLowerCase());
      const right = preferredProperties.indexOf(rightKey.toLowerCase());
      const leftScore = left === -1 ? preferredProperties.length : left;
      const rightScore = right === -1 ? preferredProperties.length : right;
      return leftScore - rightScore;
    });
  const entries = allEntries.slice(0, 16);

  return (
    <aside
      aria-label="Building details"
      className="absolute right-4 top-4 z-30 flex max-h-[calc(100%-2rem)] w-[min(370px,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-950/95 text-white shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-start justify-between gap-3 border-b border-white/10 p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-cyan-300">
            {sourceLabel} · 3D building
          </p>

          <h2 className="mt-2 break-words text-lg font-semibold">
            {name}
          </h2>

          <p className="mt-1 text-xs text-slate-400">
            Available attributes for this building footprint
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close building details"
          className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {(height !== null || floorCount !== null) && (
          <section
            aria-label="Building summary"
            className="grid grid-cols-2 gap-2"
          >
            {height !== null && (
              <div className="rounded-xl border border-cyan-300/15 bg-cyan-300/[0.06] p-3">
                <p className="text-xs text-slate-400">Rendered height</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-cyan-100">
                  {height.toFixed(1)} m
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {getHeightSourceLabel(heightSource)}
                </p>
              </div>
            )}

            {floorCount !== null && (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="text-xs text-slate-400">Floors</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {Math.round(floorCount)}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Source attribute
                </p>
              </div>
            )}
          </section>
        )}

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
              Picked point height: {feature.coordinates.height.toFixed(2)} m
            </p>
          </section>
        )}

        {hasFocusCoordinates && (
          <button
            type="button"
            onClick={onFocus}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-100 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            <span aria-hidden="true">◎</span>
            Focus on building
          </button>
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
                    {humanizeKey(key)}
                  </dt>

                  <dd className="break-words text-right text-xs text-slate-100">
                    {formatValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="rounded-xl border border-white/10 p-3 text-sm text-slate-400">
              No additional readable attributes are available for this building.
            </p>
          )}

          {allEntries.length > 16 && (
            <p className="mt-2 text-xs text-slate-400">
              Showing 16 of {allEntries.length} available attributes.
            </p>
          )}
        </section>

        <p className="text-xs leading-5 text-slate-500">
          Height may be sourced from Overture attributes or estimated from floor
          count. Procedural facade details are illustrative and are not verified
          architectural measurements.
        </p>
      </div>

      <footer className="border-t border-white/10 px-4 py-3 text-xs text-slate-400">
        {sourceLabel} · Building footprint and available source attributes
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
