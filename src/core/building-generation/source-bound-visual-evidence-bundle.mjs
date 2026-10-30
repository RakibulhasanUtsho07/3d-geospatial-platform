import { createHash } from "node:crypto";
import { normalizeArchitecturalObservationBatch } from "./architectural-observation-schema.mjs";

const HASH = /^[a-f0-9]{64}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const MAX_MASK_BYTES = 30 * 1024 * 1024;
const MAX_OBSERVATION_BYTES = 10 * 1024 * 1024;
const MASK_ENCODING = "binary-8bit-white-foreground-v1";
const MASK_COORDINATES = "pixel-origin-top-left";
const OBSERVATION_COORDINATES = "source-image-pixel-origin-top-left";

function bytes(value, label, maximum) {
  const result = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!result || result.length < 1 || result.length > maximum) {
    throw new TypeError(label + " bytes must be a non-empty byte array within the configured size limit.");
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value, label) {
  try {
    const parsed = JSON.parse(value.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new TypeError(label + " must contain a valid JSON object.");
  }
}

function safeTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(label + " must be a valid ISO timestamp.");
  }
  return new Date(value).toISOString();
}

function assertFalsePolicy(policy, fields, label) {
  if (!policy || typeof policy !== "object" || fields.some((field) => policy[field] !== false)) {
    throw new TypeError(label + " must explicitly keep " + fields.join(", ") + " false.");
  }
}

/**
 * Joins the independent manual mask and architectural-observation exports into one
 * immutable, hash-linked, per-view evidence manifest. Image decoders must supply
 * the dimensions they actually decoded; declared metadata alone is not trusted.
 *
 * This is an evidence-linking contract, not ground truth, metric geometry,
 * rights approval, reviewer authentication, publication approval or map readiness.
 */
