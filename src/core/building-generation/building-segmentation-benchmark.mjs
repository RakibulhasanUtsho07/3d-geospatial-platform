import { createHash } from "node:crypto";

export const SEGMENTATION_CLASSES = Object.freeze([
  { id: 0, name: "background", rgb: [0, 0, 0] },
  { id: 1, name: "building", rgb: [255, 255, 255] },
  { id: 2, name: "vegetation", rgb: [0, 255, 0] },
  { id: 3, name: "vehicle", rgb: [255, 0, 0] },
  { id: 4, name: "sky", rgb: [0, 0, 255] },
  { id: 5, name: "other", rgb: [255, 255, 0] },
]);
export const SEGMENTATION_PALETTE_ID = "building-segmentation-rgb-palette-v1";
const HASH = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SPLITS = new Set(["development", "held-out-evaluation"]);
const CLASS_BY_RGB = new Map(SEGMENTATION_CLASSES.map((item) => [item.rgb.join(","), item.id]));
const finiteInt = (value) => Number.isSafeInteger(value) && value > 0;
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function addIssue(issues, level, code, detail, sampleId = null) {
  issues.push({ level, code, detail, ...(sampleId ? { sampleId } : {}) });
}
function safeRelativePath(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    !value.includes("\\\\") && !value.startsWith("/") && !/^[a-z]:/i.test(value) &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..");
}
function validReview(review) {
  return review && review.status === "reviewed" && nonEmpty(review.reviewerId) &&
    nonEmpty(review.reviewedAt) && Number.isFinite(Date.parse(review.reviewedAt)) &&
    nonEmpty(review.annotationId);
}
function validateAsset(asset, label, sampleId, issues, requireRights = false) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    addIssue(issues, "error", label + "-missing", label + " record is missing.", sampleId);
    return false;
  }
  let good = true;
  if (!safeRelativePath(asset.path)) {
    addIssue(issues, "error", label + "-unsafe-path", label + " path must be a safe project-relative path.", sampleId);
    good = false;
  }
  if (!HASH.test(asset.sha256 ?? "")) {
    addIssue(issues, "error", label + "-invalid-sha256", label + " SHA-256 is malformed.", sampleId);
    good = false;
  }
  if (!finiteInt(asset.bytes) || !finiteInt(asset.width) || !finiteInt(asset.height)) {
    addIssue(issues, "error", label + "-invalid-metadata", label + " bytes and dimensions must be positive integers.", sampleId);
    good = false;
  }
  if (label === "label-mask" && asset.encoding !== SEGMENTATION_PALETTE_ID) {
    addIssue(issues, "error", "label-mask-encoding-unsupported", "Label masks must use " + SEGMENTATION_PALETTE_ID + ".", sampleId);
    good = false;
  }
  if (requireRights) {
    const rights = asset.rights;
    if (!rights || rights.status !== "verified" || !nonEmpty(rights.evidenceId) ||
        !nonEmpty(rights.reviewedBy) || !nonEmpty(rights.reviewedAt) ||
        !Number.isFinite(Date.parse(rights.reviewedAt))) {
      addIssue(issues, "warning", "source-rights-not-independently-verified",
        "Permission evidence must be explicitly reviewed; operator assertions alone are not independent verification.", sampleId);
    }
    if (!nonEmpty(asset.sourceId)) {
      addIssue(issues, "warning", "source-provenance-incomplete", "A source record ID is required for audit-ready evaluation.", sampleId);
    }
  }
  return good;
}

/**
 * Validate a labelled benchmark contract. Paths/hashes and reviewer fields are structural
 * evidence only; the CLI separately verifies real file bytes and dimensions.
 */
