"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { matchNearbyServices, PROPERTY_TYPES } from "@/core/geospatial/property-listings.mjs";
import type { PropertyListing } from "@/core/geospatial/property-listings.mjs";
import type { NearbyPlace } from "@/core/geospatial/nearby-places.mjs";

type PropertyResult = PropertyListing;

interface PropertyListingsPanelProps {
  disabled: boolean;
  getCenter: () => { latitude: number; longitude: number } | null;
  onPropertiesLoaded: (properties: PropertyResult[]) => Promise<void>;
  nearbyPlaces: NearbyPlace[] | null;
  selectedProperty: PropertyResult | null;
  onSelectProperty: (property: PropertyResult) => void;
  onCheckNearbyServices: (property: PropertyResult) => Promise<void>;
  onClearSelectedProperty: () => void;
}

type PropertiesResponse = {
  error?: string;
  totalMatches?: number;
  results?: PropertyResult[];
};

const STORAGE_KEY = "3d-geospatial-platform:saved-demo-properties:v1";

function formatMoney(amount: number): string {
  return "৳" + amount.toLocaleString("en-BD");
}
function formatDistance(distanceMeters: number): string {
  return distanceMeters < 1000 ? Math.round(distanceMeters) + " m" : (distanceMeters / 1000).toFixed(1) + " km";
}

