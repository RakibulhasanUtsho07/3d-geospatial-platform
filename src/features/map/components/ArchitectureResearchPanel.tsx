"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import type { BuildingVisualStyle } from "@/core/buildings/building-style";
import type { BuildingStyleAssignment } from "@/core/map-engine/types";

import {
  canAssignArchitectureReference,
  createArchitectureStylePreview,
} from "@/core/geospatial/architecture-research.mjs";
import type {
  ArchitectureResearchReference,
  ArchitectureResearchSummary,
} from "@/core/geospatial/architecture-research.mjs";

type ResearchResponse = {
  error?: string;
  dataStatus?: string;
  researchedAt?: string | null;
  totalMatches?: number;
  returnedCount?: number;
  summary?: ArchitectureResearchSummary;
  results?: ArchitectureResearchReference[];
  notice?: string;
};

type Filters = {
  query: string;
  area: string;
  style: string;
  mediaType: "all" | "image" | "video";
  usage: "all" | "open" | "research-only";
};

interface ArchitectureResearchPanelProps {
  canPreview: boolean;
  isPreviewActive: boolean;
  previewTitle: string | null;
  selectedAssignment: BuildingStyleAssignment | null;
  onPreview: (style: BuildingVisualStyle, title: string) => void;
  onAssign: (reference: ArchitectureResearchReference, style: BuildingVisualStyle) => void;
  onRemoveAssignment: () => void;
  onResetPreview: () => void;
}

const DEFAULT_FILTERS: Filters = {
  query: "",
  area: "",
  style: "",
  mediaType: "all",
  usage: "all",
};

function labelForUsage(status: string): string {
  const value = status.toLowerCase();
  if (value.includes("open-licence") || value.includes("open-license")) {
    return "Open-licence candidate";
  }
  if (value.includes("research-only")) return "Research only";
  return "Check rights";
}

function usageClass(status: string): string {
  const value = status.toLowerCase();
  if (value.includes("open-licence") || value.includes("open-license")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function readableName(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatMetadata(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([, value]) =>
      ["string", "number", "boolean"].includes(typeof value),
    )
    .slice(0, 4)
    .map(([key, value]) => readableName(key) + ": " + String(value));
}

function videoIdFromEmbedUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})$/);
    return url.protocol === "https:" && url.hostname === "www.youtube-nocookie.com" ? match?.[1] ?? null : null;
  } catch {
    return null;
  }
}

function locationMapUrl(reference: ArchitectureResearchReference): string | null {
  if (
    typeof reference.latitude !== "number" ||
    typeof reference.longitude !== "number" ||
    !Number.isFinite(reference.latitude) ||
    !Number.isFinite(reference.longitude)
  ) {
    return null;
  }
  const zoom = reference.coordinateMeaning?.toLowerCase().includes("camera") ? 17 : 18;
  return "https://www.openstreetmap.org/?mlat="
    + reference.latitude + "&mlon=" + reference.longitude
    + "#map=" + zoom + "/" + reference.latitude + "/" + reference.longitude;
}

