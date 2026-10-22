import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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

function assertSafeRelativePath(value, label) {
  if (!nonEmptyString(value) || value.includes("\\") || value.startsWith("/") || value.includes("\0")) {
    throw new TypeError(label + " must be a safe workspace-relative path.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " must not contain empty, dot or parent path segments.");
  }
  return value;
}

function assertInside(root, filePath, label) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
    if (relative === "") return;
    throw new Error(label + " must remain inside the workspace root.");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateReview(review, label, options = {}) {
  if (!isRecord(review)) throw new TypeError(label + ".review must be an object.");
  if (!nonEmptyString(review.reviewer) || review.reviewer.length > 200) {
    throw new TypeError(label + ".review.reviewer is required (max 200 characters).");
  }
  if (!isIsoDate(review.reviewedAt)) throw new TypeError(label + ".review.reviewedAt must be an ISO-compatible timestamp.");
  if (options.requireEvidencePath === true) {
    assertSafeRelativePath(review.evidencePath, label + ".review.evidencePath");
  } else if (typeof review.evidenceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(review.evidenceId)) {
    throw new TypeError(label + ".review.evidenceId must be a safe public evidence identifier.");
  }
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
  if (!Number.isSafeInteger(version.bytes) || version.bytes < 12) {
    throw new TypeError(label + ".bytes must be a valid GLB byte count.");
  }
  if (!isIsoDate(version.publishedAt)) throw new TypeError(label + ".publishedAt must be a valid timestamp.");
  validateReview(version.review, label);

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
    minimumPixelSize: 0,
    show: true,
  });
  return definition;
}

/**
 * Fail-closed structural validator for the public, read-only model catalog.
 * It verifies release metadata and placement but intentionally does not assert
 * that human review claims are true in the real world.
 */
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