export default function PropertyListingsPanel({
  disabled, getCenter, onPropertiesLoaded, nearbyPlaces, selectedProperty,
  onSelectProperty, onCheckNearbyServices, onClearSelectedProperty,
}: PropertyListingsPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const [radius, setRadius] = useState("5000");
  const [minRent, setMinRent] = useState("");
  const [maxRent, setMaxRent] = useState("");
  const [minBedrooms, setMinBedrooms] = useState("0");
  const [propertyType, setPropertyType] = useState("all");
  const [furnishing, setFurnishing] = useState("all");
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [savedLoaded, setSavedLoaded] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [results, setResults] = useState<PropertyResult[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [hasSearched, setHasSearched] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
      if (Array.isArray(stored)) {
        setSavedIds([...new Set(stored.filter((id): id is string => typeof id === "string" && /^[a-z0-9-]{1,80}$/i.test(id)))].slice(0, 100));
      }
    } catch {
      // Storage can be disabled by privacy settings; keep the panel usable.
    } finally {
      setSavedLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!savedLoaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(savedIds));
    } catch {
      // Keep favourites in memory for this session if storage is unavailable.
    }
  }, [savedIds, savedLoaded]);

  useEffect(() => () => activeRequestRef.current?.abort(), []);
  useEffect(() => {
    if (nearbyPlaces !== null) setServiceError(null);
  }, [nearbyPlaces]);

  function toggleSaved(id: string) {
    setSavedIds((previous) => previous.includes(id)
      ? previous.filter((value) => value !== id)
      : [...previous, id].slice(-100));
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const center = getCenter();
    if (!center) {
      setErrorMessage("The map centre is not over visible ground. Move the map slightly and retry.");
      return;
    }
    if (query.trim().length === 1 || query.trim().length > 100) {
      setErrorMessage("Search text must be empty or contain between 2 and 100 characters.");
      return;
    }
    if (savedOnly && savedIds.length === 0) {
      setResults([]);
      setTotalMatches(0);
      setHasSearched(true);
      setErrorMessage(null);
      return;
    }

    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setIsLoading(true);
    setErrorMessage(null);
    setHasSearched(true);

    try {
      const params = new URLSearchParams({
        lat: String(center.latitude), lon: String(center.longitude), radius,
        limit: "100", minBedrooms, type: propertyType, furnishing,
        savedOnly: String(savedOnly),
      });
      if (query.trim()) params.set("q", query.trim());
      if (minRent.trim()) params.set("minRent", minRent.trim());
      if (maxRent.trim()) params.set("maxRent", maxRent.trim());
      if (savedOnly) params.set("savedIds", savedIds.join(","));

      const response = await fetch("/api/geospatial/properties?" + params.toString(), {
        signal: controller.signal,
      });
      const payload = (await response.json()) as PropertiesResponse;
      if (!response.ok) throw new Error(payload.error || "Property search failed.");
      if (!Array.isArray(payload.results)) throw new Error("The property service returned an invalid response.");

      setResults(payload.results);
      setTotalMatches(typeof payload.totalMatches === "number" ? payload.totalMatches : payload.results.length);
      await onPropertiesLoaded(payload.results);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setResults([]);
      setTotalMatches(0);
      try {
        await onPropertiesLoaded([]);
      } catch {
        // Preserve the visible property API error.
      }
      setErrorMessage(error instanceof Error ? error.message : "Property search failed.");
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        setIsLoading(false);
      }
    }
  }

  async function handleCheckServices(property: PropertyResult) {
    setServiceLoading(true);
    setServiceError(null);
    try {
      await onCheckNearbyServices(property);
      onSelectProperty(property);
    } catch (error: unknown) {
      setServiceError(error instanceof Error ? error.message : "Nearby service matching failed.");
    } finally {
      setServiceLoading(false);
    }
  }

  const visibleResults = savedOnly ? results.filter((property) => savedIds.includes(property.id)) : results;
  const selectedMatches = selectedProperty && nearbyPlaces !== null
    ? matchNearbyServices(selectedProperty, nearbyPlaces, 1500)
    : [];
  const hasServiceResults = nearbyPlaces !== null;

  return (
    <aside aria-label="Property listings" className="absolute right-4 top-4 z-20 max-h-[calc(100%-2rem)] w-[min(370px,calc(100%-5.5rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 text-white shadow-2xl backdrop-blur-xl">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((previous) => !previous)} className="flex w-full items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-left transition hover:bg-white/[0.04]">
        <span>
          <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">Property discovery</span>
          <span className="mt-1 block text-xs text-zinc-400">{hasSearched ? totalMatches + " matching demo listings" : "Rent filters, saved places and service matching"}</span>
        </span>
        <span aria-hidden="true" className="text-zinc-300">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="max-h-[calc(100vh-8rem)] overflow-y-auto">
          <form onSubmit={handleSearch} className="space-y-3 border-b border-white/10 p-3">
            <label className="block text-xs text-zinc-400">
              Search area or property
              <input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} disabled={disabled || isLoading} placeholder="Dhanmondi, Gulshan, family…" className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-amber-300/60" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-zinc-400">
                Min rent / month
                <input inputMode="numeric" pattern="[0-9]*" value={minRent} onChange={(event) => setMinRent(event.target.value)} disabled={disabled || isLoading} placeholder="No minimum" className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-white outline-none focus:border-amber-300/60" />
              </label>
              <label className="text-xs text-zinc-400">
                Max rent / month
                <input inputMode="numeric" pattern="[0-9]*" value={maxRent} onChange={(event) => setMaxRent(event.target.value)} disabled={disabled || isLoading} placeholder="No maximum" className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-white outline-none focus:border-amber-300/60" />
              </label>
              <label className="text-xs text-zinc-400">
                Bedrooms
                <select value={minBedrooms} onChange={(event) => setMinBedrooms(event.target.value)} disabled={disabled || isLoading} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-white outline-none focus:border-amber-300/60">
                  <option value="0">Any</option><option value="1">1 or more</option><option value="2">2 or more</option><option value="3">3 or more</option><option value="4">4 or more</option>
                </select>
              </label>
              <label className="text-xs text-zinc-400">
                Property type
                <select value={propertyType} onChange={(event) => setPropertyType(event.target.value)} disabled={disabled || isLoading} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-white outline-none focus:border-amber-300/60">
                  <option value="all">All types</option>
                  {Object.entries(PROPERTY_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="property-radius" className="shrink-0 text-xs text-zinc-400">Radius</label>
              <select id="property-radius" value={radius} onChange={(event) => setRadius(event.target.value)} disabled={disabled || isLoading} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-white outline-none focus:border-amber-300/60">
                <option value="1000">1 km</option><option value="3000">3 km</option><option value="5000">5 km</option><option value="10000">10 km</option><option value="20000">20 km</option>
              </select>
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-300">
                <input type="checkbox" checked={savedOnly} onChange={(event) => setSavedOnly(event.target.checked)} disabled={disabled || isLoading} className="accent-amber-300" />Saved only
              </label>
            </div>
            {savedOnly && <p className="text-[10px] leading-4 text-zinc-500">Saved-only mode finds saved records beyond the selected radius.</p>}
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              Furnishing
              <select value={furnishing} onChange={(event) => setFurnishing(event.target.value)} disabled={disabled || isLoading} className="flex-1 rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-white outline-none focus:border-amber-300/60">
                <option value="all">Any</option><option value="unfurnished">Unfurnished</option><option value="semi-furnished">Semi-furnished</option><option value="furnished">Furnished</option>
              </select>
            </label>
            <button type="submit" disabled={disabled || isLoading} className="w-full rounded-lg bg-amber-300 px-3 py-2.5 text-xs font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40">{isLoading ? "Searching listings…" : "Find properties"}</button>
          </form>

          {errorMessage && <p role="alert" className="mx-3 mt-3 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs leading-5 text-red-200">{errorMessage}</p>}
          {serviceError && <p role="alert" className="mx-3 mt-3 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs leading-5 text-red-200">{serviceError}</p>}
          <div className="flex items-center justify-between px-4 py-2 text-xs text-zinc-400"><span>{visibleResults.length} shown · {savedIds.length} saved</span><span>Nearest first</span></div>

          {hasSearched && !isLoading && visibleResults.length === 0 && (
            <p role="status" className="px-4 pb-4 text-xs leading-5 text-zinc-400">{savedOnly && savedIds.length === 0 ? "Save a listing first, then search saved properties." : "No matching sample listings. Try a larger radius or wider rent range."}</p>
          )}

          {visibleResults.length > 0 && (
            <ol className="max-h-56 space-y-1 overflow-y-auto px-2 pb-2">
              {visibleResults.map((property) => {
                const isSelected = selectedProperty?.id === property.id;
                const isSaved = savedIds.includes(property.id);
                return (
                  <li key={property.id}>
                    <article className={"rounded-xl border px-3 py-3 transition " + (isSelected ? "border-amber-300/40 bg-amber-300/[0.06]" : "border-transparent hover:bg-white/[0.04]")}>
                      <div className="flex items-start justify-between gap-2">
                        <button type="button" onClick={() => onSelectProperty(property)} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">
                          <span className="block break-words text-sm font-semibold text-zinc-100">{property.title}</span>
                          <span className="mt-1 block text-xs text-zinc-400">{property.neighborhood}, {property.area}</span>
                        </button>
                        <button type="button" aria-pressed={isSaved} aria-label={isSaved ? "Remove saved property" : "Save property"} onClick={() => toggleSaved(property.id)} className={"shrink-0 rounded-lg border px-2 py-1 text-xs " + (isSaved ? "border-amber-300/40 text-amber-200" : "border-white/10 text-zinc-400 hover:text-white")}>{isSaved ? "★ Saved" : "☆ Save"}</button>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
                        <span className="font-semibold text-amber-200">{formatMoney(property.monthlyRentBdt)}/mo</span><span>{property.bedrooms} bed</span><span>{property.bathrooms} bath</span><span>{property.areaSqft.toLocaleString("en-BD")} sqft</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
                        <span>{property.propertyTypeLabel}</span><span>{property.furnishing}</span><span>{formatDistance(property.distanceMeters)} from search centre, straight line</span>
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button type="button" onClick={() => onSelectProperty(property)} className="flex-1 rounded-lg border border-white/10 px-2 py-2 text-xs text-zinc-200 hover:bg-white/10">Focus & draw line</button>
                        <button type="button" onClick={() => void handleCheckServices(property)} disabled={serviceLoading} className="flex-1 rounded-lg bg-amber-300 px-2 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-200 disabled:opacity-40">{serviceLoading && isSelected ? "Checking…" : "Match nearby services"}</button>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ol>
          )}

          {selectedProperty && (
            <section aria-label="Selected property details" className="border-t border-white/10 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">Selected demo property</p>
                  <h3 className="mt-1 break-words text-sm font-semibold">{selectedProperty.title}</h3>
                  <p className="mt-1 text-xs text-amber-100">{formatMoney(selectedProperty.monthlyRentBdt)} / month · {selectedProperty.areaSqft.toLocaleString("en-BD")} sqft</p>
                </div>
                <button type="button" aria-label="Clear selected property and line" onClick={onClearSelectedProperty} className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10">✕</button>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-zinc-500">Illustrative seed data only—not a live or verified rental offer. The globe line is a geodesic straight-line indicator, not a road route.</p>
              <div className="mt-3">
                <p className="text-xs font-medium text-zinc-200">Nearby service matches (within 1.5 km)</p>
                {!hasServiceResults && <p className="mt-1 text-xs leading-5 text-zinc-500">Choose “Match nearby services” to query pharmacies, hospitals, clinics, supermarkets and markets around this property.</p>}
                {hasServiceResults && selectedMatches.length === 0 && <p className="mt-1 text-xs leading-5 text-zinc-500">No mapped services within 1.5 km in the loaded OpenStreetMap results. Coverage depends on community mapping completeness.</p>}
                {selectedMatches.length > 0 && <ul className="mt-2 space-y-1">{selectedMatches.map((place) => <li key={place.id} className="flex items-start justify-between gap-2 text-xs"><span className="min-w-0 text-zinc-300">{place.categoryLabel}: {place.name}</span><span className="shrink-0 tabular-nums text-amber-200">{formatDistance(place.distanceFromPropertyMeters)}</span></li>)}</ul>}
              </div>
            </section>
          )}
          <footer className="border-t border-white/10 px-3 py-2 text-[10px] leading-4 text-zinc-500">Sample data only · straight-line distances · nearby services © OpenStreetMap contributors.</footer>
        </div>
      )}
    </aside>
  );
}
