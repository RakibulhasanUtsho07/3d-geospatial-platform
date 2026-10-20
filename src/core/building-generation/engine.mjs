import {
  normalizeBuildingGenerationRequest,
  planBuildingGeneration,
} from "./input-policy.mjs";
import { generateParametricBuildingGlb } from "./procedural-builder.mjs";

function fail(code, message, plan = null) {
  const error = new Error(message);
  error.code = code;
  if (plan) error.plan = plan;
  throw error;
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
export function createBuildingGenerationEngine({ tripoClient = null, loadAsset = null } = {}) {
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
    const task = await tripoClient.submitImage({ input, signal });
    return {
      strategy: "parametric-plus-ai-image",
      ...task,
      uploadedReferences: uploadTracker.uploadedReferences,
      plan,
    };
  }

  return Object.freeze({
    analyze,
    generateProceduralCandidate,
    submitReferenceCandidate,
  });
}
