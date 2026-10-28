import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const REQUIRED_SCOPES = Object.freeze(["inspect-source", "use-for-validation", "derive-model"]);
const ALLOWED_SCOPES = new Set([
  ...REQUIRED_SCOPES,
  "public-display-derived-model",
  "commercial-use-derived-model",
  "redistribute-source",
  "redistribute-derived-model",
]);
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
const FLAGS = Object.freeze({
  acceptanceEligible: false,
  publicationEligible: false,
  mapReady: false,
  automaticApproval: false,
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isSha(value) {
  return typeof value === "string" && SHA256.test(value);
}
function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isHttps(value) {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function unique(values) {
  return [...new Set(values)];
}
function add(checks, blockers, id, passed, detail) {
  checks.push({ id, status: passed ? "passed" : "blocked", detail });
  if (!passed) blockers.push(id);
}
function safeRelative(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    !value.includes("\\") && !value.startsWith("/") && !/^[a-z]:/i.test(value) &&
    value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}
async function readEvidence(root, evidence) {
  if (!safeRelative(evidence?.filename)) throw new TypeError("Rights evidence filename must be a safe relative path.");
  const target = path.resolve(root, ...evidence.filename.split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
    throw new TypeError("Rights evidence path escapes its evidence root.");
  }
  let current = root;
  const parts = evidence.filename.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError("Rights evidence must not traverse symbolic links.");
    if (index < parts.length - 1 && !info.isDirectory()) throw new TypeError("Rights evidence parent must be a directory.");
    if (index === parts.length - 1 && (!info.isFile() || info.size < 1 || info.size > MAX_EVIDENCE_BYTES)) {
      throw new TypeError("Rights evidence must be a non-empty regular file within the size limit.");
    }
  }
  const resolved = await realpath(target);
  if (resolved !== target) {
    const rel = path.relative(root, resolved);
    if (rel.startsWith(".." + path.sep) || rel === ".." || path.isAbsolute(rel)) {
      throw new TypeError("Resolved rights evidence escapes its evidence root.");
    }
  }
  const bytes = await readFile(resolved);
  const actualSha256 = sha256(bytes);
  if (bytes.length !== evidence.byteSize || actualSha256.toLowerCase() !== String(evidence.sha256 ?? "").toLowerCase()) {
    throw new TypeError("Rights evidence bytes do not match the declared size and SHA-256: " + evidence.filename);
  }
  return { filename: evidence.filename, byteSize: bytes.length, sha256: actualSha256 };
}

function sourceIndex(sourceManifest) {
  const views = sourceManifest?.views;
  if (!Array.isArray(views)) return new Map();
  return new Map(views.map(view => [view?.id, view]));
}

export async function validateBrf45ExactAssetRightsAdmission(manifest, options = {}) {
  const checks = [];
  const blockers = [];
  const evidenceRootArg = options.evidenceRoot;
  let evidenceRoot = null;
  try {
    if (!isText(evidenceRootArg)) throw new TypeError("evidenceRoot is required.");
    const rootPath = path.resolve(evidenceRootArg);
    const rootStat = await lstat(rootPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new TypeError("evidenceRoot must be a real directory, not a symlink.");
    evidenceRoot = await realpath(rootPath);
  } catch (error) {
    add(checks, blockers, "evidence-root-safe", false, error instanceof Error ? error.message : String(error));
  }
  const sourceManifest = options.sourceManifest;
  const sourceBinding = isRecord(manifest) && isRecord(manifest.sourceBinding) ? manifest.sourceBinding : {};
  const viewsById = sourceIndex(sourceManifest);
  const sourceViews = Array.isArray(sourceManifest?.views) ? sourceManifest.views : [];
  const assets = isRecord(manifest) && Array.isArray(manifest.assets) ? manifest.assets : [];
  const evaluatedAt = isRecord(manifest) ? manifest.evaluatedAt : null;

  const manifestValid = isRecord(manifest) &&
    manifest.schemaVersion === "1.0.0" &&
    manifest.recordType === "brf-45-exact-asset-rights-admission" &&
    manifest.evaluationId === "BRF-45-EXACT-ASSET-RIGHTS-ADMISSION" &&
    isTimestamp(evaluatedAt) &&
    manifest.requestedPurpose === "private-local-reconstruction-and-validation";
  add(checks, blockers, "manifest-schema", manifestValid,
    "Manifest must use the supported BRF-45 schema, evaluation ID and private reconstruction purpose.");
  const sourceBindingValid = isRecord(sourceManifest) &&
    sourceManifest.schemaVersion === "1.0.0" &&
    sourceManifest.evaluationStage === "multiview-source-byte-intake-only" &&
    sourceViews.length >= 3 && sourceViews.length <= 32 &&
    sourceBinding.sourceManifestFilename === "brf-14-multiview-source.json" &&
    sourceBinding.sampleId === sourceManifest.sampleId &&
    sourceBinding.sourceRepositoryCommit === sourceManifest.dataset?.sourceRepositoryCommit &&
    sourceBinding.declaredLicense === sourceManifest.dataset?.license &&
    sourceBinding.licenseScope === sourceManifest.dataset?.licenseScope &&
    sourceBinding.rightsStatus === sourceManifest.dataset?.rightsStatus;
  add(checks, blockers, "source-manifest-binding", sourceBindingValid,
    "Rights records must be bound to the exact pinned BRF-14 sample and source repository commit.");
  add(checks, blockers, "asset-count-and-identity", assets.length === sourceViews.length && assets.length >= 3 && assets.length <= 32,
    "The rights register must contain exactly one row for each selected source image.");
  const ids = assets.map(row => row?.sourceId);
  add(checks, blockers, "unique-source-ids", ids.every(id => isText(id) && SAFE_ID.test(id)) && ids.length === unique(ids).length,
    "Every source image needs one unique stable identifier.");
  add(checks, blockers, "required-scopes", Array.isArray(manifest?.requiredScopes) &&
    manifest.requiredScopes.length === REQUIRED_SCOPES.length &&
    REQUIRED_SCOPES.every(scope => manifest.requiredScopes.includes(scope)) &&
    manifest.requiredScopes.every(scope => ALLOWED_SCOPES.has(scope)) &&
    unique(manifest.requiredScopes).length === manifest.requiredScopes.length,
    "The requested operation scopes must explicitly include inspection, validation and model derivation only.");
  add(checks, blockers, "no-permission-inference", manifest?.policy?.inferPermissionFromPublicAvailability === false &&
    manifest?.policy?.repositoryLicenseAloneSufficient === false &&
    manifest?.policy?.requireExactAssetByteBinding === true &&
    manifest?.policy?.requireHumanReview === true &&
    manifest?.policy?.sourceRedistributionRequested === false &&
    manifest?.policy?.publicDerivedModelDisplayRequested === false,
    "Public availability or a repository license label cannot substitute for rights evidence; broad distribution uses are not assumed.");
  const flags = manifest?.releaseFlags;
  const flagsOk = isRecord(flags) && Object.keys(FLAGS).every(flag => flags[flag] === false) &&
    Object.keys(flags).every(flag => Object.hasOwn(FLAGS, flag));
  add(checks, blockers, "release-flags-false", flagsOk,
    "BRF-45 validates source-use evidence only; every release/publication flag must remain false.");

  const perAsset = [];
  const seenIds = new Set();
  for (const row of assets) {
    const id = isText(row?.sourceId) ? row.sourceId : "invalid-source";
    const source = viewsById.get(id);
    const rowPrefix = "asset-" + id;
    const exactSourceMatch = Boolean(source) &&
      row.filename === source.filename &&
      row.sha256?.toLowerCase() === String(source.expectedSha256 ?? "").toLowerCase() &&
      row.byteSize === source.expectedByteSize &&
      row.sourceUrl === source.sourceUrl &&
      row.sourceRepositoryCommit === sourceBinding.sourceRepositoryCommit &&
      isHttps(row.sourceUrl) && isSha(row.sha256) &&
      Number.isSafeInteger(row.byteSize) && row.byteSize > 0 &&
      Array.isArray(row.requestedScopes) &&
      row.requestedScopes.length === manifest.requiredScopes.length &&
      manifest.requiredScopes.every((scope, index) => row.requestedScopes[index] === scope) &&
      row.requestedScopes.every(scope => ALLOWED_SCOPES.has(scope)) &&
      unique(row.requestedScopes).length === row.requestedScopes.length;
    add(checks, blockers, rowPrefix + "-exact-source-binding", exactSourceMatch,
      exactSourceMatch ? "Source ID, filename, URL, commit, exact hash/size and requested scopes match BRF-14."
        : "Source identity, URL, commit, SHA-256, size or requested scopes differ from BRF-14.");
    if (!source || seenIds.has(id)) {
      add(checks, blockers, rowPrefix + "-source-id-unique-and-known", false,
        "Rights row references an unknown or duplicate source ID.");
    }
    seenIds.add(id);
    const decision = row?.decision;
    if (decision !== "approved") {
      add(checks, blockers, rowPrefix + "-decision-approved", false,
        "Exact-asset rights decision is pending or denied; a dataset label cannot imply permission.");
      perAsset.push({ sourceId: id, status: "blocked", missingEvidence: ["explicit-approved-rights-decision"] });
      continue;
    }
    const rights = isRecord(row.rights) ? row.rights : {};
    const granted = Array.isArray(rights.grantedScopes) ? rights.grantedScopes : [];
    const scopesOk = Array.isArray(row.requestedScopes) &&
      row.requestedScopes.every(scope => granted.includes(scope)) &&
      granted.every(scope => ALLOWED_SCOPES.has(scope)) &&
      unique(granted).length === granted.length;
    const grantFieldsOk = rights.status === "approved" &&
      isText(rights.rightsHolderOrGrantor) &&
      isText(rights.authorityBasis) &&
      isRecord(rights.license) &&
      isText(rights.license.identifier) &&
      isText(rights.license.name) &&
      isHttps(rights.license.url) &&
      isText(rights.attributionText) &&
      isText(rights.restrictionsText) &&
      isText(rights.scopeDescription) &&
      rights.explicitGrantConfirmed === true &&
      isText(rights.decisionId) &&
      isText(rights.reviewedBy) &&
      isTimestamp(rights.reviewedAt) &&
      Date.parse(rights.reviewedAt) <= Date.parse(evaluatedAt) &&
      isTimestamp(rights.effectiveAt) &&
      Date.parse(rights.effectiveAt) <= Date.parse(evaluatedAt) &&
      (rights.expiresAt === null || (isTimestamp(rights.expiresAt) && Date.parse(rights.expiresAt) >= Date.parse(evaluatedAt))) &&
      rights.revoked === false;
    add(checks, blockers, rowPrefix + "-grant-record-complete", grantFieldsOk,
      "Grantor/authority, license, purpose scope, attribution, restrictions, dates and an explicit human grant are required.");
    add(checks, blockers, rowPrefix + "-requested-scopes-granted", scopesOk,
      "Every requested operation must appear in a unique, recognized granted-scope list.");
    const evidenceRows = Array.isArray(rights.evidenceSnapshots) ? rights.evidenceSnapshots : [];
    const evidenceIds = evidenceRows.map(item => item?.filename);
    const evidenceListOk = evidenceRows.length > 0 &&
      evidenceRows.every(item => isRecord(item) &&
        isText(item.filename) && safeRelative(item.filename) &&
        isHttps(item.sourceUrl) &&
        isTimestamp(item.retrievedAt) && Date.parse(item.retrievedAt) <= Date.parse(evaluatedAt) &&
        Number.isSafeInteger(item.byteSize) && item.byteSize > 0 && isSha(item.sha256) &&
        isText(item.evidenceType)) &&
      unique(evidenceIds).length === evidenceIds.length;
    add(checks, blockers, rowPrefix + "-rights-evidence-declared", evidenceListOk,
      "At least one unique, dated, HTTPS-referenced local evidence snapshot with declared exact bytes is required.");
    let evidenceChecksPassed = evidenceListOk && evidenceRoot !== null;
    const checkedSnapshots = [];
    if (evidenceListOk && evidenceRoot !== null) {
      for (const item of evidenceRows) {
        try {
          const verified = await readEvidence(evidenceRoot, item);
          checkedSnapshots.push(verified);
        } catch (error) {
          evidenceChecksPassed = false;
          add(checks, blockers, rowPrefix + "-evidence-bytes-" + (item.filename || "invalid"),
            false, error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (evidenceListOk && evidenceRoot !== null && evidenceChecksPassed) {
      add(checks, blockers, rowPrefix + "-evidence-bytes", true,
        "Every local rights evidence snapshot matches its declared byte size and SHA-256.");
    }
    const approved = exactSourceMatch && decision === "approved" && grantFieldsOk && scopesOk &&
      evidenceListOk && evidenceChecksPassed;
    if (!approved && evidenceChecksPassed && evidenceListOk) {
      add(checks, blockers, rowPrefix + "-rights-admission", false,
        "Rights record is incomplete for the exact requested local-reconstruction use.");
    }
    perAsset.push({
      sourceId: id,
      status: approved ? "evidence-complete-human-review-required" : "blocked",
      grantor: rights.rightsHolderOrGrantor ?? null,
      grantedScopes: granted,
      evidenceSnapshots: checkedSnapshots,
    });
  }
  for (const source of sourceViews) {
    if (!assets.some(row => row?.sourceId === source.id)) {
      add(checks, blockers, "asset-" + source.id + "-rights-row-present", false,
        "No exact-asset rights row is present for this selected source image.");
    }
  }
  const uniqueBlockers = unique(blockers);
  const approvedCount = perAsset.filter(row => row.status === "evidence-complete-human-review-required").length;
  return {
    schemaVersion: "1.0.0",
    evaluationId: "BRF-45-EXACT-ASSET-RIGHTS-ADMISSION",
    status: uniqueBlockers.length === 0 && approvedCount === sourceViews.length
      ? "rights-admission-complete-human-review-required"
      : "blocked",
    sourceRightsStatus: uniqueBlockers.length === 0 && approvedCount === sourceViews.length
      ? "evidence-complete-human-review-required"
      : "incomplete-or-invalid",
    sourceManifestSha256: options.sourceManifestSha256 ?? null,
    sourceRepositoryCommit: sourceBinding.sourceRepositoryCommit ?? null,
    sourceViewCount: sourceViews.length,
    rightsApprovedAssetCount: approvedCount,
    blockers: uniqueBlockers,
    checks,
    assets: perAsset,
    releaseFlags: { ...FLAGS },
    policy: "Exact source-use evidence completeness only; does not independently authenticate grantor authority, interpret legal rights, certify building identity/accuracy, or approve publication.",
  };
}
