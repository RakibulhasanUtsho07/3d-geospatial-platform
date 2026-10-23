import { createHash } from "node:crypto";

export const REQUIRED_REVIEW_VIEWS = Object.freeze([
  "front", "back", "left", "right", "top",
  "turntable-000", "turntable-045", "turntable-090", "turntable-135",
  "turntable-180", "turntable-225", "turntable-270", "turntable-315",
]);

const sha256Pattern = /^[a-f0-9]{64}$/i;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function finiteVector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(finite);
}

function finiteVector4(value) {
  return Array.isArray(value) && value.length === 4 && value.every(finite);
}

function validCameraPose(pose) {
  if (!pose || typeof pose !== "object" || Array.isArray(pose) || pose.projection !== "ORTHO" ||
    !finiteVector3(pose.positionWorld) || !finiteVector3(pose.targetWorld) ||
    !finiteVector3(pose.viewDirectionWorld) || !finiteVector3(pose.rotationEulerRadians) ||
    !finite(pose.orthographicScale) || pose.orthographicScale <= 0) return false;
  const cameraToTarget = pose.targetWorld.map((value, index) => value - pose.positionWorld[index]);
  const directionLength = Math.hypot(...pose.viewDirectionWorld);
  const cameraDistance = Math.hypot(...cameraToTarget);
  if (Math.abs(directionLength - 1) > 0.01 || cameraDistance <= 1e-8) return false;
  const expectedDirection = cameraToTarget.map((value) => value / cameraDistance);
  const directionError = Math.hypot(...expectedDirection.map((value, index) => value - pose.viewDirectionWorld[index]));
  return directionError <= 0.02;
}

function validRenderSettings(settings, resolution) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  if (typeof settings.renderEngine !== "string" || !settings.renderEngine.trim() ||
    settings.resolutionX !== resolution || settings.resolutionY !== resolution ||
    settings.resolutionPercentage !== 100 || settings.imageFormat !== "PNG" ||
    settings.imageColorMode !== "RGBA" || settings.imageColorDepth !== "8" ||
    !Number.isSafeInteger(settings.imageCompression) || settings.imageCompression < 0 || settings.imageCompression > 100 ||
    typeof settings.filmTransparent !== "boolean" ||
    typeof settings.viewTransform !== "string" || !settings.viewTransform.trim() ||
    settings.cameraProjection !== "ORTHO" ||
    !finite(settings.cameraDistanceMultiplier) || settings.cameraDistanceMultiplier <= 0 ||
    !finite(settings.cameraOrthoScaleMultiplier) || settings.cameraOrthoScaleMultiplier <= 0 ||
    !finite(settings.turntableElevationDegrees) ||
    !finiteVector4(settings.worldBackgroundRgba) ||
    !finite(settings.worldBackgroundStrength) ||
    !Array.isArray(settings.lights) || settings.lights.length !== 3) return false;
  return settings.lights.every((light) => light && light.type === "AREA" &&
    typeof light.name === "string" && light.name.trim() && finiteVector3(light.positionWorld) &&
    finite(light.energy) && light.energy > 0 && finite(light.size) && light.size > 0);
}

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function safePngName(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(value) &&
    !value.includes("..") && !value.includes("/") && !value.includes("\\");
}

/**
 * Validates the render outputs made by the Blender runner and creates a human-review
 * manifest. This is not a perceptual or architectural accuracy score.
 */
