const HASH = /^[a-f0-9]{64}$/i;
const PROVIDER_KINDS = new Set(["automatic-segmentation", "human-reviewed-mask", "edge-preview"]);
const REVIEW_STATES = new Set(["proposed", "reviewed", "rejected"]);
const COORDINATE_CONVENTION = "pixel-origin-top-left";
const BINARY_MASK_ENCODING = "binary-8bit-white-foreground-v1";
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const digestOk = (value) => typeof value === "string" && HASH.test(value);
const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * Validate a semantic building mask against the exact source-image identity.
 * decodedMask.pixels is a decoded single-channel 0/255 image; callers must separately
 * compute actualMaskSha256 from the encoded PNG bytes, not from decoded pixels.
 */
export function validateBuildingMaskArtifact({ source, result, actualMaskSha256, decodedMask } = {}) {
  const errors = [], warnings = [];
  const addError = (code, detail) => errors.push({ code, detail });
  const addWarning = (code, detail) => warnings.push({ code, detail });
  if (!source || typeof source !== "object" || !nonEmpty(source.sourceId) ||
      !digestOk(source.sha256) || !positiveInt(source.width) || !positiveInt(source.height)) {
    addError("source-metadata-invalid", "Source image must include sourceId, SHA-256 and positive pixel dimensions.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result) || result.schemaVersion !== "1.0.0") {
    addError("mask-result-invalid", "Mask provider result schemaVersion 1.0.0 is required.");
  }
  if (!result || result.sourceId !== source?.sourceId) addError("source-id-mismatch", "Mask result references a different source ID.");
  if (!digestOk(result?.inputSha256) || result?.inputSha256?.toLowerCase() !== source?.sha256?.toLowerCase()) {
    addError("source-hash-mismatch", "Mask result must bind to the exact source-image SHA-256.");
  }
  const provider = result?.provider;
  if (!provider || !nonEmpty(provider.id) || !nonEmpty(provider.version) ||
      !PROVIDER_KINDS.has(provider.kind)) {
    addError("provider-metadata-invalid", "Provider ID, version, and a supported provider kind are required.");
  } else if (provider.kind === "edge-preview") {
    addError("edge-map-is-not-semantic-mask", "A grayscale edge/sketch preview must never be treated as a verified building-only mask.");
  }
  if (!digestOk(provider?.configurationSha256)) {
    addWarning("provider-config-unpinned", "Provider configuration SHA-256 is missing; exact processing configuration is not reproducible.");
  }
  const mask = result?.mask;
  if (!mask || !digestOk(mask.sha256) || !digestOk(actualMaskSha256)) {
    addError("mask-hash-missing", "Declared and computed encoded-mask SHA-256 are required.");
  } else if (mask.sha256.toLowerCase() !== actualMaskSha256.toLowerCase()) {
    addError("mask-hash-mismatch", "Encoded mask bytes do not match the declared SHA-256.");
  }
  if (!mask || !positiveInt(mask.width) || !positiveInt(mask.height) ||
      !positiveInt(mask.bytes) || mask.encoding !== BINARY_MASK_ENCODING ||
      mask.coordinateConvention !== COORDINATE_CONVENTION ||
      mask.backgroundValue !== 0 || mask.foregroundValue !== 255) {
    addError("mask-contract-invalid", "Mask must declare dimensions, byte length, binary 0/255 encoding and top-left pixel coordinates.");
  }
  if (source && mask && positiveInt(source.width) && positiveInt(source.height) &&
      (mask.width !== source.width || mask.height !== source.height)) {
    addError("mask-source-dimensions-mismatch", "Mask pixel dimensions must exactly match the source image.");
  }
  if (!decodedMask || !positiveInt(decodedMask.width) || !positiveInt(decodedMask.height) ||
      decodedMask.width !== source?.width || decodedMask.height !== source?.height ||
      !(decodedMask.pixels instanceof Uint8Array || Array.isArray(decodedMask.pixels)) ||
      decodedMask.pixels.length !== decodedMask.width * decodedMask.height) {
    addError("decoded-mask-invalid", "Decoded single-channel mask must match source dimensions and contain one byte per pixel.");
  } else {
    let nonBinaryIndex = -1, foreground = 0;
    for (let i = 0; i < decodedMask.pixels.length; i += 1) {
      const value = decodedMask.pixels[i];
      if (value !== 0 && value !== 255) { nonBinaryIndex = i; break; }
      if (value === 255) foreground += 1;
    }
    if (nonBinaryIndex >= 0) addError("mask-not-binary", "Mask pixel " + nonBinaryIndex + " has a value other than 0 or 255.");
    if (foreground === 0) addWarning("mask-empty-foreground", "Mask contains no building foreground pixels.");
    if (foreground === decodedMask.pixels.length && foreground > 0) {
      addWarning("mask-full-foreground", "Mask marks every pixel as foreground; manually review the crop and segmentation.");
    }
  }
  const assessment = result?.assessment;
  if (!assessment || !REVIEW_STATES.has(assessment.status) ||
      typeof assessment.confidence !== "number" || !Number.isFinite(assessment.confidence) ||
      assessment.confidence < 0 || assessment.confidence > 1) {
    addError("assessment-invalid", "Assessment status and confidence in [0,1] are required.");
  } else if (assessment.status === "rejected") {
    addError("mask-rejected-by-reviewer", "A rejected mask cannot enter feature extraction.");
  } else if (assessment.status !== "reviewed" || assessment.humanReviewed !== true ||
      !nonEmpty(assessment.reviewerId) || !nonEmpty(assessment.reviewedAt) ||
      !Number.isFinite(Date.parse(assessment.reviewedAt))) {
    addWarning("mask-review-pending", "Mask must be explicitly reviewed by a named reviewer before feature extraction.");
  }
  const status = errors.length ? "failed" : warnings.length ? "review-required" : "ready-for-feature-extraction";
  return { status, valid: errors.length === 0, validForFeatureExtraction: status === "ready-for-feature-extraction",
    sourceId: source?.sourceId ?? null, providerId: provider?.id ?? null,
    confidence: assessment?.confidence ?? null, errors, warnings,
    policy: { semanticMask: provider?.kind !== "edge-preview", publishable: false } };
}

/** Prefer a sufficiently confident and reviewed model result; otherwise use only a reviewed manual mask. */
export function resolveBuildingMaskProvider({ automaticReport = null, manualFallbackReport = null, minimumAutomaticConfidence = 0.8 } = {}) {
  if (typeof minimumAutomaticConfidence !== "number" || !Number.isFinite(minimumAutomaticConfidence) ||
      minimumAutomaticConfidence < 0 || minimumAutomaticConfidence > 1) {
    throw new RangeError("minimumAutomaticConfidence must be between 0 and 1.");
  }
  if (automaticReport?.validForFeatureExtraction === true &&
      automaticReport.status === "ready-for-feature-extraction" &&
      automaticReport.confidence >= minimumAutomaticConfidence) {
    return { status: "ready-for-feature-extraction", selected: "automatic-segmentation",
      reason: "The exact source-bound automatic mask passed structural checks and its per-image result was explicitly reviewed.",
      publishable: false };
  }
  const manualReady = manualFallbackReport?.validForFeatureExtraction === true &&
    manualFallbackReport.status === "ready-for-feature-extraction" &&
    manualFallbackReport.providerId !== null;
  if (manualReady) {
    return { status: "ready-for-feature-extraction", selected: "human-reviewed-mask",
      reason: automaticReport?.status === "failed"
        ? "Automatic output failed validation; selected the explicitly reviewed manual fallback."
        : automaticReport?.confidence < minimumAutomaticConfidence
          ? "Automatic result did not meet the configured confidence floor; selected the reviewed manual fallback."
          : "Automatic output is unavailable or pending review; selected the reviewed manual fallback.",
      publishable: false };
  }
  const anyFailed = automaticReport?.status === "failed" &&
    (!manualFallbackReport || manualFallbackReport.status === "failed");
  return { status: anyFailed ? "failed" : "incomplete", selected: null,
    reason: "Neither a sufficiently confident reviewed automatic mask nor a reviewed manual fallback is ready. Keep architecture unknown and block feature extraction.",
    publishable: false };
}