export function validateSegmentationBenchmarkManifest(manifest) {
  const issues = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { status: "failed", issues: [{ level: "error", code: "manifest-not-object", detail: "Manifest must be an object." }], sampleCount: 0 };
  }
  if (manifest.schemaVersion !== "1.0.0") addIssue(issues, "error", "schema-version-unsupported", "schemaVersion must be 1.0.0.");
  if (!ID.test(manifest.benchmarkId ?? "")) addIssue(issues, "error", "benchmark-id-invalid", "benchmarkId must be a safe identifier.");
  if (!nonEmpty(manifest.createdAt) || !Number.isFinite(Date.parse(manifest.createdAt))) {
    addIssue(issues, "error", "created-at-invalid", "createdAt must be a valid timestamp.");
  }
  if (manifest.paletteId !== SEGMENTATION_PALETTE_ID) {
    addIssue(issues, "error", "palette-id-unsupported", "paletteId must be " + SEGMENTATION_PALETTE_ID + ".");
  }
  if (!Array.isArray(manifest.samples)) {
    addIssue(issues, "error", "samples-not-array", "samples must be an array.");
    return { status: "failed", issues, sampleCount: 0 };
  }
  if (!manifest.samples.length) addIssue(issues, "warning", "benchmark-has-no-samples", "No labelled samples are available; this validates tooling only.");
  const sampleIds = new Set(), groupSplit = new Map();
  for (const sample of manifest.samples) {
    const sampleId = sample?.sampleId;
    if (!ID.test(sampleId ?? "")) addIssue(issues, "error", "sample-id-invalid", "Each sample needs a safe sampleId.", nonEmpty(sampleId) ? sampleId : null);
    if (sampleIds.has(sampleId)) addIssue(issues, "error", "duplicate-sample-id", "sampleId values must be unique.", sampleId);
    sampleIds.add(sampleId);
    if (!nonEmpty(sample?.captureGroupId)) addIssue(issues, "error", "capture-group-missing", "Every sample needs captureGroupId to prevent burst leakage.", sampleId);
    if (!SPLITS.has(sample?.split)) addIssue(issues, "error", "split-invalid", "split must be development or held-out-evaluation.", sampleId);
    if (nonEmpty(sample?.captureGroupId) && SPLITS.has(sample?.split)) {
      const oldSplit = groupSplit.get(sample.captureGroupId);
      if (oldSplit && oldSplit !== sample.split) {
        addIssue(issues, "error", "capture-group-split-leakage",
          "Images from one captureGroupId appear in both development and held-out evaluation.", sampleId);
      } else groupSplit.set(sample.captureGroupId, sample.split);
    }
    validateAsset(sample?.source, "source-image", sampleId, issues, true);
    validateAsset(sample?.groundTruthMask, "label-mask", sampleId, issues, false);
    if (!validReview(sample?.groundTruthMask?.review)) {
      addIssue(issues, "warning", "ground-truth-mask-not-reviewed",
        "Ground-truth mask needs an annotation ID, reviewer, timestamp and reviewed status.", sampleId);
    }
    const predictions = sample?.predictions;
    if (!Array.isArray(predictions) || predictions.length === 0) {
      addIssue(issues, "warning", "sample-has-no-candidate-mask", "No candidate segmentation output is configured for this sample.", sampleId);
      continue;
    }
    const candidateIds = new Set();
    for (const candidate of predictions) {
      if (!ID.test(candidate?.providerId ?? "") || !nonEmpty(candidate?.modelVersion) ||
          !HASH.test(candidate?.configSha256 ?? "")) {
        addIssue(issues, "error", "candidate-provenance-invalid",
          "Each prediction needs providerId, modelVersion and a config SHA-256.", sampleId);
      }
      const candidateKey = candidate?.providerId;
      if (candidateIds.has(candidateKey)) addIssue(issues, "error", "duplicate-candidate-provider",
        "A provider may appear only once per sample.", sampleId);
      candidateIds.add(candidateKey);
      if (!HASH.test(candidate?.inputSha256 ?? "") ||
          candidate?.inputSha256?.toLowerCase() !== sample?.source?.sha256?.toLowerCase()) {
        addIssue(issues, "error", "candidate-input-hash-mismatch",
          "Candidate result must bind to the exact source-image SHA-256.", sampleId);
      }
      validateAsset(candidate?.mask, "prediction-mask", sampleId, issues, false);
      if (candidate?.mask?.encoding !== SEGMENTATION_PALETTE_ID) {
        addIssue(issues, "error", "prediction-mask-encoding-unsupported",
          "Candidate masks must use " + SEGMENTATION_PALETTE_ID + ".", sampleId);
      }
      if (finiteInt(candidate?.mask?.width) && finiteInt(sample?.source?.width) &&
          (candidate.mask.width !== sample.source.width || candidate.mask.height !== sample.source.height)) {
        addIssue(issues, "error", "prediction-dimensions-mismatch",
          "Prediction dimensions must match the original source image pixel dimensions.", sampleId);
      }
    }
  }
  if (manifest.samples.length && !manifest.samples.some((sample) => sample?.split === "held-out-evaluation")) {
    addIssue(issues, "warning", "held-out-subset-missing", "A clearly held-out evaluation subset is required before comparing candidates.");
  }
  const status = issues.some((item) => item.level === "error") ? "failed" :
    issues.some((item) => item.level === "warning") ? "incomplete" : "ready-for-evaluation";
  return { status, issues, sampleCount: manifest.samples.length,
    heldOutSamples: manifest.samples.filter((sample) => sample?.split === "held-out-evaluation").length };
}

