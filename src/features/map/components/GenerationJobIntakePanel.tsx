"use client";

import { useEffect, useState, type FormEvent, type ChangeEvent } from "react";

import {
  buildMapGenerationBuildingSpec,
  buildMapGenerationJobInput,
  getMapGenerationOperationScopes,
} from "@/core/building-generation/generation-map-intake.mjs";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_COUNT = 12;
const POLL_INTERVAL_MS = 5000;

type Strategy = "procedural" | "single-image-ai" | "photogrammetry";

type UploadedSource = {
  fileKey: string;
  buildingId: string;
  licence: string;
  sourceId: string;
  relativePath: string;
  kind: "image";
  sha256: string;
  byteSize: number;
  title?: string;
};

type GenerationJob = {
  jobId: string;
  buildingId: string;
  strategy: string;
  status: "queued" | "running" | "completed" | "failed";
  phase: string;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
  review?: Record<string, unknown>;
  mapReady: false;
  publicationEligible: false;
};

type StrategyCapability = {
  status: "ready" | "configured" | "blocked";
  blockers: string[];
  caveats: string[];
  modelWeights?: "cached" | "missing" | "not-checked" | "unknown";
};

type WorkerStatus = {
  availability: "online" | "offline" | "stale" | "stopped";
  phase: string;
  online: boolean;
  heartbeatAgeMs?: number;
  currentJobId: string | null;
  lastError: string | null;
  capabilities: {
    checkedAt: string;
    strategies: Record<"procedural" | "photogrammetry" | "single-image-ai", StrategyCapability>;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The generation API returned an invalid JSON response.");
  }
  if (!isRecord(payload)) throw new Error("The generation API returned an invalid response.");
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Generation API request failed (HTTP " + response.status + ").");
  }
  return payload;
}

async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function stableSourceId(contentHash: string, licence: string): Promise<string> {
  const identity = new TextEncoder().encode(contentHash + "\\0" + licence.trim());
  const digest = await crypto.subtle.digest("SHA-256", identity);
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return "map-" + hex.slice(0, 32);
}

function statusLabel(status: GenerationJob["status"]): string {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "completed") return "Candidate ready for review";
  return "Failed";
}

function workerLabel(status: WorkerStatus["availability"]): string {
  if (status === "online") return "Worker online";
  if (status === "stale") return "Worker heartbeat stale";
  if (status === "stopped") return "Worker stopped";
  return "Worker offline";
}

/**
 * Map-side intake UI. The bearer token stays in React memory only. Uploads
 * start unreviewed; a worker later records only the operator's explicit
 * CLI attestation as pipeline usage approval, not independent rights review.
 */
