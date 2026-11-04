import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { registerModelToWgs84 } from "./ground-control-registration.mjs";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 128 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be an object.");
  }
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      actual.some((key) => !allowed.includes(key))) {
    throw new TypeError(label + " has a missing or unexpected field.");
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError("controlPointManifestPath must be a workspace-relative POSIX path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError("controlPointManifestPath contains an unsafe path segment.");
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
  );
}

function signature(info) {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

async function readStableManifest(root, relativePath) {
  const safePath = safeRelativePath(relativePath);
  let current = root;
  const segments = safePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new TypeError("Control-point manifest path must not contain symbolic links.");
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new TypeError("Control-point manifest path contains a non-directory segment.");
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new TypeError("Control-point manifest must be a regular file.");
    }
  }
  const actual = await realpath(current);
  if (!inside(root, actual)) throw new TypeError("Control-point manifest resolves outside workspaceRoot.");

  const handle = await open(actual, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_MANIFEST_BYTES) {
      throw new RangeError("Control-point manifest must be non-empty and at most 128 KiB.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(actual);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        signature(before) !== signature(after) ||
        signature(after) !== signature(pathAfter) ||
        bytes.length !== after.size) {
      throw new Error("Control-point manifest changed while it was being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new TypeError(label + " must be a canonical UTC ISO timestamp with milliseconds.");
  }
  return value;
}

function normalizeManifest(raw, { buildingId, sourceId, sourceSha256 }) {
  if (!isObject(raw) || !["1.0.0", "1.1.0"].includes(raw.schemaVersion)) {
    throw new TypeError("Control-point manifest schema version is unsupported.");
  }
  exactKeys(
    raw,
    ["schemaVersion", "kind", "buildingId", "source", "horizontalCrs", "horizontalDatum",
      "verticalDatum", "survey", "controlPoints"],
    raw.schemaVersion === "1.1.0" ? ["vertical"] : [],
    "Control-point manifest",
  );
  if (raw.kind !== "single-image-control-point-manifest" ||
      raw.buildingId !== buildingId ||
      raw.horizontalCrs !== "EPSG:4326" ||
      raw.horizontalDatum !== "WGS84" ||
      raw.verticalDatum !== "not-provided") {
    throw new TypeError("Control-point manifest schema, building identity or coordinate reference is invalid.");
  }
  exactKeys(raw.source, ["sourceId", "sha256"], [], "Control-point source binding");
  if (raw.source.sourceId !== sourceId || raw.source.sha256 !== sourceSha256 ||
      !HASH.test(raw.source.sha256 ?? "")) {
    throw new TypeError("Control-point manifest does not bind the exact selected source image.");
  }
  exactKeys(raw.survey, ["method", "reference", "observedAtUtc", "horizontalAccuracyM"], [], "Survey metadata");
  if (typeof raw.survey.method !== "string" || !raw.survey.method.trim() || raw.survey.method.length > 120 ||
      typeof raw.survey.reference !== "string" || !raw.survey.reference.trim() || raw.survey.reference.length > 300 ||
      !Number.isFinite(raw.survey.horizontalAccuracyM) ||
      raw.survey.horizontalAccuracyM <= 0 || raw.survey.horizontalAccuracyM > 100) {
    throw new TypeError("Survey method, reference or declared horizontal accuracy is invalid.");
  }
  canonicalTimestamp(raw.survey.observedAtUtc, "survey.observedAtUtc");
  if (!Array.isArray(raw.controlPoints) || raw.controlPoints.length < 3 || raw.controlPoints.length > 100) {
    throw new RangeError("Control-point manifest must contain 3–100 surveyed control points.");
  }
  const seen = new Set();
  const controlPoints = raw.controlPoints.map((point, index) => {
    exactKeys(
      point,
      ["id", "modelX", "modelZ", "longitude", "latitude", "evidenceSourceId"],
      ["description"],
      "controlPoints[" + index + "]",
    );
    if (typeof point.id !== "string" || !SAFE_ID.test(point.id) || seen.has(point.id)) {
      throw new TypeError("Control-point IDs must be valid and unique.");
    }
    seen.add(point.id);
    if (point.evidenceSourceId !== sourceId) {
      throw new TypeError("Every control point must identify the selected source through evidenceSourceId.");
    }
    for (const key of ["modelX", "modelZ", "longitude", "latitude"]) {
      if (typeof point[key] !== "number" || !Number.isFinite(point[key])) {
        throw new TypeError("controlPoints[" + index + "]." + key + " must be finite.");
      }
    }
    if (point.longitude < -180 || point.longitude > 180 ||
        point.latitude < -85 || point.latitude > 85) {
      throw new RangeError("Control-point longitude/latitude is outside the supported WGS84 range.");
    }
    if (point.description !== undefined &&
        (typeof point.description !== "string" || point.description.length > 500)) {
      throw new TypeError("Control-point descriptions must be strings of at most 500 characters.");
    }
    return {
      id: point.id,
      modelX: point.modelX,
      modelZ: point.modelZ,
      longitude: point.longitude,
      latitude: point.latitude,
      evidenceSourceId: point.evidenceSourceId,
      ...(point.description !== undefined ? { description: point.description } : {}),
    };
  });

  let vertical = null;
  if (raw.schemaVersion === "1.1.0" && raw.vertical === undefined) {
    throw new TypeError("Control-point manifest schema 1.1.0 requires an explicit vertical control section.");
  }
  if (raw.vertical !== undefined) {
    if (raw.schemaVersion !== "1.1.0") {
      throw new TypeError("Ellipsoidal-height controls require control-point manifest schema 1.1.0.");
    }
    exactKeys(raw.vertical, [
      "crs", "heightType", "unit", "referenceFrame", "coordinateEpoch", "survey", "controlPoints",
    ], [], "Vertical control section");
    if (raw.vertical.crs !== "EPSG:4979" ||
        raw.vertical.heightType !== "ellipsoidal" ||
        raw.vertical.unit !== "metre") {
      throw new TypeError("Vertical controls must use EPSG:4979 ellipsoidal heights in metres; orthometric/MSL/AGL heights are unsupported.");
    }
    if (typeof raw.vertical.referenceFrame !== "string" ||
        !/^WGS 84 \\([A-Za-z0-9._ -]{1,40}\\)$/.test(raw.vertical.referenceFrame.trim())) {
      throw new TypeError("Vertical controls require a named WGS 84 realization/reference frame such as WGS 84 (G2139).");
    }
    if (typeof raw.vertical.coordinateEpoch !== "number" ||
        !Number.isFinite(raw.vertical.coordinateEpoch) ||
        raw.vertical.coordinateEpoch < 1980 || raw.vertical.coordinateEpoch > 2100) {
      throw new RangeError("Vertical coordinateEpoch must be a finite decimal year from 1980 to 2100.");
    }
    exactKeys(raw.vertical.survey, ["method", "reference", "observedAtUtc", "verticalAccuracyM"], [],
      "Vertical survey metadata");
    if (typeof raw.vertical.survey.method !== "string" || !raw.vertical.survey.method.trim() ||
        raw.vertical.survey.method.length > 120 ||
        typeof raw.vertical.survey.reference !== "string" || !raw.vertical.survey.reference.trim() ||
        raw.vertical.survey.reference.length > 300 ||
        typeof raw.vertical.survey.verticalAccuracyM !== "number" ||
        !Number.isFinite(raw.vertical.survey.verticalAccuracyM) ||
        raw.vertical.survey.verticalAccuracyM <= 0 || raw.vertical.survey.verticalAccuracyM > 100) {
      throw new TypeError("Vertical survey method, reference or declared accuracy is invalid.");
    }
    canonicalTimestamp(raw.vertical.survey.observedAtUtc, "vertical.survey.observedAtUtc");
    if (!Array.isArray(raw.vertical.controlPoints) ||
        raw.vertical.controlPoints.length !== controlPoints.length ||
        raw.vertical.controlPoints.length < 3 || raw.vertical.controlPoints.length > 100) {
      throw new RangeError("Vertical controls must provide exactly one measurement for every horizontal control point.");
    }
    const horizontalIds = new Set(controlPoints.map((point) => point.id));
    const verticalIds = new Set();
    const verticalPoints = raw.vertical.controlPoints.map((point, index) => {
      exactKeys(point, ["horizontalControlPointId", "modelY", "ellipsoidalHeightM", "evidenceSourceId"], [],
        "vertical.controlPoints[" + index + "]");
      const id = point.horizontalControlPointId;
      if (typeof id !== "string" || !SAFE_ID.test(id) || !horizontalIds.has(id) || verticalIds.has(id)) {
        throw new TypeError("Every vertical control must map one-to-one to a unique existing horizontal control ID.");
      }
      verticalIds.add(id);
      if (point.evidenceSourceId !== sourceId) {
        throw new TypeError("Every vertical control must identify the selected source through evidenceSourceId.");
      }
      if (typeof point.modelY !== "number" || !Number.isFinite(point.modelY) ||
          Math.abs(point.modelY) > 100000) {
        throw new RangeError("Vertical control modelY must be finite and within the supported GLB model range.");
      }
      if (typeof point.ellipsoidalHeightM !== "number" ||
          !Number.isFinite(point.ellipsoidalHeightM) ||
          point.ellipsoidalHeightM < -12000 || point.ellipsoidalHeightM > 100000) {
        throw new RangeError("Ellipsoidal height must be finite and within the supported physical range.");
      }
      return {
        horizontalControlPointId: id,
        modelY: point.modelY,
        ellipsoidalHeightM: point.ellipsoidalHeightM,
        evidenceSourceId: point.evidenceSourceId,
      };
    });
    if (verticalIds.size !== horizontalIds.size ||
        [...horizontalIds].some((id) => !verticalIds.has(id))) {
      throw new TypeError("Vertical controls must match the complete horizontal control ID set.");
    }
    vertical = {
      crs: "EPSG:4979",
      heightType: "ellipsoidal",
      unit: "metre",
      referenceFrame: raw.vertical.referenceFrame.trim(),
      coordinateEpoch: raw.vertical.coordinateEpoch,
      survey: {
        method: raw.vertical.survey.method.trim(),
        reference: raw.vertical.survey.reference.trim(),
        observedAtUtc: raw.vertical.survey.observedAtUtc,
        verticalAccuracyM: raw.vertical.survey.verticalAccuracyM,
      },
      controlPoints: verticalPoints,
    };
  }

  return {
    schemaVersion: raw.schemaVersion,
    kind: "single-image-control-point-manifest",
    buildingId,
    source: { sourceId, sha256: sourceSha256 },
    horizontalCrs: "EPSG:4326",
    horizontalDatum: "WGS84",
    verticalDatum: "not-provided",
    survey: {
      method: raw.survey.method.trim(),
      reference: raw.survey.reference.trim(),
      observedAtUtc: raw.survey.observedAtUtc,
      horizontalAccuracyM: raw.survey.horizontalAccuracyM,
    },
    controlPoints,
    ...(vertical ? { vertical } : {}),
  };
}
function validateThresholds(maxGcpRmsErrorM, maxGcpResidualM) {
  if (!Number.isFinite(maxGcpRmsErrorM) || maxGcpRmsErrorM <= 0 || maxGcpRmsErrorM > 100) {
    throw new RangeError("maxGcpRmsErrorM must be in (0,100].");
  }
  if (!Number.isFinite(maxGcpResidualM) || maxGcpResidualM <= 0 || maxGcpResidualM > 100) {
    throw new RangeError("maxGcpResidualM must be in (0,100].");
  }
}

function manifestSummary(loaded) {
  const { manifest } = loaded;
  return {
    path: loaded.path,
    bytes: loaded.bytes,
    sha256: loaded.sha256,
    pointCount: manifest.controlPoints.length,
    horizontalCrs: manifest.horizontalCrs,
    horizontalDatum: manifest.horizontalDatum,
    verticalDatum: manifest.verticalDatum,
    survey: manifest.survey,
    ...(manifest.vertical ? { vertical: {
      crs: manifest.vertical.crs,
      heightType: manifest.vertical.heightType,
      unit: manifest.vertical.unit,
      referenceFrame: manifest.vertical.referenceFrame,
      coordinateEpoch: manifest.vertical.coordinateEpoch,
      survey: manifest.vertical.survey,
      pointCount: manifest.vertical.controlPoints.length,
    } } : {}),
  };
}

export async function loadSingleImageControlPointManifest({
  workspaceRoot,
  relativePath,
  buildingId,
  sourceId,
  sourceSha256,
}) {
  const root = await realpath(path.resolve(workspaceRoot));
  const safePath = safeRelativePath(relativePath);
  if (typeof buildingId !== "string" || !SAFE_ID.test(buildingId) ||
      typeof sourceId !== "string" || !SAFE_ID.test(sourceId) ||
      !HASH.test(sourceSha256 ?? "")) {
    throw new TypeError("Control-point building/source identity is invalid.");
  }
  const bytes = await readStableManifest(root, safePath);
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Control-point manifest is not valid UTF-8 JSON.");
  }
  const manifest = normalizeManifest(raw, { buildingId, sourceId, sourceSha256 });
  return {
    path: safePath,
    bytes: bytes.length,
    sha256: sha256(bytes),
    manifest,
  };
}

