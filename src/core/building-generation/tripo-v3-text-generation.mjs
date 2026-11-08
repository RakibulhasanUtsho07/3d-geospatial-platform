import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeBuildingSpec } from "./building-spec.mjs";
import { analyzeGlbQuality } from "./glb-geometry-qa.mjs";

export const TRIPO_V3_API_BASE_URL = "https://openapi.tripo3d.ai/v3";
export const TRIPO_V3_DEFAULT_MODEL = "v3.1-20260211";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const TASK_ID = /^[A-Za-z0-9_-]{4,200}$/;
const FILE_TOKEN = /^file_[A-Za-z0-9_-]{4,240}$/;
const ALLOWED_MODELS = new Set(["v3.1-20260211", "v3.0-20250812"]);
const ALLOWED_QUALITY = new Set(["standard", "detailed"]);
const MAX_PROMPT_LENGTH = 1024;
const MAX_MODEL_BYTES = 500 * 1024 * 1024;
const TERMINAL_FAILURES = new Set(["failed", "cancelled", "banned", "expired"]);

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function normalizeText(value, maxLength = 160) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function approximateFootprintRatio(spec) {
  const ring = spec.footprint?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const points = ring.filter(point => Array.isArray(point) && point.length >= 2);
  if (points.length < 3) return null;
  const longitudes = points.map(point => point[0]);
  const latitudes = points.map(point => point[1]);
  const meanLatitude = latitudes.reduce((sum, value) => sum + value, 0) / latitudes.length;
  const widthM = (Math.max(...longitudes) - Math.min(...longitudes)) *
    Math.PI / 180 * 6378137 * Math.cos(meanLatitude * Math.PI / 180);
  const depthM = (Math.max(...latitudes) - Math.min(...latitudes)) *
    Math.PI / 180 * 6378137;
  if (!(widthM > 0) || !(depthM > 0)) return null;
  return { widthM, depthM };
}

/**
 * Compose a bounded visual-design prompt from the current BuildingSpec.
 * Coordinates are deliberately omitted: provider geometry is not georeferenced.
 */
export function buildTripoTextPrompt(rawBuildingSpec) {
  const { spec } = normalizeBuildingSpec(rawBuildingSpec);
  const architecture = spec.architecture ?? {};
  const parts = [];
  const name = normalizeText(spec.name, 120);
  parts.push("Create one isolated exterior architectural 3D model of " + (name || "the described building") + ".");
  const style = normalizeText(architecture.style, 100);
  if (style) parts.push("Architectural style: " + style + ".");
  const rawDimensions = rawBuildingSpec.dimensions ?? {};
  if (Number.isInteger(rawDimensions.floorCount)) {
    parts.push("Massing: " + rawDimensions.floorCount + " visible floors.");
  }
  if (Number.isFinite(rawDimensions.floorHeightM)) {
    parts.push("Design guidance for floor height: approximately " + rawDimensions.floorHeightM + " metres.");
  }
  if (Number.isFinite(rawDimensions.parapetHeightM)) {
    parts.push("Parapet height design guidance: approximately " + rawDimensions.parapetHeightM + " metres.");
  }
  const footprint = approximateFootprintRatio(spec);
  if (footprint) {
    const ratio = footprint.widthM / footprint.depthM;
    parts.push("Plan proportions are approximately " + ratio.toFixed(2) + " to 1 (width to depth); use this only as visual shape guidance, not surveyed scale.");
  }
  const roofType = normalizeText(architecture.roofType, 40);
  if (roofType) parts.push("Roof form: " + roofType + ".");
  for (const [field, label] of [
    ["wallColor", "wall colour"],
    ["roofColor", "roof colour"],
    ["glassColor", "glass colour"],
    ["frameColor", "frame colour"],
    ["concreteColor", "concrete colour"],
    ["doorColor", "door colour"],
  ]) {
    const value = normalizeText(architecture[field], 40);
    if (value) parts.push(label + ": " + value + ".");
  }
  if (architecture.balcony?.enabled === true) {
    parts.push("Include visible balconies with a consistent repeated facade rhythm.");
  }
  if (architecture.windows?.enabled === true) {
    parts.push("Include clearly modelled windows and frames; window profile: " +
      normalizeText(architecture.windows.shape, 30).replace(/[^a-z0-9 -]/gi, "") + ".");
  }
  if (architecture.includeDoor === true) parts.push("Include a clearly visible main entrance door.");
  parts.push("Create complete exterior walls, roof, facade openings and architectural details; omit terrain, streets, neighbouring buildings and people.");
  const mandatoryTail = " Visual candidate only: dimensions, hidden geometry and georeferencing are unverified. Independent measurements and human review are required; this output is not map-ready.";
  const body = parts.join(" ");
  const budget = MAX_PROMPT_LENGTH - mandatoryTail.length;
  const clipped = body.length > budget
    ? body.slice(0, Math.max(0, budget - 3)).trimEnd() + "..."
    : body;
  return (clipped + mandatoryTail).slice(0, MAX_PROMPT_LENGTH);
}

