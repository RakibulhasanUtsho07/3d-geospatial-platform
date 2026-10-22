import { normalizeGeneratedModelDefinition } from "../map-engine/generated-model-policy.mjs";

export const PUBLISHED_MODEL_CATALOG_SCHEMA_VERSION = "1.0.0";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const VERSION_PATTERN = /^[a-f0-9]{16}$/;
const REQUIRED_REVIEW_CHECKS = [
  "rightsVerified",
  "sourceIdentityVerified",
  "architectureReviewed",
  "metricScaleVerified",
  "horizontalGeoreferenceVerified",
  "verticalDatumVerified",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isIsoDate(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function assertSafePublicEvidenceId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new TypeError(label + " must be a safe public evidence identifier.");
  }
}

function validateReview(review, label) {
  if (!isRecord(review)) throw new TypeError(label + ".review must be an object.");
  if (!nonEmptyString(review.reviewer) || review.reviewer.length > 200) {
    throw new TypeError(label + ".review.reviewer is required (max 200 characters).");
  }
  if (!isIsoDate(review.reviewedAt)) throw new TypeError(label + ".review.reviewedAt must be a valid timestamp.");
  assertSafePublicEvidenceId(review.evidenceId, label + ".review.evidenceId");
  if (!isHash(review.evidenceSha256)) throw new TypeError(label + ".review.evidenceSha256 must be a SHA-256 hash.");
  if (!isRecord(review.checks)) throw new TypeError(label + ".review.checks must be an object.");
  for (const check of REQUIRED_REVIEW_CHECKS) {
    if (review.checks[check] !== true) {
      throw new Error(label + ".review.checks." + check + " must be explicitly true before publication.");
    }
  }
  if (!nonEmptyString(review.notes) || review.notes.length > 4000) {
    throw new TypeError(label + ".review.notes is required (max 4000 characters).");
  }
}

function validateVersion(model, version, index) {
  const label = "models[" + index + "].versions";
  if (!isRecord(version)) throw new TypeError(label + " must contain objects.");
  if (typeof version.versionId !== "string" || !VERSION_PATTERN.test(version.versionId)) {
    throw new TypeError(label + ".versionId must be 16 lowercase hexadecimal characters.");
  }
  if (typeof version.url !== "string" ||
    !/^\/models\/generated\/[A-Za-z0-9._-]+\.glb$/.test(version.url) ||
    version.url.includes("..")) {
    throw new TypeError(label + ".url must target a versioned GLB under /models/generated/.");
  }
  if (!isHash(version.sha256)) throw new TypeError(label + ".sha256 must be a SHA-256 hash.");
  if (!Number.isSafeInteger(version.bytes) || version.bytes < 24) {
    throw new TypeError(label + ".bytes must be a valid GLB byte count.");
  }
  if (!isIsoDate(version.publishedAt)) throw new TypeError(label + ".publishedAt must be a valid timestamp.");
  validateReview(version.review, label);

  return normalizeGeneratedModelDefinition({
    id: model.id,
    name: model.name,
    url: version.url,
    position: version.position,
    headingDegrees: version.headingDegrees,
    pitchDegrees: version.pitchDegrees,
    rollDegrees: version.rollDegrees,
    scale: version.scale,
    upAxis: version.upAxis,
    forwardAxis: version.forwardAxis,
    minimumPixelSize: 0,
    show: true,
  });
}

/** Validate public, read-only catalog metadata before it can drive a map load. */
export function validatePublishedModelCatalog(raw) {
  if (!isRecord(raw)) throw new TypeError("Published model catalog must be an object.");
  if (raw.schemaVersion !== PUBLISHED_MODEL_CATALOG_SCHEMA_VERSION) {
    throw new TypeError("Unsupported published model catalog schemaVersion.");
  }
  if (!Array.isArray(raw.models) || raw.models.length > 5000) {
    throw new TypeError("Published model catalog models must be an array with at most 5000 entries.");
  }

  const modelIds = new Set();
  let totalVersions = 0;
  const models = raw.models.map((model, modelIndex) => {
    const label = "models[" + modelIndex + "]";
    if (!isRecord(model) || typeof model.id !== "string" || !ID_PATTERN.test(model.id)) {
      throw new TypeError(label + ".id is invalid.");
    }
    if (modelIds.has(model.id)) throw new Error("Duplicate published model id: " + model.id);
    modelIds.add(model.id);
    if (!nonEmptyString(model.name) || model.name.length > 200) {
      throw new TypeError(label + ".name is required (max 200 characters).");
    }
    if (!Array.isArray(model.versions) || model.versions.length < 1 || model.versions.length > 100) {
      throw new TypeError(label + ".versions must contain between 1 and 100 versions.");
    }
    if (typeof model.activeVersion !== "string" || !VERSION_PATTERN.test(model.activeVersion)) {
      throw new TypeError(label + ".activeVersion must point to a valid version id.");
    }

    const versionIds = new Set();
    const versions = model.versions.map((version) => {
      totalVersions += 1;
      if (totalVersions > 10000) throw new RangeError("Published model catalog contains too many versions.");
      if (!isRecord(version) || typeof version.versionId !== "string" || versionIds.has(version.versionId)) {
        throw new Error(label + " contains a duplicate or malformed version.");
      }
      versionIds.add(version.versionId);
      validateVersion(model, version, modelIndex);
      return version;
    });
    if (!versionIds.has(model.activeVersion)) {
      throw new Error(label + ".activeVersion does not identify an available version.");
    }
    return { id: model.id, name: model.name, activeVersion: model.activeVersion, versions };
  });

  return { schemaVersion: PUBLISHED_MODEL_CATALOG_SCHEMA_VERSION, models };
}

export function getActivePublishedModels(raw) {
  const catalog = validatePublishedModelCatalog(raw);
  return catalog.models.map((model) => {
    const version = model.versions.find((item) => item.versionId === model.activeVersion);
    const definition = normalizeGeneratedModelDefinition({
      id: model.id,
      name: model.name,
      url: version.url,
      position: version.position,
      headingDegrees: version.headingDegrees,
      pitchDegrees: version.pitchDegrees,
      rollDegrees: version.rollDegrees,
      scale: version.scale,
      upAxis: version.upAxis,
      forwardAxis: version.forwardAxis,
      show: true,
    });
    return {
      definition,
      versionId: version.versionId,
      sha256: version.sha256,
      bytes: version.bytes,
      publishedAt: version.publishedAt,
      review: {
        reviewer: version.review.reviewer,
        reviewedAt: version.review.reviewedAt,
        checks: { ...version.review.checks },
      },
    };
  });
}
