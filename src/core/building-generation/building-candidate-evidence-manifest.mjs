import { REQUIRED_REVIEW_VIEWS } from "./render-review-manifest.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,119}$/i;
const COMMIT = /^[a-f0-9]{7,64}$/i;
const ARTIFACT_TYPES = new Set([
  "candidate-glb", "building-spec", "generation-report", "generation-config",
  "capture-manifest", "source-image", "reference-image", "camera-evidence",
  "camera-calibration", "frame-alignment-evidence", "measurement-evidence",
  "ground-control-evidence", "render-manifest", "render-image", "geometry-qa",
  "texture-qa", "reference-comparison", "accuracy-report",
  "release-readiness-report", "other",
]);
const SIDES = new Set(["front", "back", "left", "right", "corner", "roof", "other", "unknown"]);
const RIGHTS = new Set(["verified", "operator-attested", "unknown", "missing"]);
const PURPOSES = new Set(["capture", "reference", "measurement-evidence"]);
const POSE = new Set(["calibrated", "estimated", "supplied", "unknown", "missing"]);
const PROOF = new Set(["verified", "estimated", "unknown", "missing"]);
const CONFIDENCE = new Set(["measured", "observed", "inferred", "unknown", "missing"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const hashOk = (value) => typeof value === "string" && SHA256.test(value);
const idOk = (value) => typeof value === "string" && ID.test(value);
const dateOk = (value) => nonEmpty(value) && Number.isFinite(Date.parse(value));
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function requireObject(value, label) {
  if (!object(value)) throw new TypeError(label + " must be an object");
  return value;
}
function requireId(value, label) {
  if (!idOk(value)) throw new TypeError(label + " must be a safe identifier");
  return value;
}
function relativePathOk(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") || value.startsWith("/") ||
      /^[a-z]:/i.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}
function uniqueIds(values, label) {
  if (new Set(values).size !== values.length) throw new TypeError(label + " must not contain duplicate IDs");
}
function normaliseIds(value, label, max = 300) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(label + " must be an array of at most " + max + " IDs");
  const ids = value.map((item, index) => requireId(item, label + "[" + index + "]"));
  uniqueIds(ids, label);
  return ids;
}
function normaliseConfidence(raw, key, artifactIds) {
  const value = requireObject(raw ?? { status: "missing", evidenceArtifactIds: [] }, "confidence." + key);
  const status = value.status ?? "missing";
  if (!CONFIDENCE.has(status)) throw new TypeError("confidence." + key + ".status is unsupported");
  const evidenceArtifactIds = normaliseIds(value.evidenceArtifactIds ?? [], "confidence." + key + ".evidenceArtifactIds");
  for (const id of evidenceArtifactIds) {
    if (!artifactIds.has(id)) throw new TypeError("confidence." + key + " references unknown artifact: " + id);
  }
  if (["measured", "observed", "inferred"].includes(status) && evidenceArtifactIds.length === 0) {
    throw new TypeError("confidence." + key + " requires supporting artifact IDs for status " + status);
  }
  return { status, evidenceArtifactIds };
}
function normaliseArtifact(raw, index) {
  const item = requireObject(raw, "artifacts[" + index + "]");
  const id = requireId(item.id, "artifacts[" + index + "].id");
  if (!ARTIFACT_TYPES.has(item.type)) throw new TypeError("artifacts[" + index + "].type is unsupported");
  const status = item.status ?? "present";
  if (!["present", "missing"].includes(status)) throw new TypeError("artifacts[" + index + "].status must be present or missing");
  const out = { id, type: item.type, status };
  if (status === "present") {
    if (!relativePathOk(item.relativePath)) throw new TypeError("artifacts[" + index + "].relativePath must be a safe project-relative path");
    if (!hashOk(item.sha256)) throw new TypeError("artifacts[" + index + "].sha256 must be a 64-character SHA-256 hash");
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 1) throw new TypeError("artifacts[" + index + "].bytes must be a positive integer");
    out.relativePath = item.relativePath;
    out.sha256 = item.sha256.toLowerCase();
    out.bytes = item.bytes;
    if (item.expectedSha256 !== undefined && item.expectedSha256 !== null && item.expectedSha256 !== "") {
      if (!hashOk(item.expectedSha256)) throw new TypeError("artifacts[" + index + "].expectedSha256 is invalid");
      out.expectedSha256 = item.expectedSha256.toLowerCase();
    }
  } else {
    if (item.sha256 !== undefined || item.bytes !== undefined || item.expectedSha256 !== undefined) {
      throw new TypeError("missing artifact " + id + " must not claim hashes or byte length");
    }
    if (item.relativePath !== undefined && item.relativePath !== null && !relativePathOk(item.relativePath)) {
      throw new TypeError("missing artifact " + id + " has an unsafe expected path");
    }
    if (item.relativePath) out.relativePath = item.relativePath;
    if (item.reason !== undefined) {
      if (!nonEmpty(item.reason) || item.reason.length > 500) throw new TypeError("missing artifact reason must be a short non-empty string");
      out.reason = item.reason.trim();
    }
  }
  if (item.subjectBuildingId !== undefined && item.subjectBuildingId !== null) {
    out.subjectBuildingId = requireId(item.subjectBuildingId, "artifacts[" + index + "].subjectBuildingId");
  }
  if (item.sourceId !== undefined && item.sourceId !== null) out.sourceId = requireId(item.sourceId, "artifacts[" + index + "].sourceId");
  if (item.purpose !== undefined && item.purpose !== null) {
    if (!PURPOSES.has(item.purpose)) throw new TypeError("artifacts[" + index + "].purpose is unsupported");
    out.purpose = item.purpose;
  }
  if (item.side !== undefined && item.side !== null) {
    if (!SIDES.has(item.side)) throw new TypeError("artifacts[" + index + "].side is unsupported");
    out.side = item.side;
  }
  if (item.rightsStatus !== undefined && item.rightsStatus !== null) {
    if (!RIGHTS.has(item.rightsStatus)) throw new TypeError("artifacts[" + index + "].rightsStatus is unsupported");
    out.rightsStatus = item.rightsStatus;
  }
  if (item.viewId !== undefined && item.viewId !== null) {
    if (!REQUIRED_REVIEW_VIEWS.includes(item.viewId)) throw new TypeError("artifacts[" + index + "].viewId is not a required review view");
    out.viewId = item.viewId;
  }
  if (item.width !== undefined || item.height !== undefined) {
    if (!Number.isSafeInteger(item.width) || item.width < 1 || !Number.isSafeInteger(item.height) || item.height < 1) {
      throw new TypeError("artifacts[" + index + "] image dimensions must be positive integers");
    }
    out.width = item.width;
    out.height = item.height;
  }
  if (item.contentType !== undefined && item.contentType !== null) {
    if (!nonEmpty(item.contentType) || item.contentType.length > 120) throw new TypeError("artifacts[" + index + "].contentType is invalid");
    out.contentType = item.contentType.trim();
  }
  return out;
}
function artifactRef(id, byId, label, allowedTypes, { allowMissing = false } = {}) {
  if (id === undefined || id === null || id === "") return null;
  requireId(id, label);
  const artifact = byId.get(id);
  if (!artifact) throw new TypeError(label + " references unknown artifact: " + id);
  if (!allowedTypes.includes(artifact.type)) throw new TypeError(label + " references wrong artifact type: " + id);
  if (!allowMissing && artifact.status !== "present") throw new TypeError(label + " must reference a present artifact: " + id);
  return id;
}
function normaliseArtifactOutput(raw, label, byId, types, allowedStatuses, { candidateBinding = true } = {}) {
  const value = requireObject(raw ?? { status: "missing" }, "outputs." + label);
  const status = value.status ?? "missing";
  if (!allowedStatuses.includes(status)) throw new TypeError("outputs." + label + ".status is unsupported");
  const artifactId = artifactRef(value.artifactId, byId, "outputs." + label + ".artifactId", types, { allowMissing: status === "missing" });
  if (status === "missing" && artifactId && byId.get(artifactId).status !== "missing") {
    throw new TypeError("outputs." + label + " marked missing cannot reference a present artifact");
  }
  if (status !== "missing" && (!artifactId || byId.get(artifactId).status !== "present")) {
    throw new TypeError("outputs." + label + " status " + status + " requires a present artifact");
  }
  const out = { status, artifactId };
  if (candidateBinding) {
    if (value.candidateSha256 !== undefined && value.candidateSha256 !== null && value.candidateSha256 !== "") {
      if (!hashOk(value.candidateSha256)) throw new TypeError("outputs." + label + ".candidateSha256 is invalid");
      out.candidateSha256 = value.candidateSha256.toLowerCase();
    } else out.candidateSha256 = null;
    if (status !== "missing" && !out.candidateSha256) throw new TypeError("outputs." + label + " needs the bound candidate GLB SHA-256");
  }
  return out;
}