export function finalizeRenderReviewManifest({ rawManifest, modelSha256, files, resolution, geometryQaSummary = null, textureQaSummary = null }) {
  if (!rawManifest || typeof rawManifest !== "object" || !Array.isArray(rawManifest.views)) {
    throw new TypeError("rawManifest must contain a views array");
  }
  if (!sha256Pattern.test(modelSha256 ?? "")) throw new TypeError("modelSha256 must be a 64-character SHA-256 hash");
  if (!Number.isSafeInteger(resolution) || resolution < 256 || resolution > 2048 || (resolution & (resolution - 1)) !== 0) {
    throw new RangeError("resolution must be a power-of-two integer between 256 and 2048");
  }
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new TypeError("files must map PNG file names to validated metadata");

  const errors = [], warnings = [], seenIds = new Set(), seenFiles = new Set();
  const views = [];
  const byId = new Map();

  if (rawManifest.renderProfile !== "building-review-fixed-cameras-v1") {
    errors.push("render-profile-missing-or-unsupported");
  }
  const settingsValid = validRenderSettings(rawManifest.renderSettings, resolution);
  if (!settingsValid) errors.push("render-settings-invalid-or-incomplete");
  if (!geometryQaSummary || typeof geometryQaSummary !== "object" || Array.isArray(geometryQaSummary)) {
    errors.push("geometry-qa-missing");
  } else {
    if (geometryQaSummary.valid !== true || typeof geometryQaSummary.engine !== "string" ||
      typeof geometryQaSummary.status !== "string" || !Array.isArray(geometryQaSummary.warnings) ||
      !Array.isArray(geometryQaSummary.errors)) {
      errors.push("geometry-qa-summary-invalid");
    }
    const counts = geometryQaSummary.counts;
    if (!counts || !Number.isSafeInteger(counts.meshCount) || counts.meshCount < 1 ||
      !Number.isSafeInteger(counts.vertexCount) || counts.vertexCount < 3 ||
      !Number.isSafeInteger(counts.triangleCount) || counts.triangleCount < 1 ||
      !Number.isSafeInteger(counts.degenerateTriangleCount) || counts.degenerateTriangleCount < 0) {
      errors.push("geometry-qa-counts-invalid");
    }
    if (Array.isArray(geometryQaSummary.errors) && geometryQaSummary.errors.length) {
      errors.push("geometry-qa-reported-errors");
    }
    if (Array.isArray(geometryQaSummary.warnings) && geometryQaSummary.warnings.length) {
      warnings.push("glb-geometry-qa-review-required");
    }
  }
  for (const view of rawManifest.views) {
    if (!view || typeof view.id !== "string" || !view.id) {
      errors.push("render-view-has-invalid-id");
      continue;
    }
    if (seenIds.has(view.id)) errors.push("duplicate-render-view-id:" + view.id);
    seenIds.add(view.id);
    byId.set(view.id, view);
  }
  for (const requiredId of REQUIRED_REVIEW_VIEWS) {
    if (!byId.has(requiredId)) errors.push("missing-required-view:" + requiredId);
  }
  for (const id of seenIds) {
    if (!REQUIRED_REVIEW_VIEWS.includes(id)) warnings.push("unexpected-render-view:" + id);
  }

  for (const id of REQUIRED_REVIEW_VIEWS) {
    const view = byId.get(id);
    if (!view) continue;
    if (!safePngName(view.filename)) {
      errors.push("invalid-render-filename:" + id);
      continue;
    }
    if (seenFiles.has(view.filename)) errors.push("duplicate-render-filename:" + view.filename);
    seenFiles.add(view.filename);
    const file = files[view.filename];
    if (!file) {
      errors.push("render-file-missing:" + view.filename);
      continue;
    }
    if (file.width !== resolution || file.height !== resolution ||
      view.width !== resolution || view.height !== resolution) {
      errors.push("render-dimensions-mismatch:" + id);
    }
    if (!sha256Pattern.test(file.sha256 ?? "")) errors.push("render-sha256-invalid:" + id);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 1) errors.push("render-byte-length-invalid:" + id);
    if (view.renderComplete !== true) errors.push("render-not-complete:" + id);
    if (!validCameraPose(view.cameraPose)) errors.push("render-camera-pose-invalid:" + id);
    const stats = view.pixelStatistics ?? {};
    if (!finite(stats.luminanceMean) || !finite(stats.luminanceStandardDeviation) ||
      !finite(stats.transparentRatio) || !Number.isSafeInteger(stats.sampledPixels) || stats.sampledPixels < 1) {
      errors.push("render-pixel-statistics-invalid:" + id);
    } else {
      if (stats.luminanceStandardDeviation < 0.002) warnings.push("low-contrast-render-review:" + id);
      if (stats.transparentRatio > 0.95) warnings.push("mostly-transparent-render-review:" + id);
    }
    views.push({
      id,
      filename: view.filename,
      width: file.width,
      height: file.height,
      bytes: file.bytes,
      sha256: file.sha256.toLowerCase(),
      renderComplete: view.renderComplete === true,
      cameraPose: view.cameraPose ?? null,
      pixelStatistics: stats,
    });
  }

  const bounds = rawManifest.sceneBounds;
  if (!bounds || !Array.isArray(bounds.min) || !Array.isArray(bounds.max) ||
    !Array.isArray(bounds.dimensions) || bounds.min.length !== 3 || bounds.max.length !== 3 ||
    bounds.dimensions.length !== 3 || [...bounds.min, ...bounds.max, ...bounds.dimensions].some((n) => !finite(n)) ||
    bounds.dimensions.some((n) => n <= 0)) {
    errors.push("model-scene-bounds-invalid");
  }
  if (typeof rawManifest.rendererVersion !== "string" || !rawManifest.rendererVersion.trim()) {
    errors.push("renderer-version-missing");
  }
  if (rawManifest.width !== resolution || rawManifest.height !== resolution) errors.push("render-manifest-resolution-mismatch");

  const renderConfigPayload = {
    renderProfile: rawManifest.renderProfile ?? null,
    rendererVersion: rawManifest.rendererVersion ?? null,
    renderSettings: rawManifest.renderSettings ?? null,
    views: REQUIRED_REVIEW_VIEWS.map((id) => ({
      id,
      cameraPose: byId.get(id)?.cameraPose ?? null,
    })),
  };
  const renderConfigSha256 = createHash("sha256").update(stableJson(renderConfigPayload)).digest("hex");
  const status = errors.length ? "failed" : warnings.length ? "review-required" : "render-set-ready-for-human-review";
  return {
    schemaVersion: "1.0.0",
    engine: "building-render-review-manifest-v1",
    status,
    valid: errors.length === 0,
    publicationEligible: false,
    modelSha256: modelSha256.toLowerCase(),
    renderer: "Blender",
    rendererVersion: rawManifest.rendererVersion ?? null,
    renderProfile: rawManifest.renderProfile ?? null,
    renderSettings: rawManifest.renderSettings ?? null,
    renderConfigSha256,
    geometryQaSummary: geometryQaSummary ?? null,
    renderResolution: { width: resolution, height: resolution },
    sceneBounds: bounds ?? null,
    counts: { requiredViews: REQUIRED_REVIEW_VIEWS.length, generatedViews: views.length, errors: errors.length,
      warnings: warnings.length },
    views,
    textureQaSummary,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    humanReview: {
      status: "pending",
      checklist: [
        { id: "silhouette", label: "Compare overall silhouette and proportions against reference photos", reviewed: false },
        { id: "facade", label: "Confirm front, rear and side facades are oriented and assigned correctly", reviewed: false },
        { id: "openings", label: "Inspect window, door, column, balcony and roof details", reviewed: false },
        { id: "texture-alignment", label: "Inspect texture alignment, UV seams, blur and lighting mismatch", reviewed: false },
        { id: "hidden-surfaces", label: "Verify unseen surfaces from independent evidence; do not infer them as verified", reviewed: false },
      ],
    },
    limitations: [
      "The front/back/left/right labels refer to Blender world axes after GLB import; the script cannot infer the real-world facade direction.",
      "Image statistics detect only a few technical risks and are not a visual similarity or architectural accuracy score.",
      "renderConfigSha256 fingerprints renderer version, camera poses and declared render settings; it does not guarantee pixel-identical output across different hardware or Blender builds.",
      "Render completion and a clean manifest do not establish metric scale, georeferencing, correct building identity, or source-photo correctness.",
      "Human review against independent source photographs remains required. publicationEligible is always false.",
    ],
  };
}
