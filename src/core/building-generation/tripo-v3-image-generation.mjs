import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeBuildingSpec } from "./building-spec.mjs";
import { analyzeGlbQuality } from "./glb-geometry-qa.mjs";
import { normalizeSourceOperationScopes } from "./source-operation-scopes.mjs";
import {
  createTripoV3Client,
  TRIPO_V3_DEFAULT_MODEL,
} from "./tripo-v3-text-generation.mjs";

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_BYTES = 500 * 1024 * 1024;
const TERMINAL_FAILURES = new Set(["failed", "cancelled", "banned", "expired"]);
const VIEW_LABELS = ["front", "left", "back", "right"];

function safeId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(label + " is invalid.");
  return value;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function cleanMessage(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

async function requireRegularFile(filePath, label) {
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new TypeError(label + " must be a regular non-symlink file.");
  const resolved = await realpath(filePath);
  const finalEntry = await lstat(resolved);
  if (finalEntry.isSymbolicLink() || !finalEntry.isFile()) throw new TypeError(label + " does not resolve to a regular file.");
  return { path: resolved, size: finalEntry.size };
}

async function pollProviderTask(client, taskId, {
  signal,
  pollIntervalMs,
  maxPollAttempts,
  onPoll = () => {},
  stage,
} = {}) {
  let task = null;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    task = await client.queryTask({ taskId, signal });
    onPoll(task);
    if (task.status === "success") break;
    if (TERMINAL_FAILURES.has(task.status)) {
      const reason = cleanMessage(task.error_message, 500);
      throw new Error("Tripo " + stage + " task ended with status " + task.status + (reason ? ": " + reason : "") + ".");
    }
    if (attempt + 1 < maxPollAttempts) await waitForPoll(pollIntervalMs, signal);
  }
  if (task?.status !== "success") {
    throw new Error("Tripo " + stage + " task did not complete within the configured polling limit.");
  }
  return task;
}