export function buildSourceBoundVisualEvidenceBundle(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("bundle input must be an object.");
  }

  const sourceBytes = bytes(input.sourceBytes, "source image", MAX_SOURCE_BYTES);
  const maskBytes = bytes(input.maskBytes, "mask PNG", MAX_MASK_BYTES);
  const maskManifestBytes = bytes(input.maskManifestBytes, "mask manifest", MAX_OBSERVATION_BYTES);
  const observationBatchBytes = bytes(input.observationBatchBytes, "observation batch", MAX_OBSERVATION_BYTES);

  const sourceSha256 = sha256(sourceBytes);
  const maskSha256 = sha256(maskBytes);
  const maskManifestSha256 = sha256(maskManifestBytes);
  const observationFileSha256 = sha256(observationBatchBytes);
  const maskManifest = parseJson(maskManifestBytes, "mask manifest");
  const rawBatch = parseJson(observationBatchBytes, "observation batch");

  const source = maskManifest.source;
  const result = maskManifest.result;
  const mask = result?.mask;
  if (maskManifest.schemaVersion !== "1.0.0" ||
      maskManifest.artifactType !== "source-bound-manual-mask-review" ||
      !source || !result || result.schemaVersion !== "1.0.0" ||
      !SAFE_ID.test(source.sourceId ?? "") || !HASH.test(source.sha256 ?? "") ||
      !Number.isSafeInteger(source.bytes) || !Number.isSafeInteger(source.width) ||
      !Number.isSafeInteger(source.height) || source.width < 1 || source.height < 1) {
    throw new TypeError("mask manifest identity or source metadata is invalid.");
  }

  if (source.sha256.toLowerCase() !== sourceSha256 ||
      result.inputSha256?.toLowerCase() !== sourceSha256 ||
      result.sourceId !== source.sourceId || source.bytes !== sourceBytes.length) {
    throw new TypeError("mask manifest does not bind to the exact supplied source-image bytes.");
  }
  if (!Number.isSafeInteger(input.sourceDimensions?.width) ||
      !Number.isSafeInteger(input.sourceDimensions?.height) ||
      input.sourceDimensions.width !== source.width ||
      input.sourceDimensions.height !== source.height) {
    throw new TypeError("decoded source-image dimensions do not match the mask manifest.");
  }
  if (!mask || !HASH.test(mask.sha256 ?? "") || mask.sha256.toLowerCase() !== maskSha256 ||
      mask.bytes !== maskBytes.length || mask.width !== source.width || mask.height !== source.height ||
      mask.encoding !== MASK_ENCODING || mask.coordinateConvention !== MASK_COORDINATES ||
      mask.backgroundValue !== 0 || mask.foregroundValue !== 255) {
    throw new TypeError("mask PNG bytes, dimensions or encoding do not match the exact mask manifest.");
  }
  if (!Number.isSafeInteger(input.maskDimensions?.width) ||
      !Number.isSafeInteger(input.maskDimensions?.height) ||
      input.maskDimensions.width !== source.width || input.maskDimensions.height !== source.height) {
    throw new TypeError("decoded mask dimensions must exactly match the source image.");
  }
  if (rawBatch.coordinateConvention !== OBSERVATION_COORDINATES ||
      rawBatch.source?.id !== source.sourceId ||
      rawBatch.source?.sha256?.toLowerCase() !== sourceSha256 ||
      rawBatch.source?.width !== source.width || rawBatch.source?.height !== source.height) {
    throw new TypeError("architectural observations do not bind to the same source ID, bytes and dimensions.");
  }
  if (!SAFE_ID.test(rawBatch.buildingId ?? "") || !SAFE_ID.test(rawBatch.viewId ?? "")) {
    throw new TypeError("observation buildingId and viewId must be safe identifiers.");
  }
  if (rawBatch.mask && (rawBatch.mask.sha256?.toLowerCase() !== maskSha256 ||
      rawBatch.mask.width !== source.width || rawBatch.mask.height !== source.height)) {
    throw new TypeError("observation batch contains a conflicting mask reference.");
  }
  for (const observation of rawBatch.observations ?? []) {
    for (const candidate of [observation?.evidence, observation?.originalProposal?.evidence]) {
      if (candidate?.maskSha256 !== undefined && candidate.maskSha256 !== null &&
          candidate.maskSha256.toLowerCase() !== maskSha256) {
        throw new TypeError("an observation references a different mask SHA-256.");
      }
    }
  }

  assertFalsePolicy(rawBatch.policy, ["groundTruth", "publicationEligible", "publishable"], "observation input policy");
  const normalizedBatch = normalizeArchitecturalObservationBatch({
    ...rawBatch,
    mask: { sha256: maskSha256, width: source.width, height: source.height },
  });
  if (normalizedBatch.coordinateConvention !== OBSERVATION_COORDINATES) {
    throw new TypeError("normalized observation coordinate convention is invalid.");
  }

  assertFalsePolicy(maskManifest.policy,
    ["acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval", "publishable"],
    "mask manifest policy");
  assertFalsePolicy(normalizedBatch.policy,
    ["groundTruth", "publicationEligible"],
    "normalized observation batch policy");

  const assessment = result.assessment;
  if (!assessment || !["proposed", "reviewed"].includes(assessment.status) ||
      typeof assessment.humanReviewed !== "boolean" ||
      (assessment.status === "reviewed" && (!assessment.humanReviewed ||
        typeof assessment.reviewerId !== "string" || !assessment.reviewerId.trim() ||
        !Number.isFinite(Date.parse(assessment.reviewedAt ?? ""))) ) ||
      (assessment.status === "proposed" && assessment.humanReviewed)) {
    throw new TypeError("mask review assessment is inconsistent or invalid.");
  }

  const createdAt = safeTimestamp(input.createdAt ?? new Date().toISOString(), "bundle createdAt");
  const normalizedBatchBytes = Buffer.from(JSON.stringify(normalizedBatch, null, 2) + "\n", "utf8");
  const normalizedBatchSha256 = sha256(normalizedBatchBytes);
  const bundleId = "visual-evidence-" + sha256(Buffer.from([
    sourceSha256, maskSha256, normalizedBatchSha256, rawBatch.buildingId, rawBatch.viewId,
  ].join("\n"))).slice(0, 24);

  const bundle = {
    schemaVersion: "1.0.0",
    bundleType: "source-bound-visual-evidence",
    bundleId,
    createdAt,
    buildingId: normalizedBatch.buildingId,
    viewId: normalizedBatch.viewId,
    coordinateConvention: OBSERVATION_COORDINATES,
    source: {
      id: source.sourceId,
      sha256: sourceSha256,
      bytes: sourceBytes.length,
      mimeType: source.mimeType ?? input.sourceMimeType ?? null,
      width: source.width,
      height: source.height,
    },
    maskArtifact: {
      manifestSha256: maskManifestSha256,
      sha256: maskSha256,
      bytes: maskBytes.length,
      width: mask.width,
      height: mask.height,
      encoding: mask.encoding,
      coordinateConvention: mask.coordinateConvention,
      assessment: {
        status: assessment.status,
        humanReviewed: assessment.humanReviewed,
        ...(assessment.humanReviewed ? {
          reviewerId: assessment.reviewerId.trim(),
          reviewedAt: new Date(assessment.reviewedAt).toISOString(),
        } : {}),
      },
    },
    observationArtifact: {
      inputFileSha256: observationFileSha256,
      normalizedBatchSha256,
      batchId: normalizedBatch.batchId,
      observationCount: normalizedBatch.observations.length,
      batch: normalizedBatch,
    },
    evidenceLinks: {
      sourceImageSha256: sourceSha256,
      maskPngSha256: maskSha256,
      maskManifestSha256,
      observationInputSha256: observationFileSha256,
      normalizedObservationBatchSha256: normalizedBatchSha256,
      maskAndObservationsShareExactSource: true,
      observationsReferenceExactMask: true,
    },
    policy: {
      groundTruth: false,
      acceptanceEligible: false,
      publicationEligible: false,
      publishable: false,
      mapReady: false,
      automaticApproval: false,
      independentlyAuthenticatedReviewer: false,
    },
    limitations: [
      "This bundle links source bytes, a manually reviewed mask artifact and per-view architectural observations; it does not prove semantic correctness.",
      "Decoded dimensions are supplied by the caller's image decoder and must be obtained from the actual files, not copied from metadata.",
      "Reviewer identity and decisions remain operator-supplied attestations and are not independently authenticated.",
      "Source rights, building identity, camera calibration, metric dimensions, held-out accuracy and survey truth require separate evidence.",
      "A linked mask is not ground truth; unknown, occluded, not-visible and not-detected observations remain distinct.",
      "The bundle is review evidence only and cannot authorize publication or automatic map loading.",
    ],
  };

  return { bundle, normalizedBatchBytes, normalizedBatchSha256 };
}
