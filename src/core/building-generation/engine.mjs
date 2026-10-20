import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractVideoKeyframes } from "./video-frame-extractor.mjs";
import {
  normalizeBuildingGenerationRequest,
  planBuildingGeneration,
} from "./input-policy.mjs";
import { generateParametricBuildingGlb } from "./procedural-builder.mjs";
import { alignGeneratedGlbToDimensions, downloadGeneratedGlb } from "./glb-validation.mjs";

function fail(code, message, plan = null) {
  const error = new Error(message);
  error.code = code;
  if (plan) error.plan = plan;
  throw error;
}

function clampPromptSegment(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maxLength);
}

/** Create a provider prompt from admin-authored fields without inventing missing measurements. */
export function buildArchitecturalTextPrompt(requestValue) {
  const request = normalizeBuildingGenerationRequest(requestValue);
  const building = request.building;
  const dimensions = building.dimensions ?? {};
  const parts = ["Exterior architectural 3D building model."];
  parts.push("Building type: " + clampPromptSegment(building.buildingType, 100) + ".");
  if (building.name) parts.push("Building name/context: " + clampPromptSegment(building.name, 100) + ".");
  if (building.architecturalStyle) parts.push("Architectural style: " + clampPromptSegment(building.architecturalStyle, 140) + ".");
  if (dimensions.totalHeightMeters !== undefined) parts.push("Target total height: " + dimensions.totalHeightMeters + " metres.");
  if (dimensions.aboveGroundFloors !== undefined) parts.push("Above-ground storeys: " + dimensions.aboveGroundFloors + ".");
  if (dimensions.floorToFloorHeightMeters !== undefined) parts.push("Floor-to-floor height: " + dimensions.floorToFloorHeightMeters + " metres.");
  if (dimensions.basementFloors !== undefined && dimensions.basementFloors > 0) parts.push("Basement floors: " + dimensions.basementFloors + ".");
  if (building.footprint?.widthMeters !== undefined && building.footprint?.depthMeters !== undefined) {
    parts.push("Footprint target: " + building.footprint.widthMeters + " metres wide by " + building.footprint.depthMeters + " metres deep.");
  } else if (building.footprint?.polygonXYMeters) {
    parts.push("Use the supplied non-rectangular footprint as the plan outline; exact footprint alignment will be checked after generation.");
  }
  if (building.frontAzimuthDegrees !== undefined) parts.push("Front facade heading metadata: " + building.frontAzimuthDegrees + " degrees clockwise from north.");
  if (building.roofType) parts.push("Roof type: " + clampPromptSegment(building.roofType, 80) + ".");
  if (building.facadeMaterials?.length) parts.push("Facade material palette: " + building.facadeMaterials.map((v) => clampPromptSegment(v, 50)).join(", ") + ".");
  if (building.facadeColours?.length) parts.push("Facade colours: " + building.facadeColours.map((v) => clampPromptSegment(v, 30)).join(", ") + ".");
  const features = building.architecturalFeatures;
  if (features?.windowStyle) parts.push("Window style: " + features.windowStyle + ".");
  if (features?.entranceStyle) parts.push("Entrance style: " + features.entranceStyle + ".");
  if (features?.balconies?.enabled) {
    const balcony = features.balconies;
    const floors = balcony.floors?.length ? " on storeys " + balcony.floors.join(", ") : " on upper storeys";
    parts.push("Balconies: " + (balcony.count ?? 1) + " per front arrangement" + floors + ", approximate width ratio " + (balcony.widthRatio ?? 0.72) + ", depth " + (balcony.depthMeters ?? 1.2) + " metres, railing " + ((balcony.railing ?? true) ? "included" : "omitted") + ".");
  }
  if (features?.columns?.frontCount) parts.push("Front columns: " + features.columns.frontCount + ", width " + (features.columns.widthMeters ?? 0.28) + " metres.");
  if (building.designBrief) parts.push("Architectural brief: " + clampPromptSegment(building.designBrief, 360) + ".");
  parts.push("Create one coherent exterior building asset with connected roof and facade; no labels, watermarks, people, surrounding city or landscape.");

  let prompt = "";
  for (const part of parts) {
    const next = prompt ? prompt + " " + part : part;
    if (next.length <= 1024) { prompt = next; continue; }
    const remaining = 1024 - prompt.length - (prompt ? 1 : 0);
    if (remaining > 40 && part.startsWith("Architectural brief: ")) prompt = prompt + (prompt ? " " : "") + part.slice(0, remaining).replace(/[\s.,;:-]+$/, "") + ".";
    break;
  }
  if (!prompt.trim()) fail("text-prompt-empty", "The architectural information did not produce a usable text-to-3D prompt.");
  return prompt;
}