function round(value) {
  return Number(value.toFixed(4));
}

function createVerticalHeightEvidence({
  loadedManifest,
  modelSha256,
  horizontalRegistration,
  maxVerticalGcpRmsErrorM = 0.5,
  maxVerticalGcpResidualM = 1.0,
}) {
  const vertical = loadedManifest?.manifest?.vertical ?? null;
  if (!vertical) {
    return {
      schemaVersion: "1.0.0",
      status: "not-requested",
      modelSha256,
      controlPointManifestSha256: loadedManifest?.sha256 ?? null,
      horizontalMetresPerModelUnit: horizontalRegistration?.transform?.metresPerModelUnit ?? null,
      mapReady: false,
      publicationEligible: false,
      automaticApproval: false,
    };
  }
  if (!Number.isFinite(maxVerticalGcpRmsErrorM) ||
      maxVerticalGcpRmsErrorM <= 0 || maxVerticalGcpRmsErrorM > 100 ||
      !Number.isFinite(maxVerticalGcpResidualM) ||
      maxVerticalGcpResidualM <= 0 || maxVerticalGcpResidualM > 100) {
    throw new RangeError("Vertical GCP residual thresholds must be finite values in (0,100].");
  }
  const horizontalScale = horizontalRegistration?.transform?.metresPerModelUnit;
  if (!Number.isFinite(horizontalScale) || horizontalScale <= 0) {
    throw new TypeError("Vertical calibration requires the exact positive horizontal registration scale.");
  }
  if (horizontalRegistration.status !== "calibrated-needs-human-review") {
    return {
      schemaVersion: "1.0.0",
      status: "blocked-horizontal-registration-failed",
      modelSha256,
      controlPointManifestSha256: loadedManifest.sha256,
      horizontalMetresPerModelUnit: horizontalScale,
      verticalCrs: vertical.crs,
      heightType: vertical.heightType,
      unit: vertical.unit,
      referenceFrame: vertical.referenceFrame,
      coordinateEpoch: vertical.coordinateEpoch,
      mapReady: false,
      publicationEligible: false,
      automaticApproval: false,
    };
  }
  const heights = vertical.controlPoints;
  const modelYs = heights.map((point) => point.modelY);
  const modelYSpanM = (Math.max(...modelYs) - Math.min(...modelYs)) * horizontalScale;
  if (!Number.isFinite(modelYSpanM) || modelYSpanM < 1) {
    throw new RangeError("Vertical controls must span at least 1 metre in the exact horizontal model scale.");
  }
  // Reuse the horizontal scale exactly; solve only the ellipsoidal-height offset.
  const offsets = heights.map((point) =>
    point.ellipsoidalHeightM - horizontalScale * point.modelY
  );
  const heightOffsetM = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
  const residuals = heights.map((point) => {
    const predicted = heightOffsetM + horizontalScale * point.modelY;
    return {
      horizontalControlPointId: point.horizontalControlPointId,
      modelY: point.modelY,
      surveyedEllipsoidalHeightM: point.ellipsoidalHeightM,
      predictedEllipsoidalHeightM: round(predicted),
      residualM: round(predicted - point.ellipsoidalHeightM),
      evidenceSourceId: point.evidenceSourceId,
    };
  });
  const rmsErrorM = Math.sqrt(residuals.reduce((sum, point) => sum + point.residualM ** 2, 0) / residuals.length);
  const maxErrorM = Math.max(...residuals.map((point) => Math.abs(point.residualM)));
  const thresholdPass = rmsErrorM <= maxVerticalGcpRmsErrorM && maxErrorM <= maxVerticalGcpResidualM;
  return {
    schemaVersion: "1.0.0",
    status: thresholdPass ? "calibrated-needs-human-review" : "calibration-failed-review-required",
    modelSha256,
    controlPointManifestSha256: loadedManifest.sha256,
    verticalCrs: vertical.crs,
    heightType: vertical.heightType,
    unit: vertical.unit,
    referenceFrame: vertical.referenceFrame,
    coordinateEpoch: vertical.coordinateEpoch,
    survey: vertical.survey,
    horizontalMetresPerModelUnit: horizontalScale,
    verticalScalePolicy: "reuses-exact-horizontal-scale-no-independent-y-scale",
    modelYSpanM: round(modelYSpanM),
    heightOffsetM: round(heightOffsetM),
    controls: {
      count: heights.length,
      ids: heights.map((point) => point.horizontalControlPointId),
      residuals,
      rmsErrorM: round(rmsErrorM),
      maxResidualM: round(maxErrorM),
      maxRmsErrorM: maxVerticalGcpRmsErrorM,
      maxAllowedResidualM: maxVerticalGcpResidualM,
      thresholdPass,
    },
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    warnings: [
      "Ellipsoidal height is operator-supplied and not independently authenticated.",
      "The vertical solution assumes the supplied modelY values identify the same physical control points as the horizontal observations.",
      "EPSG:4979 ellipsoidal heights are not orthometric/MSL/AGL heights; no geoid conversion is performed.",
      "This vertical offset is human-review-only and never enables map publication.",
    ],
  };
}

