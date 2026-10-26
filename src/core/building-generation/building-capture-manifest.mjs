import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SIDES = new Set(["front", "back", "left", "right", "corner", "roof", "other", "unknown"]);
const PURPOSES = new Set(["capture", "reference", "measurement-evidence"]);
const KINDS = new Set(["photo", "video", "video-frame", "document"]);
const ATTESTATION = new Set(["verified", "operator-attested", "estimated", "unknown", "missing"]);
const RIGHTS = new Set(["verified", "operator-attested", "unknown", "missing"]);
const OCCLUSION = new Set(["clear", "partial", "heavy", "unknown"]);
const DIMENSIONS = new Set(["x", "y", "z"]);
const MEASUREMENT_BASES = new Set(["surveyed", "published-measurement", "operator-estimate", "inferred", "missing"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const dateOk = (value) => nonEmpty(value) && Number.isFinite(Date.parse(value));
const numberOk = (value) => typeof value === "number" && Number.isFinite(value);
const hashOk = (value) => typeof value === "string" && SHA256.test(value);
const idOk = (value) => typeof value === "string" && ID.test(value);

function requireObject(value, label) {
  if (!object(value)) throw new TypeError(label + " must be an object");
  return value;
}
function requireId(value, label) {
  if (!idOk(value)) throw new TypeError(label + " must be a safe identifier");
  return value;
}
function validateRelativePath(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.includes("\\") || value.startsWith("/") ||
      /^[a-z]:/i.test(value) || value.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new TypeError(label + " must be a safe project-relative path without dot segments");
  }
  return value;
}
function uniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new TypeError(label + " contains duplicate id: " + item.id);
    seen.add(item.id);
  }
}
function normaliseReviewMetadata(raw, label) {
  const value = raw ?? {};
  requireObject(value, label);
  const out = {};
  for (const key of ["evidenceId", "reviewedBy", "verifiedBy", "sourceId", "evidenceDescription"]) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
      if (!nonEmpty(value[key])) throw new TypeError(label + "." + key + " must be a non-empty string");
      out[key] = value[key].trim();
    }
  }
  for (const key of ["reviewedAt", "verifiedAt"]) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
      if (!dateOk(value[key])) throw new TypeError(label + "." + key + " must be a valid timestamp");
      out[key] = new Date(value[key]).toISOString();
    }
  }
  return out;
}

/**
 * Validate the structure of a source/evidence manifest while preserving missing evidence
 * as missing. This function does not authenticate licenses, surveys, or building identity.
 */
