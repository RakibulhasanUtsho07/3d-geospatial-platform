export const REQUIRED_REVIEW_VIEWS = Object.freeze([
  "front", "back", "left", "right", "top",
  "turntable-000", "turntable-045", "turntable-090", "turntable-135",
  "turntable-180", "turntable-225", "turntable-270", "turntable-315",
]);

const sha256Pattern = /^[a-f0-9]{64}$/i;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function safePngName(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(value) &&
    !value.includes("..") && !value.includes("/") && !value.includes("\\");
}

/**
 * Validates the render outputs made by the Blender runner and creates a human-review
 * manifest. This is not a perceptual or architectural accuracy score.
 */
export function finalizeRenderReviewManifest({ rawManifest, modelSha256, files, resolution, textureQaSummary = null }) {
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
      "Render completion and a clean manifest do not establish metric scale, georeferencing, correct building identity, or source-photo correctness.",
      "Human review against independent source photographs remains required. publicationEligible is always false.",
    ],
  };
}
