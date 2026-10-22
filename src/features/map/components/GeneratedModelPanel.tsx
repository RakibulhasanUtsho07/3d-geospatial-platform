"use client";

import { useEffect, useState, type FormEvent } from "react";
import { getActivePublishedModels } from "@/core/building-generation/published-model-catalog-reader.mjs";

import type { GeneratedModelDefinition } from "@/core/map-engine/types";

interface GeneratedModelPanelProps {
  disabled: boolean;
  onAdd: (definition: GeneratedModelDefinition) => Promise<void>;
  onSetVisibility: (id: string, visible: boolean) => boolean;
  onRemove: (id: string) => boolean;
  onFocus: (definition: GeneratedModelDefinition) => void;
}

interface PublishedCatalogModel {
  definition: GeneratedModelDefinition;
  versionId: string;
  sha256: string;
  bytes: number;
  publishedAt: string;
  review: { reviewer: string; reviewedAt: string; checks: Record<string, boolean> };
}

interface LoadedGeneratedModel {
  definition: GeneratedModelDefinition;
  visible: boolean;
}

function finiteNumber(value: string, label: string): number {
  if (!value.trim()) throw new TypeError(label + " is required.");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(label + " must be a finite number.");
  return parsed;
}

export default function GeneratedModelPanel({
  disabled,
  onAdd,
  onSetVisibility,
  onRemove,
  onFocus,
}: GeneratedModelPanelProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [models, setModels] = useState<LoadedGeneratedModel[]>([]);
  const [id, setId] = useState("generated-building-01");
  const [name, setName] = useState("Generated building preview");
  const [url, setUrl] = useState("/models/generated-building.glb");
  const [longitude, setLongitude] = useState("90.40606");
  const [latitude, setLatitude] = useState("23.70860");
  const [height, setHeight] = useState("0");
  const [heading, setHeading] = useState("0");
  const [scale, setScale] = useState("1");
  const [catalogModels, setCatalogModels] = useState<PublishedCatalogModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedCatalogModelId, setSelectedCatalogModelId] = useState("");
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/models/generated/manifest.json", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Published model catalog could not be loaded (HTTP " + response.status + ").");
        return response.json() as Promise<unknown>;
      })
      .then((payload) => {
        const active = getActivePublishedModels(payload) as PublishedCatalogModel[];
        if (cancelled) return;
        setCatalogModels(active);
        setSelectedCatalogModelId((current) =>
          current && active.some((item) => item.definition.id === current)
            ? current
            : active[0]?.definition.id ?? ""
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setCatalogError(cause instanceof Error ? cause.message : "Published model catalog is invalid.");
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });

    return () => { cancelled = true; };
  }, [open, catalogRefreshKey]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);

    try {
      const definition: GeneratedModelDefinition = {
        id: id.trim(),
        name: name.trim(),
        url: url.trim(),
        position: {
          longitude: finiteNumber(longitude, "Longitude"),
          latitude: finiteNumber(latitude, "Latitude"),
          height: finiteNumber(height, "Height"),
        },
        headingDegrees: finiteNumber(heading, "Heading"),
        scale: finiteNumber(scale, "Scale"),
        upAxis: "Y",
        forwardAxis: "Z",
        show: true,
      };

      await onAdd(definition);
      setModels((current) => [
        ...current,
        { definition, visible: true },
      ]);
      setMessage("Model loaded into the current map session.");
      const usedIds = new Set([
        ...models.map((item) => item.definition.id),
        definition.id,
      ]);
      let nextSequence = 1;
      let nextId = "generated-building-" + String(nextSequence).padStart(2, "0");
      while (usedIds.has(nextId)) {
        nextSequence += 1;
        nextId = "generated-building-" + String(nextSequence).padStart(2, "0");
      }
      setId(nextId);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not load this GLB model.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadPublishedModel() {
    setError(null);
    setMessage(null);
    const published = catalogModels.find((item) => item.definition.id === selectedCatalogModelId);
    if (!published) {
      setError("Choose a published model version first.");
      return;
    }
    if (models.some((item) => item.definition.id === published.definition.id)) {
      setError("This model is already loaded in the current map session. Remove it before reloading.");
      return;
    }

    setBusy(true);
    try {
      await onAdd(published.definition);
      setModels((current) => [...current, { definition: published.definition, visible: true }]);
      onFocus(published.definition);
      setMessage(
        (published.definition.name ?? published.definition.id) +
        " published version " + published.versionId + " loaded. SHA-256: " + published.sha256.slice(0, 12) + "…"
      );
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not load this published model.");
    } finally {
      setBusy(false);
    }
  }

  function toggleVisibility(model: LoadedGeneratedModel) {
    setError(null);
    const visible = !model.visible;
    if (!onSetVisibility(model.definition.id, visible)) {
      setError("The map no longer has this model. Close and reopen the model loader after retrying the map.");
      return;
    }
    setModels((current) => current.map((item) =>
      item.definition.id === model.definition.id
        ? { ...item, visible }
        : item
    ));
    setMessage(model.definition.name + (visible ? " is visible." : " is hidden."));
  }

  function removeModel(model: LoadedGeneratedModel) {
    setError(null);
    if (!onRemove(model.definition.id)) {
      setError("The map no longer has this model. Retry the map before removing it.");
      return;
    }
    setModels((current) => current.filter((item) => item.definition.id !== model.definition.id));
    setMessage((model.definition.name ?? model.definition.id) + " was removed from the current map session.");
  }

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="generated-model-loader"
        disabled={disabled}
        onClick={() => {
          if (!open) {
            setCatalogLoading(true);
            setCatalogError(null);
          }
          setOpen(!open);
          setError(null);
          setMessage(null);
        }}
        className="absolute bottom-4 right-4 z-30 rounded-xl border border-cyan-200/20 bg-zinc-950/95 px-4 py-3 text-left text-sm font-semibold text-cyan-50 shadow-2xl backdrop-blur-xl transition hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="mr-2 inline-flex rounded-md bg-cyan-300/10 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-cyan-200">GLB</span>
        Generated models{models.length ? " (" + models.length + ")" : ""}
      </button>

      {open && (
        <div
          className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-3 backdrop-blur-sm sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setOpen(false);
          }}
        >
          <section
            id="generated-model-loader"
            role="dialog"
            aria-modal="true"
            aria-labelledby="generated-model-loader-title"
            className="my-auto max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 p-4 text-white shadow-2xl sm:p-6"
          >
            <header className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Building Generation Engine</p>
                <h2 id="generated-model-loader-title" className="mt-1 text-lg font-semibold">Load a generated GLB into the map</h2>
                <p className="mt-1 max-w-xl text-xs leading-5 text-zinc-400">
                  Add a model asset that is already available at a same-origin public path or an HTTPS URL.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close generated model loader"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-40"
              >
                Close
              </button>
            </header>

            <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/5 px-3 py-2.5 text-xs leading-5 text-amber-100">
              The generator output in <code>.building-engine/jobs/</code> is a review candidate, not a public asset. After review, place the approved GLB under <code>public/</code> and enter its URL below. This panel does not publish, copy, or approve model files.
            </div>

            <section className="mt-4 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.04] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-emerald-100">Published model catalog</h3>
                  <p className="mt-1 text-xs leading-5 text-zinc-400">
                    Loads the active version recorded in the reviewed catalog and shows its checksum.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={catalogLoading || busy}
                  onClick={() => {
                    setCatalogModels([]);
                    setCatalogLoading(true);
                    setCatalogError(null);
                    setCatalogRefreshKey((current) => current + 1);
                  }}
                  className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-40"
                >
                  Refresh catalog
                </button>
              </div>
              {catalogError && <p role="alert" className="mt-2 text-xs leading-5 text-red-200">{catalogError}</p>}
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                <select
                  value={selectedCatalogModelId}
                  onChange={(event) => setSelectedCatalogModelId(event.target.value)}
                  disabled={catalogLoading || busy || catalogModels.length === 0}
                  aria-label="Published model to load"
                  className="min-w-0 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-300/60 disabled:opacity-50"
                >
                  {catalogModels.length === 0 ? (
                    <option value="">{catalogLoading ? "Loading catalog…" : "No published models yet"}</option>
                  ) : catalogModels.map((item) => (
                    <option key={item.definition.id} value={item.definition.id}>
                      {(item.definition.name ?? item.definition.id) + " · v" + item.versionId}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={catalogLoading || busy || catalogModels.length === 0 || !selectedCatalogModelId}
                  onClick={handleLoadPublishedModel}
                  className="rounded-lg bg-emerald-300 px-3 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {catalogLoading ? "Loading catalog…" : "Load published model"}
                </button>
              </div>
              {catalogModels.find((item) => item.definition.id === selectedCatalogModelId) && (
                <p className="mt-2 break-all text-[11px] leading-5 text-zinc-400">
                  SHA-256 {catalogModels.find((item) => item.definition.id === selectedCatalogModelId)?.sha256} · reviewed by {catalogModels.find((item) => item.definition.id === selectedCatalogModelId)?.review.reviewer}
                </p>
              )}
              <p className="mt-2 text-[11px] leading-5 text-zinc-500">
                Catalog review claims are operator-supplied attestations. Publishing checks the recorded file hashes; it does not independently prove rights, architecture or survey quality.
              </p>
            </section>

            <div className="mt-4 border-t border-white/10 pt-4">
              <h3 className="text-sm font-semibold text-zinc-200">Manual / development preview</h3>
              <p className="mt-1 text-xs leading-5 text-amber-100/80">
                This path bypasses the publication catalog. Use it only for local review; production map content should be loaded from the published catalog above.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-3">
              <label className="block text-xs font-medium text-zinc-300">
                Model asset URL
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  required
                  maxLength={2048}
                  placeholder="/models/generated-building.glb"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-300/60"
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-zinc-300">
                  Model ID
                  <input value={id} onChange={(event) => setId(event.target.value)} required maxLength={160} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
                </label>
                <label className="block text-xs font-medium text-zinc-300">
                  Display name
                  <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <label className="block text-xs font-medium text-zinc-300">
                  Longitude
                  <input type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
                </label>
                <label className="block text-xs font-medium text-zinc-300">
                  Latitude
                  <input type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
                </label>
                <label className="block text-xs font-medium text-zinc-300">
                  Height (m)
                  <input type="number" step="any" value={height} onChange={(event) => setHeight(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-zinc-300">
                  Heading (degrees)
                  <input type="number" step="any" value={heading} onChange={(event) => setHeading(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
                </label>
                <label className="block text-xs font-medium text-zinc-300">
                  Scale multiplier
                  <input type="number" min="0.001" max="1000" step="any" value={scale} onChange={(event) => setScale(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
                </label>
              </div>

              <p className="text-xs leading-5 text-zinc-400">
                Placement is horizontal WGS84 longitude/latitude plus height above the configured ellipsoid reference. The default axes are Y-up and Z-forward. This loader does not infer building dimensions, orientation, or surveyed elevation from a GLB.
              </p>

              {error && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">{error}</p>}
              {message && <p role="status" className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs leading-5 text-emerald-200">{message}</p>}

              <button type="submit" disabled={disabled || busy} className="w-full rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-50">
                {busy ? "Loading model…" : "Load GLB into 3D map"}
              </button>
            </form>

            <div className="mt-5 border-t border-white/10 pt-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Models in this session</h3>
                <span className="text-xs text-zinc-500">{models.length} loaded</span>
              </div>
              {models.length === 0 ? (
                <p className="mt-2 text-xs leading-5 text-zinc-500">No generated models loaded in this map session yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {models.map((model) => (
                    <li key={model.definition.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium text-white">{model.definition.name ?? model.definition.id}</p>
                          <p className="mt-1 break-all text-xs text-zinc-500">{model.definition.url}</p>
                          <p className="mt-1 text-[11px] text-zinc-500">
                            {model.definition.position.longitude.toFixed(5)}, {model.definition.position.latitude.toFixed(5)} · scale {model.definition.scale ?? 1}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => onFocus(model.definition)} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">Focus</button>
                          <button type="button" onClick={() => toggleVisibility(model)} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">{model.visible ? "Hide" : "Show"}</button>
                          <button type="button" onClick={() => removeModel(model)} className="rounded-lg border border-red-300/20 px-2.5 py-1.5 text-xs text-red-200 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Remove</button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