export function decodeSegmentationPalette(rgbPixels) {
  if (!(rgbPixels instanceof Uint8Array) && !Array.isArray(rgbPixels)) {
    throw new TypeError("rgbPixels must be a Uint8Array or array of RGB bytes.");
  }
  if (rgbPixels.length % 3 !== 0) throw new RangeError("RGB pixel buffer length must be divisible by three.");
  const labels = new Uint8Array(rgbPixels.length / 3);
  for (let i = 0, pixel = 0; i < rgbPixels.length; i += 3, pixel += 1) {
    const key = rgbPixels[i] + "," + rgbPixels[i + 1] + "," + rgbPixels[i + 2];
    const value = CLASS_BY_RGB.get(key);
    if (value === undefined) throw new TypeError("Label mask contains an unsupported palette colour at pixel " + pixel + ".");
    labels[pixel] = value;
  }
  return labels;
}

export function calculateSegmentationMetrics(referenceLabels, predictedLabels) {
  if ((!ArrayBuffer.isView(referenceLabels) && !Array.isArray(referenceLabels)) ||
      (!ArrayBuffer.isView(predictedLabels) && !Array.isArray(predictedLabels))) {
    throw new TypeError("referenceLabels and predictedLabels must be array-like.");
  }
  if (referenceLabels.length === 0 || referenceLabels.length !== predictedLabels.length) {
    throw new RangeError("reference/prediction label arrays must have the same non-zero length.");
  }
  const size = SEGMENTATION_CLASSES.length;
  const confusion = Array.from({ length: size }, () => Array(size).fill(0));
  for (let i = 0; i < referenceLabels.length; i += 1) {
    const reference = referenceLabels[i], predicted = predictedLabels[i];
    if (!Number.isInteger(reference) || reference < 0 || reference >= size ||
        !Number.isInteger(predicted) || predicted < 0 || predicted >= size) {
      throw new RangeError("Label IDs must be integers in the declared palette range.");
    }
    confusion[reference][predicted] += 1;
  }
  const perClass = SEGMENTATION_CLASSES.map((item) => {
    const tp = confusion[item.id][item.id];
    const support = confusion[item.id].reduce((sum, value) => sum + value, 0);
    const predicted = confusion.reduce((sum, row) => sum + row[item.id], 0);
    const fp = predicted - tp, fn = support - tp;
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const iou = tp + fp + fn ? tp / (tp + fp + fn) : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0
      ? 2 * precision * recall / (precision + recall) : precision === 0 && recall === 0 ? 0 : null;
    return { id: item.id, className: item.name, tp, fp, fn, support,
      precision: precision === null ? null : Number(precision.toFixed(6)),
      recall: recall === null ? null : Number(recall.toFixed(6)),
      iou: iou === null ? null : Number(iou.toFixed(6)),
      f1: f1 === null ? null : Number(f1.toFixed(6)) };
  });
  const present = perClass.filter((item) => item.id !== 0 && item.iou !== null);
  const macroForegroundIoU = present.length
    ? Number((present.reduce((sum, item) => sum + item.iou, 0) / present.length).toFixed(6)) : null;
  const total = referenceLabels.length;
  const correct = perClass.reduce((sum, item) => sum + item.tp, 0);
  return { pixels: total, accuracy: Number((correct / total).toFixed(6)), macroForegroundIoU, perClass, confusionMatrix: confusion };
}