async function waitForPoll(intervalMs, signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Tripo generation was aborted.");
  if (intervalMs === 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, intervalMs);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Tripo generation was aborted."));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function normalizeViewLabels(sourceIds, value) {
  if (sourceIds.length === 1) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("viewLabels must be an object.");
    const keys = Object.keys(value);
    if (keys.length === 0) return null;
    if (keys.length !== 1 || value.front !== sourceIds[0]) {
      throw new TypeError("a single-image job may only label its selected source as front.");
    }
    return { front: sourceIds[0] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("multi-view Tripo generation requires explicit viewLabels.");
  }
  const keys = Object.keys(value);
  if (keys.some(key => !VIEW_LABELS.includes(key))) throw new TypeError("viewLabels contains an unsupported view name.");
  if (keys.length < 2 || keys.length > 4 || !Object.hasOwn(value, "front")) {
    throw new TypeError("multi-view generation requires a front view and at least one additional labelled view.");
  }
  const ids = keys.map(key => safeId(value[key], "viewLabels." + key));
  if (new Set(ids).size !== ids.length) throw new TypeError("each selected source must have exactly one view label.");
  if (ids.length !== sourceIds.length || sourceIds.some(id => !ids.includes(id))) {
    throw new TypeError("viewLabels must map every and only the selected sourceIds.");
  }
  return Object.fromEntries(VIEW_LABELS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

async function loadApprovedImage({ root, buildingId, sourceId, spec, sourceRoot, assetRoot }) {
  const declared = spec.sources.find(source => source.id === sourceId);
  if (!declared) throw new TypeError("BuildingSpec does not contain selected image source '" + sourceId + "'.");
  const recordPath = path.join(sourceRoot, sourceId + ".json");
  const recordFile = await requireRegularFile(recordPath, "source metadata");
  if (!inside(sourceRoot, recordFile.path)) throw new TypeError("source metadata resolves outside the building source store.");
  const record = JSON.parse(await readFile(recordFile.path, "utf8"));
  if (record.id !== sourceId || record.buildingId !== buildingId) throw new TypeError("source metadata identity mismatch.");
  if (!["image", "video-frame"].includes(record.kind)) throw new TypeError("Tripo image generation accepts only reviewed still images or extracted video frames.");
  if (!["image/jpeg", "image/png"].includes(record.mimeType)) throw new TypeError("Tripo File Upload currently accepts only JPEG and PNG images.");
  if (record.usageStatus !== "approved" || typeof record.licence !== "string" || !record.licence.trim() || record.licence.toLowerCase() === "unknown") {
    throw new TypeError("source must have a reviewed licence and usageStatus=approved.");
  }
  const recordScopes = normalizeSourceOperationScopes(record.permittedOperations, "source " + sourceId + " permittedOperations");
  const declaredScopes = normalizeSourceOperationScopes(declared.permittedOperations, "BuildingSpec source " + sourceId + " permittedOperations");
  if (JSON.stringify(recordScopes) !== JSON.stringify(declaredScopes)) {
    throw new TypeError("BuildingSpec source must match the source record permitted operation scopes.");
  }
  if (!recordScopes.includes("external-provider-image-generation")) {
    throw new TypeError("source " + sourceId + " lacks explicit external-provider-image-generation permission.");
  }
  if (declared.usageStatus !== "approved" || declared.licence !== record.licence || declared.assetId !== record.assetId) {
    throw new TypeError("BuildingSpec source must match the approved source licence, usage status and assetId.");
  }
  if (typeof record.relativePath !== "string" || !record.relativePath.trim() || record.relativePath.includes("\\")) {
    throw new TypeError("source asset relativePath is invalid.");
  }
  const assetPath = path.resolve(root, record.relativePath);
  if (!inside(root, assetPath)) throw new TypeError("source asset path escapes workspaceRoot.");
  const sourceFile = await requireRegularFile(assetPath, "source image");
  if (!inside(assetRoot, sourceFile.path)) throw new TypeError("source image is outside this building's approved asset store.");
  if (sourceFile.size <= 0 || sourceFile.size > MAX_IMAGE_BYTES) throw new RangeError("Tripo image input must be between 1 byte and 20 MiB.");
  const bytes = await readFile(sourceFile.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== record.sha256 || sha256 !== record.assetId) throw new TypeError("source image SHA-256 does not match its ingestion record.");
  return {
    sourceId,
    kind: record.kind,
    mimeType: record.mimeType,
    licence: record.licence,
    usageStatus: record.usageStatus,
    permittedOperations: recordScopes,
    sha256,
    bytes,
  };
}

/**
 * Sends explicitly approved source images to the paid Tripo V3 image/multiview API.
 * The returned GLB is always an AI-proposed visual candidate and remains review-only.
 */
export async function runTripoImageGeneration(options = {}) {
  if (!options || typeof options !== "object") throw new TypeError("options are required.");
  if (options.allowPaidProviderGeneration !== true) {
    throw new TypeError("allowPaidProviderGeneration must be explicitly true before calling the paid Tripo API.");
  }
  if (options.confirmExternalProviderProcessing !== true) {
    throw new TypeError("confirmExternalProviderProcessing must be true after authorizing the selected source images for external Tripo processing.");
  }
  const { spec } = normalizeBuildingSpec(options.buildingSpec);
  const buildingId = safeId(options.buildingId ?? spec.id, "buildingId");
  const jobId = safeId(options.jobId, "jobId");
  if (spec.id !== buildingId) throw new TypeError("BuildingSpec id must equal buildingId.");
  if (typeof options.workspaceRoot !== "string" || !options.workspaceRoot.trim()) throw new TypeError("workspaceRoot must be a non-empty path.");
  if (!Array.isArray(options.sourceIds) || options.sourceIds.length < 1 || options.sourceIds.length > 4) {
    throw new TypeError("sourceIds must contain one image or two to four explicitly selected views.");
  }
  const sourceIds = options.sourceIds.map(id => safeId(id, "sourceId"));
  if (new Set(sourceIds).size !== sourceIds.length) throw new TypeError("sourceIds must not contain duplicates.");
  const viewLabels = normalizeViewLabels(sourceIds, options.viewLabels);
  const generateMultiviewFromSingleImage = options.generateMultiviewFromSingleImage ?? false;
  if (typeof generateMultiviewFromSingleImage !== "boolean") {
    throw new TypeError("generateMultiviewFromSingleImage must be a boolean.");
  }
  if (generateMultiviewFromSingleImage && sourceIds.length !== 1) {
    throw new TypeError("AI-synthesized multiview expansion is only available for exactly one actual source image.");
  }
  if (generateMultiviewFromSingleImage && options.confirmSyntheticViewGeneration !== true) {
    throw new TypeError("confirmSyntheticViewGeneration must be true after acknowledging that Tripo will synthesize non-independent side views from one photograph.");
  }
  if (sourceIds.length > 1 && options.confirmSameBuilding !== true) {
    throw new TypeError("confirmSameBuilding must be true after checking that every labelled view depicts the same physical building.");
  }
  const model = options.model ?? TRIPO_V3_DEFAULT_MODEL;
  const texture = options.texture ?? true;
  const pbr = options.pbr ?? true;
  const geometryQuality = options.geometryQuality ?? "detailed";
  const textureQuality = options.textureQuality ?? "detailed";
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const maxPollAttempts = options.maxPollAttempts ?? 120;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60000) throw new RangeError("pollIntervalMs must be between 0 and 60000.");
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1 || maxPollAttempts > 120) throw new RangeError("maxPollAttempts must be between 1 and 120.");

  const client = createTripoV3Client({
    apiKey: options.apiKey ?? process.env.TRIPO_API_KEY,
    fetchImpl: options.fetchImpl ?? fetch,
    model,
  });
  const workspaceRoot = await realpath(path.resolve(options.workspaceRoot));
  const engineRootCandidate = path.join(workspaceRoot, ".building-engine");
  const engineRootEntry = await lstat(engineRootCandidate).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (engineRootEntry?.isSymbolicLink() || (engineRootEntry && !engineRootEntry.isDirectory())) {
    throw new TypeError("building engine directory must be a real directory.");
  }
  if (!engineRootEntry) await mkdir(engineRootCandidate, { recursive: true, mode: 0o700 });
  const engineRoot = await realpath(engineRootCandidate);
  if (!inside(workspaceRoot, engineRoot)) throw new TypeError("building engine directory resolves outside workspaceRoot.");
  const mediaRootCandidate = path.join(engineRoot, "media", buildingId);
  const mediaRoot = await realpath(mediaRootCandidate);
  if (!inside(engineRoot, mediaRoot)) throw new TypeError("building media directory resolves outside the engine root.");
  const sourceRoot = await realpath(path.join(mediaRoot, "sources"));
  const assetRoot = await realpath(path.join(mediaRoot, "assets"));
  if (!inside(mediaRoot, sourceRoot) || !inside(mediaRoot, assetRoot)) throw new TypeError("source/asset directory escapes the building media store.");

  const images = [];
  for (const sourceId of sourceIds) {
    images.push(await loadApprovedImage({ root: workspaceRoot, buildingId, sourceId, spec, sourceRoot, assetRoot }));
  }
  const jobDirCandidate = path.join(engineRoot, "jobs", buildingId, jobId + "-tripo-v3-image");
  const parent = path.dirname(jobDirCandidate);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const realParent = await realpath(parent);
  if (!inside(engineRoot, realParent)) throw new TypeError("Tripo image job directory resolves outside building jobs.");
  await mkdir(jobDirCandidate, { recursive: false, mode: 0o700 });
  const jobDir = await realpath(jobDirCandidate);
  if (!inside(realParent, jobDir)) throw new TypeError("Tripo image job directory resolves outside building jobs.");

  const reportPath = path.join(jobDir, "report.json");
  const report = {
    schemaVersion: "1.0.0",
    engine: "tripo-v3-image-to-model",
    buildingId,
    jobId,
    model,
    generationStage: generateMultiviewFromSingleImage
      ? "image-to-multiview-then-multiview-to-model"
      : images.length === 1 ? "image-to-model" : "multiview-to-model",
    ...(generateMultiviewFromSingleImage ? {
      syntheticViewProvenance: {
        kind: "ai-synthesized-from-single-image",
        sourceImageId: images[0].sourceId,
        generatedViewsAreIndependentObservations: false,
        eligibleAsSurveyEvidence: false,
      },
    } : {}),
    sameBuildingConfirmed: images.length > 1 && options.confirmSameBuilding === true,
    sources: images.map((image, index) => ({
      sourceId: image.sourceId,
      kind: image.kind,
      mimeType: image.mimeType,
      sha256: image.sha256,
      licence: image.licence,
      usageStatus: image.usageStatus,
      permittedOperations: image.permittedOperations,
      ...(viewLabels ? { view: Object.entries(viewLabels).find(([, id]) => id === image.sourceId)?.[0] ?? null } : {}),
      externalProviderProcessing: "explicitly-authorized",
    })),
    confidence: "ai-proposed",
    status: "running",
    startedAt: new Date().toISOString(),
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    metricAlignment: { status: "not-run" },
    georeference: { status: "not-solved" },
    warnings: [
      "Tripo image/multiview generation infers unseen geometry; it is not a surveyed reconstruction.",
      "A labelled multi-view task requires the selected images to show the same physical building from their declared views.",
      ...(generateMultiviewFromSingleImage ? ["AI-synthesized side views are derived from one photograph and are not independent captures, camera calibrations or survey evidence."] : []),
      "Image pixels, model dimensions and output orientation are not independent metric or geospatial truth.",
      "Human visual review and independent dimensions/checkpoints are required before any map publication.",
      "The paid external provider receives the selected source image bytes under the user-attested licence and operation scope.",
    ],
  };
  const saveReport = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "w", mode: 0o600 });

  try {
    await saveReport();
    const uploaded = [];
    for (const image of images) {
      const extension = image.mimeType === "image/jpeg" ? ".jpg" : ".png";
      const result = await client.uploadImage({
        bytes: image.bytes,
        filename: image.sourceId + extension,
        contentType: image.mimeType,
        signal: options.signal,
      });
      uploaded.push({ sourceId: image.sourceId, fileToken: result.fileToken });
    }
    let submitted;
    const stageTaskIds = [];
    if (generateMultiviewFromSingleImage) {
      const imageViewsTask = await client.submitImageToMultiview({
        fileToken: uploaded[0].fileToken,
        signal: options.signal,
      });
      stageTaskIds.push(imageViewsTask.taskId);
      report.stageTaskIds = [...stageTaskIds];
      report.generationStages = ["image-to-multiview"];
      report.status = "image-to-multiview-submitted";
      await saveReport();

      const generatedViewsTask = await pollProviderTask(client, imageViewsTask.taskId, {
        signal: options.signal,
        pollIntervalMs,
        maxPollAttempts,
        stage: "image-to-multiview",
        onPoll: task => {
          report.intermediateTaskStatus = task.status;
          report.intermediateTaskProgress = Number.isFinite(task.progress) ? task.progress : null;
        },
      });
      const acceptedImageToMultiviewTaskTypes = new Set(["image_to_multiview", "generate_multiview_image"]);
      if (!acceptedImageToMultiviewTaskTypes.has(generatedViewsTask.type)) {
        throw new TypeError("Tripo image-to-multiview task type mismatch: received " + cleanMessage(generatedViewsTask.type, 80) + ".");
      }
      const syntheticViewOutput = generatedViewsTask.output?.generate_multiview_image;
      const availableSyntheticViews = Object.entries(syntheticViewOutput ?? {}).filter(([name, url]) => {
        if (!["front_view_url", "left_view_url", "back_view_url", "right_view_url"].includes(name) || typeof url !== "string") return false;
        try {
          const parsed = new URL(url);
          return parsed.protocol === "https:" && parsed.hostname === "cdn.tripo3d.ai" && !parsed.username && !parsed.password;
        } catch {
          return false;
        }
      }).map(([name]) => name);
      if (!availableSyntheticViews.includes("front_view_url") || availableSyntheticViews.length < 2) {
        throw new TypeError("Tripo image-to-multiview succeeded without a front view and at least one additional side view.");
      }
      report.syntheticViewProvenance = {
        ...report.syntheticViewProvenance,
        taskId: generatedViewsTask.task_id,
        taskType: generatedViewsTask.type,
        outputViewsAvailable: availableSyntheticViews,
        generatedViewsAreIndependentObservations: false,
        eligibleAsSurveyEvidence: false,
      };
      report.generationStages.push("multiview-to-model");
      await saveReport();

      submitted = await client.submitMultiviewFromTask({
        sourceTaskId: imageViewsTask.taskId,
        model,
        texture,
        pbr,
        geometryQuality,
        textureQuality,
        signal: options.signal,
      });
    } else if (images.length === 1) {
      submitted = await client.submitImageToModel({
        fileToken: uploaded[0].fileToken,
        model,
        texture,
        pbr,
        geometryQuality,
        textureQuality,
        signal: options.signal,
      });
    } else {
      const providerViews = Object.fromEntries(Object.entries(viewLabels).map(([view, sourceId]) => [
        view,
        uploaded.find(item => item.sourceId === sourceId)?.fileToken,
      ]));
      submitted = await client.submitMultiviewToModel({
        views: providerViews,
        model,
        texture,
        pbr,
        geometryQuality,
        textureQuality,
        signal: options.signal,
      });
    }
    stageTaskIds.push(submitted.taskId);
    report.stageTaskIds = stageTaskIds;
    report.generationStages = generateMultiviewFromSingleImage
      ? ["image-to-multiview", "multiview-to-model"]
      : [submitted.stage];
    report.taskId = submitted.taskId;
    report.status = "submitted";
    await saveReport();

    const expectedTaskType = images.length === 1 && !generateMultiviewFromSingleImage
      ? "image_to_model"
      : "multiview_to_model";
    const task = await pollProviderTask(client, submitted.taskId, {
      signal: options.signal,
      pollIntervalMs,
      maxPollAttempts,
      stage: "model-generation",
      onPoll: value => {
        report.taskStatus = value.status;
        report.taskProgress = Number.isFinite(value.progress) ? value.progress : null;
      },
    });
    if (task.type !== expectedTaskType) {
      throw new TypeError("Tripo task type mismatch: expected " + expectedTaskType + " but received " + cleanMessage(task.type, 80) + ".");
    }
    report.taskType = task.type;
    if (typeof task.output?.model_url !== "string") throw new TypeError("Successful Tripo task did not contain output.model_url.");
    const modelBytes = await client.downloadModel({
      modelUrl: task.output.model_url,
      signal: options.signal,
      maxBytes: options.maxModelBytes ?? MAX_MODEL_BYTES,
    });
    const quality = analyzeGlbQuality(modelBytes);
    if (quality.valid !== true || !Number.isFinite(quality.counts?.meshCount) || quality.counts.meshCount < 1) {
      throw new TypeError("Downloaded Tripo output did not pass structural GLB geometry validation.");
    }
    const modelPath = path.join(jobDir, "candidate.glb");
    await writeFile(modelPath, modelBytes, { flag: "wx", mode: 0o600 });
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
    await saveReport();
    return { jobDir, modelPath, reportPath, report };
  } catch (error) {
    report.status = "failed";
    report.completedAt = new Date().toISOString();
    report.failureMessage = cleanMessage(error?.message, 2000) || "Tripo image generation failed.";
    await saveReport().catch(() => {});
    throw error;
  }
}