async function readJsonResponse(response, label) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(label + " returned an invalid JSON response.");
  }
  if (!response.ok) {
    const detail = typeof payload?.message === "string" ? payload.message.slice(0, 500) : "HTTP " + response.status;
    throw new Error(label + " failed: " + detail);
  }
  if (!payload || payload.code !== 0 || !payload.data || typeof payload.data !== "object") {
    const detail = typeof payload?.message === "string" ? payload.message.slice(0, 500) : "provider response code was not zero";
    throw new Error(label + " failed: " + detail);
  }
  return payload.data;
}

function waitForPoll(intervalMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Tripo generation was aborted."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, intervalMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readLimitedBody(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RangeError("Generated GLB exceeds the configured model size limit.");
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new RangeError("Generated GLB exceeds the configured model size limit.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RangeError("Generated GLB exceeds the configured model size limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

export function createTripoV3Client({ apiKey, fetchImpl = fetch, model = TRIPO_V3_DEFAULT_MODEL } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096) {
    throw new TypeError("TRIPO_API_KEY must be configured on the server.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  if (!ALLOWED_MODELS.has(model)) throw new TypeError("model is not an allowed pinned Tripo V3 model version.");

  async function apiRequest(endpoint, init = {}, label = "Tripo API request") {
    const response = await fetchImpl(TRIPO_V3_API_BASE_URL + endpoint, {
      ...init,
      redirect: "error",
      headers: {
        Authorization: "Bearer " + apiKey,
        ...(init.headers ?? {}),
      },
    });
    return readJsonResponse(response, label);
  }

  return Object.freeze({
    async uploadImage({ bytes, filename = "building-reference.png", contentType = "image/png", signal } = {}) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new TypeError("Image bytes must be a non-empty Uint8Array.");
      }
      if (bytes.byteLength > 20 * 1024 * 1024) throw new RangeError("Tripo image uploads are limited to 20 MiB.");
      if (!["image/jpeg", "image/png"].includes(contentType)) {
        throw new TypeError("Tripo image upload accepts only JPEG or PNG.");
      }
      if (typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(filename) || filename.includes("..")) {
        throw new TypeError("Upload filename must be a safe basename.");
      }
      const form = new FormData();
      form.append("file", new Blob([Uint8Array.from(bytes)], { type: contentType }), filename);
      const data = await apiRequest("/files", { method: "POST", signal, body: form }, "Tripo image file upload");
      if (typeof data.file_token !== "string" || !FILE_TOKEN.test(data.file_token)) {
        throw new TypeError("Tripo file upload response did not contain a valid file_token.");
      }
      return Object.freeze({ fileToken: data.file_token });
    },

    async submitImageToModel({
      fileToken,
      model: requestedModel = model,
      texture = true,
      pbr = true,
      geometryQuality = "detailed",
      textureQuality = "detailed",
      enableImageAutofix = false,
      signal,
    } = {}) {
      if (typeof fileToken !== "string" || !FILE_TOKEN.test(fileToken)) throw new TypeError("fileToken is invalid.");
      if (!ALLOWED_MODELS.has(requestedModel)) throw new TypeError("model is not an allowed pinned Tripo V3 model version.");
      if (typeof texture !== "boolean" || typeof pbr !== "boolean" || typeof enableImageAutofix !== "boolean") {
        throw new TypeError("texture, pbr and enableImageAutofix must be booleans.");
      }
      if (!ALLOWED_QUALITY.has(geometryQuality)) throw new TypeError("geometryQuality must be standard or detailed.");
      if (!["standard", "detailed", "extreme"].includes(textureQuality)) {
        throw new TypeError("textureQuality must be standard, detailed or extreme.");
      }
      const data = await apiRequest("/generation/image-to-model", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: fileToken,
          model: requestedModel,
          texture: texture || pbr,
          pbr,
          geometry_quality: geometryQuality,
          texture_quality: textureQuality,
          enable_image_autofix: enableImageAutofix,
          auto_size: false,
        }),
      }, "Tripo image-to-model submission");
      if (typeof data.task_id !== "string" || !TASK_ID.test(data.task_id)) {
        throw new TypeError("Tripo image-to-model response did not contain a valid task_id.");
      }
      return Object.freeze({ taskId: data.task_id, stage: "image-to-model" });
    },

    async submitMultiviewToModel({
      views,
      model: requestedModel = model,
      texture = true,
      pbr = true,
      geometryQuality = "detailed",
      textureQuality = "detailed",
      signal,
    } = {}) {
      if (!views || typeof views !== "object" || Array.isArray(views)) throw new TypeError("views must map front/left/back/right to uploaded provider file tokens.");
      const allowedViews = ["front", "left", "back", "right"];
      const keys = Object.keys(views);
      if (keys.some(key => !allowedViews.includes(key))) throw new TypeError("views contains an unsupported view label.");
      if (!views.front) throw new TypeError("Tripo multiview generation requires a front view.");
      if (keys.length < 2 || keys.length > 4) throw new TypeError("Tripo multiview generation requires two to four labelled views.");
      if (!ALLOWED_MODELS.has(requestedModel)) throw new TypeError("model is not an allowed pinned Tripo V3 model version.");
      if (typeof texture !== "boolean" || typeof pbr !== "boolean") throw new TypeError("texture and pbr must be booleans.");
      if (!ALLOWED_QUALITY.has(geometryQuality)) throw new TypeError("geometryQuality must be standard or detailed.");
      if (!["standard", "detailed", "extreme"].includes(textureQuality)) {
        throw new TypeError("textureQuality must be standard, detailed or extreme.");
      }
      const inputs = [];
      for (const view of allowedViews) {
        if (views[view] === undefined) continue;
        if (typeof views[view] !== "string" || !FILE_TOKEN.test(views[view])) {
          throw new TypeError("views." + view + " must be a valid provider file token.");
        }
        inputs.push({ [view]: views[view] });
      }
      const data = await apiRequest("/generation/multiview-to-model", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs,
          model: requestedModel,
          texture: texture || pbr,
          pbr,
          geometry_quality: geometryQuality,
          texture_quality: textureQuality,
          auto_size: false,
        }),
      }, "Tripo multiview-to-model submission");
      if (typeof data.task_id !== "string" || !TASK_ID.test(data.task_id)) {
        throw new TypeError("Tripo multiview-to-model response did not contain a valid task_id.");
      }
      return Object.freeze({ taskId: data.task_id, stage: "multiview-to-model" });
    },

    async submitTextToModel({
      prompt,
      model: requestedModel = model,
      texture = true,
      pbr = true,
      geometryQuality = "detailed",
      textureQuality = "detailed",
      signal,
    } = {}) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
        throw new TypeError("prompt must contain 1–1024 characters.");
      }
      if (!ALLOWED_MODELS.has(requestedModel)) throw new TypeError("model is not an allowed pinned Tripo V3 model version.");
      if (typeof texture !== "boolean" || typeof pbr !== "boolean") throw new TypeError("texture and pbr must be booleans.");
      if (!ALLOWED_QUALITY.has(geometryQuality)) throw new TypeError("geometryQuality must be standard or detailed.");
      if (!["standard", "detailed", "extreme"].includes(textureQuality)) {
        throw new TypeError("textureQuality must be standard, detailed or extreme.");
      }
      const data = await apiRequest("/generation/text-to-model", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          model: requestedModel,
          texture: texture || pbr,
          pbr,
          geometry_quality: geometryQuality,
          texture_quality: textureQuality,
          auto_size: false,
        }),
      }, "Tripo text-to-model submission");
      if (typeof data.task_id !== "string" || !TASK_ID.test(data.task_id)) {
        throw new TypeError("Tripo text-to-model response did not contain a valid task_id.");
      }
      return Object.freeze({ taskId: data.task_id });
    },

    async queryTask({ taskId, signal } = {}) {
      if (typeof taskId !== "string" || !TASK_ID.test(taskId)) throw new TypeError("taskId is invalid.");
      const data = await apiRequest("/tasks/" + encodeURIComponent(taskId), {
        method: "GET",
        signal,
      }, "Tripo task query");
      if (data.task_id !== taskId) throw new TypeError("Tripo task response identity does not match the requested task.");
      return data;
    },

    async downloadModel({ modelUrl, signal, maxBytes = MAX_MODEL_BYTES } = {}) {
      let url;
      try { url = new URL(modelUrl); } catch { throw new TypeError("Tripo model_url must be an absolute HTTPS URL."); }
      if (url.protocol !== "https:" || url.hostname !== "cdn.tripo3d.ai" || url.username || url.password) {
        throw new TypeError("Tripo model_url host is not an approved HTTPS model CDN.");
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MODEL_BYTES) {
        throw new RangeError("maxBytes must be between 1 byte and 500 MiB.");
      }
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error("Tripo model download failed with HTTP " + response.status + ".");
      const bytes = await readLimitedBody(response, maxBytes);
      if (bytes.length < 20) throw new TypeError("Tripo model download is empty or too small to be a GLB.");
      return bytes;
    },
  });
}