export default function GenerationJobIntakePanel() {
  const [expanded, setExpanded] = useState(false);
  const [token, setToken] = useState("");
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [buildingId, setBuildingId] = useState("new-building-01");
  const [buildingName, setBuildingName] = useState("");
  const [longitude, setLongitude] = useState("");
  const [latitude, setLatitude] = useState("");
  const [referenceHeight, setReferenceHeight] = useState("0");
  const [widthM, setWidthM] = useState("18");
  const [depthM, setDepthM] = useState("24");
  const [floorCount, setFloorCount] = useState("5");
  const [floorHeightM, setFloorHeightM] = useState("3");
  const [headingDegrees, setHeadingDegrees] = useState("0");
  const [licence, setLicence] = useState("");
  const [author, setAuthor] = useState("");
  const [attribution, setAttribution] = useState("");
  const [strategy, setStrategy] = useState<Strategy>("single-image-ai");
  const [files, setFiles] = useState<File[]>([]);
  const [confirmRights, setConfirmRights] = useState(false);
  const [confirmOperationScopes, setConfirmOperationScopes] = useState(false);
  const [confirmSingleViewInference, setConfirmSingleViewInference] = useState(false);
  const [confirmSameBuilding, setConfirmSameBuilding] = useState(false);
  const [confirmOverlapReviewed, setConfirmOverlapReviewed] = useState(false);
  const [confirmUpAxisReviewed, setConfirmUpAxisReviewed] = useState(false);
  const [upAxis, setUpAxis] = useState<"X" | "Y" | "Z">("Y");
  const [uploadedSources, setUploadedSources] = useState<UploadedSource[]>([]);
  const [uploadProgress, setUploadProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState("");
  const [lookupJobId, setLookupJobId] = useState("");
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || sessionActive) return;
    let alive = true;
    fetch("/api/building-generation/operator-session", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    }).then((response) => response.json()).then((payload: unknown) => {
      if (alive && isRecord(payload) && payload.authenticated === true) setSessionActive(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [expanded, sessionActive]);

  useEffect(() => {
    if (!expanded || !sessionActive) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let pollInFlight = false;
    async function pollWorker() {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const response = await fetch("/api/building-generation/worker-status", {
          credentials: "same-origin", cache: "no-store",
        });
        if (response.status === 401) {
          if (alive) {
            setSessionActive(false);
            setStatusError("Operator session expired. Connect again to view worker readiness.");
          }
          if (timer) clearInterval(timer);
          timer = null;
          return;
        }
        const payload = await responseObject(response);
        if (!alive) return;
        setWorker(payload as unknown as WorkerStatus);
        setStatusError(null);
      } catch (cause: unknown) {
        if (alive) setStatusError(cause instanceof Error ? cause.message : "Could not refresh worker readiness.");
      } finally {
        pollInFlight = false;
      }
    }
    void pollWorker();
    timer = setInterval(() => { void pollWorker(); }, 15_000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [expanded, sessionActive]);

  useEffect(() => {
    if (!activeJobId || !sessionActive) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let pollInFlight = false;
    async function pollJob() {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const response = await fetch("/api/building-generation/jobs/" + encodeURIComponent(activeJobId), {
          credentials: "same-origin", cache: "no-store",
        });
        if (response.status === 401) {
          if (alive) {
            setSessionActive(false);
            setStatusError("Operator session expired. Connect again to keep tracking this job.");
          }
          if (timer) clearInterval(timer);
          timer = null;
          return;
        }
        if (response.status === 404) {
          if (alive) setStatusError("Generation job was not found. Check the exact job ID.");
          if (timer) clearInterval(timer);
          timer = null;
          return;
        }
        const payload = await responseObject(response);
        if (!alive) return;
        if (!isRecord(payload.job) || typeof payload.job.jobId !== "string") {
          throw new Error("Job status response is missing the job record.");
        }
        setJob(payload.job as unknown as GenerationJob);
        const nextStatus = payload.job.status;
        if (nextStatus === "completed" || nextStatus === "failed") {
          if (timer) clearInterval(timer);
          timer = null;
        }
      } catch (cause: unknown) {
        if (alive) setStatusError(cause instanceof Error ? cause.message : "Could not refresh generation job status.");
      } finally {
        pollInFlight = false;
      }
    }
    void pollJob();
    timer = setInterval(() => { void pollJob(); }, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [activeJobId, sessionActive]);

  function handleFilesChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    setError(null);
    setMessage(null);
    if (selected.length > MAX_IMAGE_COUNT) {
      setFiles([]);
      setError("Select at most " + MAX_IMAGE_COUNT + " images per generation job.");
      event.currentTarget.value = "";
      return;
    }
    const invalid = selected.find((file) =>
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size === 0 || file.size > MAX_IMAGE_BYTES
    );
    if (invalid) {
      setFiles([]);
      setError(invalid.size > MAX_IMAGE_BYTES
        ? invalid.name + " exceeds the 20 MiB image limit."
        : invalid.name + " is not a supported JPEG, PNG or WebP image.");
      event.currentTarget.value = "";
      return;
    }
    setFiles(selected);
    setConfirmRights(false);
    setConfirmOperationScopes(false);
    setConfirmSingleViewInference(false);
    setConfirmSameBuilding(false);
    setConfirmOverlapReviewed(false);
    setConfirmUpAxisReviewed(false);
    setMessage(selected.length + " image(s) selected. Rights and source identity still require operator review.");
  }

  async function connectOperatorSession() {
    setError(null);
    setMessage(null);
    if (token.length < 32) {
      setError("Enter the configured operator login token (at least 32 characters).");
      return;
    }
    setSessionBusy(true);
    try {
      const response = await fetch("/api/building-generation/operator-session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await responseObject(response);
      if (payload.authenticated !== true) throw new Error("The server did not establish an operator session.");
      setSessionActive(true);
      setToken("");
      setMessage("Operator session connected. The server stores the session in a short-lived HttpOnly cookie; the login token was cleared from this UI.");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not connect the operator session.");
    } finally {
      setSessionBusy(false);
    }
  }

  async function disconnectOperatorSession() {
    try {
      await fetch("/api/building-generation/operator-session", {
        method: "DELETE",
        credentials: "same-origin",
      });
    } finally {
      setSessionActive(false);
      setActiveJobId("");
      setJob(null);
      setWorker(null);
    }
  }

  async function uploadOne(
    file: File,
    index: number,
    total: number,
    fileKey: string,
    currentSources: UploadedSource[],
  ): Promise<UploadedSource> {
    const reusable = currentSources.find((source) =>
      source.fileKey === fileKey &&
      source.buildingId === buildingId.trim() &&
      source.licence === licence.trim()
    );
    if (reusable) return reusable;

    const contentHash = fileKey.slice(fileKey.lastIndexOf("|") + 1);
    const sourceId = await stableSourceId(contentHash, licence);
    const form = new FormData();
    form.append("buildingId", buildingId.trim());
    form.append("sourceId", sourceId);
    form.append("kind", "image");
    form.append("licence", licence.trim());
    if (author.trim()) form.append("author", author.trim());
    if (attribution.trim()) form.append("attribution", attribution.trim());
    form.append("title", file.name);
    form.append("description", "Map-side facade image intake; usage remains unreviewed.");
    form.append("file", file, file.name);

    setUploadProgress("Uploading image " + (index + 1) + " of " + total + "…");
    const response = await fetch("/api/building-generation/uploads", {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const payload = await responseObject(response);
    if (!isRecord(payload.source) ||
        typeof payload.source.relativePath !== "string" ||
        typeof payload.source.sha256 !== "string" ||
        typeof payload.source.id !== "string") {
      throw new Error("Upload succeeded but its source record is incomplete.");
    }
    return {
      fileKey,
      buildingId: buildingId.trim(),
      licence: licence.trim(),
      sourceId: payload.source.id,
      relativePath: payload.source.relativePath,
      kind: "image",
      sha256: payload.source.sha256,
      byteSize: typeof payload.source.byteSize === "number" ? payload.source.byteSize : file.size,
      title: file.name,
    };
  }

  async function submitGeneration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!sessionActive) {
      setError("Connect an operator session before uploading images or queueing a job.");
      return;
    }
    const strategyCapability = worker?.capabilities?.strategies[strategy];
    if (worker?.availability === "online" && strategyCapability && strategyCapability.status !== "ready") {
      const detail = strategyCapability.blockers.join(" ") ||
        (strategy === "single-image-ai" && strategyCapability.modelWeights === "missing"
          ? "TripoSR config.yaml and model.ckpt must be cached before this worker can claim single-image jobs."
          : "Required runtime prerequisites are not ready.");
      setError("The active worker cannot run " + strategy + ": " + detail);
      return;
    }
    if (!files.length) {
      setError("Select at least one facade image.");
      return;
    }
    if ((strategy === "single-image-ai" || strategy === "photogrammetry") &&
        files.some((file) => file.type === "image/webp")) {
      setError("The selected reconstruction worker accepts JPEG or PNG only. Convert WebP images before using single-image AI or photogrammetry; changing the file extension is not conversion.");
      return;
    }
    if (!licence.trim() || ["unknown", "n/a", "none"].includes(licence.trim().toLowerCase())) {
      setError("Enter a known licence or permission basis for the selected images.");
      return;
    }
    if (!confirmRights) {
      setError("Confirm that you checked the rights for every selected source before creating a job.");
      return;
    }
    if (!confirmOperationScopes) {
      setError("Confirm that every selected source permits the requested generation operations.");
      return;
    }
    if (strategy === "single-image-ai" && (files.length !== 1 || !confirmSingleViewInference)) {
      setError("Single-image AI requires exactly one image and explicit single-view inference confirmation.");
      return;
    }
    if (strategy === "photogrammetry" &&
        (files.length < 3 || !confirmSameBuilding || !confirmOverlapReviewed || !confirmUpAxisReviewed)) {
      setError("Photogrammetry requires at least three images and all same-building, overlap and up-axis confirmations.");
      return;
    }

    setBusy(true);
    setUploadProgress("");
    let localSources = [...uploadedSources];
    const selectedSources: UploadedSource[] = [];
    try {
      const buildingSpec = buildMapGenerationBuildingSpec({
        id: buildingId.trim(),
        name: buildingName,
        longitude: Number(longitude),
        latitude: Number(latitude),
        heightM: Number(referenceHeight),
        widthM: Number(widthM),
        depthM: Number(depthM),
        floorCount: Number(floorCount),
        floorHeightM: Number(floorHeightM),
        headingDegrees: Number(headingDegrees),
      });

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const digest = await sha256File(file);
        const fileKey = [file.name, file.size, file.lastModified, digest].join("|");
        const source = await uploadOne(file, index, files.length, fileKey, localSources);
        selectedSources.push(source);
        if (!localSources.some((item) => item.sourceId === source.sourceId)) {
          localSources = [...localSources, source];
        }
        setUploadedSources(localSources);
      }

      setUploadProgress("Creating durable generation job…");
      const requestBody = buildMapGenerationJobInput({
        buildingSpec,
        strategy,
        uploadedSources: selectedSources.map((source) => ({
          sourceId: source.sourceId,
          relativePath: source.relativePath,
          kind: source.kind,
          licence: source.licence,
          permittedOperations: getMapGenerationOperationScopes(strategy),
          author,
          attribution,
        })),
        confirmRights,
        confirmOperationScopes,
        selectedViewSourceIds: selectedSources.map((source) => source.sourceId),
        confirmSingleViewInference,
        confirmSameBuilding,
        confirmOverlapReviewed,
        confirmUpAxisReviewed,
        upAxis,
      });

      const response = await fetch("/api/building-generation/jobs", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await responseObject(response);
      if (!isRecord(payload.job) || typeof payload.job.jobId !== "string") {
        throw new Error("Generation API did not return a valid queued job.");
      }
      const queuedJob = payload.job as unknown as GenerationJob;
      setJob(queuedJob);
      setActiveJobId(queuedJob.jobId);
      setLookupJobId(queuedJob.jobId);
      setMessage("Generation job " + queuedJob.jobId + " was queued. The worker may be on a separate machine.");
      setFiles([]);
      setUploadProgress("");
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : "Could not create the generation job.";
      if (/unauthorized|operator session/i.test(detail)) setSessionActive(false);
      setError(
        detail +
        (localSources.length ? " Successfully uploaded source records were retained in this panel; retrying the same files and licence will reuse them." : "")
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadExistingJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatusError(null);
    if (!sessionActive) {
      setError("Connect an operator session before looking up a job.");
      return;
    }
    const id = lookupJobId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) {
      setError("Enter a valid generation job ID.");
      return;
    }
    setActiveJobId(id);
    setJob(null);
    setWorker(null);
  }

  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.035] p-3"
    >
      <summary className="cursor-pointer list-inside text-sm font-semibold text-cyan-100">
        Upload images and start building generation
      </summary>

      <div className="mt-2 space-y-4">
        <p className="text-xs leading-5 text-zinc-400">
          Connect with the server-configured operator login token to receive a 30-minute HttpOnly session cookie. The login token is cleared after connection; the browser never receives the server-side GENERATION_API_TOKEN or session-signing secret.
        </p>

        <form onSubmit={submitGeneration} className="space-y-3">
          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-zinc-200">Operator session</p>
              {sessionActive
                ? <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-[10px] text-emerald-200">Connected · HttpOnly cookie</span>
                : <span className="rounded-full bg-amber-300/10 px-2 py-1 text-[10px] text-amber-100">Not connected</span>}
            </div>
            {!sessionActive ? (
              <>
                <label className="mt-2 block text-xs font-medium text-zinc-300">
                  Operator login token
                  <input
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    autoComplete="off"
                    maxLength={4096}
                    placeholder="GENERATION_OPERATOR_LOGIN_TOKEN"
                    className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-300/60"
                  />
                </label>
                <button type="button" onClick={() => void connectOperatorSession()} disabled={sessionBusy || busy || token.length < 32} className="mt-2 w-full rounded-lg bg-cyan-300 px-3 py-2.5 text-xs font-semibold text-zinc-950 disabled:opacity-40">
                  {sessionBusy ? "Connecting…" : "Connect operator session"}
                </button>
              </>
            ) : (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] leading-5 text-zinc-500">Session expires after 30 minutes. Login token was cleared; the cookie is HttpOnly, SameSite=Strict and scoped to generation APIs.</p>
                <button type="button" onClick={() => void disconnectOperatorSession()} disabled={busy} className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-white/10">Disconnect</button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-zinc-300">
              Building ID
              <input value={buildingId} onChange={(event) => setBuildingId(event.target.value)} required maxLength={80} pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,79}" className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Building name
              <input value={buildingName} onChange={(event) => setBuildingName(event.target.value)} required maxLength={240} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="block text-xs font-medium text-zinc-300">
              Longitude (WGS84)
              <input type="number" step="any" min="-180" max="180" value={longitude} onChange={(event) => setLongitude(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Latitude (WGS84)
              <input type="number" step="any" min="-85" max="85" value={latitude} onChange={(event) => setLatitude(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Reference height (m; datum unverified)
              <input type="number" step="any" value={referenceHeight} onChange={(event) => setReferenceHeight(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block text-xs font-medium text-zinc-300">
              Footprint width (m)
              <input type="number" min="1" max="500" step="any" value={widthM} onChange={(event) => setWidthM(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Footprint depth (m)
              <input type="number" min="1" max="500" step="any" value={depthM} onChange={(event) => setDepthM(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Floor count
              <input type="number" min="1" max="100" step="1" value={floorCount} onChange={(event) => setFloorCount(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Floor height (m)
              <input type="number" min="2" max="8" step="any" value={floorHeightM} onChange={(event) => setFloorHeightM(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
          </div>

          <label className="block text-xs font-medium text-zinc-300">
            Footprint heading (degrees)
            <input type="number" min="-360" max="360" step="any" value={headingDegrees} onChange={(event) => setHeadingDegrees(event.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
          </label>

          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <p className="text-xs font-semibold text-zinc-200">Facade images</p>
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFilesChange}
              disabled={busy}
              className="mt-2 block w-full text-xs text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-300 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-zinc-950"
            />
            <p className="mt-1 text-[11px] leading-5 text-zinc-500">
              JPEG, PNG or WebP · up to {MAX_IMAGE_COUNT} images · maximum 20 MiB per image. Video and PDF intake are not part of this map-side slice.
            </p>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1 text-[11px] text-zinc-300">
                {files.map((file) => <li key={[file.name, file.size, file.lastModified].join("|")} className="flex justify-between gap-2"><span className="truncate">{file.name}</span><span className="shrink-0 text-zinc-500">{(file.size / (1024 * 1024)).toFixed(1)} MiB</span></li>)}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block text-xs font-medium text-zinc-300">
              Licence / permission basis (applies to every selected image)
              <input value={licence} onChange={(event) => {
                setLicence(event.target.value);
                setConfirmRights(false);
              }} required maxLength={300} placeholder="e.g. CC BY 4.0 / owner permission" className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Author (optional)
              <input value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={500} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
            <label className="block text-xs font-medium text-zinc-300">
              Attribution (optional)
              <input value={attribution} onChange={(event) => setAttribution(event.target.value)} maxLength={500} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60" />
            </label>
          </div>
          <p className="text-[11px] leading-5 text-zinc-500">Use this batch only when the same permission/licence basis applies to every selected image. Split mixed-rights material into separate jobs.</p>

          <label className="block text-xs font-medium text-zinc-300">
            Generation strategy
            <select value={strategy} onChange={(event) => {
              setStrategy(event.target.value as Strategy);
              setConfirmOperationScopes(false);
              setConfirmSingleViewInference(false);
              setConfirmSameBuilding(false);
              setConfirmOverlapReviewed(false);
              setConfirmUpAxisReviewed(false);
            }} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/60">
              <option value="single-image-ai">Single-image AI reconstruction</option>
              <option value="photogrammetry">Multi-view photogrammetry (COLMAP)</option>
              <option value="procedural">Procedural from entered dimensions (does not infer from images)</option>
            </select>
          </label>

          {strategy === "single-image-ai" && (
            <label className="flex items-start gap-2 text-xs leading-5 text-amber-100">
              <input type="checkbox" checked={confirmSingleViewInference} onChange={(event) => setConfirmSingleViewInference(event.target.checked)} className="mt-0.5" />
              <span>I understand single-image AI creates an inferred proposal from one view; hidden/rear geometry is not observed and the output remains a review candidate.</span>
            </label>
          )}

          {strategy === "photogrammetry" && (
            <div className="space-y-2 rounded-lg border border-amber-300/20 bg-amber-300/[0.04] p-3 text-xs text-amber-100">
              <p>Use at least three overlapping views of the same building. The COLMAP worker and required tools must be configured on the worker host.</p>
              <label className="flex items-start gap-2"><input type="checkbox" checked={confirmSameBuilding} onChange={(event) => setConfirmSameBuilding(event.target.checked)} className="mt-0.5" /><span>I checked that all selected images show the same building.</span></label>
              <label className="flex items-start gap-2"><input type="checkbox" checked={confirmOverlapReviewed} onChange={(event) => setConfirmOverlapReviewed(event.target.checked)} className="mt-0.5" /><span>I reviewed image overlap and view coverage.</span></label>
              <label className="flex items-start gap-2"><input type="checkbox" checked={confirmUpAxisReviewed} onChange={(event) => setConfirmUpAxisReviewed(event.target.checked)} className="mt-0.5" /><span>I confirmed the source reconstruction up-axis.</span></label>
              <label className="flex items-center justify-between gap-2">
                <span>COLMAP up-axis</span>
                <select value={upAxis} onChange={(event) => setUpAxis(event.target.value as "X" | "Y" | "Z")} className="rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 text-white"><option>X</option><option>Y</option><option>Z</option></select>
              </label>
            </div>
          )}

          <label className="flex items-start gap-2 text-xs leading-5 text-amber-100">
            <input type="checkbox" checked={confirmRights} onChange={(event) => setConfirmRights(event.target.checked)} className="mt-0.5" />
            <span>I attest that I checked the reuse rights for every selected image. When the worker processes this job, it records <code>usageStatus=approved</code> with <code>rightsReviewMethod=explicit-cli-attestation</code> from this attestation only. This is not independent legal verification or a separate reviewer approval.</span>
          </label>
          <label className="flex items-start gap-2 text-xs leading-5 text-amber-100">
            <input type="checkbox" checked={confirmOperationScopes} onChange={(event) => setConfirmOperationScopes(event.target.checked)} className="mt-0.5" />
            <span>I explicitly authorize these operation scopes for every selected image: <strong>{getMapGenerationOperationScopes(strategy).join(", ")}</strong>. The worker records these operator-supplied scopes in source/job provenance; it does not independently verify the source owner's permission. This is separate from copyright/reuse rights.</span>
          </label>

          {uploadProgress && <p role="status" className="text-xs text-cyan-100">{uploadProgress}</p>}
          {error && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">{error}</p>}
          {message && <p role="status" className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs leading-5 text-emerald-200">{message}</p>}

          <button type="submit" disabled={busy || !sessionActive} className="w-full rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-50">
            {busy ? "Uploading and queuing…" : "Upload images and create generation job"}
          </button>
        </form>

        {uploadedSources.length > 0 && (
          <div className="rounded-lg border border-emerald-400/15 bg-emerald-400/[0.035] p-3">
            <p className="text-xs font-semibold text-emerald-100">
              {uploadedSources.length} image(s) securely stored in the private workspace and retained for retry
            </p>
            <ul className="mt-2 space-y-1 text-[11px] text-zinc-400">
              {uploadedSources.map((source) => (
                <li key={source.sourceId} className="flex flex-wrap justify-between gap-2">
                  <span className="min-w-0 break-all">{source.title ?? source.sourceId}</span>
                  <span className="font-mono text-zinc-500">{source.sha256.slice(0, 12)}…</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] leading-4 text-zinc-500">These source records remain unreviewed. They are reused on retry while this panel remains mounted; upload retries after a lost response use deterministic content IDs and server-side SHA-256 verification.</p>
          </div>
        )}

        <div className="border-t border-white/10 pt-3">
          <h3 className="text-sm font-semibold text-zinc-200">Track an existing generation job</h3>
          <form onSubmit={loadExistingJob} className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input value={lookupJobId} onChange={(event) => setLookupJobId(event.target.value)} maxLength={80} placeholder="gen-..." className="min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2.5 text-xs text-white outline-none focus:border-cyan-300/60" />
            <button type="submit" disabled={!sessionActive || busy} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-white/10 disabled:opacity-40">Track job</button>
          </form>
        </div>

        {(job || worker || statusError) && (
          <section className="rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-zinc-200">Generation status</h3>
              {worker && (
                <span className={worker.availability === "online" ? "rounded-full bg-emerald-400/10 px-2 py-1 text-[10px] text-emerald-200" : "rounded-full bg-amber-300/10 px-2 py-1 text-[10px] text-amber-100"}>
                  {workerLabel(worker.availability)}
                </span>
              )}
            </div>
            {job && (
              <div className="mt-2 space-y-1 text-xs">
                <p className="break-all font-mono text-cyan-100">{job.jobId}</p>
                <p className="text-zinc-200">{statusLabel(job.status)} · phase: {job.phase}</p>
                <p className="text-zinc-400">Strategy: {job.strategy} · attempt {job.attempt}/{job.maxAttempts}</p>
                <p className="text-zinc-500">Updated: {new Date(job.updatedAt).toLocaleString()}</p>
                {job.status === "completed" && (
                  <p className="mt-2 text-emerald-100">Candidate generated. Inspect GLB and QA evidence, then record the separate review before publication. This job is not automatically placed on the map.</p>
                )}
                {job.status === "failed" && job.lastError && (
                  <p role="alert" className="mt-2 rounded-lg bg-red-500/10 p-2 leading-5 text-red-200">{job.lastError}</p>
                )}
              </div>
            )}
            {worker && (
              <>
                <p className="mt-2 text-[11px] leading-5 text-zinc-500">
                  {worker.availability === "online"
                    ? "Worker heartbeat age: " + Math.round((worker.heartbeatAgeMs ?? 0) / 1000) + "s."
                    : "A queued job will remain queued until a worker with access to the same persistent workspace is started."}
                </p>
                {worker.capabilities && (
                  <div className="mt-2 space-y-1 text-[11px]">
                    <p className="font-semibold text-zinc-300">Strategy runtime readiness · checked {new Date(worker.capabilities.checkedAt).toLocaleString()}</p>
                    {(["procedural", "photogrammetry", "single-image-ai"] as const).map((key) => {
                      const capability = worker.capabilities?.strategies[key];
                      if (!capability) return null;
                      const label = key === "procedural" ? "Procedural" : key === "photogrammetry" ? "COLMAP photogrammetry" : "Single-image AI";
                      const readiness = capability.status === "ready"
                        ? "Ready"
                        : capability.status === "configured" && capability.modelWeights === "missing"
                          ? "Weights missing"
                          : capability.status === "configured" ? "Runtime configured" : "Blocked";
                      return (
                        <div key={key} className="flex flex-wrap gap-x-2">
                          <span className="text-zinc-300">{label}:</span>
                          <span className={capability.status === "blocked" ? "text-amber-200" : "text-emerald-200"}>{readiness}</span>
                          {capability.status === "blocked" && capability.blockers.length > 0 && (
                            <span className="basis-full text-zinc-500">{capability.blockers.join(" ")}</span>
                          )}
                          {key === "single-image-ai" && capability.modelWeights === "missing" && (
                            <span className="basis-full text-amber-200">Cache the TripoSR config.yaml and model.ckpt files first. This worker will keep AI jobs queued until both are present.</span>
                          )}
                          {key === "single-image-ai" && capability.modelWeights === "not-checked" && (
                            <span className="basis-full text-zinc-500">Legacy worker status has no model-cache result; restart the worker to refresh readiness.</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
            {statusError && <p role="alert" className="mt-2 text-xs text-amber-100">{statusError}</p>}
            {job && <p className="mt-2 text-[11px] text-zinc-500">mapReady=false · publicationEligible=false. Generation completion does not establish reconstruction accuracy.</p>}
          </section>
        )}
      </div>
    </details>
  );
}
