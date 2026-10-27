import {
  validateAffineMatrix4x4,
} from "./glb-geometry-extraction.mjs";
import { validateSurveyFrameTransformMatrix4x4 } from "./independent-reference-geometry-adapter.mjs";

const HASH = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MIN_HELD_OUT_CHECKPOINTS = 6;
const ASSET_ROLES = new Set([
  "candidate-image",
  "reference-model",
  "independent-surface",
  "independent-control",
]);
const ENGINE_GENERATORS = new Set([
  "engine-multiview-reconstruction",
  "engine-single-image-inference",
  "engine-parametric-generation",
]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function safeRelative(value) {
  return nonEmpty(value) && !value.includes("\\") && !value.startsWith("/") &&
    !/^[a-z]:/i.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}
function validUrl(value) {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function validTimestamp(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}
function uniqueStrings(value) {
  return Array.isArray(value) && value.every(nonEmpty) && new Set(value).size === value.length;
}

/**
 * Assess whether an intake manifest contains enough independently sourced,
 * rights-reviewed, hash-bound evidence to attempt a real-building benchmark.
 * This is a readiness check only; it never computes or grants model acceptance.
 */
export function assessBuildingBenchmarkReadiness(manifest) {
  const checks = [];
  const add = (id, passed, detail) => checks.push({
    id,
    status: passed ? "passed" : "blocked",
    detail,
  });
  const blocked = (id, detail) => add(id, false, detail);
  if (!object(manifest)) {
    return {
      schemaVersion: "1.0.0",
      status: "invalid",
      checks: [{ id: "manifest-object", status: "blocked", detail: "Manifest must be a JSON object." }],
      blockers: ["manifest-object"],
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    };
  }

  add("manifest-schema-version", manifest.schemaVersion === "1.0.0",
    manifest.schemaVersion === "1.0.0" ? "Manifest schema version is supported." : "schemaVersion must be 1.0.0.");
  add("evaluation-id", ID.test(manifest.evaluationId ?? ""),
    ID.test(manifest.evaluationId ?? "") ? "Evaluation ID is a safe identifier." : "evaluationId must be a safe identifier.");
  const building = manifest.building;
  const buildingId = object(building) && ID.test(building.id ?? "") ? building.id : null;
  add("building-identity", Boolean(buildingId && nonEmpty(building.name) && nonEmpty(building.identityEvidence)),
    buildingId && nonEmpty(building.name) && nonEmpty(building.identityEvidence)
      ? "Building has a stable ID, a name and documented cross-source identity evidence."
      : "building.id, building.name and building.identityEvidence are all required; do not assume separate files depict the same structure.");

  const evaluation = manifest.evaluation;
  const evaluationFrame = object(evaluation) ? evaluation.coordinateFrameId : null;
  add("evaluation-frame", Boolean(object(evaluation) && nonEmpty(evaluationFrame) && evaluation.units === "m"),
    object(evaluation) && nonEmpty(evaluationFrame) && evaluation.units === "m"
      ? "Evaluation frame is declared in metres."
      : "evaluation.coordinateFrameId and evaluation.units='m' are required.");

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  add("asset-manifest-present", assets.length > 0,
    assets.length ? "At least one source asset is declared." : "No source assets are declared.");
  const assetsById = new Map();
  let duplicates = false;
  for (const [index, asset] of assets.entries()) {
    if (!object(asset) || !ID.test(asset.id ?? "")) {
      blocked("asset-" + index + "-id", "Asset " + index + " must have a safe unique id.");
      continue;
    }
    if (assetsById.has(asset.id)) {
      duplicates = true;
      blocked("asset-ids-unique", "Duplicate asset ID: " + asset.id + ".");
      continue;
    }
    assetsById.set(asset.id, asset);
    add("asset-" + asset.id + "-role", ASSET_ROLES.has(asset.role),
      ASSET_ROLES.has(asset.role) ? "Asset role is recognized." : "Asset " + asset.id + " has an unsupported role.");
    add("asset-" + asset.id + "-identity", buildingId !== null && asset.buildingId === buildingId,
      asset.buildingId === buildingId ? "Asset is explicitly assigned to the evaluated building." :
        "Asset " + asset.id + " must explicitly use the same buildingId as the manifest.");
    add("asset-" + asset.id + "-source", validUrl(asset.sourceUrl) && nonEmpty(asset.filename) &&
      finite(asset.byteSize) && asset.byteSize > 0 && HASH.test(asset.sha256 ?? ""),
    validUrl(asset.sourceUrl) && nonEmpty(asset.filename) && finite(asset.byteSize) && asset.byteSize > 0 && HASH.test(asset.sha256 ?? "")
      ? "Asset URL, filename, byte size and SHA-256 are present."
      : "Asset " + asset.id + " must record an HTTP(S) source URL, filename, positive byte size and actual SHA-256 of downloaded bytes.");
    const license = asset.license;
    const licensePassed = object(license) && license.reviewStatus === "approved" &&
      nonEmpty(license.name) && validUrl(license.url) && nonEmpty(license.attribution) &&
      nonEmpty(license.reviewedBy) && validTimestamp(license.reviewedAt);
    add("asset-" + asset.id + "-license-review", licensePassed,
      licensePassed ? "Asset licence/terms were explicitly reviewed and attributed." :
        "Asset " + asset.id + " is blocked until the exact asset/version's licence URL, attribution, approved review status, reviewer and review timestamp are recorded.");
  }
  if (!duplicates) add("asset-ids-unique", true, "Asset IDs are unique.");

  const candidate = manifest.candidate;
  const candidateObject = object(candidate);
  const candidateAssetIds = candidateObject && uniqueStrings(candidate.sourceAssetIds) ? candidate.sourceAssetIds : [];
  const candidateAssets = candidateAssetIds.map((id) => assetsById.get(id)).filter(Boolean);
  const candidateImagesOnly = candidateAssets.length > 0 && candidateAssets.length === candidateAssetIds.length &&
    candidateAssets.every((asset) => asset.role === "candidate-image");
  add("candidate-building-identity", candidateObject && candidate.buildingId === buildingId,
    candidateObject && candidate.buildingId === buildingId ? "Candidate is explicitly assigned to the evaluated building." :
      "candidate.buildingId must match building.id.");
  add("candidate-image-inputs", candidateImagesOnly,
    candidateImagesOnly ? "Candidate references only declared candidate image/video-frame inputs." :
      "candidate.sourceAssetIds must reference one or more declared candidate-image assets; a benchmark truth model must never be used as the candidate input.");

  const candidateGlbPathValid = candidateObject && safeRelative(candidate.glbPath) &&
    candidate.glbPath.toLowerCase().endsWith(".glb");
  const candidateGlbHashValid = candidateObject && HASH.test(candidate.glbSha256 ?? "");
  const generatorValid = candidateObject && ENGINE_GENERATORS.has(candidate.generator) &&
    candidate.generatedByPlatform === true && candidate.groundTruthModelImported !== true;
  add("candidate-engine-generated", generatorValid,
    generatorValid ? "Candidate is declared as platform-generated rather than imported benchmark truth." :
      "Candidate must be generated by the platform's reconstruction path; ground-truth model import is prohibited as a candidate.");
  add("candidate-glb-integrity-fields", Boolean(candidateGlbPathValid && candidateGlbHashValid),
    candidateGlbPathValid && candidateGlbHashValid
      ? "Candidate GLB path and SHA-256 are declared."
      : "candidate.glbPath must be a safe project-relative .glb path and candidate.glbSha256 must be the digest of the exact GLB bytes.");
  add("candidate-frame-transform", Boolean(candidateObject && nonEmpty(candidate.modelCoordinateFrameId) &&
      nonEmpty(candidate.evaluationCoordinateFrameId) && candidate.evaluationCoordinateFrameId === evaluationFrame &&
      Array.isArray(candidate.modelToEvaluationFrameMatrix4x4) &&
      (() => { try { validateAffineMatrix4x4(candidate.modelToEvaluationFrameMatrix4x4); return true; } catch { return false; } })()),
    "Candidate must declare modelCoordinateFrameId, evaluationCoordinateFrameId matching evaluation.coordinateFrameId, and a valid invertible affine transform.");

  const reference = manifest.reference;
  const referenceObject = object(reference);
  const referenceAssetIds = referenceObject && uniqueStrings(reference.sourceAssetIds) ? reference.sourceAssetIds : [];
  const referenceAssets = referenceAssetIds.map((id) => assetsById.get(id)).filter(Boolean);
  const referenceRolesValid = referenceAssets.length > 0 && referenceAssets.length === referenceAssetIds.length &&
    referenceAssets.every((asset) => asset.role === "reference-model" || asset.role === "independent-surface");
  const hasIndependentSurface = referenceAssets.some((asset) => asset.role === "independent-surface");
  add("reference-building-identity", referenceObject && reference.buildingId === buildingId,
    referenceObject && reference.buildingId === buildingId ? "Reference is explicitly assigned to the evaluated building." :
      "reference.buildingId must match building.id.");
  add("reference-assets-present", referenceRolesValid && hasIndependentSurface,
    referenceRolesValid && hasIndependentSurface
      ? "Reference includes a declared independent surface/measurement asset."
      : "reference.sourceAssetIds must refer to separate reference-model/independent-surface assets and include at least one independent-surface asset (e.g. independently acquired laser scan).");
  add("candidate-reference-separation", candidateAssetIds.length > 0 && referenceAssetIds.length > 0 &&
      !candidateAssetIds.some((id) => referenceAssetIds.includes(id)),
    candidateAssetIds.length > 0 && referenceAssetIds.length > 0 &&
      !candidateAssetIds.some((id) => referenceAssetIds.includes(id))
      ? "Candidate image assets and independent reference assets are disjoint."
      : "Candidate input asset IDs must not overlap reference asset IDs.");
  const referenceFramePassed = referenceObject && nonEmpty(reference.coordinateFrameId) &&
    reference.coordinateFrameId === evaluationFrame && reference.units === "m" &&
    nonEmpty(reference.crs) && nonEmpty(reference.verticalDatum) && nonEmpty(reference.frameRegistrationEvidence) &&
    Array.isArray(reference.sourceToEvaluationFrameMatrix4x4) &&
    (() => { try { validateSurveyFrameTransformMatrix4x4(reference.sourceToEvaluationFrameMatrix4x4); return true; } catch { return false; } })();
  add("reference-frame-registration", referenceFramePassed,
    referenceFramePassed
      ? "Reference declares CRS, vertical datum, registration evidence and a metric-preserving frame transform."
      : "Reference needs CRS, vertical datum, frame-registration evidence and a valid metre-preserving horizontal axis-alignment transform into the evaluation frame.");

  const controls = manifest.controls;
  const fitControls = object(controls) && Array.isArray(controls.fitControls) ? controls.fitControls : [];
  const fitControlIds = fitControls.map((point) => object(point) ? point.id : null);
  const fitIdsValid = fitControlIds.length >= 3 && uniqueStrings(fitControlIds) &&
    fitControls.every((point) => object(point) && ID.test(point.id ?? "") &&
      finite(point.x) && finite(point.y) && finite(point.z) &&
      finite(point.uncertaintyM) && point.uncertaintyM > 0 &&
      point.coordinateFrameId === evaluationFrame &&
      assetsById.has(point.sourceAssetId) &&
      assetsById.get(point.sourceAssetId)?.role === "independent-control");
  add("fit-controls", fitIdsValid,
    fitIdsValid ? "At least three unique metric fit controls are backed by independent-control assets." :
      "At least three unique fit controls with finite metric coordinates, positive uncertainty and an independent-control source asset are required.");
  const checkpoints = object(controls) && Array.isArray(controls.heldOutCheckpoints)
    ? controls.heldOutCheckpoints : [];
  const checkpointIds = new Set();
  let checkpointBindingsValid = checkpoints.length >= MIN_HELD_OUT_CHECKPOINTS;
  for (const checkpoint of checkpoints) {
    if (!object(checkpoint) || !ID.test(checkpoint.id ?? "") || checkpointIds.has(checkpoint.id)) {
      checkpointBindingsValid = false;
      continue;
    }
    checkpointIds.add(checkpoint.id);
    const binding = checkpoint.candidateVertexBinding;
    if (checkpoint.independentOfFit !== true || !finite(checkpoint.x) || !finite(checkpoint.y) ||
        !finite(checkpoint.z) || !finite(checkpoint.uncertaintyM) || checkpoint.uncertaintyM <= 0 ||
        !assetsById.has(checkpoint.sourceAssetId) ||
        assetsById.get(checkpoint.sourceAssetId)?.role !== "independent-control" ||
        checkpoint.coordinateFrameId !== evaluationFrame ||
        !object(binding) || !Number.isSafeInteger(binding.nodeIndex) || binding.nodeIndex < 0 ||
        !Number.isSafeInteger(binding.primitiveIndex) || binding.primitiveIndex < 0 ||
        !Number.isSafeInteger(binding.vertexIndex) || binding.vertexIndex < 0) {
      checkpointBindingsValid = false;
    }
  }
  const noFitLeakage = checkpoints.length > 0 && checkpoints.every((point) =>
    object(point) && !fitControlIds.includes(point.id));
  add("held-out-checkpoints", checkpointBindingsValid && checkpoints.every((point) =>
      object(point) && point.independentOfFit === true) && noFitLeakage,
    checkpointBindingsValid && checkpoints.every((point) => object(point) && point.independentOfFit === true) && noFitLeakage
      ? "At least six unique held-out points have independent source IDs, finite metric coordinates/uncertainty, and exact candidate GLB vertex bindings."
      : "At least six unique, finite, independently sourced held-out points are required; each must set independentOfFit=true, avoid fit-control IDs, declare positive uncertainty and frame, and bind to an actual GLB node/primitive/POSITION vertex.");

  const validChecks = checks.filter((check) => check.status === "passed").length;
  const blockers = checks.filter((check) => check.status !== "passed").map((check) => check.id);
  const status = blockers.length ? "blocked" : "manifest-complete";
  return {
    schemaVersion: "1.0.0",
    evaluationId: nonEmpty(manifest.evaluationId) ? manifest.evaluationId : null,
    buildingId,
    status,
    counts: { passed: validChecks, blocked: blockers.length },
    checks,
    blockers,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  };
}