export function createSingleImageGeoreferenceEvidence({
  loadedManifest,
  modelSha256,
  maxGcpRmsErrorM = 0.5,
  maxGcpResidualM = 1.0,
  maxVerticalGcpRmsErrorM = 0.5,
  maxVerticalGcpResidualM = 1.0,
}) {
  if (!HASH.test(modelSha256 ?? "")) throw new TypeError("modelSha256 must be a SHA-256 digest.");
  if (!loadedManifest) {
    return {
      schemaVersion: "1.0.0",
      status: "not-requested",
      modelSha256,
      maxGcpRmsErrorM: null,
      maxGcpResidualM: null,
      manifest: null,
      registration: null,
    };
  }
  validateThresholds(maxGcpRmsErrorM, maxGcpResidualM);
  const registration = JSON.parse(JSON.stringify(registerModelToWgs84({
    controlPoints: loadedManifest.manifest.controlPoints,
    maxRmsErrorM: maxGcpRmsErrorM,
    maxResidualM: maxGcpResidualM,
  })));
  if (registration.vertical?.status !== "not-solved" ||
      registration.mapReady !== false || registration.publicationEligible !== false) {
    throw new TypeError("Ground-control registration changed its unresolved vertical/release boundary.");
  }
  const verticalEvidence = createVerticalHeightEvidence({
    loadedManifest,
    modelSha256,
    horizontalRegistration: registration,
    maxVerticalGcpRmsErrorM,
    maxVerticalGcpResidualM,
  });
  return {
    schemaVersion: loadedManifest.manifest.vertical ? "1.1.0" : "1.0.0",
    status: registration.status,
    modelSha256,
    maxGcpRmsErrorM,
    maxGcpResidualM,
    manifest: manifestSummary(loadedManifest),
    registration,
    ...(loadedManifest.manifest.vertical ? { verticalEvidence } : {}),
  };
}
function canonicalObjectJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

