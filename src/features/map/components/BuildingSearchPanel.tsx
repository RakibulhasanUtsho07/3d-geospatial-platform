"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import type { BuildingSearchResult } from "@/core/geospatial/building-search.mjs";

interface BuildingSearchPanelProps {
  disabled: boolean;
  onSelect: (result: BuildingSearchResult) => void;
}

type SearchResponse = {
  error?: string;
  totalMatches?: number;
  returnedCount?: number;
  results?: BuildingSearchResult[];
};

export default function BuildingSearchPanel({
  disabled,
  onSelect,
}: BuildingSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BuildingSearchResult[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [hasSearched, setHasSearched] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    activeRequestRef.current?.abort();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedQuery = query.trim();

    if (normalizedQuery.length < 2) {
      setErrorMessage("Enter at least 2 characters to search.");
      setResults([]);
      setTotalMatches(0);
      setHasSearched(false);
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
        q: normalizedQuery,
        limit: "8",
      });
      const response = await fetch(
        "/api/geospatial/overture-buildings/search?" + params.toString(),
        { signal: controller.signal },
      );
      const payload = (await response.json()) as SearchResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Building search failed.");
      }
      if (!Array.isArray(payload.results)) {
        throw new Error("The building search returned an invalid response.");
      }

      setResults(payload.results);
      setTotalMatches(
        typeof payload.totalMatches === "number"
          ? payload.totalMatches
          : payload.results.length,
      );
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setResults([]);
      setTotalMatches(0);
      setErrorMessage(
        error instanceof Error ? error.message : "Building search failed.",
      );
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        setIsLoading(false);
      }
    }
  }

  return (
    <aside
      aria-label="Building search"
      className="absolute left-4 top-4 z-20 w-[min(360px,calc(100%-5.5rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 text-white shadow-2xl backdrop-blur-xl"
    >
      <div className="border-b border-white/10 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Building discovery
        </p>
        <p className="mt-1 text-xs text-zinc-400">
          Search names, building attributes, or Overture IDs
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 p-3">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search buildings</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            minLength={2}
            maxLength={100}
            disabled={disabled || isLoading}
            placeholder="Name, class, or feature ID"
            className="w-full rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/15 disabled:opacity-50"
          />
        </label>
        <button
          type="submit"
          disabled={disabled || isLoading || query.trim().length < 2}
          className="shrink-0 rounded-xl bg-cyan-300 px-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isLoading ? "…" : "Search"}
        </button>
      </form>

      {isLoading && (
        <p role="status" className="px-4 pb-3 text-xs text-zinc-400">
          Searching the Dhaka pilot dataset…
        </p>
      )}

      {errorMessage && (
        <p role="alert" className="mx-3 mb-3 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs leading-5 text-red-200">
          {errorMessage}
        </p>
      )}

      {hasSearched && !isLoading && !errorMessage && results.length === 0 && (
        <p role="status" className="px-4 pb-4 text-xs leading-5 text-zinc-400">
          No matching buildings found. Try a shorter name, class, or source ID.
        </p>
      )}

      {results.length > 0 && (
        <div className="border-t border-white/10">
          <div className="flex items-center justify-between px-4 py-2 text-xs text-zinc-400">
            <span>{totalMatches} matching {totalMatches === 1 ? "building" : "buildings"}</span>
            <span>Top {results.length}</span>
          </div>
          <ol className="max-h-52 space-y-1 overflow-y-auto px-2 pb-2">
            {results.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  onClick={() => onSelect(result)}
                  className="w-full rounded-xl px-3 py-2.5 text-left transition hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                >
                  <span className="block break-words text-sm font-medium text-zinc-100">
                    {result.name}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-zinc-400">
                    <span>{result.category}</span>
                    {result.floors !== null && <span>{Math.round(result.floors)} floors</span>}
                    {result.heightMeters !== null && <span>{result.heightMeters.toFixed(1)} m</span>}
                  </span>
                  <span className="mt-1 block break-all font-mono text-[10px] text-zinc-500">
                    {result.id}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </aside>
  );
}
