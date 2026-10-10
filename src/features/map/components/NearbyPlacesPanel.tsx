"use client";

import { useState, type FormEvent } from "react";

import {
  NEARBY_PLACE_CATEGORIES,
} from "@/core/geospatial/nearby-places.mjs";
import type {
  NearbyPlace,
  NearbyPlaceCategory,
} from "@/core/geospatial/nearby-places.mjs";

interface NearbyPlacesPanelProps {
  disabled: boolean;
  getCenter: () => { latitude: number; longitude: number } | null;
  onPlacesLoaded: (places: NearbyPlace[]) => Promise<void>;
  selectedPlace: NearbyPlace | null;
  onSelectPlace: (place: NearbyPlace) => void;
  onClearSelectedPlace: () => void;
}

type PlacesResponse = {
  error?: string;
  count?: number;
  results?: NearbyPlace[];
};

const CATEGORY_ORDER: NearbyPlaceCategory[] = [
  "pharmacy",
  "hospital",
  "medical_center",
  "supermarket",
  "market",
];

export default function NearbyPlacesPanel({
  disabled,
  getCenter,
  onPlacesLoaded,
  selectedPlace,
  onSelectPlace,
  onClearSelectedPlace,
}: NearbyPlacesPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [radius, setRadius] = useState("800");
  const [categories, setCategories] = useState<NearbyPlaceCategory[]>(CATEGORY_ORDER);
  const [results, setResults] = useState<NearbyPlace[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  function toggleCategory(category: NearbyPlaceCategory, checked: boolean) {
    setCategories((previous) => checked
      ? [...new Set([...previous, category])]
      : previous.filter((value) => value !== category));
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const center = getCenter();

    if (!center) {
      setErrorMessage("The map centre is not over visible ground. Tilt or move the map slightly, then retry.");
      return;
    }
    if (categories.length === 0) {
      setErrorMessage("Choose at least one place category.");
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setHasSearched(true);

    try {
      const params = new URLSearchParams({
        lat: String(center.latitude),
        lon: String(center.longitude),
        radius,
        limit: "100",
        categories: categories.join(","),
      });
      const response = await fetch(
        "/api/geospatial/nearby-places?" + params.toString(),
        { signal: AbortSignal.timeout(30_000) },
      );
      const payload = (await response.json()) as PlacesResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Nearby-place search failed.");
      }
      if (!Array.isArray(payload.results)) {
        throw new Error("The nearby-place service returned an invalid response.");
      }

      setResults(payload.results);
      onClearSelectedPlace();
      await onPlacesLoaded(payload.results);
    } catch (error: unknown) {
      setResults([]);
      try {
        await onPlacesLoaded([]);
      } catch {
        // Preserve the actionable error from the place lookup.
      }
      setErrorMessage(
        error instanceof Error ? error.message : "Nearby-place search failed.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <aside
      aria-label="Nearby places"
      className="absolute left-4 top-[13.25rem] z-20 w-[min(360px,calc(100%-5.5rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 text-white shadow-2xl backdrop-blur-xl"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
      >
        <span>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
            Nearby places
          </span>
          <span className="mt-1 block text-xs text-zinc-400">
            {hasSearched ? `${results.length} places in current search` : "Find services around the map centre"}
          </span>
        </span>
        <span aria-hidden="true" className="text-zinc-300">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="border-t border-white/10">
          <form onSubmit={handleSearch} className="space-y-3 p-3">
            <fieldset disabled={disabled || isLoading} className="grid grid-cols-2 gap-x-3 gap-y-2">
              <legend className="mb-2 text-xs font-medium text-zinc-300">
                Categories
              </legend>
              {CATEGORY_ORDER.map((category) => (
                <label key={category} className="flex min-w-0 items-center gap-2 text-xs text-zinc-200">
                  <input
                    type="checkbox"
                    checked={categories.includes(category)}
                    onChange={(event) => toggleCategory(category, event.target.checked)}
                    className="h-3.5 w-3.5 shrink-0 accent-cyan-300"
                  />
                  <span className="truncate">{NEARBY_PLACE_CATEGORIES[category].label}</span>
                </label>
              ))}
            </fieldset>

            <div className="flex items-center gap-2">
              <label htmlFor="nearby-radius" className="shrink-0 text-xs text-zinc-400">
                Radius
              </label>
              <select
                id="nearby-radius"
                value={radius}
                onChange={(event) => setRadius(event.target.value)}
                disabled={disabled || isLoading}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-white outline-none focus:border-cyan-300"
              >
                <option value="400">400 metres</option>
                <option value="800">800 metres</option>
                <option value="1200">1.2 km</option>
                <option value="1500">1.5 km</option>
              </select>
              <button
                type="submit"
                disabled={disabled || isLoading || categories.length === 0}
                className="rounded-lg bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isLoading ? "Searching…" : "Find places"}
              </button>
            </div>
          </form>

          {errorMessage && (
            <p role="alert" className="mx-3 mb-3 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs leading-5 text-red-200">
              {errorMessage}
            </p>
          )}
          {isLoading && (
            <p role="status" className="px-4 pb-3 text-xs text-zinc-400">
              Querying OpenStreetMap data…
            </p>
          )}
          {hasSearched && !isLoading && !errorMessage && results.length === 0 && (
            <p role="status" className="px-4 pb-3 text-xs text-zinc-400">
              No mapped places found in this radius. Try a larger radius or fewer categories.
            </p>
          )}

          {results.length > 0 && (
            <ol className="max-h-44 space-y-1 overflow-y-auto border-t border-white/10 px-2 py-2">
              {results.map((place) => (
                <li key={place.id}>
                  <button
                    type="button"
                    onClick={() => onSelectPlace(place)}
                    className={`w-full rounded-xl px-3 py-2 text-left transition hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${selectedPlace?.id === place.id ? "bg-white/[0.08]" : ""}`}
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="break-words text-sm font-medium text-zinc-100">{place.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-cyan-200">
                        {place.distanceMeters < 1000
                          ? `${place.distanceMeters} m`
                          : `${(place.distanceMeters / 1000).toFixed(1)} km`}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs text-zinc-400">{place.categoryLabel}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {selectedPlace && (
            <section aria-label="Selected nearby place" className="border-t border-white/10 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-300">
                    {selectedPlace.categoryLabel}
                  </p>
                  <h3 className="mt-1 break-words text-sm font-semibold">{selectedPlace.name}</h3>
                </div>
                <button
                  type="button"
                  aria-label="Close place details"
                  onClick={onClearSelectedPlace}
                  className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10"
                >
                  ✕
                </button>
              </div>
              {selectedPlace.address && <p className="mt-2 text-xs leading-5 text-zinc-300">{selectedPlace.address}</p>}
              {selectedPlace.openingHours && <p className="mt-2 text-xs text-zinc-400">Hours: {selectedPlace.openingHours}</p>}
              {selectedPlace.phone && <p className="mt-2 text-xs text-zinc-300">Phone: {selectedPlace.phone}</p>}
              {selectedPlace.website && (
                <a href={selectedPlace.website} target="_blank" rel="noreferrer" className="mt-2 block break-all text-xs text-cyan-200 underline">
                  {selectedPlace.website}
                </a>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onSelectPlace(selectedPlace)}
                  className="rounded-lg bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-200"
                >
                  Focus on map
                </button>
                <a
                  href={selectedPlace.osmUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-200 hover:bg-white/10"
                >
                  OpenStreetMap
                </a>
              </div>
            </section>
          )}

          <footer className="border-t border-white/10 px-3 py-2 text-[10px] leading-4 text-zinc-500">
            Data © OpenStreetMap contributors · <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">ODbL attribution</a>
          </footer>
        </div>
      )}
    </aside>
  );
}