export function normalizeBuildingCaptureManifest(input = {}) {
  requireObject(input, "capture manifest");
  if (input.schemaVersion !== "1.0.0") throw new TypeError("capture manifest schemaVersion must be 1.0.0");
  const manifestId = requireId(input.manifestId, "manifestId");
  const buildingId = requireId(input.buildingId, "buildingId");
  if (!dateOk(input.createdAt)) throw new TypeError("createdAt must be a valid timestamp");
  if (!Array.isArray(input.sources) || input.sources.length > 200) throw new TypeError("sources must be an array of at most 200 records");
  if (!Array.isArray(input.measurements ?? [] ) || (input.measurements ?? []).length > 30) throw new TypeError("measurements must be an array of at most 30 records");
  if (!Array.isArray(input.controlPoints ?? []) || (input.controlPoints ?? []).length > 100) throw new TypeError("controlPoints must be an array of at most 100 records");

  const buildingIdentity = input.buildingIdentity === undefined ? { status: "missing" } : requireObject(input.buildingIdentity, "buildingIdentity");
  const identityStatus = buildingIdentity.status ?? "missing";
  if (!ATTESTATION.has(identityStatus)) throw new TypeError("buildingIdentity.status is unsupported");
  const identity = { status: identityStatus, ...normaliseReviewMetadata(buildingIdentity, "buildingIdentity") };
  for (const key of ["sourceId", "evidenceDescription"]) {
    if (buildingIdentity[key] !== undefined) identity[key] = buildingIdentity[key].trim();
  }

  const sources = input.sources.map((raw, index) => {
    const item = requireObject(raw, "sources[" + index + "]");
    const id = requireId(item.id, "sources[" + index + "].id");
    const purpose = item.purpose ?? "capture";
    const kind = item.kind;
    if (!PURPOSES.has(purpose)) throw new TypeError("sources[" + index + "].purpose is unsupported");
    if (!KINDS.has(kind)) throw new TypeError("sources[" + index + "].kind is unsupported");
    const side = item.side ?? "unknown";
    if (!SIDES.has(side)) throw new TypeError("sources[" + index + "].side is unsupported");
    const relativePath = validateRelativePath(item.path, "sources[" + index + "].path");
    if (item.sha256 !== undefined && item.sha256 !== null && item.sha256 !== "" && !hashOk(item.sha256)) {
      throw new TypeError("sources[" + index + "].sha256 must be a 64-character SHA-256 hash");
    }
    if (item.bytes !== undefined && item.bytes !== null &&
        (!Number.isSafeInteger(item.bytes) || item.bytes < 1)) {
      throw new TypeError("sources[" + index + "].bytes must be a positive integer");
    }
    const rightsRaw = item.rights ?? {};
    requireObject(rightsRaw, "sources[" + index + "].rights");
    const rightsStatus = rightsRaw.status ?? "missing";
    if (!RIGHTS.has(rightsStatus)) throw new TypeError("sources[" + index + "].rights.status is unsupported");
    const rights = { status: rightsStatus, ...normaliseReviewMetadata(rightsRaw, "sources[" + index + "].rights") };
    const cameraRaw = item.camera ?? { status: "unknown" };
    requireObject(cameraRaw, "sources[" + index + "].camera");
    const cameraStatus = cameraRaw.status ?? "unknown";
    if (!ATTESTATION.has(cameraStatus)) throw new TypeError("sources[" + index + "].camera.status is unsupported");
    const camera = { status: cameraStatus };
    for (const key of ["focalLengthMm", "headingDegrees", "pitchDegrees", "rollDegrees", "longitude", "latitude", "altitudeM",
      "horizontalFovDegrees", "verticalFovDegrees"]) {
      if (cameraRaw[key] !== undefined && cameraRaw[key] !== null) {
        if (!numberOk(cameraRaw[key])) throw new TypeError("sources[" + index + "].camera." + key + " must be finite");
        camera[key] = cameraRaw[key];
      }
    }
    for (const key of ["imageWidth", "imageHeight"]) {
      if (cameraRaw[key] !== undefined && cameraRaw[key] !== null) {
        if (!Number.isSafeInteger(cameraRaw[key]) || cameraRaw[key] < 1 || cameraRaw[key] > 20000) {
          throw new RangeError("sources[" + index + "].camera." + key + " must be an integer between 1 and 20000");
        }
        camera[key] = cameraRaw[key];
      }
    }
    for (const key of ["make", "model", "lens"]) {
      if (cameraRaw[key] !== undefined && cameraRaw[key] !== null && cameraRaw[key] !== "") {
        if (!nonEmpty(cameraRaw[key]) || cameraRaw[key].trim().length > 200) {
          throw new TypeError("sources[" + index + "].camera." + key + " must be a non-empty string of at most 200 characters");
        }
        camera[key] = cameraRaw[key].trim();
      }
    }
    for (const key of ["horizontalFovDegrees", "verticalFovDegrees"]) {
      if (camera[key] !== undefined && (camera[key] <= 0 || camera[key] >= 180)) {
        throw new RangeError("camera " + key + " must be greater than 0 and less than 180");
      }
    }
    if (camera.longitude !== undefined && (camera.longitude < -180 || camera.longitude > 180)) throw new RangeError("camera longitude must be between -180 and 180");
    if (camera.latitude !== undefined && (camera.latitude < -85 || camera.latitude > 85)) throw new RangeError("camera latitude must be between -85 and 85");
    if (camera.headingDegrees !== undefined && (camera.headingDegrees < 0 || camera.headingDegrees > 360)) throw new RangeError("camera headingDegrees must be between 0 and 360");
    const occlusionRaw = item.occlusion ?? {};
    requireObject(occlusionRaw, "sources[" + index + "].occlusion");
    const occlusionStatus = occlusionRaw.status ?? "unknown";
    if (!OCCLUSION.has(occlusionStatus)) throw new TypeError("sources[" + index + "].occlusion.status is unsupported");
    const out = { id, purpose, kind, side, path: relativePath, sha256: item.sha256?.toLowerCase() ?? null,
      bytes: item.bytes ?? null, sourceId: item.sourceId ?? null, title: item.title ?? null, rights, camera,
      occlusion: { status: occlusionStatus, notes: nonEmpty(occlusionRaw.notes) ? occlusionRaw.notes.trim() : null } };
    if (out.sourceId !== null && !nonEmpty(out.sourceId)) throw new TypeError("sources[" + index + "].sourceId must be non-empty");
    if (out.title !== null && !nonEmpty(out.title)) throw new TypeError("sources[" + index + "].title must be non-empty");
    return out;
  });
  uniqueIds(sources, "sources");

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const measurements = (input.measurements ?? []).map((raw, index) => {
    const item = requireObject(raw, "measurements[" + index + "]");
    const id = requireId(item.id, "measurements[" + index + "].id");
    const axis = item.axis;
    if (!DIMENSIONS.has(axis)) throw new TypeError("measurements[" + index + "].axis must be x, y or z");
    const basis = item.basis ?? "missing";
    if (!MEASUREMENT_BASES.has(basis)) throw new TypeError("measurements[" + index + "].basis is unsupported");
    const status = item.status ?? "missing";
    if (!ATTESTATION.has(status)) throw new TypeError("measurements[" + index + "].status is unsupported");
    if (item.valueM !== undefined && item.valueM !== null && (!numberOk(item.valueM) || item.valueM <= 0)) {
      throw new TypeError("measurements[" + index + "].valueM must be positive and finite");
    }
    if (item.uncertaintyM !== undefined && item.uncertaintyM !== null && (!numberOk(item.uncertaintyM) || item.uncertaintyM < 0)) {
      throw new TypeError("measurements[" + index + "].uncertaintyM must be finite and non-negative");
    }
    if (item.sourceId !== undefined && item.sourceId !== null && !sourceById.has(item.sourceId)) {
      throw new TypeError("measurements[" + index + "] references unknown sourceId '" + item.sourceId + "'");
    }
    return { id, axis, valueM: item.valueM ?? null, uncertaintyM: item.uncertaintyM ?? null, basis, status,
      sourceId: item.sourceId ?? null, ...normaliseReviewMetadata(item, "measurements[" + index + "]") };
  });
  uniqueIds(measurements, "measurements");

  const controlPoints = (input.controlPoints ?? []).map((raw, index) => {
    const item = requireObject(raw, "controlPoints[" + index + "]");
    const id = requireId(item.id, "controlPoints[" + index + "].id");
    const status = item.status ?? "missing";
    if (!ATTESTATION.has(status)) throw new TypeError("controlPoints[" + index + "].status is unsupported");
    for (const key of ["longitude", "latitude"]) {
      if (!numberOk(item[key])) throw new TypeError("controlPoints[" + index + "]." + key + " must be finite");
    }
    if (item.longitude < -180 || item.longitude > 180) throw new RangeError("control point longitude must be between -180 and 180");
    if (item.latitude < -85 || item.latitude > 85) throw new RangeError("control point latitude must be between -85 and 85");
    if (item.elevationM !== undefined && item.elevationM !== null && !numberOk(item.elevationM)) {
      throw new TypeError("controlPoints[" + index + "].elevationM must be finite");
    }
    if (item.sourceId !== undefined && item.sourceId !== null && !sourceById.has(item.sourceId)) {
      throw new TypeError("controlPoints[" + index + "] references unknown sourceId '" + item.sourceId + "'");
    }
    return { id, status, longitude: item.longitude, latitude: item.latitude, elevationM: item.elevationM ?? null,
      sourceId: item.sourceId ?? null, ...normaliseReviewMetadata(item, "controlPoints[" + index + "]") };
  });
  uniqueIds(controlPoints, "controlPoints");

  return { schemaVersion: "1.0.0", manifestId, buildingId, createdAt: new Date(input.createdAt).toISOString(),
    buildingIdentity: identity, sources, measurements, controlPoints };
}

