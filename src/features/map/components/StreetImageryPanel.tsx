"use client";

import { useState, type CSSProperties } from "react";

import {
  assessReconstructionReadiness,
} from "@/core/geospatial/street-imagery.mjs";
import type {
  StreetImageryReference,
} from "@/core/geospatial/street-imagery.mjs";

type ImageryResponse = {
  error?: string;
  count?: number;
  results?: StreetImageryReference[];
  note?: string;
};

interface StreetImageryPanelProps {
  latitude: number;
  longitude: number;
  buildingLabel: string;
}

function formatDistance(distance: number): string {
  return distance < 1000 ? Math.round(distance) + " m" : (distance / 1000).toFixed(1) + " km";
}

function thumbnailStyle(url: string): CSSProperties {
  return {
    backgroundImage: 'url("' + url.replace(/["\\\n\r]/g, "") + '")',
  };
}

export default function StreetImageryPanel({
  latitude,
  longitude,
  buildingLabel,
}: StreetImageryPanelProps) {
  const [radius, setRadius] = useState("250");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ImageryResponse | null>(null);
  const [searchKey, setSearchKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const currentKey = latitude.toFixed(5) + ":" + longitude.toFixed(5);
  const visibleResponse = searchKey === currentKey ? response : null;
  const photos = Array.isArray(visibleResponse?.results) ? visibleResponse.results : [];
  const readiness = assessReconstructionReadiness(photos);

  async function findReferences() {
    setLoading(true);
    setErrorMessage(null);
    setSearchKey(currentKey);
    try {
      const params = new URLSearchParams({
        lat: String(latitude),
        lon: String(longitude),
        radius,
        limit: "25",
      });
      const result = await fetch("/api/geospatial/street-imagery?" + params.toString(), {
        signal: AbortSignal.timeout(20_000),
      });
      const payload = (await result.json()) as ImageryResponse;
      if (!result.ok) throw new Error(payload.error ?? "Street imagery lookup failed.");
      if (!Array.isArray(payload.results)) throw new Error("KartaView returned an invalid result format.");
      setResponse(payload);
    } catch (error: unknown) {
      setResponse(null);
      setErrorMessage(error instanceof Error ? error.message : "Street imagery lookup failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-label="Street imagery references" className="rounded-xl border border-cyan-300/20 bg-cyan-300/[0.04] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-100">Street imagery references</h3>
          <p className="mt-1 text-[11px] leading-4 text-slate-400">Public KartaView captures near this building; nearby does not guarantee exact building identity.</p>
        </div>
        <span className="shrink-0 rounded-full border border-white/10 px-2 py-1 text-[10px] text-slate-300">Reference only</span>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <label className="min-w-0 flex-1 text-[11px] text-slate-400">
          Search radius
          <select value={radius} onChange={(event) => setRadius(event.target.value)} disabled={loading} className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-2 text-xs text-white outline-none focus:border-cyan-300/60">
            <option value="50">50 m</option>
            <option value="100">100 m</option>
            <option value="250">250 m</option>
            <option value="500">500 m</option>
          </select>
        </label>
        <button type="button" onClick={() => void findReferences()} disabled={loading} className="mt-4 shrink-0 rounded-lg bg-cyan-300 px-3 py-2.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-50">
          {loading ? "Searching…" : "Find photos"}
        </button>
      </div>

      {loading && <p role="status" className="mt-3 text-xs text-slate-400">Searching public street-level image metadata near {buildingLabel}…</p>}
      {errorMessage && <p role="alert" className="mt-3 rounded-lg border border-red-300/20 bg-red-400/[0.06] p-2 text-xs leading-5 text-red-200">{errorMessage}</p>}

      {visibleResponse && (
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-white/10 bg-black/20 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-200">Architecture reference status</p>
            <p className="mt-1 text-xs font-semibold text-slate-100">{readiness.title}</p>
            <p className="mt-1 text-[11px] leading-4 text-slate-400">{readiness.detail}</p>
            <p className="mt-2 text-[10px] text-slate-500">{photos.length} reference(s) · {readiness.distinctCapturePoints} distinct capture point(s)</p>
          </div>

          {photos.length === 0 && (
            <p role="status" className="text-xs leading-5 text-slate-400">No usable public image references were returned within {radius} m. This does not mean no photo exists elsewhere; provider coverage and search scope are limited.</p>
          )}

          {photos.length > 0 && (
            <ul className="grid grid-cols-2 gap-2">
              {photos.slice(0, 8).map((photo) => (
                <li key={photo.id} className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-black/20">
                  <a href={photo.imageUrl ?? photo.thumbnailUrl} target="_blank" rel="noreferrer" className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" aria-label={"Open KartaView image reference " + photo.id}>
                    <div role="img" aria-label={"Street image reference " + photo.id} className="h-24 bg-slate-800 bg-cover bg-center" style={thumbnailStyle(photo.thumbnailUrl)} />
                  </a>
                  <div className="space-y-1 p-2">
                    <p className="text-[10px] font-semibold text-cyan-100">{photo.mediaKind === "video-frame" ? "Video-sequence frame" : "Street photo"}</p>
                    <p className="text-[10px] text-slate-300">{formatDistance(photo.distanceMeters)} away</p>
                    {photo.headingDegrees !== null && <p className="text-[10px] text-slate-500">Heading {Math.round(photo.headingDegrees)}°</p>}
                    {photo.captureDate && <p className="break-words text-[10px] text-slate-500">{photo.captureDate}</p>}
                    <a href={photo.sourceUrl} target="_blank" rel="noreferrer" className="inline-block text-[10px] text-cyan-200 underline">KartaView source</a>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[10px] leading-4 text-slate-500">{visibleResponse.note} Media licence: CC BY-SA 4.0. Attribution: © Grab and KartaView Contributors.</p>
        </div>
      )}

      <p className="mt-3 border-t border-white/10 pt-2 text-[10px] leading-4 text-slate-500">Street images provide facade clues, not complete building geometry. A real photogrammetry model requires multiple overlapping views. This panel does not download media in bulk or generate a mesh automatically.</p>
    </section>
  );
}
