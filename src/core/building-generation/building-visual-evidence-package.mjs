import { createHash } from "node:crypto";
import {
  validateBuildingMaskArtifact,
} from "./building-mask-provider.mjs";
import {
  normalizeArchitecturalObservationBatch,
} from "./architectural-observation-schema.mjs";
import {
  evaluateArchitecturalFeatureProposals,
  proposeArchitecturalFeatures,
} from "./architectural-feature-proposals.mjs";
import {
  assessSourceCameraForRender,
  finalizeSourceCameraRenderManifest,
} from "./source-camera-render.mjs";
import { validateSegmentationBenchmarkManifest } from "./building-segmentation-benchmark.mjs";

const HASH = /^[a-f0-9]{64}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MASK_ROLES = new Set([
  "vegetation", "vehicle", "wire-pole", "person", "nearby-structure", "shadow", "other-occluder", "uncertain",
]);
const MAX_ANALYSIS_PIXELS = 8_000_000;
const MAX_OVERLAY_RUNS = 50_000;
const MAX_CONTOUR_SAMPLES = 2_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isPositiveInt = (value) => Number.isSafeInteger(value) && value > 0;
const hasHash = (value) => typeof value === "string" && HASH.test(value);
const asBytes = (value) => Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : null;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function stableJson(value) {
  return JSON.stringify(stableValue(value));
}
function finitePixelPlane(mask, label) {
  if (!isRecord(mask) || !isPositiveInt(mask.width) || !isPositiveInt(mask.height) ||
      mask.width * mask.height > MAX_ANALYSIS_PIXELS ||
      !(mask.pixels instanceof Uint8Array || Array.isArray(mask.pixels)) ||
      mask.pixels.length !== mask.width * mask.height) {
    throw new TypeError(label + " must contain one pixel byte per bounded image pixel.");
  }
  let foreground = 0;
  for (let index = 0; index < mask.pixels.length; index += 1) {
    const value = mask.pixels[index];
    if (value !== 0 && value !== 255) throw new TypeError(label + " contains a non-binary pixel at index " + index + ".");
    if (value === 255) foreground += 1;
  }
  return { pixels: mask.pixels, width: mask.width, height: mask.height, foreground };
}
function validateImageMimeType(value) {
  return ["image/png", "image/jpeg", "image/webp"].includes(value);
}

/**
 * Make a deterministic visual review overlay. It embeds the original source bytes and
 * draws bounded horizontal spans from a binary mask; it does not attest that the pixels
 * or mask labels are correct.
 */
export function buildBinaryMaskReviewOverlaySvg({
  sourceBytes, sourceMimeType, sourceSha256, sourceWidth, sourceHeight,
  maskBytes, maskSha256, maskPixels, maskWidth, maskHeight, role = "building",
  maxRuns = MAX_OVERLAY_RUNS,
} = {}) {
  const imageBytes = asBytes(sourceBytes);
  const encodedMask = asBytes(maskBytes);
  if (!imageBytes || !encodedMask) throw new TypeError("Source image bytes and encoded mask bytes are required.");
  if (!validateImageMimeType(sourceMimeType)) throw new TypeError("Only PNG, JPEG and WebP source images can be embedded.");
  if (!hasHash(sourceSha256) || digest(imageBytes) !== sourceSha256.toLowerCase()) {
    throw new TypeError("Source image bytes do not match the declared SHA-256.");
  }
  if (!hasHash(maskSha256) || digest(encodedMask) !== maskSha256.toLowerCase()) {
    throw new TypeError("Encoded mask bytes do not match the declared SHA-256.");
  }
  if (!isPositiveInt(sourceWidth) || !isPositiveInt(sourceHeight) ||
      sourceWidth * sourceHeight > MAX_ANALYSIS_PIXELS) {
    throw new RangeError("Source image dimensions are invalid or exceed the bounded overlay limit.");
  }
  const mask = finitePixelPlane({ width: maskWidth, height: maskHeight, pixels: maskPixels }, "Mask");
  if (mask.width !== sourceWidth || mask.height !== sourceHeight) {
    throw new RangeError("Mask dimensions must exactly match the original source image.");
  }
  if (!SAFE_ID.test(role)) throw new TypeError("Mask role must be a safe identifier.");
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_OVERLAY_RUNS) {
    throw new RangeError("maxRuns must be an integer between 1 and " + MAX_OVERLAY_RUNS + ".");
  }

  const spans = [];
  for (let y = 0; y < mask.height; y += 1) {
    const row = y * mask.width;
    let x = 0;
    while (x < mask.width) {
      while (x < mask.width && mask.pixels[row + x] === 0) x += 1;
      const start = x;
      while (x < mask.width && mask.pixels[row + x] === 255) x += 1;
      if (x > start) {
        spans.push('<rect x="' + start + '" y="' + y + '" width="' + (x - start) +
          '" height="1" fill="#ff3b30" fill-opacity="0.35"/>');
        if (spans.length > maxRuns) {
          throw new RangeError("Mask overlay exceeds the bounded horizontal-span limit; review or simplify the mask.");
        }
      }
    }
  }
  const dataUrl = "data:" + sourceMimeType + ";base64," + imageBytes.toString("base64");
  const label = role.replace(/[^a-z0-9._-]/gi, "-");
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + mask.width + '" height="' + mask.height +
    '" viewBox="0 0 ' + mask.width + " " + mask.height + '" role="img" aria-label="' + label +
    ' mask review overlay"><title>Source-bound ' + label + ' mask; SHA-256 ' + maskSha256.slice(0, 12) +
    '</title><image href="' + dataUrl + '" width="' + mask.width + '" height="' + mask.height +
    '" preserveAspectRatio="none"/><g id="mask-spans">' + spans.join("") + '</g></svg>';
}