function nonCollinear(points) {
  if (points.length < 3) return false;
  const meanLat = points.reduce((sum, point) => sum + point.latitude, 0) / points.length * Math.PI / 180;
  const xy = points.map((point) => [point.longitude * Math.cos(meanLat), point.latitude]);
  const origin = xy[0];
  for (let i = 1; i < xy.length - 1; i += 1) {
    for (let j = i + 1; j < xy.length; j += 1) {
      const area = (xy[i][0] - origin[0]) * (xy[j][1] - origin[1]) -
        (xy[j][0] - origin[0]) * (xy[i][1] - origin[1]);
      if (Math.abs(area) > 1e-10) return true;
    }
  }
  return false;
}

/**
 * Check readiness separately from structural validity. Warnings mean evidence is missing;
 * failures mean declared evidence is contradictory or invalid. Asset bytes are only verified
 * when callers pass fileIntegrity results produced by the filesystem validator.
 */
export function assessBuildingCaptureManifest(input = {}, options = {}) {
  const manifest = normalizeBuildingCaptureManifest(input);
  const checks = [];
  const add = (id, pass, detail, fail = false) => checks.push({ id, status: pass ? "passed" : fail ? "failed" : "warning", detail });
  const sources = manifest.sources;
  // Only decoded stills/frames count as independently inspectable reconstruction views.
  // A raw video file needs explicit frame extraction before it can satisfy side coverage.
  const captured = sources.filter((source) => source.purpose === "capture" && ["photo", "video-frame"].includes(source.kind));
  const videos = sources.filter((source) => source.purpose === "capture" && source.kind === "video");
  const references = sources.filter((source) => source.purpose === "reference" && ["photo", "video-frame"].includes(source.kind));
  const measurementSources = sources.filter((source) => source.purpose === "measurement-evidence");
  const rightsOk = (source) => ["verified", "operator-attested"].includes(source.rights.status) &&
    nonEmpty(source.sourceId) && nonEmpty(source.rights.evidenceId) &&
    nonEmpty(source.rights.reviewedBy) && dateOk(source.rights.reviewedAt);
  const sourceBytesOk = (source) => nonEmpty(source.path) && hashOk(source.sha256) && Number.isSafeInteger(source.bytes) && source.bytes > 0;
  const fileIntegrity = options.fileIntegrity;
  const integrityById = new Map(Array.isArray(fileIntegrity) ? fileIntegrity.map((item) => [item.sourceId, item]) : []);
  const assetIntegrityOk = (source) => fileIntegrity !== undefined &&
    integrityById.get(source.id)?.status === "passed" &&
    integrityById.get(source.id)?.sha256?.toLowerCase() === source.sha256 &&
    integrityById.get(source.id)?.bytes === source.bytes;

  const validCaptures = captured.filter((source) => sourceBytesOk(source) && rightsOk(source));
  const captureSides = new Set(validCaptures.map((source) => source.side));
  const captureCoverage = validCaptures.length >= 4 && ["front", "back", "left", "right"].every((side) => captureSides.has(side));
  add("capture-source-coverage-and-rights", captureCoverage,
    "At least four hash-declared still images or extracted video frames must cover front/back/left/right and have reviewed rights evidence.");
  const videosWithFrames = videos.filter((video) => sources.some((source) =>
    source.purpose === "capture" && source.kind === "video-frame" &&
    nonEmpty(video.sourceId) && source.sourceId === video.sourceId));
  add("video-frame-extraction", videos.length === 0 || videosWithFrames.length === videos.length,
    "Raw videos do not count as a facade view until extracted video-frame evidence is linked to each video source.");
  const validCaptureHashes = validCaptures.map((source) => source.sha256.toLowerCase());
  const duplicateCaptureBytes = new Set(validCaptureHashes).size !== validCaptureHashes.length;
  add("capture-source-byte-uniqueness", validCaptureHashes.length > 0 && !duplicateCaptureBytes,
    "Byte-identical capture files cannot count as independent facade views.", duplicateCaptureBytes);
  const validReferences = references.filter((source) => sourceBytesOk(source) && rightsOk(source));
  const referenceSides = new Set(validReferences.map((source) => source.side));
  const referenceCoverage = validReferences.length >= 4 && ["front", "back", "left", "right"].every((side) => referenceSides.has(side));
  add("independent-reference-coverage-and-rights", referenceCoverage,
    "At least four independent reference assets must cover front/back/left/right and retain rights/source provenance.");
  const captureHashes = new Set(captured.filter((source) => hashOk(source.sha256)).map((source) => source.sha256.toLowerCase()));
  const duplicateReferenceHashes = validReferences.map((source) => source.sha256);
  const duplicateReferenceFiles = new Set(duplicateReferenceHashes).size !== duplicateReferenceHashes.length;
  add("reference-source-byte-uniqueness", validReferences.length > 0 && !duplicateReferenceFiles,
    "Byte-identical references cannot be counted as separate independent views.", duplicateReferenceFiles);
  const duplicateReferenceBytes = validReferences.some((source) => captureHashes.has(source.sha256));
  add("reference-bytes-independent-from-captures", validReferences.length > 0 && !duplicateReferenceBytes,
    "Reference images must not be byte-identical to the reconstruction capture images; shared bytes are not independent validation.",
    duplicateReferenceBytes);

  const captureCameraOk = captured.length >= 1 && captured.every((source) =>
    ["verified", "estimated"].includes(source.camera.status) &&
    Object.keys(source.camera).some((key) => key !== "status") && source.occlusion.status !== "unknown");
  add("camera-and-occlusion-metadata", captureCameraOk,
    "Each capture needs a declared camera/pose status and a reviewed occlusion status; estimated camera poses remain estimates.");

  const measurementByAxis = new Map();
  let duplicateAxis = false;
  for (const measurement of manifest.measurements) {
    if (measurementByAxis.has(measurement.axis)) duplicateAxis = true;
    else measurementByAxis.set(measurement.axis, measurement);
  }
  const validDimensions = !duplicateAxis && ["x", "y", "z"].every((axis) => {
    const measurement = measurementByAxis.get(axis);
    return measurement && numberOk(measurement.valueM) && measurement.valueM > 0 &&
      numberOk(measurement.uncertaintyM) && measurement.uncertaintyM >= 0 &&
      ["surveyed", "published-measurement"].includes(measurement.basis) && measurement.status === "verified" &&
      nonEmpty(measurement.sourceId) && measurementSources.some((source) => source.id === measurement.sourceId) &&
      nonEmpty(measurement.evidenceId) && nonEmpty(measurement.verifiedBy) && dateOk(measurement.verifiedAt);
  });
  add("independent-dimensions", validDimensions,
    "Independent x/y/z dimensions must be sourced to measurement-evidence assets, with basis, uncertainty, reviewer and timestamp.",
    duplicateAxis);

  const validControls = manifest.controlPoints.filter((point) =>
    point.status === "verified" && nonEmpty(point.sourceId) &&
    measurementSources.some((source) => source.id === point.sourceId) &&
    nonEmpty(point.evidenceId) && nonEmpty(point.verifiedBy) && dateOk(point.verifiedAt));
  const controlReady = validControls.length >= 3 && nonCollinear(validControls);
  add("survey-control-evidence", controlReady,
    "At least three reviewed, non-collinear WGS84 control points must cite measurement-evidence sources.");

  const identity = manifest.buildingIdentity;
  const identityReady = ["verified", "operator-attested"].includes(identity.status) &&
    nonEmpty(identity.sourceId) && nonEmpty(identity.evidenceDescription) &&
    nonEmpty(identity.verifiedBy) && dateOk(identity.verifiedAt);
  add("building-identity-provenance", identityReady,
    "Building identity must link to a documented source, reviewer and timestamp; attestation is not independent authentication.");

  const allIntegrity = fileIntegrity !== undefined && sources.length > 0 &&
    sources.every((source) => sourceBytesOk(source) && assetIntegrityOk(source));
  const badIntegrity = Array.isArray(fileIntegrity) && fileIntegrity.some((item) => item.status === "failed");
  add("on-disk-source-integrity", allIntegrity,
    "Declared asset paths, byte lengths and SHA-256 digests must match the actual files before using this pack.",
    badIntegrity);

  const status = checks.some((check) => check.status === "failed") ? "failed" :
    checks.some((check) => check.status === "warning") ? "incomplete" : "ready-for-review";
  return { schemaVersion: "1.0.0", engine: "building-capture-manifest-validator-v1", manifestId: manifest.manifestId,
    buildingId: manifest.buildingId, generatedAt: new Date().toISOString(), status, readyForModelReview: status === "ready-for-review",
    counts: { sources: sources.length, captures: captured.length, videos: videos.length, references: references.length,
      measurementSources: measurementSources.length, measurements: manifest.measurements.length, controlPoints: manifest.controlPoints.length,
      passed: checks.filter((check) => check.status === "passed").length, warnings: checks.filter((check) => check.status === "warning").length,
      failed: checks.filter((check) => check.status === "failed").length },
    checks, fileIntegrity: Array.isArray(fileIntegrity) ? fileIntegrity : null,
    policy: { mapReady: false, publicationEligible: false, automaticApproval: false },
    limitations: ["The validator checks consistency and provenance fields, not the truth of copyright, identity or survey assertions.",
      "Declared image hashes prove byte identity only; they do not prove image independence or facade correctness.",
      "A ready capture manifest is evidence-ready for review, not proof that a generated GLB is architecturally accurate.",
      "Ground-control coordinates in this manifest are not yet bound to an exact GLB; the benchmark must bind model-space coordinates to its exact model hash."] };
}
