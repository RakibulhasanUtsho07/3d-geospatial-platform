import { createHash } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const COMMIT = /^[a-f0-9]{7,64}$/i;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeRelative(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    !value.includes("\\") && !value.startsWith("/") && !/^[a-z]:/i.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Geometry payload contains a non-finite number.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) throw new TypeError("Geometry payload must contain JSON-compatible values only.");
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError("Geometry payload must not contain undefined values.");
    result[key] = canonicalize(value[key]);
  }
  return result;
}

/**
 * Hash only the geometry that participates in the independent comparison.
 * Stable key ordering makes the digest independent of source JSON property order.
 */
export function geometryPayloadSha256(geometry = {}) {
  if (!object(geometry)) throw new TypeError("geometry payload must be an object.");
  const payload = {
    coordinateFrameId: geometry.coordinateFrameId ?? null,
    units: geometry.units ?? null,
    footprint: geometry.footprint ?? null,
    dimensionsM: geometry.dimensionsM ?? null,
    checkPoints: geometry.checkPoints ?? null,
    surfaceMesh: geometry.surfaceMesh ?? null,
  };
  return sha256(JSON.stringify(canonicalize(payload)));
}

/**
 * Validate the declared provenance envelope. The filesystem CLI must additionally
 * hash the actual extractor and configuration files before it can report their
 * byte-integrity checks as passed.
 */
export function validateGeometryExtractionProvenance({
  provenance, sourceSha256, geometrySha256, coordinateFrameId, units, label = "geometry",
} = {}) {
  const checks = [];
  const add = (id, passed, detail, severity = "failed") => {
    checks.push({ id, status: passed ? "passed" : severity === "warning" ? "warning" : "failed", detail });
  };
  if (!object(provenance)) {
    add(label + "-extraction-provenance-present", false,
      "A versioned geometry extraction record is required before this evidence can be accepted.", "warning");
    return { status: "incomplete", checks, provenance: null };
  }

  const extractor = provenance.extractor;
  const structureValid = provenance.schemaVersion === "1.0.0" &&
    typeof provenance.extractionRunId === "string" && ID.test(provenance.extractionRunId) &&
    typeof provenance.method === "string" && provenance.method.trim().length > 0 &&
    typeof provenance.extractedAt === "string" && Number.isFinite(Date.parse(provenance.extractedAt)) &&
    object(extractor) && typeof extractor.id === "string" && ID.test(extractor.id) &&
    typeof extractor.version === "string" && extractor.version.trim().length > 0 &&
    typeof extractor.commitSha === "string" && COMMIT.test(extractor.commitSha) &&
    safeRelative(extractor.artifactPath) && HASH.test(extractor.artifactSha256 ?? "") &&
    safeRelative(extractor.configurationPath) && HASH.test(extractor.configurationSha256 ?? "") &&
    HASH.test(provenance.inputArtifactSha256 ?? "") &&
    HASH.test(provenance.outputGeometrySha256 ?? "") &&
    typeof provenance.coordinateFrameId === "string" && provenance.coordinateFrameId.trim().length > 0 &&
    provenance.units === "m";
  add(label + "-extraction-provenance-schema", structureValid,
    structureValid ? "Versioned extractor, exact extractor/config digests, run ID and geometry payload digest are declared." :
      "Extraction provenance has a missing or invalid schema field, extractor identity, path, SHA-256, run ID, timestamp or units.");

  if (!structureValid) return { status: "failed", checks, provenance };

  const inputMatches = HASH.test(sourceSha256 ?? "") &&
    provenance.inputArtifactSha256.toLowerCase() === sourceSha256.toLowerCase();
  add(label + "-extraction-input-binding", inputMatches,
    inputMatches ? "Extraction provenance is bound to the expected source artifact SHA-256." :
      "Extraction input SHA-256 does not match the candidate GLB or independent truth source.");

  const outputMatches = HASH.test(geometrySha256 ?? "") &&
    provenance.outputGeometrySha256.toLowerCase() === geometrySha256.toLowerCase();
  add(label + "-extraction-output-binding", outputMatches,
    outputMatches ? "Extraction provenance matches the deterministic geometry payload SHA-256." :
      "Extraction output digest does not match the supplied geometry values.");

  const frameMatches = provenance.coordinateFrameId === coordinateFrameId && units === "m";
  add(label + "-extraction-coordinate-frame", frameMatches,
    frameMatches ? "Extraction provenance uses the evaluated metre-based coordinate frame." :
      "Extraction provenance coordinate-frame ID or metre units disagree with the geometry under evaluation.");

  const failed = checks.some((check) => check.status === "failed");
  const incomplete = checks.some((check) => check.status === "warning");
  return { status: failed ? "failed" : incomplete ? "incomplete" : "passed", checks, provenance };
}