export default function ArchitectureResearchPanel({
  canPreview,
  isPreviewActive,
  previewTitle,
  selectedAssignment,
  onPreview,
  onAssign,
  onRemoveAssignment,
  onResetPreview,
}: ArchitectureResearchPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [results, setResults] = useState<ArchitectureResearchReference[]>([]);
  const [summary, setSummary] = useState<ArchitectureResearchSummary | null>(null);
  const [totalMatches, setTotalMatches] = useState(0);
  const [notice, setNotice] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();

    async function loadResearch() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (appliedFilters.query.trim()) params.set("q", appliedFilters.query.trim());
        if (appliedFilters.area.trim()) params.set("area", appliedFilters.area.trim());
        if (appliedFilters.style) params.set("style", appliedFilters.style);
        if (appliedFilters.mediaType !== "all") params.set("mediaType", appliedFilters.mediaType);
        if (appliedFilters.usage !== "all") params.set("usage", appliedFilters.usage);
        const response = await fetch(
          "/api/geospatial/architecture-research?" + params.toString(),
          { signal: controller.signal },
        );
        const payload = (await response.json()) as ResearchResponse;
        if (!response.ok) throw new Error(payload.error ?? "Could not load the architecture research catalogue.");
        if (!Array.isArray(payload.results)) throw new Error("The research API returned an invalid catalogue.");
        setResults(payload.results);
        setSummary(payload.summary ?? null);
        setTotalMatches(typeof payload.totalMatches === "number" ? payload.totalMatches : payload.results.length);
        setNotice(payload.notice ?? "");
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        setResults([]);
        setTotalMatches(0);
        setErrorMessage(error instanceof Error ? error.message : "Could not load the architecture research catalogue.");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadResearch();
    return () => controller.abort();
  }, [isOpen, appliedFilters]);

  const styleOptions = useMemo(
    () => summary?.styles ?? [],
    [summary],
  );

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (filters.query.trim().length === 1) {
      setErrorMessage("Search requires at least 2 characters.");
      return;
    }
    setAppliedFilters({ ...filters });
  }

  function resetFilters() {
    setFilters(DEFAULT_FILTERS);
    setAppliedFilters(DEFAULT_FILTERS);
    setErrorMessage(null);
  }

  return (
    <section aria-label="Dhaka architecture research library" className="overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Research-backed building styles</p>
          <h2 className="mt-1 text-lg font-semibold sm:text-xl">Dhaka Architecture Library</h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-slate-600">
            Browse source-linked building references, estimated facade colours, location confidence and reuse rights.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedAssignment && (
            <button type="button" onClick={onRemoveAssignment}
              className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-900 transition hover:bg-emerald-100">
              Remove saved profile
            </button>
          )}
          {isPreviewActive && (
            <button type="button" onClick={onResetPreview}
              className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-900 transition hover:bg-amber-100">
              Reset 3D preview
            </button>
          )}
          <button type="button" onClick={() => setIsOpen((value) => !value)} aria-expanded={isOpen}
            className="shrink-0 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
            {isOpen ? "Hide library" : "Browse research"}
          </button>
        </div>
      </div>

      {!isOpen && (
        <div className="grid grid-cols-2 gap-px border-t border-slate-200 bg-slate-200 md:grid-cols-4">
          <div className="bg-slate-50 px-4 py-3"><p className="text-xl font-semibold tabular-nums">{summary?.totalReferences ?? 33}</p><p className="text-xs text-slate-500">Source records</p></div>
          <div className="bg-slate-50 px-4 py-3"><p className="text-xl font-semibold tabular-nums">{summary?.imageCount ?? 29}</p><p className="text-xs text-slate-500">Image/project refs</p></div>
          <div className="bg-slate-50 px-4 py-3"><p className="text-xl font-semibold tabular-nums">{summary?.videoCount ?? 4}</p><p className="text-xs text-slate-500">Video refs</p></div>
          <div className="bg-slate-50 px-4 py-3"><p className="text-xl font-semibold tabular-nums">7</p><p className="text-xs text-slate-500">Palette families</p></div>
        </div>
      )}

      {isOpen && (
        <div className="border-t border-slate-200">
          <form onSubmit={submitFilters} className="grid gap-3 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 sm:px-6">
            <label className="min-w-0 text-xs font-medium text-slate-700">
              Search styles, features, colours
              <input value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                maxLength={100} placeholder="e.g. courtyard, #2F6C96"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="min-w-0 text-xs font-medium text-slate-700">
              Neighbourhood / location
              <input value={filters.area} onChange={(event) => setFilters((current) => ({ ...current, area: event.target.value }))}
                maxLength={100} placeholder="e.g. Banani, Old Dhaka"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="min-w-0 text-xs font-medium text-slate-700">
              Architecture family
              <select value={filters.style} onChange={(event) => setFilters((current) => ({ ...current, style: event.target.value }))}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                <option value="">All architecture styles</option>
                {styleOptions.map((style) => <option key={style} value={style}>{readableName(style)}</option>)}
              </select>
            </label>
            <label className="min-w-0 text-xs font-medium text-slate-700">
              Media
              <select value={filters.mediaType} onChange={(event) => setFilters((current) => ({ ...current, mediaType: event.target.value as Filters["mediaType"] }))}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                <option value="all">Images and videos</option>
                <option value="image">Image / project</option>
                <option value="video">Video</option>
              </select>
            </label>
            <label className="min-w-0 text-xs font-medium text-slate-700">
              Reuse status
              <select value={filters.usage} onChange={(event) => setFilters((current) => ({ ...current, usage: event.target.value as Filters["usage"] }))}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                <option value="all">All rights statuses</option>
                <option value="open">Open-licence candidates</option>
                <option value="research-only">Research-only / permissions unclear</option>
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button type="submit" disabled={isLoading} className="flex-1 rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50">Apply filters</button>
              <button type="button" onClick={resetFilters} className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">Reset</button>
            </div>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
            <p className="text-xs leading-5 text-slate-600">
              {canPreview
                ? "A building is selected on the map. You can apply a temporary visual style inspired by a source reference."
                : "Select a building on the 3D map first to enable temporary facade-style previews."}
            </p>
            {isPreviewActive && <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-semibold text-amber-900">Preview active{previewTitle ? ": " + previewTitle : ""}</span>}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 sm:px-6">
            <p className="text-sm font-semibold text-slate-800">
              {isLoading ? "Loading research references…" : totalMatches + " matching reference" + (totalMatches === 1 ? "" : "s")}
            </p>
            <p className="text-xs text-slate-500">{results.filter((item) => item.mediaType === "image").length} images · {results.filter((item) => item.mediaType === "video").length} videos in results</p>
          </div>

          {errorMessage && <p role="alert" className="m-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{errorMessage}</p>}
          {!isLoading && !errorMessage && results.length === 0 && <p className="p-6 text-sm text-slate-500">No references matched these filters. Try a wider location or style search.</p>}

          <ul className="grid max-h-[760px] gap-3 overflow-y-auto bg-slate-100 p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-3 sm:px-6">
            {results.map((reference) => {
              const metadata = formatMetadata(reference.reportedBuildingMetadata);
              const mapUrl = locationMapUrl(reference);
              const observations = (reference.designProfile.facadeFeatures ?? []).slice(0, 4);
              const roofObservations = (reference.designProfile.roofFeatures ?? []).slice(0, 2);
              const siteObservations = (reference.designProfile.siteContext ?? []).slice(0, 2);
              const assignableFacade = canAssignArchitectureReference(reference);
              const renderProfile = assignableFacade
                ? createArchitectureStylePreview(reference)
                : null;
              const renderFlags = renderProfile ? [
                renderProfile.materialPattern ? readableName(renderProfile.materialPattern) + " surface" : null,
                renderProfile.decorativeColumns ? "Decorative columns" : null,
                renderProfile.verticalLouvres ? "Vertical sun-shading" : null,
                renderProfile.greenery ? "Planters / creepers" : null,
                renderProfile.grilles ? "Window grilles" : null,
                renderProfile.groundFloorArches ? "Ground-floor arches" : null,
                renderProfile.roofDetail === "roof-garden" ? "Roof garden" : null,
                renderProfile.roofDetail === "roof-terrace" ? "Roof terrace" : null,
              ].filter((flag): flag is string => Boolean(flag)) : [];
              return (
                <li key={reference.id} className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[10px] font-semibold text-slate-600">{reference.id}</span>
                    <span className="rounded-full border border-slate-200 px-2 py-1 text-[10px] text-slate-600">{reference.mediaType === "video" ? "Video" : "Image / project"}</span>
                  </div>
                  <h3 className="mt-3 break-words text-sm font-semibold leading-5 text-slate-900">{reference.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{reference.sourceName ?? "Source page"} · {reference.locationText}</p>
                  {reference.mediaPreviewKind === "image" && reference.mediaPreviewUrl && (
                    <a href={reference.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 block overflow-hidden rounded-lg border border-slate-200 bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" aria-label={"Open original image source for " + reference.title}>
                      {/* Direct third-party Commons preview; image bytes are never copied into this repository. */}
                      <div className="relative aspect-[4/3] w-full bg-slate-100">
                        <img
                          src={reference.mediaPreviewUrl}
                          alt={"Reference image preview: " + reference.title}
                          loading="lazy"
                          className="h-full w-full object-contain"
                          referrerPolicy="no-referrer"
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                      </div>
                    </a>
                  )}
                  {reference.mediaPreviewKind === "video" && videoIdFromEmbedUrl(reference.mediaPreviewUrl) && (
                    <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-black">
                      <div className="aspect-video">
                        <iframe
                          title={"Video context: " + reference.title}
                          src={reference.mediaPreviewUrl ?? undefined}
                          loading="lazy"
                          referrerPolicy="strict-origin-when-cross-origin"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                          allowFullScreen
                          className="h-full w-full"
                        />
                      </div>
                    </div>
                  )}
                  {reference.mediaPreviewKind === "image" && reference.mediaPreviewUrl && (
                    <p className="mt-1 text-[10px] leading-4 text-slate-500">
                      External Commons preview · {reference.author ? "Creator: " + reference.author + " · " : ""}{reference.license ?? "Licence not recorded"}. The original source page remains the attribution/licence authority.
                    </p>
                  )}
                  {reference.mediaPreviewKind === "video" && (
                    <p className="mt-1 text-[10px] leading-4 text-slate-500">
                      Embedded from YouTube for street-context review only. Do not download/extract frames or reuse them as building textures without permission.
                    </p>
                  )}
                  {reference.mediaType === "image" && !reference.mediaPreviewUrl && (
                    <a href={reference.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 flex aspect-[4/1] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 text-xs font-medium text-blue-800 underline underline-offset-4">
                      Open source photo / project gallery
                    </a>
                  )}
                  {reference.mediaType === "video" && !reference.mediaPreviewUrl && (
                    <a href={reference.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 flex aspect-[4/1] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 text-xs font-medium text-blue-800 underline underline-offset-4">
                      Watch source video
                    </a>
                  )}

                  <p className="mt-2 break-words text-xs font-medium text-blue-800">{readableName(reference.designProfile.styleFamily)}</p>

                  <div className="mt-3 flex flex-wrap gap-1.5" aria-label={"Estimated design palette for " + reference.id}>
                    {reference.designProfile.colorPalette.slice(0, 5).map((swatch) => (
                      <span key={swatch.hex + swatch.name} className="group relative inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-2 text-[10px] text-slate-600" title={swatch.name + " · estimated " + swatch.hex}>
                        <span aria-hidden="true" className="h-4 w-4 rounded-full border border-black/10" style={{ backgroundColor: swatch.hex }} />
                        <span>{swatch.hex}</span>
                      </span>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-amber-700">Estimated visual palette · {reference.designProfile.paletteConfidence}</p>
                  {selectedAssignment?.referenceId === reference.id && (
                    <p className="mt-2 inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-800">Saved on selected building</p>
                  )}

                  {observations.length > 0 && (
                    <div className="mt-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Observed facade cues</p>
                      <ul className="mt-1 space-y-1 text-xs leading-4 text-slate-700">
                        {observations.map((feature) => <li key={feature} className="flex gap-2"><span className="text-blue-600">•</span><span>{feature}</span></li>)}
                      </ul>
                    </div>
                  )}

                  {(roofObservations.length > 0 || siteObservations.length > 0) && (
                    <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                      {roofObservations.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Roof / upper massing clues</p>
                          {roofObservations.map((item) => <p key={item} className="mt-1 text-[11px] leading-4 text-slate-700">{item}</p>)}
                        </div>
                      )}
                      {siteObservations.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{reference.mediaType === "video" ? "Street context from video description" : "Site / street context"}</p>
                          {siteObservations.map((item) => <p key={item} className="mt-1 text-[11px] leading-4 text-slate-700">{item}</p>)}
                        </div>
                      )}
                    </div>
                  )}

                  {renderFlags.length > 0 && (
                    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-blue-900">Features used by procedural preview</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {renderFlags.map((flag) => <span key={flag} className="rounded-full border border-blue-200 bg-white px-2 py-1 text-[10px] text-blue-900">{flag}</span>)}
                      </div>
                      <p className="mt-2 text-[10px] leading-4 text-blue-800">Rendered on demand from the saved text profile and estimated colour swatches; this is not pixel-extracted geometry.</p>
                    </div>
                  )}

                  {!assignableFacade && reference.mediaType === "image" && (
                    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-700">Context image only</p>
                      <p className="mt-1 text-[11px] leading-4 text-slate-600">This is a panorama, skyline, or building-cluster reference. It is useful for neighbourhood context but not specific enough to assign to one mapped facade.</p>
                    </div>
                  )}
                  {reference.mediaType === "video" && (
                    <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-900">Video-derived context only</p>
                      <p className="mt-1 text-[11px] leading-4 text-violet-900">Lane enclosure, frontage density and broad street character can inform a streetscape preset, but this route is not frame-matched to a particular mapped property. Video reuse permissions are not established.</p>
                    </div>
                  )}

                  {metadata.length > 0 && (
                    <div className="mt-3 rounded-lg bg-slate-50 p-2.5">
                      {metadata.map((line) => <p key={line} className="text-[11px] leading-4 text-slate-600">{line}</p>)}
                    </div>
                  )}

                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <p className="text-[10px] leading-4 text-slate-500">Location precision: {reference.designProfile.locationPrecision}</p>
                    <p className="mt-1 text-[10px] leading-4 text-slate-500">Match confidence: {reference.locationConfidence}</p>
                    <p className={"mt-2 inline-flex rounded-full border px-2 py-1 text-[10px] font-medium " + usageClass(reference.usageStatus)}>{labelForUsage(reference.usageStatus)}</p>
                  </div>

                  <div className="mt-auto space-y-3 pt-4">
                    <button type="button" disabled={!canPreview || !assignableFacade}
                      onClick={() => onAssign(reference, createArchitectureStylePreview(reference))}
                      title={!assignableFacade ? "This record is context-only or lacks an individual-building facade; it cannot be assigned to a single footprint." : "Save this researched facade profile to the currently selected building ID."}
                      className="w-full rounded-lg bg-emerald-700 px-3 py-2.5 text-xs font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">
                      {!assignableFacade
                        ? (reference.mediaType === "video" ? "Video context only" : "Context only — no building match")
                        : selectedAssignment?.referenceId === reference.id
                          ? "Update saved profile"
                          : "Apply & save to this building"}
                    </button>
                    <button type="button" disabled={!canPreview || !assignableFacade}
                      onClick={() => onPreview(createArchitectureStylePreview(reference), reference.title)}
                      title={!assignableFacade ? "This source is useful for city/street context, not as a single-building facade preview." : undefined}
                      className="w-full rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs font-semibold text-blue-900 transition hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">
                      Preview temporarily
                    </button>
                    <div className="flex flex-wrap gap-3 text-xs font-semibold">
                    <a href={reference.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline decoration-blue-300 underline-offset-4 hover:text-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">Open source ↗</a>
                    {mapUrl && <a href={mapUrl} target="_blank" rel="noreferrer" className="text-slate-700 underline decoration-slate-300 underline-offset-4 hover:text-slate-950">Open map point ↗</a>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <p className="border-t border-slate-200 bg-white px-4 py-3 text-xs leading-5 text-slate-500 sm:px-6">
            {notice} Source availability is not reuse permission. Neighbourhoods, camera viewpoints and named landmarks are distinguished; do not treat a nearby point as a verified building centroid.
          </p>
        </div>
      )}
    </section>
  );
}