function boundaryPoints(mask) {
  const points = [];
  const { width, height, pixels } = mask;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      if (pixels[index] !== 255) continue;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
          pixels[index - 1] === 0 || pixels[index + 1] === 0 ||
          pixels[index - width] === 0 || pixels[index + width] === 0) {
        points.push([x, y]);
      }
    }
  }
  return points;
}
function samplePoints(points, limit) {
  if (points.length <= limit) return points;
  const selected = [];
  const stride = points.length / limit;
  for (let index = 0; index < limit; index += 1) selected.push(points[Math.floor(index * stride)]);
  return selected;
}
function directedNearestDistances(left, right) {
  const distances = [];
  for (const [x, y] of left) {
    let best = Infinity;
    for (const [otherX, otherY] of right) {
      const distance = Math.hypot(x - otherX, y - otherY);
      if (distance < best) best = distance;
      if (best === 0) break;
    }
    distances.push(best);
  }
  return distances;
}
function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

/**
 * Compare an independently reviewed source-image silhouette mask with a mask extracted
 * from the exact source-camera PNG. Metrics are diagnostics only; this function never
 * determines architectural accuracy or publication eligibility.
 */
export function calculateBinarySilhouetteMetrics({
  sourceImageSha256, sourceImageSize, referenceMask, candidateMask,
} = {}) {
  const incomplete = (reason) => ({ status: "incomplete", reason, metrics: null, acceptanceEligible: false });
  if (!hasHash(sourceImageSha256) || !isPositiveInt(sourceImageSize?.width) ||
      !isPositiveInt(sourceImageSize?.height)) return incomplete("source-image-identity-or-dimensions-missing");
  if (!isRecord(referenceMask) || referenceMask.review?.status !== "reviewed" ||
      referenceMask.review?.independentlyReviewed !== true ||
      !SAFE_ID.test(referenceMask.review?.annotationId ?? "") ||
      typeof referenceMask.review?.reviewerId !== "string" || !referenceMask.review.reviewerId.trim() ||
      !Number.isFinite(Date.parse(referenceMask.review?.reviewedAt ?? ""))) {
    return incomplete("independently-reviewed-reference-mask-missing");
  }
  if (referenceMask.sourceImageSha256?.toLowerCase() !== sourceImageSha256.toLowerCase()) {
    return incomplete("reference-mask-source-image-hash-mismatch");
  }
  if (!isRecord(candidateMask) ||
      candidateMask.sourceImageSha256?.toLowerCase() !== sourceImageSha256.toLowerCase() ||
      !hasHash(candidateMask.sourceCameraRenderSha256) ||
      !SAFE_ID.test(candidateMask.extractionVersion ?? "")) {
    return incomplete("render-silhouette-provenance-missing");
  }
  const referenceBytes = asBytes(referenceMask.encodedBytes);
  const candidateBytes = asBytes(candidateMask.encodedBytes);
  if (!referenceBytes || !candidateBytes || !hasHash(referenceMask.sha256) || !hasHash(candidateMask.sha256) ||
      digest(referenceBytes) !== referenceMask.sha256.toLowerCase() ||
      digest(candidateBytes) !== candidateMask.sha256.toLowerCase()) {
    return incomplete("silhouette-mask-encoded-byte-hash-mismatch");
  }
  let reference, candidate;
  try {
    reference = finitePixelPlane(referenceMask, "Reference mask");
    candidate = finitePixelPlane(candidateMask, "Candidate mask");
  } catch (error) {
    return incomplete("silhouette-mask-invalid:" + error.message);
  }
  if (reference.width !== sourceImageSize.width || reference.height !== sourceImageSize.height ||
      candidate.width !== sourceImageSize.width || candidate.height !== sourceImageSize.height) {
    return incomplete("silhouette-mask-dimensions-mismatch");
  }
  if (reference.foreground === 0) return incomplete("reference-silhouette-has-no-building-foreground");
  if (candidate.foreground === 0) return incomplete("candidate-silhouette-has-no-building-foreground");

  let truePositive = 0, falsePositive = 0, falseNegative = 0;
  for (let index = 0; index < reference.pixels.length; index += 1) {
    const truth = reference.pixels[index] === 255;
    const prediction = candidate.pixels[index] === 255;
    if (truth && prediction) truePositive += 1;
    else if (prediction) falsePositive += 1;
    else if (truth) falseNegative += 1;
  }
  const union = truePositive + falsePositive + falseNegative;
  const referenceContour = samplePoints(boundaryPoints(reference), MAX_CONTOUR_SAMPLES);
  const candidateContour = samplePoints(boundaryPoints(candidate), MAX_CONTOUR_SAMPLES);
  if (!referenceContour.length || !candidateContour.length) return incomplete("silhouette-contour-is-empty");
  const leftDistances = directedNearestDistances(referenceContour, candidateContour);
  const rightDistances = directedNearestDistances(candidateContour, referenceContour);
  const symmetricDistances = leftDistances.concat(rightDistances);
  const mean = symmetricDistances.reduce((sum, value) => sum + value, 0) / symmetricDistances.length;
  return {
    status: "evaluated",
    sourceImageSha256: sourceImageSha256.toLowerCase(),
    sourceImageSize: { ...sourceImageSize },
    referenceMaskSha256: referenceMask.sha256.toLowerCase(),
    candidateMaskSha256: candidateMask.sha256.toLowerCase(),
    referenceReview: {
      annotationId: referenceMask.review.annotationId,
      reviewerId: referenceMask.review.reviewerId,
      reviewedAt: new Date(referenceMask.review.reviewedAt).toISOString(),
      independentReviewAttested: true,
    },
    contourMethod: "four-neighbour-boundary; deterministically-sampled-symmetric-euclidean-nearest-distance-v1",
    metrics: {
      truePositivePixels: truePositive,
      falsePositivePixels: falsePositive,
      falseNegativePixels: falseNegative,
      referenceForegroundPixels: reference.foreground,
      candidateForegroundPixels: candidate.foreground,
      intersectionOverUnion: Number((truePositive / union).toFixed(6)),
      precision: Number((truePositive / (truePositive + falsePositive)).toFixed(6)),
      recall: Number((truePositive / (truePositive + falseNegative)).toFixed(6)),
      f1: Number((2 * truePositive / (2 * truePositive + falsePositive + falseNegative)).toFixed(6)),
      symmetricMeanContourDistancePx: Number(mean.toFixed(4)),
      symmetricP95ContourDistancePx: Number(percentile(symmetricDistances, 0.95).toFixed(4)),
      referenceContourSamples: referenceContour.length,
      candidateContourSamples: candidateContour.length,
    },
    notes: [
      "Scores are computed only for the exact source image and hash-linked masks supplied here.",
      "Pixel metrics do not validate camera calibration truth, hidden facades, physical dimensions, materials or full 3D geometry.",
      "The independent-review flag is an evidence attestation; this function cannot verify reviewer identity or legal rights.",
    ],
    acceptanceEligible: false,
  };
}