function actualBuildingImages(request) {
  return request.references.filter((ref) =>
    ref.kind === "image" &&
    ref.purpose === "actual-building" &&
    ref.permission === "authorized"
  );
}

function safeUploadFilename(reference, asset) {
  if (typeof asset.filename === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(asset.filename) && !asset.filename.includes("..")) return asset.filename;
  const extension = asset.contentType === "image/png" ? ".png" : ".jpg";
  return "reference-" + reference.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) + extension;
}

function createUploadTracker() {
  return { uploadedReferences: [] };
}

function deriveAlignmentTarget(building) {
  const footprint = building.footprint;
  const dimensions = building.dimensions ?? {};
  let width;
  let depth;
  if (Number.isFinite(footprint?.widthMeters) && Number.isFinite(footprint?.depthMeters)) {
    width = footprint.widthMeters;
    depth = footprint.depthMeters;
  } else if (Array.isArray(footprint?.polygonXYMeters) && footprint.polygonXYMeters.length >= 3) {
    const xs = footprint.polygonXYMeters.map((point) => point[0]);
    const ys = footprint.polygonXYMeters.map((point) => point[1]);
    width = Math.max(...xs) - Math.min(...xs);
    depth = Math.max(...ys) - Math.min(...ys);
  }
  const height = dimensions.totalHeightMeters ?? (
    Number.isFinite(dimensions.aboveGroundFloors) && Number.isFinite(dimensions.floorToFloorHeightMeters)
      ? dimensions.aboveGroundFloors * dimensions.floorToFloorHeightMeters
      : undefined
  );
  if (![width, depth, height].every((value) => Number.isFinite(value) && value >= 0.5 && value <= 1000)) return null;
  return { footprintWidthMeters: width, footprintDepthMeters: depth, totalHeightMeters: height };
}

async function resolveProviderToken(reference, { tripoClient, loadAsset, uploadedReferences, signal }) {
  if (reference.providerFileToken) return reference.providerFileToken;
  if (typeof loadAsset !== "function" || typeof tripoClient.uploadImage !== "function") {
    fail("provider-upload-required", "Reference " + reference.id + " needs a server-side asset reader and provider image uploader.");
  }
  let asset;
  try {
    asset = await loadAsset(reference.assetId);
  } catch {
    fail("source-asset-load-failed", "The protected source asset for reference " + reference.id + " could not be loaded.");
  }
  if (!asset || !(asset.bytes instanceof Uint8Array)) {
    fail("source-asset-invalid", "The protected source asset reader must return image bytes as Uint8Array.");
  }
  const upload = await tripoClient.uploadImage({
    bytes: asset.bytes,
    filename: safeUploadFilename(reference, asset),
    contentType: asset.contentType,
    signal,
  });
  if (!upload || typeof upload.fileToken !== "string" || !/^file_[A-Za-z0-9_-]{4,240}$/.test(upload.fileToken)) {
    fail("provider-upload-invalid", "The generation provider did not return a valid file token.");
  }
  uploadedReferences.push({ referenceId: reference.id, providerFileToken: upload.fileToken });
  return upload.fileToken;
}

async function viewMap(references, uploadContext) {
  const result = {};
  for (const reference of references) {
    if (!["front", "left", "back", "right"].includes(reference.view)) continue;
    if (result[reference.view]) fail("duplicate-view", "More than one selected reference is labelled " + reference.view + ".");
    result[reference.view] = await resolveProviderToken(reference, uploadContext);
  }
  if (!result.front) fail("front-view-required", "Multiview generation requires an Admin-reviewed front view.");
  if (Object.keys(result).length < 2) fail("second-view-required", "Multiview generation needs a front view plus at least one side or rear view.");
  return result;
}

/**
 * Engine orchestration facade. The returned GLB is a procedural base candidate;
 * AI candidates remain separate until a later geometry-alignment/merge worker exists.
 */