/**
 * Normalize one building candidate's evidence graph. This validates schema and links,
 * not real-world truth; the assessor separately compares declared hashes to file bytes.
 */
export function normalizeBuildingCandidateEvidenceManifest(input = {}) {
  requireObject(input, "candidate evidence manifest");
  if (input.schemaVersion !== "1.0.0") throw new TypeError("candidate evidence manifest schemaVersion must be 1.0.0");
  const manifestId = requireId(input.manifestId, "manifestId");
  const buildingId = requireId(input.buildingId, "buildingId");
  const candidateId = requireId(input.candidateId, "candidateId");
  if (!dateOk(input.generatedAt)) throw new TypeError("generatedAt must be a valid timestamp");
  const candidateCommit = input.candidateCommit ?? null;
  if (candidateCommit !== null && (typeof candidateCommit !== "string" || !COMMIT.test(candidateCommit))) {
    throw new TypeError("candidateCommit must be a Git commit SHA or null");
  }
  if (!Array.isArray(input.artifacts) || input.artifacts.length < 3 || input.artifacts.length > 300) {
    throw new TypeError("artifacts must contain between 3 and 300 records");
  }
  const artifacts = input.artifacts.map(normaliseArtifact);
  uniqueIds(artifacts.map((artifact) => artifact.id), "artifacts");
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const paths = artifacts.filter((artifact) => artifact.status === "present").map((artifact) => artifact.relativePath);
  uniqueIds(paths, "present artifact relative paths");

  const candidateRaw = requireObject(input.candidate, "candidate");
  const glbArtifactId = artifactRef(candidateRaw.glbArtifactId, artifactById, "candidate.glbArtifactId", ["candidate-glb"]);
  const buildingSpecArtifactId = artifactRef(candidateRaw.buildingSpecArtifactId, artifactById, "candidate.buildingSpecArtifactId", ["building-spec"]);
  const generationReportArtifactId = artifactRef(candidateRaw.generationReportArtifactId, artifactById, "candidate.generationReportArtifactId", ["generation-report"]);
  if ([glbArtifactId, buildingSpecArtifactId, generationReportArtifactId].some((id) =>
      artifactById.get(id).status !== "present" || artifactById.get(id).subjectBuildingId !== buildingId)) {
    throw new TypeError("candidate GLB, BuildingSpec and generation report must be present and bound to the same building");
  }
  const generatorRaw = requireObject(candidateRaw.generator, "candidate.generator");
  for (const key of ["name", "version", "strategy"]) {
    if (!nonEmpty(generatorRaw[key]) || generatorRaw[key].length > 120) throw new TypeError("candidate.generator." + key + " must be a short non-empty string");
  }
  const configurationArtifactId = artifactRef(generatorRaw.configurationArtifactId, artifactById,
    "candidate.generator.configurationArtifactId", ["generation-config"]);
  const candidate = {
    glbArtifactId, buildingSpecArtifactId, generationReportArtifactId,
    generator: { name: generatorRaw.name.trim(), version: generatorRaw.version.trim(), strategy: generatorRaw.strategy.trim(), configurationArtifactId },
  };

  const evidenceRaw = requireObject(input.evidence ?? {}, "evidence");
  const captureManifest = requireObject(evidenceRaw.captureManifest ?? { status: "missing" }, "evidence.captureManifest");
  const captureManifestStatus = captureManifest.status ?? "missing";
  if (!["verified", "incomplete", "failed", "missing"].includes(captureManifestStatus)) {
    throw new TypeError("evidence.captureManifest.status is unsupported");
  }
  const captureManifestArtifactId = artifactRef(captureManifest.artifactId, artifactById,
    "evidence.captureManifest.artifactId", ["capture-manifest"], { allowMissing: captureManifestStatus !== "verified" });
  if (captureManifestStatus === "verified" && (!captureManifestArtifactId ||
      artifactById.get(captureManifestArtifactId).status !== "present" ||
      artifactById.get(captureManifestArtifactId).subjectBuildingId !== buildingId)) {
    throw new TypeError("verified capture manifest requires a present artifact explicitly bound to the same building");
  }
  const captureArtifactIds = normaliseIds(evidenceRaw.captureArtifactIds ?? [], "evidence.captureArtifactIds", 200);
  for (const id of captureArtifactIds) {
    const artifact = artifactById.get(id);
    if (!artifact || artifact.type !== "source-image" || artifact.status !== "present" ||
        artifact.purpose !== "capture" || artifact.subjectBuildingId !== buildingId) {
      throw new TypeError("captureArtifactIds must reference present source-image artifacts for this building with purpose capture");
    }
  }
  const referenceArtifactIds = normaliseIds(evidenceRaw.referenceArtifactIds ?? [], "evidence.referenceArtifactIds", 200);
  for (const id of referenceArtifactIds) {
    const artifact = artifactById.get(id);
    if (!artifact || artifact.type !== "reference-image" || artifact.status !== "present" ||
        artifact.purpose !== "reference" || artifact.subjectBuildingId !== buildingId) {
      throw new TypeError("referenceArtifactIds must reference present reference-image artifacts for this building with purpose reference");
    }
  }
  const cameraEvidenceRaw = evidenceRaw.cameraEvidence ?? [];
  if (!Array.isArray(cameraEvidenceRaw) || cameraEvidenceRaw.length > 200) throw new TypeError("evidence.cameraEvidence must be an array of at most 200 records");
  const cameraEvidence = cameraEvidenceRaw.map((raw, index) => {
    const item = requireObject(raw, "evidence.cameraEvidence[" + index + "]");
    const id = requireId(item.id, "evidence.cameraEvidence[" + index + "].id");
    const sourceImageArtifactId = artifactRef(item.sourceImageArtifactId, artifactById,
      "evidence.cameraEvidence[" + index + "].sourceImageArtifactId", ["source-image"]);
    if (!captureArtifactIds.includes(sourceImageArtifactId)) throw new TypeError("camera evidence must reference one of the declared capture images");
    const cameraArtifactId = artifactRef(item.cameraArtifactId, artifactById,
      "evidence.cameraEvidence[" + index + "].cameraArtifactId", ["camera-evidence"], { allowMissing: true });
    const calibrationArtifactId = artifactRef(item.calibrationArtifactId, artifactById,
      "evidence.cameraEvidence[" + index + "].calibrationArtifactId", ["camera-calibration"], { allowMissing: true });
    const frameAlignmentArtifactId = artifactRef(item.frameAlignmentArtifactId, artifactById,
      "evidence.cameraEvidence[" + index + "].frameAlignmentArtifactId", ["frame-alignment-evidence"], { allowMissing: true });
    const poseStatus = item.poseStatus ?? "unknown";
    const calibrationStatus = item.calibrationStatus ?? "unknown";
    const frameAlignmentStatus = item.frameAlignmentStatus ?? "unknown";
    if (!POSE.has(poseStatus) || !PROOF.has(calibrationStatus) || !PROOF.has(frameAlignmentStatus)) {
      throw new TypeError("camera evidence status is unsupported for " + id);
    }
    if (["calibrated", "estimated", "supplied"].includes(poseStatus) &&
        (!cameraArtifactId || artifactById.get(cameraArtifactId).status !== "present")) {
      throw new TypeError("camera evidence with a declared pose requires a present camera artifact: " + id);
    }
    if (calibrationStatus === "verified" &&
        (!calibrationArtifactId || artifactById.get(calibrationArtifactId).status !== "present")) {
      throw new TypeError("verified calibration requires a present calibration artifact: " + id);
    }
    if (frameAlignmentStatus === "verified" &&
        (!frameAlignmentArtifactId || artifactById.get(frameAlignmentArtifactId).status !== "present")) {
      throw new TypeError("verified frame alignment requires a present frame-alignment artifact: " + id);
    }
    return { id, sourceImageArtifactId, cameraArtifactId, calibrationArtifactId, frameAlignmentArtifactId, poseStatus, calibrationStatus, frameAlignmentStatus };
  });
  uniqueIds(cameraEvidence.map((item) => item.id), "evidence.cameraEvidence IDs");
  uniqueIds(cameraEvidence.map((item) => item.sourceImageArtifactId), "evidence.cameraEvidence source images");

  const dimensionsRaw = requireObject(evidenceRaw.independentDimensions ?? { status: "missing", basis: "missing" }, "evidence.independentDimensions");
  const dimensionsStatus = dimensionsRaw.status ?? "missing";
  const dimensionsBasis = dimensionsRaw.basis ?? "missing";
  if (!["verified", "estimated", "unknown", "missing"].includes(dimensionsStatus)) throw new TypeError("independentDimensions.status is unsupported");
  if (!["surveyed", "published-measurement", "operator-estimate", "inferred", "missing"].includes(dimensionsBasis)) throw new TypeError("independentDimensions.basis is unsupported");
  const dimensionsArtifactId = artifactRef(dimensionsRaw.artifactId, artifactById,
    "evidence.independentDimensions.artifactId", ["measurement-evidence"], { allowMissing: dimensionsStatus !== "verified" });
  const valuesM = dimensionsRaw.valuesM ?? null;
  const uncertaintyM = dimensionsRaw.uncertaintyM ?? null;
  if (valuesM !== null) {
    requireObject(valuesM, "evidence.independentDimensions.valuesM");
    for (const axis of ["x", "y", "z"]) if (!finite(valuesM[axis]) || valuesM[axis] <= 0) {
      throw new TypeError("independent dimension " + axis + " must be a positive finite metre value");
    }
  }
  if (uncertaintyM !== null) {
    requireObject(uncertaintyM, "evidence.independentDimensions.uncertaintyM");
    for (const axis of ["x", "y", "z"]) if (!finite(uncertaintyM[axis]) || uncertaintyM[axis] < 0) {
      throw new TypeError("independent dimension uncertainty " + axis + " must be finite and non-negative");
    }
  }
  if (dimensionsStatus === "verified" &&
      (!dimensionsArtifactId || artifactById.get(dimensionsArtifactId).status !== "present" ||
       !["surveyed", "published-measurement"].includes(dimensionsBasis) || !valuesM || !uncertaintyM)) {
    throw new TypeError("verified independent dimensions require surveyed/published evidence, positive values and uncertainty");
  }

  const groundRaw = requireObject(evidenceRaw.groundControl ?? { status: "missing", coordinateFrame: "unknown" }, "evidence.groundControl");
  const groundStatus = groundRaw.status ?? "missing";
  const coordinateFrame = groundRaw.coordinateFrame ?? "unknown";
  if (!PROOF.has(groundStatus)) throw new TypeError("groundControl.status is unsupported");
  if (!["WGS84", "local-ENU", "unknown"].includes(coordinateFrame)) throw new TypeError("groundControl.coordinateFrame is unsupported");
  const groundControlArtifactId = artifactRef(groundRaw.artifactId, artifactById,
    "evidence.groundControl.artifactId", ["ground-control-evidence"], { allowMissing: groundStatus !== "verified" });
  if (groundStatus === "verified" && (!groundControlArtifactId || coordinateFrame === "unknown")) {
    throw new TypeError("verified ground control requires a ground-control artifact and declared coordinate frame");
  }

  const outputsRaw = requireObject(input.outputs ?? {}, "outputs");
  const renderManifest = normaliseArtifactOutput(outputsRaw.renderManifest, "renderManifest", artifactById, ["render-manifest"], ["ready", "partial", "missing"], { candidateBinding: true });
  const requiredViewIds = normaliseIds(renderManifest.status === "missing" ? [] : (outputsRaw.renderManifest?.requiredViewIds ?? REQUIRED_REVIEW_VIEWS),
    "outputs.renderManifest.requiredViewIds", REQUIRED_REVIEW_VIEWS.length);
  for (const id of requiredViewIds) if (!REQUIRED_REVIEW_VIEWS.includes(id)) throw new TypeError("outputs.renderManifest contains unsupported view ID: " + id);
  const renderViewArtifactIds = normaliseIds(outputsRaw.renderManifest?.renderViewArtifactIds ?? [], "outputs.renderManifest.renderViewArtifactIds", 50);
  for (const id of renderViewArtifactIds) {
    const artifact = artifactById.get(id);
    if (!artifact || artifact.type !== "render-image" || artifact.status !== "present" || !artifact.viewId) {
      throw new TypeError("renderViewArtifactIds must reference present render-image artifacts with viewId metadata");
    }
  }
  uniqueIds(renderViewArtifactIds.map((id) => artifactById.get(id).viewId), "outputs.renderManifest rendered view IDs");
  const geometryQa = normaliseArtifactOutput(outputsRaw.geometryQa, "geometryQa", artifactById, ["geometry-qa"], ["passed", "warning", "failed", "missing"]);
  const textureQa = normaliseArtifactOutput(outputsRaw.textureQa, "textureQa", artifactById, ["texture-qa"], ["passed", "warning", "failed", "missing"]);
  const referenceComparison = normaliseArtifactOutput(outputsRaw.referenceComparison, "referenceComparison", artifactById, ["reference-comparison"],
    ["comparable", "partial", "not-comparable", "missing"]);
  const comparableViewCount = outputsRaw.referenceComparison?.comparableViewCount ?? 0;
  if (!Number.isSafeInteger(comparableViewCount) || comparableViewCount < 0 || comparableViewCount > REQUIRED_REVIEW_VIEWS.length) {
    throw new TypeError("outputs.referenceComparison.comparableViewCount is invalid");
  }
  const comparisonReferenceArtifactIds = normaliseIds(outputsRaw.referenceComparison?.referenceArtifactIds ?? [], "outputs.referenceComparison.referenceArtifactIds", 200);
  for (const id of comparisonReferenceArtifactIds) if (!referenceArtifactIds.includes(id)) {
    throw new TypeError("reference comparison can only use declared reference artifacts");
  }
  const accuracyReport = normaliseArtifactOutput(outputsRaw.accuracyReport, "accuracyReport", artifactById, ["accuracy-report"], ["verified", "incomplete", "failed", "missing"]);
  const releaseReadiness = normaliseArtifactOutput(outputsRaw.releaseReadiness, "releaseReadiness", artifactById, ["release-readiness-report"],
    ["ready-for-final-human-review", "ready-for-final-human-review-with-warnings", "blocked", "missing"]);
  if (typeof (outputsRaw.releaseReadiness?.publicationEligible ?? false) !== "boolean") {
    throw new TypeError("outputs.releaseReadiness.publicationEligible must be boolean");
  }
  const confidenceRaw = requireObject(input.confidence ?? {}, "confidence");
  const confidence = {};
  for (const key of ["identity", "dimensions", "geometry", "facadeLayout", "appearance", "georeference"]) {
    confidence[key] = normaliseConfidence(confidenceRaw[key], key, artifactById);
  }

  return {
    schemaVersion: "1.0.0",
    engine: "building-candidate-evidence-manifest-v1",
    manifestId, candidateId, buildingId,
    generatedAt: new Date(input.generatedAt).toISOString(),
    candidateCommit,
    candidate,
    artifacts,
    evidence: {
      captureManifest: { status: captureManifestStatus, artifactId: captureManifestArtifactId },
      captureArtifactIds,
      referenceArtifactIds,
      cameraEvidence,
      independentDimensions: { status: dimensionsStatus, basis: dimensionsBasis, artifactId: dimensionsArtifactId, valuesM, uncertaintyM },
      groundControl: { status: groundStatus, artifactId: groundControlArtifactId, coordinateFrame },
    },
    outputs: {
      renderManifest: { ...renderManifest, requiredViewIds, renderViewArtifactIds },
      geometryQa,
      textureQa,
      referenceComparison: { ...referenceComparison, comparableViewCount, referenceArtifactIds: comparisonReferenceArtifactIds },
      accuracyReport,
      releaseReadiness: { ...releaseReadiness, publicationEligible: outputsRaw.releaseReadiness?.publicationEligible ?? false },
    },
    confidence,
  };
}