export function buildSegmentationBenchmarkReport({ manifest, evaluatedSamples = [], generatedAt = new Date().toISOString() } = {}) {
  const validation = validateSegmentationBenchmarkManifest(manifest);
  const resultsByKey = new Map();
  const reportIssues = [...validation.issues];
  for (const result of evaluatedSamples) {
    const key = result.sampleId + "::" + result.providerId;
    if (resultsByKey.has(key)) addIssue(reportIssues, "error", "duplicate-evaluation-result", "Each sample/provider pair must be evaluated once.", result.sampleId);
    else resultsByKey.set(key, result);
  }
  const perImage = [];
  for (const sample of manifest?.samples ?? []) {
    for (const candidate of sample?.predictions ?? []) {
      const result = resultsByKey.get(sample.sampleId + "::" + candidate.providerId);
      if (!result) {
        addIssue(reportIssues, "warning", "candidate-result-not-evaluated",
          "Candidate output has no evaluation result; no score is inferred.", sample.sampleId);
        continue;
      }
      if (result.status !== "evaluated" || !result.metrics) {
        addIssue(reportIssues, "error", "candidate-result-invalid",
          result.detail ?? "Candidate evaluation failed integrity or decoding checks.", sample.sampleId);
      }
      perImage.push({ sampleId: sample.sampleId, captureGroupId: sample.captureGroupId,
        split: sample.split, providerId: candidate.providerId, modelVersion: candidate.modelVersion,
        status: result.status, sourceSha256: sample.source?.sha256 ?? null,
        groundTruthSha256: sample.groundTruthMask?.sha256 ?? null,
        predictionSha256: candidate.mask?.sha256 ?? null,
        ...(result.metrics ? { metrics: result.metrics } : {}),
        ...(result.detail ? { detail: result.detail } : {}) });
    }
  }
  const candidates = [...new Set((manifest?.samples ?? []).flatMap((sample) => (sample?.predictions ?? []).map((item) => item.providerId)))];
  const candidateSummaries = candidates.map((providerId) => {
    const images = perImage.filter((item) => item.providerId === providerId && item.status === "evaluated");
    const heldOut = images.filter((item) => item.split === "held-out-evaluation");
    const metricAverages = (selected) => {
      const values = selected.map((item) => item.metrics?.macroForegroundIoU).filter(Number.isFinite);
      return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)) : null;
    };
    return { providerId, evaluatedImageCount: images.length, heldOutImageCount: heldOut.length,
      meanPerImageMacroForegroundIoU: metricAverages(images), heldOutMeanMacroForegroundIoU: metricAverages(heldOut),
      recommendation: "manual-review-required",
      note: "Scores are descriptive; an approved threshold and human-reviewed held-out failures are required before selecting an automatic provider." };
  });
  const status = reportIssues.some((item) => item.level === "error") ? "benchmark-failed" :
    reportIssues.some((item) => item.level === "warning") || validation.status !== "ready-for-evaluation"
      ? "benchmark-incomplete" : "benchmark-review-required";
  return { schemaVersion: "1.0.0", engine: "building-segmentation-benchmark-v1",
    benchmarkId: manifest?.benchmarkId ?? null, generatedAt, status, acceptanceEligible: false,
    paletteId: SEGMENTATION_PALETTE_ID, classDefinitions: SEGMENTATION_CLASSES,
    splitPolicy: "captureGroupId must remain within exactly one split; held-out-evaluation is not used to tune candidate configuration.",
    counts: { samples: manifest?.samples?.length ?? 0, evaluatedPairs: perImage.filter((item) => item.status === "evaluated").length,
      errors: reportIssues.filter((item) => item.level === "error").length,
      warnings: reportIssues.filter((item) => item.level === "warning").length },
    candidateSummaries, perImage, issues: reportIssues,
    limitations: [
      "No segmentation model is trained or downloaded by this benchmark.",
      "Palette-labelled masks are only ground truth when their annotation provenance and permission records are genuine and independently reviewed.",
      "Image hashes establish byte identity, not building identity, license truth or annotation correctness.",
      "Macro IoU/precision/recall are segmentation diagnostics; they do not prove 3D architecture, hidden facade geometry or dimensions.",
      "No automatic model is selected, and acceptanceEligible remains false until thresholds are approved and held-out results receive human review."
    ] };
}

export function sha256Bytes(bytes) {
  return digest(bytes);
}