export function createBuildingGenerationEngine({
  tripoClient = null,
  loadAsset = null,
  resolveVideoAssetPath = null,
  storeFrameAsset = null,
  storeGeneratedCandidate = null,
  fetchImpl = fetch,
  allowedModelHosts = undefined,
  extractVideo = extractVideoKeyframes,
  createVideoWorkDirectory = () => mkdtemp(join(tmpdir(), "building-video-engine-")),
  removeVideoWorkDirectory = (directory) => rm(directory, { recursive: true, force: true }),
  sleepImpl = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Generation wait was aborted."), { code: "ABORT_ERR" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error("Generation wait was aborted."), { code: "ABORT_ERR" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  }),
} = {}) {
  function analyze(requestValue) {
    const request = normalizeBuildingGenerationRequest(requestValue);
    return { request, plan: planBuildingGeneration(request) };
  }

  function generateProceduralCandidate(requestValue) {
    const { request, plan } = analyze(requestValue);
    if (!plan.canGenerateParametricBase) {
      fail("missing-parametric-inputs", plan.missingInputs.join(" "), plan);
    }
    const artifact = generateParametricBuildingGlb(request);
    return {
      strategy: "parametric-only",
      contentType: "model/gltf-binary",
      extension: ".glb",
      ...artifact,
      plan,
    };
  }

  async function prepareVideoFrames(requestValue, { videoReferenceId, signal, extractionOptions = {} } = {}) {
    const { request, plan } = analyze(requestValue);
    const video = request.references.find((reference) => reference.id === videoReferenceId);
    if (!video || video.kind !== "video" || video.purpose !== "actual-building") {
      fail("video-reference-not-found", "Choose an existing actual-building video reference.");
    }
    if (video.permission !== "authorized") {
      fail("video-processing-not-authorized", "The source video must be marked authorized before frame extraction.");
    }
    if (typeof resolveVideoAssetPath !== "function" || typeof storeFrameAsset !== "function") {
      fail("video-storage-adapter-required", "Configure a private server-side video path resolver and frame asset writer before extracting frames.", plan);
    }
    if (typeof extractVideo !== "function") {
      fail("video-extractor-not-configured", "No video keyframe extractor is configured.", plan);
    }

    let inputPath;
    try { inputPath = await resolveVideoAssetPath(video.assetId); } catch {
      fail("source-video-load-failed", "The protected source video could not be resolved from private storage.");
    }
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      fail("source-video-path-invalid", "Private video storage did not return a valid internal file path.");
    }

    const workDirectory = await createVideoWorkDirectory();
    const outputDirectory = join(workDirectory, "frames");
    try {
      const extraction = await extractVideo({ ...extractionOptions, inputPath, outputDirectory, signal });
      const frameReferences = [];
      for (const frame of extraction.frames) {
        const stored = await storeFrameAsset({
          path: frame.path,
          filename: frame.filename,
          contentType: "image/jpeg",
          sourceVideoAssetId: video.assetId,
          sourceVideoReferenceId: video.id,
          timestampSeconds: frame.timestampSeconds,
        });
        if (!stored || typeof stored.assetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(stored.assetId)) {
          fail("frame-asset-store-failed", "The private asset writer did not return a valid frame asset ID.");
        }
        const sourceKey = createHash("sha256").update(video.id).digest("hex").slice(0, 12);
        const reference = {
          id: "frame-" + sourceKey + "-" + String(frame.index + 1).padStart(3, "0"),
          assetId: stored.assetId,
          kind: "image",
          purpose: "actual-building",
          permission: video.permission,
          view: "unknown",
          derivedFromReferenceId: video.id,
          timestampSeconds: frame.timestampSeconds,
          sourceLabel: "Video frame " + (frame.index + 1) + " at " + frame.timestampSeconds.toFixed(2) + "s",
          ...(video.licence ? { licence: video.licence } : {}),
        };
        frameReferences.push(reference);
      }
      const updatedRequest = normalizeBuildingGenerationRequest({
        ...request,
        references: [...request.references.filter((reference) => reference.derivedFromReferenceId !== video.id), ...frameReferences],
      });
      return {
        request: updatedRequest,
        videoReferenceId: video.id,
        frameReferences,
        extraction: {
          durationSeconds: extraction.durationSeconds,
          samplingFps: extraction.samplingFps,
          notes: extraction.notes,
        },
        reviewRequired: true,
        nextStep: "Admin must label selected frames as front/left/back/right before multiview generation.",
      };
    } finally {
      await removeVideoWorkDirectory(workDirectory).catch(() => {});
    }
  }

  async function waitForProviderTask(taskId, { signal, timeoutMs = 300_000, pollIntervalMs = 2_000, maxAttempts = 150, sleep = sleepImpl } = {}) {
    if (!tripoClient || typeof tripoClient.getTask !== "function") fail("provider-not-configured", "No AI generation task client is configured on the server.");
    if (typeof taskId !== "string" || !/^task_[A-Za-z0-9_-]{4,195}$/.test(taskId)) {
      fail("provider-task-id-invalid", "The generation provider task ID is invalid.");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000) throw new RangeError("timeoutMs must be from 1000 to 900000.");
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 30_000) throw new RangeError("pollIntervalMs must be from 100 to 30000.");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000) throw new RangeError("maxAttempts must be from 1 to 1000.");
    if (typeof sleep !== "function") throw new TypeError("sleep must be a function.");
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) fail("provider-task-aborted", "Waiting for the provider task was aborted.");
      if (Date.now() >= deadline) fail("provider-task-timeout", "Provider task did not finish before the configured timeout.");
      let task;
      try { task = await tripoClient.getTask(taskId, { signal }); } catch (error) {
        if (signal?.aborted) fail("provider-task-aborted", "Waiting for the provider task was aborted.");
        throw error;
      }
      if (!task || task.taskId !== taskId) fail("provider-task-response-invalid", "Provider returned a different task ID.");
      if (task.status === "success") return task;
      if (task.status === "failed" || task.status === "cancelled") {
        fail("provider-task-" + task.status, task.message || ("Provider task " + task.status + "."));
      }
      if (task.status !== "queued" && task.status !== "running") {
        fail("provider-task-status-invalid", "Provider returned an unsupported task status.");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail("provider-task-timeout", "Provider task did not finish before the configured timeout.");
      await sleep(Math.min(pollIntervalMs, remaining), signal);
    }
    fail("provider-task-attempt-limit", "Provider task exceeded the configured polling attempt limit.");
  }

  async function validateAndStoreProviderOutput(task, {
    signal,
    maxBytes = 100 * 1024 * 1024,
    downloadTimeoutMs = 60_000,
    alignmentTarget = null,
    alignmentMode = "uniform-fit",
    generationContext = null,
  } = {}) {
    if (!task || task.status !== "success") fail("provider-task-not-successful", "Only successful provider tasks can produce a candidate model.");
    if (!task.modelUrl) fail("provider-output-missing-model", "The provider task succeeded but did not return a model URL.");
    if (typeof storeGeneratedCandidate !== "function") {
      fail("candidate-storage-not-configured", "Configure the server-side private candidate asset writer before storing provider output.");
    }
    let downloaded;
    try {
      downloaded = await downloadGeneratedGlb(task.modelUrl, {
        fetchImpl,
        ...(allowedModelHosts === undefined ? {} : { allowedHosts: allowedModelHosts }),
        maxBytes,
        timeoutMs: downloadTimeoutMs,
        signal,
      });
    } catch (error) {
      fail("provider-output-validation-failed", "Provider output was not accepted: " + (error instanceof Error ? error.message : String(error)));
    }

    let candidateGlb = downloaded.glb;
    let validation = downloaded.validation;
    let alignment = null;
    const warnings = [...validation.warnings];
    if (alignmentTarget) {
      try {
        const aligned = alignGeneratedGlbToDimensions(candidateGlb, { ...alignmentTarget, mode: alignmentMode, maxBytes });
        candidateGlb = aligned.glb;
        validation = aligned.validation;
        alignment = aligned.alignment;
        warnings.push(...alignment.warnings);
      } catch (error) {
        fail("provider-output-alignment-failed", "Generated model did not pass dimension alignment: " + (error instanceof Error ? error.message : String(error)));
      }
    } else {
      warnings.push("No authoritative footprint plus height is available; provider model scale remains unaligned and must be measured during Admin review.");
    }

    const inputSummary = generationContext ? {
      requestId: generationContext.requestId,
      quality: generationContext.quality,
      building: generationContext.building,
      referenceIds: generationContext.referenceIds ?? [],
      strategy: generationContext.strategy,
    } : undefined;
    const generationMetadata = {
      taskId: task.taskId,
      provider: "tripo",
      outputValidation: validation,
      provenance: "external-ai-candidate",
      ...(inputSummary ? { inputSummary } : {}),
      ...(typeof generationContext?.prompt === "string" ? { prompt: generationContext.prompt } : {}),
      ...(alignment ? { alignment } : {}),
      ...(Array.isArray(generationContext?.taskIds) ? { taskIds: generationContext.taskIds } : { taskIds: [task.taskId] }),
      ...(Array.isArray(generationContext?.generationStages) ? { generationStages: generationContext.generationStages } : { generationStages: ["direct-3d-generation"] }),
    };
    let stored;
    try {
      stored = await storeGeneratedCandidate({
        taskId: task.taskId,
        bytes: candidateGlb,
        contentType: "model/gltf-binary",
        metadata: generationMetadata,
      });
    } catch {
      fail("candidate-storage-failed", "Validated provider output could not be saved to private storage.");
    }
    if (!stored || typeof stored.assetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(stored.assetId)) {
      fail("candidate-storage-failed", "Private candidate storage did not return a valid internal asset ID.");
    }
    warnings.push("AI-generated geometry is a candidate. Admin review is required before the model can be published to the map.");
    return {
      status: "needs-admin-review",
      taskId: task.taskId,
      assetId: stored.assetId,
      validation,
      alignment,
      warnings: [...new Set(warnings)],
    };
  }
  async function generateAndStoreReferenceCandidate(requestValue, {
    selectedVideoFrameIds = [],
    signal,
    pollOptions = {},
    downloadOptions = {},
  } = {}) {
    const { request } = analyze(requestValue);
    const submitted = await submitReferenceCandidate(request, { selectedVideoFrameIds, signal });
    const taskIds = [submitted.taskId];
    const generationStages = [submitted.stage ?? "direct-3d-generation"];
    let finalStrategy = submitted.strategy;
    let completed = await waitForProviderTask(submitted.taskId, { ...pollOptions, signal });

    if (submitted.stage === "image-to-multiview") {
      const allowedSourceTaskTypes = new Set(["generate_multiview_image", "edit_multiview_image"]);
      if (completed.type && !allowedSourceTaskTypes.has(completed.type)) {
        fail("provider-source-task-type-invalid", "The image-to-multiview task completed with an unexpected type: " + completed.type);
      }
      if (!completed.type) {
        generationStages.push("multiview-source-task-type-unavailable");
      }
      if (typeof tripoClient.submitMultiviewFromTask !== "function") {
        fail("provider-multiview-from-task-unavailable", "The provider cannot continue from an image-to-multiview task.");
      }
      const modelTask = await tripoClient.submitMultiviewFromTask({ sourceTaskId: completed.taskId, signal });
      taskIds.push(modelTask.taskId);
      generationStages.push(modelTask.stage ?? "multiview-to-model");
      finalStrategy = "parametric-plus-ai-image-multiview";
      completed = await waitForProviderTask(modelTask.taskId, { ...pollOptions, signal });
    }

    const safeBuildingSummary = {
      name: request.building.name,
      buildingType: request.building.buildingType,
      architecturalStyle: request.building.architecturalStyle,
      dimensions: request.building.dimensions,
      footprint: request.building.footprint,
      roofType: request.building.roofType,
      facadeMaterials: request.building.facadeMaterials,
      facadeColours: request.building.facadeColours,
      architecturalFeatures: request.building.architecturalFeatures,
    };
    const stored = await validateAndStoreProviderOutput(completed, {
      ...downloadOptions,
      signal,
      alignmentTarget: deriveAlignmentTarget(request.building),
      generationContext: {
        requestId: request.requestId,
        quality: request.quality,
        building: safeBuildingSummary,
        referenceIds: request.references.map((reference) => reference.id),
        strategy: finalStrategy,
        ...(submitted.prompt ? { prompt: submitted.prompt } : {}),
        taskIds,
        generationStages,
      },
    });
    return {
      ...stored,
      strategy: finalStrategy,
      plan: submitted.plan,
      uploadedReferences: submitted.uploadedReferences ?? [],
      stageTaskIds: taskIds,
      generationStages,
    };
  }

  async function submitReferenceCandidate(requestValue, { selectedVideoFrameIds = [], signal } = {}) {
    const { request, plan } = analyze(requestValue);
    if (!request.allowExternalProviderProcessing) {
      fail("external-processing-not-authorized", "External processing must be explicitly authorized by the Admin.", plan);
    }
    if (plan.blocked) {
      fail("generation-inputs-blocked", [...plan.missingInputs, ...plan.warnings].join(" "), plan);
    }
    if (plan.strategy === "photogrammetry-candidate") {
      fail("photogrammetry-worker-required", "This evidence is routed to the photogrammetry worker, not the image-to-3D API.", plan);
    }
    if (!tripoClient) {
      fail("provider-not-configured", "No AI generation provider client is configured on the server.", plan);
    }

    if (plan.strategy === "parametric-plus-ai-text") {
      if (typeof tripoClient.submitText !== "function") {
        fail("text-provider-not-configured", "The configured provider does not support text-to-3D generation.", plan);
      }
      const prompt = buildArchitecturalTextPrompt(request);
      const task = await tripoClient.submitText({
        prompt,
        negativePrompt: "text, logo, watermark, people, landscape, surrounding buildings, disconnected parts, floating geometry",
        signal,
      });
      return {
        strategy: "parametric-plus-ai-text",
        ...task,
        stage: "text-to-model",
        prompt,
        uploadedReferences: [],
        plan,
      };
    }

    const uploadTracker = createUploadTracker();
    const uploadContext = { tripoClient, loadAsset, uploadedReferences: uploadTracker.uploadedReferences, signal };
    const videos = request.references.filter((ref) =>
      ref.kind === "video" &&
      ref.purpose === "actual-building" &&
      ref.permission === "authorized"
    );
    let images;

    if (videos.length > 0) {
      if (!Array.isArray(selectedVideoFrameIds) || selectedVideoFrameIds.length < 2) {
        fail("video-frame-selection-required", "Extract video keyframes, then have the Admin select and label at least two views before AI generation.", plan);
      }
      const selectedIds = new Set(selectedVideoFrameIds);
      if (selectedIds.size !== selectedVideoFrameIds.length) {
        fail("duplicate-video-frame-selection", "The same video frame was selected more than once.", plan);
      }
      images = request.references.filter((ref) =>
        selectedIds.has(ref.id) &&
        ref.kind === "image" &&
        ref.purpose === "actual-building" &&
        ref.permission === "authorized" &&
        ref.derivedFromReferenceId &&
        videos.some((video) => video.id === ref.derivedFromReferenceId)
      );
      if (images.length !== selectedIds.size || images.length < 2) {
        fail("invalid-video-frame-selection", "Selected frames must be authorized image references derived from the supplied authorized video.", plan);
      }
    } else {
      images = actualBuildingImages(request);
    }

    if (images.length === 0) {
      fail("actual-building-image-required", "Provide an authorized actual-building image, or extract and select authorized frames from a video.", plan);
    }

    const labelledViews = images.filter((ref) => ["front", "left", "back", "right"].includes(ref.view));
    const hasFront = labelledViews.some((ref) => ref.view === "front");
    const hasSecondView = labelledViews.some((ref) => ref.view !== "front");
    if (hasFront && hasSecondView) {
      const views = await viewMap(labelledViews, uploadContext);
      const task = await tripoClient.submitMultiview({ views, signal });
      return {
        strategy: videos.length ? "video-keyframes-then-ai" : "parametric-plus-ai-multiview",
        ...task,
        stage: "multiview-to-model",
        uploadedReferences: uploadTracker.uploadedReferences,
        plan,
      };
    }

    if (videos.length > 0) {
      fail("labelled-multiview-required", "Video-derived frames must be labelled as front plus at least one of left, right or back for multiview generation.", plan);
    }
    if (images.length > 1 && labelledViews.length > 0) {
      fail("incomplete-multiview-labels", "For multiple reference images, label views clearly and include front plus at least one side/rear view.", plan);
    }

    const image = images[0];
    const input = await resolveProviderToken(image, uploadContext);
    if (typeof tripoClient.submitImageToMultiview === "function" && typeof tripoClient.submitMultiviewFromTask === "function") {
      const task = await tripoClient.submitImageToMultiview({ input, signal });
      return {
        strategy: "parametric-plus-ai-image-multiview",
        ...task,
        uploadedReferences: uploadTracker.uploadedReferences,
        plan,
      };
    }
    // Compatibility fallback for providers that do not offer image-to-multiview chaining.
    const task = await tripoClient.submitImage({ input, signal });
    return {
      strategy: "parametric-plus-ai-image",
      ...task,
      stage: "direct-image-to-model",
      uploadedReferences: uploadTracker.uploadedReferences,
      plan,
    };
  }

  return Object.freeze({
    analyze,
    prepareVideoFrames,
    generateProceduralCandidate,
    submitReferenceCandidate,
    waitForProviderTask,
    validateAndStoreProviderOutput,
    generateAndStoreReferenceCandidate,
  });
}