function buildVersionId(modelId, candidateHash, placement, evidenceHash) {
  const stable = JSON.stringify({ modelId, candidateHash, placement, evidenceHash });
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

async function resolveWorkspaceFile(root, relativePath, label, allowAbsolute = false) {
  if (!allowAbsolute || !path.isAbsolute(relativePath)) {
    assertSafeRelativePath(relativePath, label);
  }
  const resolved = path.resolve(root, relativePath);
  const real = await realpath(resolved);
  assertInside(root, real, label);
  const details = await stat(real);
  if (!details.isFile()) throw new TypeError(label + " must point to a file.");
  return { real, details };
}

async function writeCatalogAtomically(manifestPath, catalog) {
  const tempPath = manifestPath + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(tempPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
  await rename(tempPath, manifestPath);
}

/**
 * Publish a reviewed candidate through an explicit human-attestation file.
 * The command copies a content-addressed GLB and updates a versioned manifest;
 * it never performs architectural review or georeference verification itself.
 */
export async function publishReviewedBuildingModel({
  workspaceRoot,
  candidatePath,
  attestationPath,
  publishedAt = new Date().toISOString(),
}) {
  const root = await realpath(path.resolve(workspaceRoot));
  const candidate = await resolveWorkspaceFile(root, candidatePath, "candidatePath", true);
  const attestationFile = await resolveWorkspaceFile(root, attestationPath, "attestationPath", true);
  const candidateBytes = await readFile(candidate.real);
  if (candidateBytes.length < 12 || candidateBytes.toString("ascii", 0, 4) !== "glTF" ||
    candidateBytes.readUInt32LE(4) !== 2 || candidateBytes.readUInt32LE(8) !== candidateBytes.length) {
    throw new Error("Candidate must be a structurally plausible GLB 2.0 file.");
  }
  const actualCandidateHash = sha256(candidateBytes);
  const attestation = JSON.parse(await readFile(attestationFile.real, "utf8"));
  if (!isRecord(attestation) || attestation.schemaVersion !== "1.0.0") {
    throw new TypeError("Attestation schemaVersion must be 1.0.0.");
  }
  if (attestation.candidateSha256 !== actualCandidateHash) {
    throw new Error("Attested candidateSha256 does not match the actual GLB bytes.");
  }
  if (!isRecord(attestation.model) || !ID_PATTERN.test(attestation.model.id ?? "") ||
    !nonEmptyString(attestation.model.name) || attestation.model.name.length > 200) {
    throw new TypeError("Attestation model.id and model.name are required.");
  }
  if (!isRecord(attestation.review)) throw new TypeError("Attestation review is required.");
  validateReview(attestation.review, "attestation", { requireEvidencePath: true });
  const evidence = await resolveWorkspaceFile(root, attestation.review.evidencePath, "review evidence");
  const evidenceHash = sha256(await readFile(evidence.real));
  if (evidenceHash !== attestation.review.evidenceSha256.toLowerCase()) {
    throw new Error("Review evidence SHA-256 does not match the attestation.");
  }

  const catalogDir = path.join(root, "public", "models", "generated");
  await mkdir(catalogDir, { recursive: true });
  const manifestPath = path.join(catalogDir, "manifest.json");
  let catalog = { schemaVersion: PUBLISHED_MODEL_CATALOG_SCHEMA_VERSION, models: [] };
  try {
    catalog = validatePublishedModelCatalog(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      // First publication starts an empty catalog.
    } else {
      throw new Error("Existing published model catalog is invalid; refusing to overwrite it.", { cause: error });
    }
  }

  const existing = catalog.models.find((model) => model.id === attestation.model.id);
  if (existing && existing.name !== attestation.model.name) {
    throw new Error("Model name is immutable for an existing id; use a new id or rename deliberately in the catalog.");
  }

  const placement = normalizeGeneratedModelDefinition({
    id: attestation.model.id,
    name: attestation.model.name,
    url: "/models/generated/pending.glb",
    position: attestation.model.position,
    headingDegrees: attestation.model.headingDegrees ?? 0,
    pitchDegrees: attestation.model.pitchDegrees ?? 0,
    rollDegrees: attestation.model.rollDegrees ?? 0,
    scale: attestation.model.scale ?? 1,
    upAxis: attestation.model.upAxis ?? "Y",
    forwardAxis: attestation.model.forwardAxis ?? "Z",
    show: true,
  });
  const safeFileId = attestation.model.id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
  const assetName = safeFileId + "-" + actualCandidateHash.slice(0, 12) + ".glb";
  const assetUrl = "/models/generated/" + assetName;
  const destination = path.join(catalogDir, assetName);
  try {
    await lstat(destination);
    const existingBytes = await readFile(destination);
    if (sha256(existingBytes) !== actualCandidateHash) {
      throw new Error("Refusing to overwrite an existing versioned GLB whose bytes do not match its filename.");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      await copyFile(candidate.real, destination);
    } else {
      throw error;
    }
  }

  const versionId = buildVersionId(attestation.model.id, actualCandidateHash, placement, evidenceHash);
  const version = {
    versionId,
    url: assetUrl,
    sha256: actualCandidateHash,
    bytes: candidate.details.size,
    publishedAt,
    position: placement.position,
    headingDegrees: placement.headingDegrees,
    pitchDegrees: placement.pitchDegrees,
    rollDegrees: placement.rollDegrees,
    scale: placement.scale,
    upAxis: placement.upAxis,
    forwardAxis: placement.forwardAxis,
    review: {
      reviewer: attestation.review.reviewer.trim(),
      reviewedAt: attestation.review.reviewedAt,
      evidenceId: (attestation.review.evidenceId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(attestation.review.evidenceId))
        ? attestation.review.evidenceId
        : "sha256-" + evidenceHash.slice(0, 24),
      evidenceSha256: evidenceHash,
      checks: Object.fromEntries(REQUIRED_REVIEW_CHECKS.map((key) => [key, true])),
      notes: attestation.review.notes.trim(),
    },
  };

  if (existing) {
    const sameVersion = existing.versions.find((item) => item.versionId === versionId);
    if (!sameVersion) existing.versions.push(version);
    existing.activeVersion = versionId;
  } else {
    catalog.models.push({
      id: attestation.model.id,
      name: attestation.model.name.trim(),
      activeVersion: versionId,
      versions: [version],
    });
  }

  const validated = validatePublishedModelCatalog(catalog);
  await writeCatalogAtomically(manifestPath, validated);
  return { modelId: attestation.model.id, versionId, assetUrl, sha256: actualCandidateHash, manifestPath };
}

/** Change the active catalog version after verifying the referenced GLB still matches its hash. */
export async function activatePublishedModelVersion({ workspaceRoot, modelId, versionId }) {
  const root = await realpath(path.resolve(workspaceRoot));
  if (!ID_PATTERN.test(modelId ?? "") || !VERSION_PATTERN.test(versionId ?? "")) {
    throw new TypeError("modelId and versionId must be valid catalog identifiers.");
  }
  const manifestPath = path.join(root, "public", "models", "generated", "manifest.json");
  const catalog = validatePublishedModelCatalog(JSON.parse(await readFile(manifestPath, "utf8")));
  const model = catalog.models.find((item) => item.id === modelId);
  if (!model) throw new Error("Published model was not found: " + modelId);
  const version = model.versions.find((item) => item.versionId === versionId);
  if (!version) throw new Error("Published model version was not found: " + versionId);
  const assetRelative = version.url.slice(1);
  const asset = await resolveWorkspaceFile(root, assetRelative, "published GLB");
  const actualHash = sha256(await readFile(asset.real));
  if (actualHash !== version.sha256) throw new Error("Published GLB checksum mismatch; refusing to activate this version.");
  model.activeVersion = versionId;
  await writeCatalogAtomically(manifestPath, validatePublishedModelCatalog(catalog));
  return { modelId, versionId, assetUrl: version.url, sha256: actualHash };
}