/** Runs a paid, opt-in Tripo V3 text generation and stores a review-only GLB candidate. */
export async function runTripoTextGeneration(options = {}) {
  if (!options || typeof options !== "object") throw new TypeError("options are required.");
  if (options.allowPaidProviderGeneration !== true) {
    throw new TypeError("allowPaidProviderGeneration must be explicitly true before calling the paid Tripo API.");
  }
  const { spec } = normalizeBuildingSpec(options.buildingSpec);
  const buildingId = safeId(options.buildingId ?? spec.id, "buildingId");
  const jobId = safeId(options.jobId, "jobId");
  if (spec.id !== buildingId) throw new TypeError("BuildingSpec id must equal buildingId.");
  if (typeof options.workspaceRoot !== "string" || !options.workspaceRoot.trim()) {
    throw new TypeError("workspaceRoot must be a non-empty path.");
  }
  const client = createTripoV3Client({
    apiKey: options.apiKey ?? process.env.TRIPO_API_KEY,
    fetchImpl: options.fetchImpl ?? fetch,
    model: options.model ?? TRIPO_V3_DEFAULT_MODEL,
  });
  const prompt = buildTripoTextPrompt(options.buildingSpec);
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const maxPollAttempts = options.maxPollAttempts ?? 120;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60000) {
    throw new RangeError("pollIntervalMs must be between 0 and 60000.");
  }
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1 || maxPollAttempts > 120) {
    throw new RangeError("maxPollAttempts must be between 1 and 120.");
  }
  const workspaceRoot = await realpath(path.resolve(options.workspaceRoot ?? ""));
  const engineRootCandidate = path.join(workspaceRoot, ".building-engine");
  await mkdir(engineRootCandidate, { recursive: true });
  const engineRoot = await realpath(engineRootCandidate);
  if (!isInside(workspaceRoot, engineRoot)) throw new TypeError("building engine directory resolves outside workspaceRoot.");
  const jobsRootCandidate = path.join(engineRoot, "jobs", buildingId);
  await mkdir(jobsRootCandidate, { recursive: true });
  const jobsRoot = await realpath(jobsRootCandidate);
  if (!isInside(engineRoot, jobsRoot)) throw new TypeError("building job directory resolves outside workspaceRoot.");
  const jobDir = path.join(jobsRoot, jobId + "-tripo-v3-text");
  await mkdir(jobDir, { recursive: false });
  const realJobDir = await realpath(jobDir);
  if (!isInside(jobsRoot, realJobDir)) throw new TypeError("Tripo job directory resolves outside the building job root.");

  const reportPath = path.join(realJobDir, "report.json");
  const report = {
    schemaVersion: "1.0.0",
    engine: "tripo-v3-text-to-model",
    buildingId,
    jobId,
    model: options.model ?? TRIPO_V3_DEFAULT_MODEL,
    prompt,
    confidence: "ai-proposed",
    status: "running",
    startedAt: new Date().toISOString(),
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    metricAlignment: { status: "not-run" },
    georeference: { status: "not-solved" },
    warnings: [
      "Tripo text generation creates a visual candidate; it does not reconstruct this building from source photographs.",
      "Prompt dimensions and footprint proportions are design guidance only, not independent survey truth.",
      "Output scale, facade orientation, hidden geometry and WGS84 placement require separate validation.",
      "Human visual review and independent measurements are required before any map publication.",
    ],
  };
  const saveReport = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "w" });
  try {
    await saveReport();
    const submitted = await client.submitTextToModel({
      prompt,
      model: report.model,
      texture: options.texture ?? true,
      pbr: options.pbr ?? true,
      geometryQuality: options.geometryQuality ?? "detailed",
      textureQuality: options.textureQuality ?? "detailed",
      signal: options.signal,
    });
    report.taskId = submitted.taskId;
    report.status = "submitted";
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

    let task = null;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      task = await client.queryTask({ taskId: submitted.taskId, signal: options.signal });
      report.taskStatus = task.status;
      report.taskProgress = Number.isFinite(task.progress) ? task.progress : null;
      if (task.status === "success") break;
      if (TERMINAL_FAILURES.has(task.status)) {
        const reason = normalizeText(task.error_message, 500);
        throw new Error("Tripo task ended with status " + task.status + (reason ? ": " + reason : "") + ".");
      }
      if (attempt + 1 < maxPollAttempts && pollIntervalMs > 0) {
        await waitForPoll(pollIntervalMs, options.signal);
      }
    }
    if (task?.status !== "success") {
      throw new Error("Tripo task did not complete within the configured polling limit.");
    }
    const modelUrl = task.output?.model_url;
    if (typeof modelUrl !== "string") throw new TypeError("Successful Tripo task did not contain output.model_url.");
    const modelBytes = await client.downloadModel({
      modelUrl,
      signal: options.signal,
      maxBytes: options.maxModelBytes ?? MAX_MODEL_BYTES,
    });
    const quality = analyzeGlbQuality(modelBytes);
    if (quality.valid !== true || !Number.isFinite(quality.counts?.meshCount) || quality.counts.meshCount < 1) {
      throw new TypeError("Downloaded Tripo output did not pass structural GLB geometry validation.");
    }
    const modelPath = path.join(realJobDir, "candidate.glb");
    await writeFile(modelPath, modelBytes, { flag: "wx" });
    report.status = "completed-requires-review";
    report.completedAt = new Date().toISOString();
    report.output = {
      file: "candidate.glb",
      bytes: modelBytes.length,
      sha256: createHash("sha256").update(modelBytes).digest("hex"),
      meshCount: quality.counts.meshCount,
      triangleCount: quality.counts.triangleCount,
      degenerateTriangleCount: quality.counts.degenerateTriangleCount,
      warnings: quality.warnings,
    };
    if (Number.isFinite(task.credits_consumed)) report.creditsConsumed = task.credits_consumed;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    return { jobDir: realJobDir, modelPath, reportPath, report };
  } catch (error) {
    report.status = "failed";
    report.completedAt = new Date().toISOString();
    report.failureMessage = normalizeText(error?.message, 2000) || "Tripo text generation failed.";
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n").catch(() => {});
    throw error;
  }
}
