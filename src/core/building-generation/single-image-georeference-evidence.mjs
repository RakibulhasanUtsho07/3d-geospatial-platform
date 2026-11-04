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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (!isObject(raw) || !["1.0.0", "1.1.0", "1.2.0"].includes(raw.schemaVersion)) {
    throw new TypeError("Control-point manifest schema version is unsupported.");
  }
  const hasIndependentCheckpoints = raw.schemaVersion === "1.2.0";
  exactKeys(
    raw,
    ["schemaVersion", "kind", "buildingId", "source", "horizontalCrs", "horizontalDatum",
      "verticalDatum", "survey", "controlPoints"],
    raw.schemaVersion === "1.0.0" ? [] :
      hasIndependentCheckpoints ? ["vertical", "heldOutCheckpoints"] : ["vertical"],
    "Control-point manifest",
  );
  if (raw.kind !== "single-image-control-point-manifest" ||
      raw.buildingId !== buildingId ||
      raw.horizontalCrs !== "EPSG:4326" ||
      raw.horizontalDatum !== "WGS84" ||
      raw.verticalDatum !== (raw.schemaVersion !== "1.0.0" && raw.vertical !== undefined
        ? "EPSG:4979-ellipsoidal" : "not-provided")) {
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
  const fitObservationIds = new Set();
  const controlPoints = raw.controlPoints.map((point, index) => {
    exactKeys(
      point,
      ["id", "modelX", "modelZ", "longitude", "latitude", "evidenceSourceId"],
      hasIndependentCheckpoints ? ["observationId", "description"] : ["description"],
      "controlPoints[" + index + "]",
    );
    if (typeof point.id !== "string" || !SAFE_ID.test(point.id) || seen.has(point.id)) {
      throw new TypeError("Control-point IDs must be valid and unique.");
    }
    seen.add(point.id);
    if (hasIndependentCheckpoints) {
      if (typeof point.observationId !== "string" || !SAFE_ID.test(point.observationId) ||
          fitObservationIds.has(point.observationId)) {
        throw new TypeError("Schema 1.2.0 fitting control observation IDs must be valid and unique.");
      }
      fitObservationIds.add(point.observationId);
    }
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
      ...(hasIndependentCheckpoints ? { observationId: point.observationId } : {}),
      ...(point.description !== undefined ? { description: point.description } : {}),
    };
  });

  let vertical = null;
  if (raw.schemaVersion !== "1.0.0" && raw.vertical === undefined) {
    throw new TypeError("Control-point manifest schema 1.1.0 requires an explicit vertical control section.");
  }
  if (raw.vertical !== undefined) {
    if (raw.schemaVersion === "1.0.0") {
      throw new TypeError("Ellipsoidal-height controls require control-point manifest schema 1.1.0 or 1.2.0.");
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
        !/^WGS 84 \([A-Za-z0-9._ -]{1,40}\)$/.test(raw.vertical.referenceFrame.trim())) {
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
    const horizontalObservationIds = new Map(controlPoints.map((point) => [point.id, point.observationId]));
    const verticalPoints = raw.vertical.controlPoints.map((point, index) => {
      exactKeys(
        point,
        ["horizontalControlPointId", "modelY", "ellipsoidalHeightM", "evidenceSourceId"],
        hasIndependentCheckpoints ? ["observationId"] : [],
        "vertical.controlPoints[" + index + "]",
      );
      const id = point.horizontalControlPointId;
      if (typeof id !== "string" || !SAFE_ID.test(id) || !horizontalIds.has(id) || verticalIds.has(id)) {
        throw new TypeError("Every vertical control must map one-to-one to a unique existing horizontal control ID.");
      }
      verticalIds.add(id);
      if (hasIndependentCheckpoints &&
          (typeof point.observationId !== "string" ||
           point.observationId !== horizontalObservationIds.get(id))) {
        throw new TypeError("Vertical fitting observations must match the exact horizontal fit observation ID.");
      }
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
        ...(hasIndependentCheckpoints ? { observationId: point.observationId } : {}),
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

  let heldOutCheckpoints = null;
  if (hasIndependentCheckpoints) {
    if (raw.heldOutCheckpoints === undefined || !vertical) {
      throw new TypeError("Control-point manifest schema 1.2.0 requires vertical fitting controls and held-out 3D checkpoints.");
    }
    exactKeys(raw.heldOutCheckpoints, [
      "crs", "heightType", "unit", "referenceFrame", "coordinateEpoch", "survey", "points",
    ], [], "heldOutCheckpoints");
    if (raw.heldOutCheckpoints.crs !== "EPSG:4979" ||
        raw.heldOutCheckpoints.heightType !== "ellipsoidal" ||
        raw.heldOutCheckpoints.unit !== "metre" ||
        raw.heldOutCheckpoints.referenceFrame !== vertical.referenceFrame ||
        raw.heldOutCheckpoints.coordinateEpoch !== vertical.coordinateEpoch) {
      throw new TypeError("Held-out checkpoints must use the exact D3M-13 EPSG:4979 frame and coordinate epoch.");
    }
    exactKeys(raw.heldOutCheckpoints.survey, [
      "method", "reference", "observedAtUtc", "horizontalAccuracyM", "verticalAccuracyM",
    ], [], "heldOutCheckpoints.survey");
    const checkpointSurvey = raw.heldOutCheckpoints.survey;
    if (typeof checkpointSurvey.method !== "string" || !checkpointSurvey.method.trim() ||
        checkpointSurvey.method.length > 120 ||
        typeof checkpointSurvey.reference !== "string" || !checkpointSurvey.reference.trim() ||
        checkpointSurvey.reference.length > 300 ||
        !Number.isFinite(checkpointSurvey.horizontalAccuracyM) ||
        checkpointSurvey.horizontalAccuracyM <= 0 || checkpointSurvey.horizontalAccuracyM > 100 ||
        !Number.isFinite(checkpointSurvey.verticalAccuracyM) ||
        checkpointSurvey.verticalAccuracyM <= 0 || checkpointSurvey.verticalAccuracyM > 100) {
      throw new TypeError("Held-out checkpoint survey metadata or declared accuracy is invalid.");
    }
    canonicalTimestamp(checkpointSurvey.observedAtUtc, "heldOutCheckpoints.survey.observedAtUtc");
    if (!Array.isArray(raw.heldOutCheckpoints.points) ||
        raw.heldOutCheckpoints.points.length < 6 ||
        raw.heldOutCheckpoints.points.length > 100) {
      throw new RangeError("Independent 3D validation requires 6–100 held-out checkpoints.");
    }
    const fitIds = new Set(controlPoints.map((point) => point.id));
    const checkpointIds = new Set();
    const checkpointObservationIds = new Set();
    const checkpointPoints = raw.heldOutCheckpoints.points.map((point, index) => {
      exactKeys(point, [
        "id", "observationId", "observationRecordSha256", "modelX", "modelY", "modelZ",
        "longitude", "latitude", "ellipsoidalHeightM",
      ], [], "heldOutCheckpoints.points[" + index + "]");
      if (typeof point.id !== "string" || !SAFE_ID.test(point.id) ||
          checkpointIds.has(point.id) || fitIds.has(point.id)) {
        throw new TypeError("Held-out checkpoint IDs must be valid, unique and disjoint from all fitting control IDs.");
      }
      if (typeof point.observationId !== "string" || !SAFE_ID.test(point.observationId) ||
          checkpointObservationIds.has(point.observationId) || fitObservationIds.has(point.observationId)) {
        throw new TypeError("Held-out observation IDs must be valid, unique and disjoint from fitting observation IDs.");
      }
      if (!HASH.test(point.observationRecordSha256 ?? "")) {
        throw new TypeError("Each held-out checkpoint requires a declared survey observation-record SHA-256.");
      }
      checkpointIds.add(point.id);
      checkpointObservationIds.add(point.observationId);
      for (const key of ["modelX", "modelY", "modelZ", "longitude", "latitude", "ellipsoidalHeightM"]) {
        if (typeof point[key] !== "number" || !Number.isFinite(point[key])) {
          throw new TypeError("heldOutCheckpoints.points[" + index + "]." + key + " must be finite.");
        }
      }
      if (Math.abs(point.modelX) > 100000 || Math.abs(point.modelY) > 100000 ||
          Math.abs(point.modelZ) > 100000 ||
          point.longitude < -180 || point.longitude > 180 ||
          point.latitude < -85 || point.latitude > 85 ||
          point.ellipsoidalHeightM < -12000 || point.ellipsoidalHeightM > 100000) {
        throw new RangeError("Held-out checkpoint coordinates are outside the supported model/WGS84/EPSG:4979 ranges.");
      }
      return {
        id: point.id,
        observationId: point.observationId,
        observationRecordSha256: point.observationRecordSha256,
        modelX: point.modelX,
        modelY: point.modelY,
        modelZ: point.modelZ,
        longitude: point.longitude,
        latitude: point.latitude,
        ellipsoidalHeightM: point.ellipsoidalHeightM,
      };
    });
    heldOutCheckpoints = {
      crs: "EPSG:4979",
      heightType: "ellipsoidal",
      unit: "metre",
      referenceFrame: vertical.referenceFrame,
      coordinateEpoch: vertical.coordinateEpoch,
      survey: {
        method: checkpointSurvey.method.trim(),
        reference: checkpointSurvey.reference.trim(),
        observedAtUtc: checkpointSurvey.observedAtUtc,
        horizontalAccuracyM: checkpointSurvey.horizontalAccuracyM,
        verticalAccuracyM: checkpointSurvey.verticalAccuracyM,
      },
      points: checkpointPoints,
    };
  } else if (raw.heldOutCheckpoints !== undefined) {
    throw new TypeError("Held-out 3D checkpoints require control-point manifest schema 1.2.0.");
  }

  return {
    schemaVersion: raw.schemaVersion,
    kind: "single-image-control-point-manifest",
    buildingId,
    source: { sourceId, sha256: sourceSha256 },
    horizontalCrs: "EPSG:4326",
    horizontalDatum: "WGS84",
    verticalDatum: vertical ? "EPSG:4979-ellipsoidal" : "not-provided",
    survey: {
      method: raw.survey.method.trim(),
      reference: raw.survey.reference.trim(),
      observedAtUtc: raw.survey.observedAtUtc,
      horizontalAccuracyM: raw.survey.horizontalAccuracyM,
    },
    controlPoints,
    ...(vertical ? { vertical } : {}),
    ...(heldOutCheckpoints ? { heldOutCheckpoints } : {}),
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
    ...(manifest.heldOutCheckpoints ? { heldOutCheckpoints: {
      crs: manifest.heldOutCheckpoints.crs,
      referenceFrame: manifest.heldOutCheckpoints.referenceFrame,
      coordinateEpoch: manifest.heldOutCheckpoints.coordinateEpoch,
      survey: manifest.heldOutCheckpoints.survey,
      pointCount: manifest.heldOutCheckpoints.points.length,
      observationIds: manifest.heldOutCheckpoints.points.map((point) => point.observationId),
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
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? 0 : rounded;
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
  const exactResiduals = heights.map((point) => ({
    point,
    residualM: heightOffsetM + horizontalScale * point.modelY - point.ellipsoidalHeightM,
  }));
  const residuals = exactResiduals.map(({ point, residualM }) => ({
    horizontalControlPointId: point.horizontalControlPointId,
    modelY: point.modelY,
    surveyedEllipsoidalHeightM: point.ellipsoidalHeightM,
    predictedEllipsoidalHeightM: round(heightOffsetM + horizontalScale * point.modelY),
    residualM: round(residualM),
    evidenceSourceId: point.evidenceSourceId,
  }));
  const rmsErrorM = Math.sqrt(exactResiduals.reduce((sum, item) => sum + item.residualM ** 2, 0) / exactResiduals.length);
  const maxErrorM = Math.max(...exactResiduals.map((item) => Math.abs(item.residualM)));
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
  const independentCheckpointEvidence = createIndependent3DCheckpointEvidence({
    loadedManifest, modelSha256, horizontalRegistration: registration, verticalEvidence,
  });
  return {
    schemaVersion: loadedManifest.manifest.heldOutCheckpoints ? "1.2.0" :
      loadedManifest.manifest.vertical ? "1.1.0" : "1.0.0",
    status: registration.status,
    modelSha256,
    maxGcpRmsErrorM,
    maxGcpResidualM,
    manifest: manifestSummary(loadedManifest),
    registration,
    ...(loadedManifest.manifest.vertical ? { verticalEvidence } : {}),
    ...(loadedManifest.manifest.heldOutCheckpoints ? { independentCheckpointEvidence } : {}),
  };
}


function createIndependent3DCheckpointEvidence({
  loadedManifest,
  modelSha256,
  horizontalRegistration,
  verticalEvidence,
}) {
  const checkpoints = loadedManifest?.manifest?.heldOutCheckpoints ?? null;
  if (!checkpoints) {
    return {
      schemaVersion: "1.0.0", status: "not-requested", modelSha256,
      controlPointManifestSha256: loadedManifest?.sha256 ?? null,
      mapReady: false, publicationEligible: false, automaticApproval: false,
    };
  }
  if (horizontalRegistration?.status !== "calibrated-needs-human-review" ||
      verticalEvidence?.status !== "calibrated-needs-human-review") {
    return {
      schemaVersion: "1.0.0", status: "blocked-fitting-calibration-failed", modelSha256,
      controlPointManifestSha256: loadedManifest.sha256,
      mapReady: false, publicationEligible: false, automaticApproval: false,
      warnings: ["Held-out evaluation cannot run unless both horizontal and vertical fitting calibration pass."],
    };
  }
  const modelXs = checkpoints.points.map((point) => point.modelX);
  const modelZs = checkpoints.points.map((point) => point.modelZ);
  const meanX = modelXs.reduce((sum, value) => sum + value, 0) / modelXs.length;
  const meanZ = modelZs.reduce((sum, value) => sum + value, 0) / modelZs.length;
  let xx = 0, zz = 0, xz = 0;
  for (let index = 0; index < checkpoints.points.length; index++) {
    const x = modelXs[index] - meanX, z = modelZs[index] - meanZ;
    xx += x * x; zz += z * z; xz += x * z;
  }
  if (xx + zz < 0.01 || xx * zz - xz * xz < 1e-8) {
    throw new RangeError("Held-out checkpoints must cover a two-dimensional, non-collinear model X/Z area.");
  }
  const transform = horizontalRegistration.transform;
  const scale = transform.metresPerModelUnit;
  const modelYValues = checkpoints.points.map((point) => point.modelY);
  const modelYSpanM = (Math.max(...modelYValues) - Math.min(...modelYValues)) * scale;
  if (!Number.isFinite(modelYSpanM) || modelYSpanM < 1) {
    throw new RangeError("Held-out 3D checkpoints must span at least 1 metre in the exact horizontal model scale.");
  }
  const theta = transform.rotationFromModelXToEastNorthDegrees * Math.PI / 180;
  const cosine = Math.cos(theta), sine = Math.sin(theta);
  const origin = horizontalRegistration.referenceOrigin;
  const lon0 = origin.longitude * Math.PI / 180;
  const lat0 = origin.latitude * Math.PI / 180;
  const cosLat0 = Math.cos(lat0);
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(cosLat0) || Math.abs(cosLat0) < 1e-6) {
    throw new TypeError("Held-out evaluation requires the exact valid D3M-13 horizontal transform and local projection origin.");
  }
  const radians = (degrees) => degrees * Math.PI / 180;
  const wrapRadians = (value) => ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const predicted = checkpoints.points.map((point) => {
    const predictedEast = scale * (cosine * point.modelX - sine * point.modelZ) + transform.translationEastM;
    const predictedNorth = scale * (sine * point.modelX + cosine * point.modelZ) + transform.translationNorthM;
    const targetEast = wrapRadians(radians(point.longitude) - lon0) * 6378137 * cosLat0;
    const targetNorth = (radians(point.latitude) - lat0) * 6378137;
    const eastResidualM = predictedEast - targetEast;
    const northResidualM = predictedNorth - targetNorth;
    const horizontalErrorM = Math.hypot(eastResidualM, northResidualM);
    const predictedLongitude = wrapRadians(lon0 + predictedEast / (6378137 * cosLat0)) * 180 / Math.PI;
    const predictedLatitude = (lat0 + predictedNorth / 6378137) * 180 / Math.PI;
    if (!Number.isFinite(predictedLongitude) || !Number.isFinite(predictedLatitude) ||
        predictedLatitude < -85 || predictedLatitude > 85) {
      throw new RangeError("Held-out checkpoint prediction falls outside the supported local WGS84 latitude range.");
    }
    const predictedEllipsoidalHeightM = verticalEvidence.heightOffsetM + scale * point.modelY;
    const verticalResidualM = predictedEllipsoidalHeightM - point.ellipsoidalHeightM;
    const spatial3dErrorM = Math.hypot(horizontalErrorM, verticalResidualM);
    return {
      id: point.id, observationId: point.observationId,
      observationRecordSha256: point.observationRecordSha256,
      model: { x: point.modelX, y: point.modelY, z: point.modelZ },
      surveyed: { longitude: point.longitude, latitude: point.latitude, ellipsoidalHeightM: point.ellipsoidalHeightM },
      predicted: {
        longitude: Number(predictedLongitude.toFixed(9)),
        latitude: Number(predictedLatitude.toFixed(9)),
        ellipsoidalHeightM: round(predictedEllipsoidalHeightM),
      },
      horizontalEastResidualM: round(eastResidualM),
      horizontalNorthResidualM: round(northResidualM),
      horizontalErrorM: round(horizontalErrorM),
      verticalResidualM: round(verticalResidualM),
      spatial3dErrorM: round(spatial3dErrorM),
      _horizontalErrorExact: horizontalErrorM,
      _verticalResidualExact: verticalResidualM,
      _spatial3dErrorExact: spatial3dErrorM,
      evidence: "manifest-declared-held-out-observation",
    };
  });
  const horizontalErrors = predicted.map((point) => point._horizontalErrorExact);
  const verticalErrors = predicted.map((point) => point._verticalResidualExact);
  const spatialErrors = predicted.map((point) => point._spatial3dErrorExact);
  const reportPoints = predicted.map((point) => {
    const { _horizontalErrorExact, _verticalResidualExact, _spatial3dErrorExact, ...reportPoint } = point;
    return reportPoint;
  });
  const rms = (values) => Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length);
  const maxAbs = (values) => Math.max(...values.map((value) => Math.abs(value)));
  const horizontalRmsErrorM = rms(horizontalErrors);
  const horizontalMaxResidualM = maxAbs(horizontalErrors);
  const verticalRmsErrorM = rms(verticalErrors);
  const verticalMaxResidualM = maxAbs(verticalErrors);
  const spatial3dRmsErrorM = rms(spatialErrors);
  const spatial3dMaxResidualM = maxAbs(spatialErrors);
  const maxHorizontalRms = horizontalRegistration.controls.maxRmsErrorM;
  const maxHorizontalResidual = horizontalRegistration.controls.maxAllowedResidualM;
  const maxVerticalRms = verticalEvidence.controls.maxRmsErrorM;
  const maxVerticalResidual = verticalEvidence.controls.maxAllowedResidualM;
  const maxSpatial3dRms = Math.hypot(maxHorizontalRms, maxVerticalRms);
  const maxSpatial3dResidual = Math.hypot(maxHorizontalResidual, maxVerticalResidual);
  const thresholdPass = horizontalRmsErrorM <= maxHorizontalRms &&
    horizontalMaxResidualM <= maxHorizontalResidual &&
    verticalRmsErrorM <= maxVerticalRms && verticalMaxResidualM <= maxVerticalResidual &&
    spatial3dRmsErrorM <= maxSpatial3dRms && spatial3dMaxResidualM <= maxSpatial3dResidual;
  return {
    schemaVersion: "1.0.0",
    status: thresholdPass ? "validated-needs-human-review" : "validation-failed-review-required",
    modelSha256, controlPointManifestSha256: loadedManifest.sha256,
    referenceFrame: checkpoints.referenceFrame, coordinateEpoch: checkpoints.coordinateEpoch,
    survey: checkpoints.survey, fittingControlsExcluded: true,
    horizontalTransform: {
      horizontalMetresPerModelUnit: scale,
      rotationFromModelXToEastNorthDegrees: transform.rotationFromModelXToEastNorthDegrees,
      translationEastM: transform.translationEastM, translationNorthM: transform.translationNorthM,
      referenceOrigin: horizontalRegistration.referenceOrigin,
      fitControlPointIds: horizontalRegistration.controls.ids,
    },
    verticalTransform: {
      verticalDatum: "EPSG:4979-ellipsoidal", heightOffsetM: verticalEvidence.heightOffsetM,
      horizontalMetresPerModelUnit: scale, fitControlPointIds: verticalEvidence.controls.ids,
    },
    controls: {
      count: reportPoints.length, ids: reportPoints.map((point) => point.id),
      observationIds: reportPoints.map((point) => point.observationId), residuals: reportPoints,
      horizontalRmsErrorM: round(horizontalRmsErrorM),
      horizontalMaxResidualM: round(horizontalMaxResidualM),
      maxHorizontalRmsErrorM: maxHorizontalRms, maxHorizontalResidualM: maxHorizontalResidual,
      verticalRmsErrorM: round(verticalRmsErrorM),
      verticalMaxResidualM: round(verticalMaxResidualM),
      maxVerticalRmsErrorM: maxVerticalRms, maxVerticalResidualM: maxVerticalResidual,
      spatial3dRmsErrorM: round(spatial3dRmsErrorM),
      spatial3dMaxResidualM: round(spatial3dMaxResidualM),
      maxSpatial3dRmsErrorM: round(maxSpatial3dRms),
      maxSpatial3dResidualM: round(maxSpatial3dResidual), thresholdPass,
    },
    mapReady: false, publicationEligible: false, automaticApproval: false,
    warnings: [
      "Held-out observations are hash-declared inside the exact manifest; original field-book/GNSS bytes are not independently retrieved or verified here.",
      "Checkpoint model coordinates and physical feature correspondence remain operator-supplied and require independent human adjudication.",
      "Held-out residuals evaluate only the supplied model coordinates and WGS 84 ellipsoidal observations; they do not establish architectural completeness or source rights.",
      "Passing synthetic evaluator tests is not a real-world accuracy result and never enables map publication.",
    ],
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
  const hasVerticalEvidence = ["1.1.0", "1.2.0"].includes(evidence?.schemaVersion);
  const hasIndependentCheckpoints = evidence?.schemaVersion === "1.2.0";
  exactKeys(
    evidence,
    ["schemaVersion", "status", "modelSha256", "maxGcpRmsErrorM", "maxGcpResidualM",
      "manifest", "registration", ...(hasVerticalEvidence ? ["verticalEvidence"] : []),
      ...(hasIndependentCheckpoints ? ["independentCheckpointEvidence"] : [])],
    [],
    "Single-image georeference evidence",
  );
  if (!["1.0.0", "1.1.0", "1.2.0"].includes(evidence.schemaVersion) || evidence.modelSha256 !== modelSha256) {
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
        "verticalDatum", "survey", ...(hasVerticalEvidence ? ["vertical"] : []),
        ...(hasIndependentCheckpoints ? ["heldOutCheckpoints"] : [])],
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
