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
  exactKeys(
    raw,
    ["schemaVersion", "kind", "buildingId", "source", "horizontalCrs", "horizontalDatum",
      "verticalDatum", "survey", "controlPoints"],
    [],
    "Control-point manifest",
  );
  if (raw.schemaVersion !== "1.0.0" ||
      raw.kind !== "single-image-control-point-manifest" ||
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
  return {
    schemaVersion: "1.0.0",
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

export function createSingleImageGeoreferenceEvidence({
  loadedManifest,
  modelSha256,
  maxGcpRmsErrorM = 0.5,
  maxGcpResidualM = 1.0,
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
  // Match the exact JSON representation stored in the workflow/report files.
  // JSON serialization canonicalizes negative zero to zero.
  const registration = JSON.parse(JSON.stringify(registerModelToWgs84({
    controlPoints: loadedManifest.manifest.controlPoints,
    maxRmsErrorM: maxGcpRmsErrorM,
    maxResidualM: maxGcpResidualM,
  })));
  if (registration.vertical?.status !== "not-solved" ||
      registration.mapReady !== false || registration.publicationEligible !== false) {
    throw new TypeError("Ground-control registration changed its unresolved vertical/release boundary.");
  }
  return {
    schemaVersion: "1.0.0",
    status: registration.status,
    modelSha256,
    maxGcpRmsErrorM,
    maxGcpResidualM,
    manifest: manifestSummary(loadedManifest),
    registration,
  };
}

export async function verifySingleImageGeoreferenceEvidence({
  workspaceRoot,
  evidence,
  buildingId,
  sourceId,
  sourceSha256,
  modelSha256,
}) {
  exactKeys(
    evidence,
    ["schemaVersion", "status", "modelSha256", "maxGcpRmsErrorM", "maxGcpResidualM",
      "manifest", "registration"],
    [],
    "Single-image georeference evidence",
  );
  if (evidence.schemaVersion !== "1.0.0" || evidence.modelSha256 !== modelSha256) {
    throw new TypeError("Georeference evidence does not bind this exact GLB candidate.");
  }
  let loadedManifest = null;
  if (evidence.manifest === null) {
    if (evidence.status !== "not-requested" || evidence.registration !== null ||
        evidence.maxGcpRmsErrorM !== null || evidence.maxGcpResidualM !== null) {
      throw new TypeError("Unrequested georeference evidence has unexpected calibration data.");
    }
  } else {
    exactKeys(
      evidence.manifest,
      ["path", "bytes", "sha256", "pointCount", "horizontalCrs", "horizontalDatum",
        "verticalDatum", "survey"],
      [],
      "Control-point manifest receipt binding",
    );
    loadedManifest = await loadSingleImageControlPointManifest({
      workspaceRoot,
      relativePath: evidence.manifest.path,
      buildingId,
      sourceId,
      sourceSha256,
    });
    if (loadedManifest.bytes !== evidence.manifest.bytes ||
        loadedManifest.sha256 !== evidence.manifest.sha256 ||
        loadedManifest.manifest.controlPoints.length !== evidence.manifest.pointCount) {
      throw new Error("Control-point manifest bytes or identity changed after the georeference receipt was written.");
    }
  }
  const expected = createSingleImageGeoreferenceEvidence({
    loadedManifest,
    modelSha256,
    maxGcpRmsErrorM: evidence.maxGcpRmsErrorM,
    maxGcpResidualM: evidence.maxGcpResidualM,
  });
  const { canonicalJson } = await import("./generation-artifact-receipt.mjs");
  if (canonicalJson(expected) !== canonicalJson(evidence)) {
    throw new TypeError("Single-image georeference evidence does not match independently recomputed control-point registration.");
  }
  return expected;
}