function validateGlbBytes(value) {
  const bytes = asBytes(value);
  if (!bytes || bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF" ||
      bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    return { valid: false, bytes, sha256: bytes ? digest(bytes) : null, reason: "glb-container-magic-version-or-length-invalid" };
  }
  return { valid: true, bytes, sha256: digest(bytes), reason: null };
}
function summarizeMaskReport(role, result, encodedBytes, overlay) {
  return {
    role,
    status: result?.status ?? "missing",
    valid: result?.valid === true,
    validForFeatureExtraction: result?.validForFeatureExtraction === true,
    providerId: result?.providerId ?? null,
    confidence: result?.confidence ?? null,
    encodedSha256: encodedBytes ? digest(encodedBytes) : null,
    errors: result?.errors ?? [],
    warnings: result?.warnings ?? [],
    overlaySha256: overlay ? digest(Buffer.from(overlay, "utf8")) : null,
  };
}

/**
 * Integrate the existing mask, annotation, feature-proposal and source-camera contracts
 * into one deterministic evidence graph. Missing real-world truth remains INCOMPLETE;
 * synthetic fixtures cannot turn this report into an accepted building-accuracy result.
 */
export function buildBuildingVisualEvidencePackage(input = {}) {
  const errors = [];
  const warnings = [];
  const stages = {};
  const source = input.source;
  const sourceBytes = asBytes(input.sourceBytes);
  let sourceSha256 = null;
  let sourceReady = false;

  if (!isRecord(source) || !SAFE_ID.test(source.id ?? "") || !SAFE_ID.test(source.sourceId ?? "") ||
      !isPositiveInt(source.width) || !isPositiveInt(source.height) ||
      source.width * source.height > MAX_ANALYSIS_PIXELS || !isPositiveInt(source.decodedWidth) ||
      !isPositiveInt(source.decodedHeight) || source.decodedWidth !== source.width ||
      source.decodedHeight !== source.height || !validateImageMimeType(source.mimeType)) {
    errors.push({ stage: "source", code: "source-metadata-or-decoded-dimensions-invalid" });
  } else if (!sourceBytes) {
    errors.push({ stage: "source", code: "source-image-bytes-missing" });
  } else {
    sourceSha256 = digest(sourceBytes);
    if (!hasHash(source.sha256) || source.sha256.toLowerCase() !== sourceSha256) {
      errors.push({ stage: "source", code: "source-image-sha256-mismatch" });
    } else {
      sourceReady = true;
    }
  }
  const sourceIdentity = sourceReady ? {
    id: source.id, sourceId: source.sourceId, sha256: sourceSha256,
    width: source.width, height: source.height, mimeType: source.mimeType,
  } : null;
  stages.source = { status: sourceReady ? "verified-bytes-and-dimensions" : "failed", sha256: sourceSha256 };

  const model = validateGlbBytes(input.model?.glbBytes);
  if (!model.valid) errors.push({ stage: "model", code: model.reason });
  if (input.model?.sha256 && model.sha256 && input.model.sha256.toLowerCase() !== model.sha256) {
    errors.push({ stage: "model", code: "declared-glb-sha256-mismatch" });
  }
  stages.model = { status: model.valid && !errors.some((item) => item.stage === "model") ? "container-header-valid" : "failed",
    sha256: model.sha256, bytes: model.bytes?.length ?? null,
    limitations: ["The GLB header check is not a replacement for the repository geometry/topology/texture QA suites."] };

  const providedMasks = [];
  if (input.buildingMask) providedMasks.push({ role: "building", ...input.buildingMask });
  for (const item of Array.isArray(input.occluderMasks) ? input.occluderMasks : []) {
    providedMasks.push(item && typeof item === "object" ? item : { role: "invalid", result: null });
  }
  const seenRoles = new Set();
  const maskReports = [];
  const overlays = {};
  const maskSource = sourceReady ? {
    sourceId: source.sourceId, sha256: sourceSha256, width: source.width, height: source.height,
  } : null;

  if (!providedMasks.some((item) => item.role === "building")) {
    errors.push({ stage: "mask", code: "building-mask-missing" });
  }
  for (const item of providedMasks) {
    const role = item.role;
    const bytes = asBytes(item.encodedBytes);
    if (role !== "building" && !MASK_ROLES.has(role)) {
      errors.push({ stage: "mask", code: "mask-role-unsupported:" + String(role) });
      continue;
    }
    if (seenRoles.has(role)) {
      errors.push({ stage: "mask", code: "duplicate-mask-role:" + role });
      continue;
    }
    seenRoles.add(role);
    if (!sourceReady || !maskSource) {
      maskReports.push({ role, status: "blocked-source-invalid", valid: false, validForFeatureExtraction: false, errors: [] });
      continue;
    }
    const report = validateBuildingMaskArtifact({
      source: maskSource, result: item.result, actualMaskSha256: bytes ? digest(bytes) : null,
      actualMaskBytes: bytes?.length ?? null, decodedMask: item.decodedMask,
    });
    let overlay = null;
    if (report.valid && bytes && sourceBytes && item.decodedMask?.pixels) {
      try {
        overlay = buildBinaryMaskReviewOverlaySvg({
          sourceBytes, sourceMimeType: source.mimeType, sourceSha256, sourceWidth: source.width, sourceHeight: source.height,
          maskBytes: bytes, maskSha256: digest(bytes), maskPixels: item.decodedMask.pixels,
          maskWidth: item.decodedMask.width, maskHeight: item.decodedMask.height, role,
        });
        overlays[role] = overlay;
      } catch (error) {
        warnings.push({ stage: "mask", code: "overlay-generation-failed:" + role, detail: error.message });
      }
    }
    maskReports.push(summarizeMaskReport(role, report, bytes, overlay));
    for (const error of report.errors ?? []) errors.push({ stage: "mask", code: role + ":" + error.code });
    for (const warning of report.warnings ?? []) warnings.push({ stage: "mask", code: role + ":" + warning.code });
  }
  const buildingMaskInput = providedMasks.find((item) => item.role === "building");
  const buildingMaskReport = maskReports.find((item) => item.role === "building");
  const buildingMaskReady = buildingMaskReport?.validForFeatureExtraction === true;
  if (!providedMasks.some((item) => item.role !== "building")) {
    warnings.push({ stage: "mask", code: "occluder-mask-set-missing",
      detail: "No explicit occluder masks were supplied; blocked and uncertain facade regions must not be inferred as observed." });
  }
  stages.masks = {
    status: errors.some((item) => item.stage === "mask") ? "failed" :
      buildingMaskReady ? "reviewed-building-mask-ready" : "incomplete",
    roles: maskReports,
    overlays: Object.fromEntries(Object.entries(overlays).map(([role, svg]) => [role, {
      mimeType: "image/svg+xml", sha256: digest(Buffer.from(svg, "utf8")), bytes: Buffer.byteLength(svg, "utf8"),
    }])),
    publicationEligible: false,
  };

  let proposalReport = null;
  if (sourceReady && buildingMaskReady && buildingMaskInput && input.edgeMap) {
    const edgeMap = input.edgeMap;
    const edgeBytes = asBytes(edgeMap.encodedBytes);
    const validEdgeSource = edgeMap.sourceImageSha256?.toLowerCase() === sourceSha256 &&
      edgeMap.width === source.width && edgeMap.height === source.height &&
      hasHash(edgeMap.sha256) && (!edgeBytes || digest(edgeBytes) === edgeMap.sha256.toLowerCase());
    if (!validEdgeSource) {
      errors.push({ stage: "features", code: "edge-map-source-or-byte-binding-invalid" });
    } else {
      try {
        proposalReport = proposeArchitecturalFeatures({
          buildingId: input.buildingId, viewId: input.viewId,
          generatedAt: input.generatedAt ?? new Date().toISOString(),
          source: { id: source.id, sha256: sourceSha256, width: source.width, height: source.height },
          mask: {
            sha256: digest(asBytes(buildingMaskInput.encodedBytes)),
            width: buildingMaskInput.decodedMask.width, height: buildingMaskInput.decodedMask.height,
            pixels: buildingMaskInput.decodedMask.pixels,
          },
          edgeMap: { sha256: edgeMap.sha256, width: edgeMap.width, height: edgeMap.height, pixels: edgeMap.pixels },
          options: input.featureOptions ?? {},
        });
      } catch (error) {
        errors.push({ stage: "features", code: "feature-proposal-failed", detail: error.message });
      }
    }
  } else {
    warnings.push({ stage: "features", code: "feature-proposals-blocked-or-incomplete",
      detail: "Feature proposals need a source-bound, explicitly reviewed building mask and same-resolution source-bound edge map." });
  }

  let reviewedBatch = null;
  if (input.reviewedAnnotationsBatch) {
    try {
      reviewedBatch = normalizeArchitecturalObservationBatch(input.reviewedAnnotationsBatch);
      if (!sourceReady || reviewedBatch.source.sha256.toLowerCase() !== sourceSha256 ||
          reviewedBatch.source.width !== source.width || reviewedBatch.source.height !== source.height ||
          reviewedBatch.viewId !== input.viewId || reviewedBatch.buildingId !== input.buildingId ||
          (buildingMaskInput && reviewedBatch.mask?.sha256?.toLowerCase() !==
            digest(asBytes(buildingMaskInput.encodedBytes)))) {
        throw new TypeError("Reviewed annotations do not bind to this exact source, view, building and building-mask hash.");
      }
    } catch (error) {
      errors.push({ stage: "features", code: "reviewed-annotation-batch-invalid", detail: error.message });
      reviewedBatch = null;
    }
  } else {
    warnings.push({ stage: "features", code: "independently-reviewed-feature-annotations-missing" });
  }
  let featureMetrics = null;
  if (proposalReport && reviewedBatch) {
    featureMetrics = evaluateArchitecturalFeatureProposals({
      predicted: proposalReport.observations, reviewed: reviewedBatch.observations,
      sourceSha256, viewId: input.viewId,
    });
  }
  const reviewedFeatureCount = reviewedBatch?.observations.filter((item) => item.status === "reviewed").length ?? 0;
  stages.features = {
    status: errors.some((item) => item.stage === "features") ? "failed" :
      featureMetrics?.status === "review-required" && reviewedFeatureCount > 0 ? "reviewed-reference-metrics-available" :
      proposalReport ? "proposal-review-required" : "incomplete",
    proposalStatus: proposalReport?.status ?? "not-generated",
    proposalCount: proposalReport?.observations?.length ?? 0,
    reviewedAnnotationCount: reviewedFeatureCount,
    metrics: featureMetrics,
    proposalsAreGroundTruth: false,
    publicationEligible: false,
  };

  let cameraAssessment = null;
  let sourceCameraRenderManifest = null;
  let renderSha256 = null;
  const cameraInput = input.camera;
  if (sourceReady && model.valid && isRecord(cameraInput)) {
    const cameraBytes = asBytes(cameraInput.manifestBytes);
    const calibrationBytes = asBytes(cameraInput.calibrationEvidenceBytes);
    const alignmentBytes = asBytes(cameraInput.frameAlignmentEvidenceBytes);
    let cameraManifest = null;
    try {
      if (!cameraBytes) throw new TypeError("Camera manifest bytes are missing.");
      cameraManifest = JSON.parse(cameraBytes.toString("utf8"));
      if (!isRecord(cameraManifest)) throw new TypeError("Camera manifest must decode to an object.");
    } catch (error) {
      errors.push({ stage: "camera", code: "camera-manifest-invalid", detail: error.message });
    }
    if (cameraManifest) {
      cameraAssessment = assessSourceCameraForRender({
        camera: cameraManifest,
        sourceImageSha256: sourceSha256,
        sourceImageSize: { width: source.width, height: source.height },
        cameraManifestSha256: digest(cameraBytes),
        calibrationEvidenceSha256: calibrationBytes ? digest(calibrationBytes) : null,
        frameAlignmentEvidenceSha256: alignmentBytes ? digest(alignmentBytes) : null,
        modelSha256: model.sha256,
        maxControlPointErrorPixels: input.maxControlPointErrorPixels ?? 3,
      });
      if (cameraAssessment.status !== "same-camera-comparable") {
        warnings.push({ stage: "camera", code: "source-camera-not-comparable",
          detail: cameraAssessment.errors.join(",") });
      }
      const renderInput = input.sourceCameraRender;
      if (cameraAssessment.sameCameraComparable && renderInput) {
        const renderBytes = asBytes(renderInput.bytes);
        if (renderBytes) renderSha256 = digest(renderBytes);
        if (renderBytes && renderInput.sha256 && renderInput.sha256.toLowerCase() !== renderSha256) {
          errors.push({ stage: "render", code: "source-camera-render-sha256-mismatch" });
        }
        if (renderBytes && renderBytes.length >= 8 && !renderBytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
          errors.push({ stage: "render", code: "source-camera-render-not-png" });
        }
        sourceCameraRenderManifest = finalizeSourceCameraRenderManifest({
          assessment: cameraAssessment,
          renderFile: renderBytes ? {
            filename: "source-camera.png", width: renderInput.width, height: renderInput.height,
            bytes: renderBytes.length, sha256: renderSha256, pixelStatistics: renderInput.pixelStatistics,
          } : null,
        });
        if (!sourceCameraRenderManifest.sameCameraComparable) {
          warnings.push({ stage: "render", code: "source-camera-render-incomplete",
            detail: sourceCameraRenderManifest.errors.join(",") });
        }
      } else if (renderInput) {
        sourceCameraRenderManifest = finalizeSourceCameraRenderManifest({
          assessment: cameraAssessment,
          renderFile: { filename: "source-camera.png", width: renderInput.width, height: renderInput.height,
            bytes: asBytes(renderInput.bytes)?.length ?? 0, sha256: asBytes(renderInput.bytes) ? digest(asBytes(renderInput.bytes)) : null,
            pixelStatistics: renderInput.pixelStatistics },
        });
      } else {
        warnings.push({ stage: "render", code: "source-camera-render-missing" });
      }
    }
  } else {
    warnings.push({ stage: "camera", code: "source-camera-assessment-inputs-missing" });
  }
  stages.sourceCamera = {
    status: cameraAssessment?.sameCameraComparable ? "same-camera-comparable" :
      cameraAssessment ? "not-comparable" : "incomplete",
    assessment: cameraAssessment,
    render: sourceCameraRenderManifest,
    publicationEligible: false,
  };

  let silhouetteMetrics = null;
  const referenceSilhouette = input.referenceSilhouette;
  const candidateSilhouette = input.sourceCameraRender?.silhouetteMask ?? null;
  if (sourceReady && sourceCameraRenderManifest?.sameCameraComparable &&
      candidateSilhouette && referenceSilhouette) {
    silhouetteMetrics = calculateBinarySilhouetteMetrics({
      sourceImageSha256: sourceSha256,
      sourceImageSize: { width: source.width, height: source.height },
      referenceMask: referenceSilhouette,
      candidateMask: candidateSilhouette,
    });
  } else {
    silhouetteMetrics = { status: "incomplete", reason: "comparable-source-camera-render-or-reviewed-silhouette-missing",
      metrics: null, acceptanceEligible: false };
  }
  stages.silhouetteMetrics = silhouetteMetrics;

  const benchmark = input.realBuildingBenchmark;
  let realBenchmarkStatus = "incomplete";
  if (isRecord(benchmark)) {
    try {
      const manifestBytes = asBytes(benchmark.manifestBytes);
      const reportBytes = asBytes(benchmark.reportBytes);
      if (!manifestBytes || !reportBytes) throw new TypeError("Exact benchmark manifest and report bytes are required.");
      const parsedManifest = JSON.parse(manifestBytes.toString("utf8"));
      const parsedReport = JSON.parse(reportBytes.toString("utf8"));
      const manifestValidation = validateSegmentationBenchmarkManifest(parsedManifest);
      const reportBytesMatchObject = stableJson(parsedReport) === stableJson(benchmark.report);
      const reportHeldOut = benchmark.report?.perImage?.filter((item) =>
        item.split === "held-out-evaluation" && item.status === "evaluated" &&
        hasHash(item.sourceSha256) && hasHash(item.groundTruthSha256) && hasHash(item.predictionSha256)) ?? [];
      const summaryHasHeldOut = benchmark.report?.candidateSummaries?.some((item) =>
        isPositiveInt(item.heldOutImageCount) && isFiniteNumber(item.heldOutMeanMacroForegroundIoU)) ?? false;
      const hashesMatch = hasHash(benchmark.manifestSha256) && digest(manifestBytes) === benchmark.manifestSha256.toLowerCase() &&
        hasHash(benchmark.reportSha256) && digest(reportBytes) === benchmark.reportSha256.toLowerCase();
      if (manifestValidation.status === "ready-for-evaluation" && reportBytesMatchObject && hashesMatch &&
          benchmark.report?.engine === "building-segmentation-benchmark-v1" &&
          benchmark.report.status === "benchmark-review-required" &&
          isPositiveInt(benchmark.report.counts?.evaluatedPairs) && reportHeldOut.length > 0 && summaryHasHeldOut &&
          benchmark.rightsReviewStatus === "verified" &&
          benchmark.independentAnnotationReviewStatus === "verified" &&
          benchmark.report.benchmarkId === parsedManifest.benchmarkId) {
        realBenchmarkStatus = "held-out-report-present-review-required";
      } else {
        warnings.push({ stage: "real-world-validation", code: "real-held-out-benchmark-validation-incomplete",
          detail: "Benchmark manifest/report hashes, reviewed real masks, held-out rows, class metrics and review attestations did not all satisfy the evidence gate." });
      }
    } catch (error) {
      warnings.push({ stage: "real-world-validation", code: "real-held-out-benchmark-invalid", detail: error.message });
    }
  } else {
    warnings.push({ stage: "real-world-validation", code: "licensed-hash-pinned-real-held-out-benchmark-missing-or-incomplete",
      detail: "Synthetic tests and caller-supplied status strings cannot substitute for a verified real-building dataset, held-out metrics and independently reviewed overlays." });
  }
  stages.realWorldValidation = {
    status: realBenchmarkStatus,
    datasetTier: input.datasetTier ?? "unknown",
    rightsReviewStatus: benchmark?.rightsReviewStatus ?? "missing",
    independentAnnotationReviewStatus: benchmark?.independentAnnotationReviewStatus ?? "missing",
    limitations: [
      "The package validates supplied hashes and schemas; it cannot independently establish photo licensing, building identity or annotation truth.",
      "A held-out segmentation report is not a metric-geometry survey and cannot validate hidden facade geometry.",
      "A real-building claim remains open until a human inspects source/mask overlays and source-camera renders and documents the decision.",
    ],
  };

  const sourceRights = source?.rights;
  const sourceRightsBytes = asBytes(sourceRights?.evidenceBytes);
  const sourceRightsReady = sourceRights?.status === "verified" && sourceRightsBytes &&
    hasHash(sourceRights.evidenceSha256) && digest(sourceRightsBytes) === sourceRights.evidenceSha256.toLowerCase() &&
    typeof sourceRights.evidenceId === "string" && sourceRights.evidenceId.trim().length > 0 &&
    typeof sourceRights.reviewerId === "string" && sourceRights.reviewerId.trim().length > 0 &&
    Number.isFinite(Date.parse(sourceRights.reviewedAt ?? ""));
  if (!sourceRightsReady) warnings.push({ stage: "rights", code: "source-image-rights-evidence-not-verified" });
  if (!Array.isArray(input.occluderMasks) || input.occluderMasks.length === 0) {
    warnings.push({ stage: "occlusion", code: "occluder-mask-coverage-missing" });
  }
  const realEvidenceComplete = input.datasetTier === "real-building" && sourceRightsReady &&
    buildingMaskReady && providedMasks.some((item) => item.role !== "building") &&
    sourceCameraRenderManifest?.sameCameraComparable === true &&
    silhouetteMetrics?.status === "evaluated" && reviewedFeatureCount > 0 &&
    realBenchmarkStatus === "held-out-report-present-review-required";
  let status = "incomplete";
  if (errors.length > 0 || stages.model.status === "failed" || stages.source.status === "failed") status = "failed";
  else if (cameraAssessment && !cameraAssessment.sameCameraComparable) status = "not-comparable";
  else if (realEvidenceComplete) status = "review-required";

  const manifest = {
    schemaVersion: "1.0.0",
    engine: "building-visual-evidence-package-v1",
    buildingId: input.buildingId ?? null,
    viewId: input.viewId ?? null,
    generatedAt: new Date(input.generatedAt ?? new Date().toISOString()).toISOString(),
    datasetTier: input.datasetTier ?? "unknown",
    status,
    stageStatuses: Object.fromEntries(Object.entries(stages).map(([key, value]) => [key, value.status ?? value.status])),
    source: sourceReady ? {
      id: source.id, sourceId: source.sourceId, sha256: sourceSha256,
      width: source.width, height: source.height, mimeType: source.mimeType,
      rightsStatus: sourceRightsReady ? "verified-attested" : sourceRights?.status ?? "missing",
      rightsEvidenceSha256: sourceRightsReady ? sourceRights.evidenceSha256.toLowerCase() : null,
    } : null,
    model: { sha256: model.sha256, bytes: model.bytes?.length ?? null, containerStatus: stages.model.status },
    masks: maskReports,
    maskOverlays: stages.masks?.overlays ?? {},
    features: {
      proposalStatus: proposalReport?.status ?? "not-generated",
      proposalCount: proposalReport?.observations?.length ?? 0,
      reviewedAnnotationCount: reviewedFeatureCount,
      reviewedBatchSha256: reviewedBatch ? digest(Buffer.from(stableJson(reviewedBatch), "utf8")) : null,
      metrics: featureMetrics,
    },
    sourceCamera: sourceCameraRenderManifest,
    silhouetteMetrics,
    realWorldValidation: stages.realWorldValidation,
    sourceRightsReady,
    errors,
    warnings,
    policy: {
      groundTruth: false,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      statusCanBePass: false,
    },
  };
  const evidenceGraphSha256 = digest(Buffer.from(stableJson(manifest), "utf8"));
  manifest.evidenceGraphSha256 = evidenceGraphSha256;
  return {
    schemaVersion: "1.0.0",
    status,
    manifest,
    evidenceGraphSha256,
    stages,
    artifacts: { maskOverlays: overlays },
    errors,
    warnings,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
  };
}
