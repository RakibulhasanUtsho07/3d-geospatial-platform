"use client";

import { useState, type FormEvent } from "react";
import { getActivePublishedModels } from "@/core/building-generation/published-model-catalog-reader.mjs";
import type { GeneratedModelDefinition } from "@/core/map-engine/types";

type PublishedCatalogModel = {
  definition: GeneratedModelDefinition;
  versionId: string;
  sha256: string;
};

type PublishResponse = {
  modelId: string;
  versionId: string;
  assetUrl: string;
  modelSha256: string;
  placement: GeneratedModelDefinition["position"];
};

interface GenerationJobPublishPanelProps {
  disabled: boolean;
  onPublished: (definition: GeneratedModelDefinition) => Promise<void>;
}

function finiteNumber(value: string, label: string, minimum: number, maximum: number): number {
  if (!value.trim()) throw new TypeError(label + " is required.");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(label + " must be between " + minimum + " and " + maximum + ".");
  }
  return parsed;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The publication service returned an invalid response.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("The publication service returned an invalid response.");
  }
  return payload as Record<string, unknown>;
}

/**
 * Operator-only bridge from an already reviewed generation job to the live
 * static catalog. The bearer token is kept in component memory only.
 */
export default function GenerationJobPublishPanel({
  disabled,
  onPublished,
}: GenerationJobPublishPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [token, setToken] = useState("");
  const [jobId, setJobId] = useState("");
  const [longitude, setLongitude] = useState("");
  const [latitude, setLatitude] = useState("");
  const [height, setHeight] = useState("");
  const [heading, setHeading] = useState("0");
  const [pitch, setPitch] = useState("0");
  const [roll, setRoll] = useState("0");
  const [scale, setScale] = useState("1");
  const [upAxis, setUpAxis] = useState<"X" | "Y" | "Z">("Y");
  const [forwardAxis, setForwardAxis] = useState<"X" | "Y" | "Z">("Z");
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (token.length < 32) {
      setError("Enter the configured publication token (at least 32 characters).");
      return;
    }
    if (!confirmPublic) {
      setError("Confirm that the GLB and catalog metadata will be publicly served.");
      return;
    }
    if (upAxis === forwardAxis) {
      setError("The model up-axis and forward-axis must be different.");
      return;
    }

    setBusy(true);
    let catalogVersionVerified = false;
    try {
      const placement = {
        position: {
          longitude: finiteNumber(longitude, "Longitude", -180, 180),
          latitude: finiteNumber(latitude, "Latitude", -90, 90),
          height: finiteNumber(height, "Height", -12000, 9000000),
        },
        heightReference: "WGS84-ellipsoid",
        headingDegrees: finiteNumber(heading, "Heading", -360, 360),
        pitchDegrees: finiteNumber(pitch, "Pitch", -90, 90),
        rollDegrees: finiteNumber(roll, "Roll", -360, 360),
        scale: finiteNumber(scale, "Scale", 0.001, 1000),
        upAxis,
        forwardAxis,
      };

      const response = await fetch(
        "/api/building-generation/jobs/" + encodeURIComponent(jobId.trim()) + "/publish",
        {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ placement }),
          cache: "no-store",
        },
      );
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "The generation job could not be published.");
      }

      const published = payload as unknown as PublishResponse;
      if (
        typeof published.modelId !== "string" ||
        typeof published.versionId !== "string" ||
        typeof published.modelSha256 !== "string" ||
        typeof published.assetUrl !== "string"
      ) {
        throw new Error("Publication succeeded but its response did not identify the published version.");
      }

      const catalogResponse = await fetch("/models/generated/manifest.json", {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      if (!catalogResponse.ok) {
        throw new Error("The model was published, but the public catalog could not be reloaded. Refresh the catalog after fixing static-file access.");
      }

      const catalogPayload: unknown = await catalogResponse.json();
      const activeModels = getActivePublishedModels(catalogPayload) as PublishedCatalogModel[];
      const exactVersion = activeModels.find((item) =>
        item.definition.id === published.modelId &&
        item.versionId === published.versionId &&
        item.sha256 === published.modelSha256 &&
        item.definition.url === published.assetUrl
      );
      if (!exactVersion) {
        throw new Error("The model was published, but the active catalog version/hash did not match the publication response. It was not loaded.");
      }
      catalogVersionVerified = true;

      setToken("");
      await onPublished(exactVersion.definition);
      setMessage(
        "Published and loaded " + (exactVersion.definition.name ?? exactVersion.definition.id) +
        " · version " + exactVersion.versionId + " · SHA-256 " + exactVersion.sha256.slice(0, 12) +
        "… The generation job's mapReady and publicationEligible flags remain false.",
      );
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : "Unknown error.";
      setError(catalogVersionVerified
        ? "The job was published and the catalog version/hash was verified, but the current map session could not load it: " + detail + " The published version remains available in the catalog; remove any older session model and load it from the catalog."
        : detail);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.035] p-3"
    >
      <summary className="cursor-pointer list-inside text-sm font-semibold text-cyan-100">
        Publish an approved generation job to this map
      </summary>
      <div className="mt-2">
        <p className="text-xs leading-5 text-zinc-400">
          Use this only after a completed job has an approved review record. Enter the exact longitude, latitude, ellipsoid height, heading, pitch, roll, scale and axes captured by that approval; any difference is rejected. Placement is never inferred from an image or model.
        </p>

        <form onSubmit={handleSubmit} className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-zinc-300">
            Publication bearer token
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              maxLength={4096}
              required
              placeholder="GENERATION_PUBLISH_API_TOKEN"
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-300/60"
            />
            <span className="mt-1 block font-normal text-zinc-500">Kept in this component&apos;s memory only; it is not written to localStorage.</span>
          </label>

          <label className="block text-xs font-medium text-zinc-300">
            Completed generation job ID
            <input
              value={jobId}
              onChange={(event) => setJobId(event.target.value)}
              required
              maxLength={80}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,79}"
              placeholder="gen-..."
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-300/60"
            />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block text-xs font-medium text-zinc-300">
              Longitude (WGS84)
              <input type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Latitude (WGS84)
              <input type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Height (m; WGS84 ellipsoid)
              <input type="number" step="any" value={height} onChange={(event) => setHeight(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block text-xs font-medium text-zinc-300">
              Heading °
              <input type="number" step="any" value={heading} onChange={(event) => setHeading(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Pitch °
              <input type="number" step="any" value={pitch} onChange={(event) => setPitch(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Roll °
              <input type="number" step="any" value={roll} onChange={(event) => setRoll(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Scale
              <input type="number" min="0.001" max="1000" step="any" value={scale} onChange={(event) => setScale(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-zinc-300">
              GLB up-axis
              <select value={upAxis} onChange={(event) => setUpAxis(event.target.value as "X" | "Y" | "Z")} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60">
                <option value="X">X</option><option value="Y">Y</option><option value="Z">Z</option>
              </select>
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              GLB forward-axis
              <select value={forwardAxis} onChange={(event) => setForwardAxis(event.target.value as "X" | "Y" | "Z")} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60">
                <option value="X">X</option><option value="Y">Y</option><option value="Z">Z</option>
              </select>
            </label>
          </div>

          <label className="flex items-start gap-2 text-xs leading-5 text-amber-100">
            <input type="checkbox" checked={confirmPublic} onChange={(event) => setConfirmPublic(event.target.checked)} className="mt-0.5" />
            <span>I confirm that publication copies the GLB and catalog metadata into the application&apos;s public static directory. Anyone with access to the site may fetch the published asset.</span>
          </label>

          {error && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">{error}</p>}
          {message && <p role="status" className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs leading-5 text-emerald-200">{message}</p>}

          <button
            type="submit"
            disabled={disabled || busy}
            className="w-full rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-50"
          >
            {busy ? "Verifying review and publishing…" : "Verify, publish and load model"}
          </button>
        </form>

        <p className="mt-3 text-[11px] leading-5 text-zinc-500">
          The current development review API uses an operator-shared token and human-supplied checks; it does not prove civil identity or legal authority. This operation does not mark groundTruth, acceptanceEligible, publicationEligible, mapReady or automaticApproval as true, and it does not establish reconstruction accuracy.
        </p>
      </div>
    </details>
  );
}