/**
 * Re-verifies a D3M-08 georeference record using the exact manifest bytes.
 * This pure-byte entry point lets offline review packages repeat the fit
 * without relying on the original worker workspace path.
 */
export function verifySingleImageGeoreferenceEvidenceBytes({
  evidence,
  manifestBytes = null,
  buildingId,
  sourceId,
  sourceSha256,
  modelSha256,
}) {
  const hasVerticalEvidence = evidence?.schemaVersion === "1.1.0";
  exactKeys(
    evidence,
    ["schemaVersion", "status", "modelSha256", "maxGcpRmsErrorM", "maxGcpResidualM",
      "manifest", "registration", ...(hasVerticalEvidence ? ["verticalEvidence"] : [])],
    [],
    "Single-image georeference evidence",
  );
  if (!["1.0.0", "1.1.0"].includes(evidence.schemaVersion) || evidence.modelSha256 !== modelSha256) {
    throw new TypeError("Georeference evidence does not bind this exact GLB candidate.");
  }

  let loadedManifest = null;
  if (evidence.manifest === null) {
    if (manifestBytes !== null || evidence.status !== "not-requested" || evidence.registration !== null ||
        evidence.maxGcpRmsErrorM !== null || evidence.maxGcpResidualM !== null) {
      throw new TypeError("Unrequested georeference evidence has unexpected calibration data.");
    }
  } else {
    if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length < 1) {
      throw new TypeError("The exact control-point manifest bytes are required for verification.");
    }
    exactKeys(
      evidence.manifest,
      ["path", "bytes", "sha256", "pointCount", "horizontalCrs", "horizontalDatum",
        "verticalDatum", "survey", ...(evidence.schemaVersion === "1.1.0" ? ["vertical"] : [])],
      [],
      "Control-point manifest receipt binding",
    );
    const relativePath = safeRelativePath(evidence.manifest.path);
    let raw;
    try {
      raw = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      throw new TypeError("Packaged control-point manifest is not valid UTF-8 JSON.");
    }
    const manifest = normalizeManifest(raw, { buildingId, sourceId, sourceSha256 });
    loadedManifest = {
      path: relativePath,
      bytes: manifestBytes.length,
      sha256: sha256(manifestBytes),
      manifest,
    };
    if (loadedManifest.bytes !== evidence.manifest.bytes ||
        loadedManifest.sha256 !== evidence.manifest.sha256 ||
        loadedManifest.manifest.controlPoints.length !== evidence.manifest.pointCount) {
      throw new Error("Control-point manifest bytes or identity do not match the georeference receipt.");
    }
  }

  const expected = createSingleImageGeoreferenceEvidence({
    loadedManifest,
    modelSha256,
    maxGcpRmsErrorM: evidence.maxGcpRmsErrorM,
    maxGcpResidualM: evidence.maxGcpResidualM,
    maxVerticalGcpRmsErrorM: evidence.verticalEvidence?.controls?.maxRmsErrorM ?? 0.5,
    maxVerticalGcpResidualM: evidence.verticalEvidence?.controls?.maxAllowedResidualM ?? 1.0,
  });
  if (canonicalObjectJson(expected) !== canonicalObjectJson(evidence)) {
    throw new TypeError("Single-image georeference evidence does not match independently recomputed horizontal and vertical control-point registration.");
  }
  return expected;
}
export async function verifySingleImageGeoreferenceEvidence({
  workspaceRoot,
  evidence,
  buildingId,
  sourceId,
  sourceSha256,
  modelSha256,
}) {
  let manifestBytes = null;
  if (evidence?.manifest !== null) {
    const root = await realpath(path.resolve(workspaceRoot));
    const relativePath = safeRelativePath(evidence.manifest.path);
    manifestBytes = await readStableManifest(root, relativePath);
  }
  return verifySingleImageGeoreferenceEvidenceBytes({
    evidence,
    manifestBytes,
    buildingId,
    sourceId,
    sourceSha256,
    modelSha256,
  });
}