/**
 * Assess a normalized candidate manifest against actual file hashes and cross-artifact
 * bindings. Missing evidence is incomplete; contradictory hashes/identities fail closed.
 */
export function assessBuildingCandidateEvidenceManifest(input = {}, options = {}) {
  const manifest = normalizeBuildingCandidateEvidenceManifest(input);
  const checks = [];
  const failures = [];
  const warnings = [];
  const record = (id, passed, detail, severity = "warning") => {
    const status = passed ? "passed" : severity === "failed" ? "failed" : "warning";
    const check = { id, status, detail };
    checks.push(check);
    if (!passed && severity === "failed") failures.push(check);
    else if (!passed) warnings.push(check);
  };
  const byId = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const candidateHash = byId.get(manifest.candidate.glbArtifactId).sha256;
  const captureArtifacts = manifest.evidence.captureArtifactIds.map((id) => byId.get(id));
  const referenceArtifacts = manifest.evidence.referenceArtifactIds.map((id) => byId.get(id));
  const sideCoverage = (artifacts) => new Set(artifacts.map((artifact) => artifact.side));
  const requiredSides = ["front", "back", "left", "right"];
  const captureSides = sideCoverage(captureArtifacts);
  const referenceSides = sideCoverage(referenceArtifacts);
  const coversSides = (set) => requiredSides.every((side) => set.has(side));

  const actualArtifacts = options.actualArtifacts;
  if (!Array.isArray(actualArtifacts)) {
    record("actual-artifact-bytes-verified", false,
      "Actual artifact bytes were not supplied; declared hashes alone are not a filesystem integrity check.");
  } else {
    const actualById = new Map();
    let actualListValid = true;
    for (const [index, item] of actualArtifacts.entries()) {
      if (!object(item) || !idOk(item.id) || !relativePathOk(item.relativePath) ||
          !hashOk(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || actualById.has(item.id)) {
        actualListValid = false;
        break;
      }
      const declared = byId.get(item.id);
      if (!declared || declared.status !== "present" || declared.relativePath !== item.relativePath) {
        actualListValid = false;
        break;
      }
      actualById.set(item.id, { relativePath: item.relativePath, sha256: item.sha256.toLowerCase(), bytes: item.bytes });
    }
    record("actual-artifact-list-valid", actualListValid,
      "Actual file evidence must have unique IDs, byte lengths and SHA-256 hashes.", "failed");
    if (actualListValid) {
      let complete = true;
      for (const artifact of manifest.artifacts.filter((item) => item.status === "present")) {
        const actual = actualById.get(artifact.id);
        if (!actual) {
          complete = false;
          record("artifact-bytes-present:" + artifact.id, false, "Actual file bytes were not supplied for " + artifact.id + ".");
          continue;
        }
        const hashMatches = actual.sha256 === artifact.sha256;
        const bytesMatch = actual.bytes === artifact.bytes;
        record("artifact-path-matches:" + artifact.id, actual.relativePath === artifact.relativePath,
          "Actual file must be read from the exact path pinned by the candidate manifest.", "failed");
        record("artifact-hash-matches:" + artifact.id, hashMatches,
          "Actual SHA-256 must match the candidate manifest.", "failed");
        record("artifact-size-matches:" + artifact.id, bytesMatch,
          "Actual byte length must match the candidate manifest.", "failed");
        if (artifact.expectedSha256) {
          record("artifact-independent-hash-pin:" + artifact.id, artifact.expectedSha256 === actual.sha256,
            "Where an independent expected hash is provided it must match actual bytes.", "failed");
        }
      }
      record("actual-artifact-coverage", complete,
        "Every present artifact declared by the manifest must have a corresponding actual-file hash.");
    }
  }

  const sourceHashSet = new Set();
  let duplicateCaptureHash = false;
  for (const artifact of captureArtifacts) {
    if (sourceHashSet.has(artifact.sha256)) duplicateCaptureHash = true;
    sourceHashSet.add(artifact.sha256);
  }
  record("capture-view-independence", !duplicateCaptureHash,
    "Byte-identical captures cannot be counted as independent facade views.", "failed");
  const captureCoverage = captureArtifacts.length >= 4 && coversSides(captureSides) &&
    captureArtifacts.every((artifact) => artifact.rightsStatus === "verified");
  record("capture-coverage-rights", captureCoverage,
    "Capture evidence needs rights-verified front/back/left/right images; operator-attested/unknown rights remain incomplete.");
  const refsIndependent = referenceArtifacts.every((artifact) => !sourceHashSet.has(artifact.sha256));
  record("reference-captures-independent", refsIndependent,
    "Reference images byte-identical to capture images are not independent validation evidence.", "failed");
  const duplicateRefHash = new Set(referenceArtifacts.map((artifact) => artifact.sha256)).size !== referenceArtifacts.length;
  record("reference-view-independence", !duplicateRefHash,
    "Byte-identical references cannot count as separate reference views.", "failed");
  const referenceCoverage = referenceArtifacts.length >= 4 && coversSides(referenceSides) &&
    referenceArtifacts.every((artifact) => artifact.rightsStatus === "verified");
  record("reference-coverage-rights", referenceCoverage,
    "Independent reference evidence needs rights-verified front/back/left/right views.");
  const captureManifest = manifest.evidence.captureManifest;
  record("capture-manifest-declared-not-failed", captureManifest.status !== "failed",
    "A capture manifest explicitly marked failed blocks the candidate evidence package.", "failed");
  record("capture-manifest-present", captureManifest.status === "verified" &&
    captureManifest.artifactId && byId.get(captureManifest.artifactId)?.status === "present",
  "Capture manifest must be present and declared verified before its metadata is treated as verified.");
  if (captureManifest.artifactId) {
    record("capture-manifest-building-binding",
      byId.get(captureManifest.artifactId)?.subjectBuildingId === manifest.buildingId,
      "Capture manifest artifact must identify the same building as the candidate.", "failed");
  }

  const cameraBySource = new Map(manifest.evidence.cameraEvidence.map((camera) => [camera.sourceImageArtifactId, camera]));
  const cameraCoverage = captureArtifacts.length > 0 && captureArtifacts.every((artifact) => cameraBySource.has(artifact.id));
  record("camera-evidence-coverage", cameraCoverage,
    "Each capture image should have a linked camera/pose evidence record.");
  const cameraPosesAcceptable = manifest.evidence.cameraEvidence.length > 0 &&
    manifest.evidence.cameraEvidence.every((camera) => ["calibrated", "estimated", "supplied"].includes(camera.poseStatus));
  record("camera-pose-known", cameraPosesAcceptable,
    "Every camera pose must be calibrated, estimated, or explicitly supplied; unknown poses do not enable measured reprojection.");
  const cameraCalibrated = manifest.evidence.cameraEvidence.length > 0 &&
    manifest.evidence.cameraEvidence.every((camera) => camera.calibrationStatus === "verified");
  record("camera-calibration-verified", cameraCalibrated,
    "Camera calibration is independently verified for every capture.");
  const frameAlignment = manifest.evidence.cameraEvidence.length > 0 &&
    manifest.evidence.cameraEvidence.every((camera) => ["verified", "estimated"].includes(camera.frameAlignmentStatus));
  record("camera-frame-alignment", frameAlignment,
    "Camera and geometry frame alignment must be verified or explicitly estimated.");

  const dimensions = manifest.evidence.independentDimensions;
  const independentDimensions = dimensions.status === "verified" &&
    ["surveyed", "published-measurement"].includes(dimensions.basis) &&
    dimensions.artifactId && dimensions.valuesM && dimensions.uncertaintyM;
  record("independent-dimensions", independentDimensions,
    "Independent dimensions must be survey/published measurements with evidence and stated uncertainty.");
  const ground = manifest.evidence.groundControl;
  const independentGroundControl = ground.status === "verified" && ground.artifactId && ground.coordinateFrame !== "unknown";
  record("ground-control-evidence", independentGroundControl,
    "Georeference is independently verified only with reviewed ground control and a declared coordinate frame.");

  const render = manifest.outputs.renderManifest;
  const renderArtifact = render.artifactId ? byId.get(render.artifactId) : null;
  const renderedViews = render.renderViewArtifactIds.map((id) => byId.get(id));
  const renderedViewIds = new Set(renderedViews.map((artifact) => artifact.viewId));
  const viewsComplete = REQUIRED_REVIEW_VIEWS.every((id) => renderedViewIds.has(id)) && renderedViews.length === REQUIRED_REVIEW_VIEWS.length;
  const renderHashBound = render.candidateSha256 === candidateHash;
  record("render-manifest-present", render.status === "ready" && renderArtifact?.status === "present",
    "A complete render manifest artifact is required.");
  record("render-manifest-candidate-binding", renderHashBound,
    "The render manifest must be bound to the exact candidate GLB hash.", "failed");
  record("required-render-views", viewsComplete,
    "All thirteen required inspection views must be linked to actual render-image artifacts.");
  const geometry = manifest.outputs.geometryQa;
  record("geometry-qa-candidate-binding", geometry.status === "missing" || geometry.candidateSha256 === candidateHash,
    "Geometry QA must reference the exact candidate GLB.", "failed");
  record("geometry-qa-passed", geometry.status === "passed",
    "Geometry QA must pass before candidate geometry is considered structurally checked.", geometry.status === "failed" ? "failed" : "warning");
  const texture = manifest.outputs.textureQa;
  record("texture-qa-candidate-binding", texture.status === "missing" || texture.candidateSha256 === candidateHash,
    "Texture QA must reference the exact candidate GLB.", "failed");
  record("texture-qa-passed", texture.status === "passed",
    "Texture/UV QA must pass or explicitly remain incomplete.", texture.status === "failed" ? "failed" : "warning");
  const comparison = manifest.outputs.referenceComparison;
  record("reference-comparison-candidate-binding", comparison.status === "missing" || comparison.candidateSha256 === candidateHash,
    "Reference comparison must reference the exact candidate GLB.", "failed");
  record("reference-comparison-comparable", comparison.status === "comparable" && comparison.comparableViewCount > 0,
    "At least one evidence-linked source-camera comparison must be comparable.");
  record("reference-comparison-uses-declared-images", comparison.referenceArtifactIds.length > 0 &&
    comparison.referenceArtifactIds.every((id) => manifest.evidence.referenceArtifactIds.includes(id)),
    "Comparison must link to reference images declared in the candidate manifest.");
  const accuracy = manifest.outputs.accuracyReport;
  record("accuracy-report-candidate-binding", accuracy.status === "missing" || accuracy.candidateSha256 === candidateHash,
    "Accuracy report must reference the exact candidate GLB.", "failed");
  record("accuracy-report-not-failed", accuracy.status !== "failed",
    "An accuracy report explicitly marked failed blocks candidate review.", "failed");
  record("accuracy-report-verified", accuracy.status === "verified",
    "Accuracy report must be verified against independent truth; visual rendering alone is not accuracy evidence.");
  const release = manifest.outputs.releaseReadiness;
  record("release-readiness-candidate-binding", release.status === "missing" || release.candidateSha256 === candidateHash,
    "Release readiness must reference the exact candidate GLB.", "failed");
  record("release-readiness-not-blocked", release.status !== "blocked",
    "A release-readiness report explicitly marked blocked blocks the candidate review.", "failed");
  record("publication-disabled", release.publicationEligible === false,
    "Candidate evidence assessment must never enable publication by itself.", "failed");
  record("release-review-state", ["ready-for-final-human-review", "ready-for-final-human-review-with-warnings"].includes(release.status),
    "Final release-readiness evidence must explicitly retain human review and disabled publication.");

  const confidence = manifest.confidence;
  for (const key of ["identity", "dimensions", "geometry", "facadeLayout", "appearance", "georeference"]) {
    const item = confidence[key];
    record("confidence-supported:" + key, ["unknown", "missing"].includes(item.status) || item.evidenceArtifactIds.length > 0,
      "Confidence status " + item.status + " for " + key + " must remain linked to its supporting evidence.");
  }
  if (confidence.dimensions.status === "measured" && !independentDimensions) {
    record("measured-dimensions-not-overstated", false,
      "Dimensions cannot be labelled measured without verified independent survey/published measurement evidence.", "failed");
  }
  if (confidence.georeference.status === "measured" && !independentGroundControl) {
    record("measured-georeference-not-overstated", false,
      "Georeference cannot be labelled measured without verified ground-control evidence.", "failed");
  }
  for (const artifact of manifest.artifacts.filter((item) => item.status === "present" && item.expectedSha256)) {
    record("manifest-expected-hash:" + artifact.id, artifact.expectedSha256 === artifact.sha256,
      "Pinned expected SHA-256 must match the manifest's content hash.", "failed");
  }

  const status = failures.length ? "failed" : warnings.length ? "incomplete" : "ready-for-review";
  let evidenceTier = "D";
  const independentEvidenceReady = captureCoverage && referenceCoverage && cameraCoverage && cameraPosesAcceptable &&
    dimensions.status === "verified" && ground.status === "verified";
  const frameAlignmentVerified = manifest.evidence.cameraEvidence.length > 0 &&
    manifest.evidence.cameraEvidence.every((camera) => camera.frameAlignmentStatus === "verified");
  if (independentEvidenceReady) {
    evidenceTier = cameraCalibrated && frameAlignmentVerified ? "A" : "B";
  } else if (referenceArtifacts.length > 0 && manifest.evidence.cameraEvidence.length > 0) evidenceTier = "C";
  const counts = {
    artifacts: manifest.artifacts.length,
    presentArtifacts: manifest.artifacts.filter((item) => item.status === "present").length,
    captureImages: captureArtifacts.length,
    referenceImages: referenceArtifacts.length,
    cameraEvidenceRecords: manifest.evidence.cameraEvidence.length,
    comparableViews: comparison.comparableViewCount,
    failedChecks: failures.length,
    warningChecks: warnings.length,
  };
  return {
    schemaVersion: "1.0.0",
    engine: "building-candidate-evidence-assessment-v1",
    manifestId: manifest.manifestId,
    candidateId: manifest.candidateId,
    buildingId: manifest.buildingId,
    candidateGlbSha256: candidateHash,
    status,
    evidenceTier,
    publicationEligible: false,
    counts,
    checks,
    failures,
    warnings,
    confidence,
    limitations: [
      "A valid hash proves byte identity, not source truth, licence legality, building identity or measurement correctness.",
      "Evidence tier is a routing aid, not a universal architectural similarity percentage.",
      "This assessment is not final publication approval; human review remains required.",
    ],
  };
}
