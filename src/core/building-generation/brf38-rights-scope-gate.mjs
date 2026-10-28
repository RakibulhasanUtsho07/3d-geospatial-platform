import { verifyBrf36SourceAssetBytes } from "./brf36-source-byte-verifier.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const FLAGS = Object.freeze({
  acceptanceEligible: false,
  publicationEligible: false,
  mapReady: false,
  automaticApproval: false,
});
const ALLOWED_SCOPES = new Set([
  "inspect-source",
  "use-for-validation",
  "derive-model",
  "public-display-derived-model",
  "commercial-use-derived-model",
  "redistribute-source",
  "redistribute-derived-model",
]);
const MAX_ASSETS = 64;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function textValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}
function hash(value) {
  return typeof value === "string" && SHA256.test(value);
}
function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function https(value) {
  if (!textValue(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function unique(values) {
  return [...new Set(values)];
}
function add(checks, blockers, id, passed, detail) {
  checks.push({ id, status: passed ? "passed" : "blocked", detail });
  if (!passed) blockers.push(id);
}
function blockedResult(manifest, checks, blockers, extra = {}) {
  return {
    schemaVersion: "1.0.0",
    evaluationId: record(manifest) && safeId(manifest.evaluationId)
      ? manifest.evaluationId
      : "invalid-manifest",
    status: blockers.length ? "blocked" : "evidence-complete-human-review-required",
    sourceRightsStatus: blockers.length ? "incomplete-or-invalid" : "evidence-complete-human-review-required",
    rightsApprovedAssetCount: extra.rightsApprovedAssetCount || 0,
    byteVerifiedAssetCount: extra.byteVerifiedAssetCount || 0,
    blockers: unique(blockers),
    checks,
    derivedOutputs: extra.derivedOutputs || [],
    releaseFlags: { ...FLAGS },
    policy: "rights evidence completeness only; no legal interpretation, license grant, same-building proof, accuracy adjudication or release approval",
  };
}

export function buildBrf38ByteVerificationManifest(manifest) {
  const items = record(manifest) && Array.isArray(manifest.assets) ? manifest.assets : [];
  return {
    schemaVersion: "1.0.0",
    evaluationId: record(manifest) && safeId(manifest.evaluationId)
      ? manifest.evaluationId
      : "invalid-manifest",
    assets: items.map((asset) => ({
      id: asset?.id,
      role: asset?.kind === "rights-evidence" ? "rights-evidence" : asset?.role,
      status: asset?.status,
      localPath: asset?.localPath ?? null,
      byteSize: asset?.byteSize ?? null,
      sha256: asset?.sha256 ?? null,
      rightsStatus: asset?.kind === "source"
        ? (asset?.rights?.status ?? "missing")
        : "not-applicable",
    })),
  };
}

function validateRecordMetadata(asset, index, checks, blockers) {
  const id = safeId(asset?.id) ? asset.id : "invalid-" + index;
  const validKind = ["source", "rights-evidence", "derived-output"].includes(asset?.kind);
  const sourceMetadataOk = asset?.kind === "derived-output" ||
    (record(asset?.source) && https(asset.source.recordUrl) &&
      textValue(asset.source.version) && textValue(asset.source.fileName) &&
      (asset.kind !== "rights-evidence" || textValue(asset.source.evidenceType)));
  const validBase = record(asset) && safeId(asset.id) && validKind &&
    textValue(asset.role) && ["pinned", "pending-acquisition"].includes(asset.status) &&
    sourceMetadataOk;
  add(checks, blockers, "asset-" + id + "-metadata", validBase,
    validBase ? "Asset ID, type, source record/version and filename are present."
      : "Asset requires a stable ID, source/evidence kind, role, acquisition state, HTTPS record URL, version and exact filename.");
  if (!validBase) return { id, valid: false };
  if (asset.status === "pinned") {
    const pinOk = textValue(asset.localPath) && Number.isSafeInteger(asset.byteSize) &&
      asset.byteSize > 0 && hash(asset.sha256);
    add(checks, blockers, "asset-" + id + "-local-byte-pin", pinOk,
      pinOk ? "Local asset path, positive exact byte size and SHA-256 are pinned."
        : "A pinned asset requires localPath, exact byteSize and SHA-256.");
    if (!pinOk) return { id, valid: false };
  } else {
    add(checks, blockers, "asset-" + id + "-acquired", false,
      "Asset is pending local acquisition and actual SHA-256/byte-size verification.");
  }
  return { id, valid: true };
}

function verifiedByteAsset(asset, byteReport) {
  if (!record(byteReport) || !Array.isArray(byteReport.assets)) return null;
  return byteReport.assets.find((entry) =>
    entry?.id === asset.id &&
    entry.byteStatus === "byte-verified" &&
    entry.actualSha256?.toLowerCase() === asset.sha256?.toLowerCase() &&
    entry.actualByteSize === asset.byteSize
  ) || null;
}

function validateRights(asset, allAssets, byteReport, evaluatedAt, checks, blockers) {
  const id = asset.id;
  const rights = record(asset.rights) ? asset.rights : {};
  const exactHashOk = hash(asset.sha256) && hash(rights.assetSha256) &&
    rights.assetSha256.toLowerCase() === asset.sha256.toLowerCase();
  add(checks, blockers, "asset-" + id + "-rights-bound-to-source-hash", exactHashOk,
    exactHashOk ? "Rights decision is bound to the exact source SHA-256."
      : "Rights decision is missing or bound to a different source asset SHA-256.");

  const recordMatch = rights.sourceFileName === asset.source.fileName &&
    rights.sourceVersion === asset.source.version &&
    rights.sourceRecordUrl === asset.source.recordUrl;
  add(checks, blockers, "asset-" + id + "-rights-source-match", recordMatch,
    recordMatch ? "Rights scope names the same exact filename, version and source record."
      : "Rights scope does not match this asset's exact filename, record version and source URL.");

  const licenseOk = record(rights.license) && textValue(rights.license.identifier) &&
    textValue(rights.license.name) && https(rights.license.url);
  add(checks, blockers, "asset-" + id + "-license-metadata", licenseOk,
    licenseOk ? "License identifier, name and HTTPS license URL are recorded; this is metadata, not permission by itself."
      : "License metadata must include identifier, name and HTTPS URL; a bare license name is insufficient.");

  const evidenceIds = Array.isArray(rights.evidenceAssetIds) ? rights.evidenceAssetIds : [];
  const evidenceAssets = evidenceIds.map((evidenceId) =>
    allAssets.find((candidate) => candidate.id === evidenceId && candidate.kind === "rights-evidence")
  );
  const evidenceUnique = evidenceIds.length > 0 &&
    evidenceIds.length === unique(evidenceIds).length &&
    evidenceAssets.every(Boolean);
  const evidenceBytesOk = evidenceUnique && evidenceAssets.every((evidenceAsset) =>
    Boolean(verifiedByteAsset(evidenceAsset, byteReport)) &&
    evidenceAsset.source.recordUrl === rights.evidenceUrl
  ) && https(rights.evidenceUrl) &&
    timestamp(rights.evidenceRetrievedAt) &&
    hash(rights.evidenceContentSha256) &&
    evidenceAssets.some((evidenceAsset) =>
      evidenceAsset.sha256.toLowerCase() === rights.evidenceContentSha256.toLowerCase()
    );
  add(checks, blockers, "asset-" + id + "-rights-evidence-bytes", evidenceBytesOk,
    evidenceBytesOk ? "At least one local rights-evidence snapshot is byte-verified and linked to the claimed evidence URL."
      : "Rights evidence needs a local byte-verified snapshot, exact digest, retrieval time and matching HTTPS evidence URL.");

  const grantorOk = textValue(rights.rightsHolderOrGrantor) &&
    textValue(rights.scopeDescription) &&
    textValue(rights.attributionText) &&
    textValue(rights.restrictionsText);
  add(checks, blockers, "asset-" + id + "-grantor-attribution-restrictions", grantorOk,
    grantorOk ? "Grantor, exact scope, attribution and restrictions are explicitly recorded."
      : "Grantor/rights holder, scope description, attribution and restriction statement are required.");

  const requestedScopes = Array.isArray(asset.requestedScopes) ? asset.requestedScopes : [];
  const scopesValid = requestedScopes.length > 0 &&
    requestedScopes.every((scope) => ALLOWED_SCOPES.has(scope)) &&
    requestedScopes.length === unique(requestedScopes).length;
  add(checks, blockers, "asset-" + id + "-requested-scopes", scopesValid,
    scopesValid ? "Requested uses are explicit, unique and recognized."
      : "Requested uses must be a non-empty unique list of recognized scope identifiers.");

  const grantedScopes = Array.isArray(rights.grantedScopes) ? rights.grantedScopes : [];
  const grantsValid = grantedScopes.every((scope) => ALLOWED_SCOPES.has(scope)) &&
    grantedScopes.length === unique(grantedScopes).length;
  const missingScopes = scopesValid ? requestedScopes.filter((scope) => !grantedScopes.includes(scope)) : requestedScopes;
  add(checks, blockers, "asset-" + id + "-requested-scopes-granted", scopesValid && grantsValid && missingScopes.length === 0,
    scopesValid && grantsValid && missingScopes.length === 0
      ? "Every requested use is explicitly covered by the human-reviewed grant record."
      : "Required use scopes are missing or conflicting; publishing a derivative does not imply source-byte redistribution permission.");

  const reviewOk = rights.status === "approved" &&
    textValue(rights.reviewedBy) && timestamp(rights.reviewedAt) &&
    textValue(rights.decisionId) && timestamp(rights.effectiveAt) &&
    (!rights.expiresAt || timestamp(rights.expiresAt)) &&
    (!rights.expiresAt || Date.parse(rights.expiresAt) >= Date.parse(evaluatedAt)) &&
    rights.revoked !== true &&
    rights.explicitGrantConfirmed === true;
  add(checks, blockers, "asset-" + id + "-human-rights-review", reviewOk,
    reviewOk ? "Explicit grant and review metadata are complete and valid at the manifest's evaluation time."
      : "Rights are pending/denied/revoked, grant not explicitly confirmed, or review/effective/expiry metadata is invalid.");

  const approved = exactHashOk && recordMatch && licenseOk && evidenceBytesOk &&
    grantorOk && scopesValid && grantsValid && missingScopes.length === 0 && reviewOk &&
    asset.status === "pinned" && Boolean(verifiedByteAsset(asset, byteReport));
  add(checks, blockers, "asset-" + id + "-usable-under-requested-scope", approved,
    approved ? "The reviewed rights evidence record covers the exact byte-verified asset and requested scopes; human release review remains mandatory."
      : "The asset is not approved for every requested use based on byte-verified, exact-file-scope evidence.");

  return {
    assetId: id,
    role: asset.role,
    status: approved ? "rights-evidence-complete" : "blocked",
    requestedScopes,
    grantedScopes,
    missingScopes,
    licenseIdentifier: record(rights.license) ? (rights.license.identifier ?? null) : null,
    evidenceAssetIds: evidenceIds,
  };
}

function validateDerivedOutputs(outputs, allAssets, rightsReports, byteReport, checks, blockers) {
  const outputReports = [];
  const ids = new Set();
  for (const [index, output] of outputs.entries()) {
    const id = safeId(output?.id) ? output.id : "invalid-" + index;
    const uniqueId = safeId(output?.id) && !ids.has(output.id);
    if (safeId(output?.id)) ids.add(output.id);
    add(checks, blockers, "derived-output-" + id + "-unique-id", uniqueId,
      uniqueId ? "Derived output has a unique stable ID." : "Derived output ID is invalid or duplicated.");

    const parentIds = Array.isArray(output?.parentAssetIds) ? output.parentAssetIds : [];
    const parents = parentIds.map((parentId) => allAssets.find((asset) => asset.id === parentId && asset.kind === "source"));
    const parentsOk = parentIds.length > 0 && parentIds.length === unique(parentIds).length && parents.every(Boolean);
    add(checks, blockers, "derived-output-" + id + "-parents", parentsOk,
      parentsOk ? "Every declared parent resolves to a source asset." : "Derived output must identify unique, existing parent source assets.");

    const rightsById = new Map(rightsReports.map((entry) => [entry.assetId, entry]));
    const requiredParentScopes = Array.isArray(output?.requiredParentScopes)
      ? output.requiredParentScopes
      : ["derive-model", "public-display-derived-model", "commercial-use-derived-model"];
    const parentRequirementsValid = requiredParentScopes.length > 0 &&
      requiredParentScopes.every((scope) => ALLOWED_SCOPES.has(scope)) &&
      requiredParentScopes.length === unique(requiredParentScopes).length;
    const parentScopesOk = parentsOk && parentRequirementsValid && parents.every((parent) => {
      const parentRights = rightsById.get(parent.id);
      return parentRights?.status === "rights-evidence-complete" &&
        requiredParentScopes.every((scope) => parentRights.grantedScopes.includes(scope));
    });
    add(checks, blockers, "derived-output-" + id + "-parent-permissions", parentScopesOk,
      parentScopesOk ? "Every parent explicitly grants the requested derivation/output use scopes."
        : "At least one parent lacks a required, exact-use permission.");

    const artifact = allAssets.find((asset) =>
      asset.id === output?.artifactAssetId && asset.kind === "derived-output"
    );
    const present = output?.status === "generated" &&
      artifact?.status === "pinned" &&
      Boolean(verifiedByteAsset(artifact, byteReport));
    add(checks, blockers, "derived-output-" + id + "-artifact", present,
      present ? "The derived output's local bytes are pinned and independently hash-verified."
        : "The derived output has not been generated or its exact local bytes are not byte-verified.");

    const requestedOutputScopes = Array.isArray(output?.requestedScopes) ? output.requestedScopes : [];
    const outputScopesValid = requestedOutputScopes.length > 0 &&
      requestedOutputScopes.every((scope) => ALLOWED_SCOPES.has(scope)) &&
      requestedOutputScopes.length === unique(requestedOutputScopes).length;
    add(checks, blockers, "derived-output-" + id + "-requested-scopes", outputScopesValid,
      outputScopesValid ? "Derived output's requested-use scopes are explicit and recognized."
        : "Derived output must declare unique recognized requested-use scopes.");

    outputReports.push({
      id,
      status: parentScopesOk && present ? "derived-output-scope-evidence-complete-human-review-required" : "blocked",
      parentAssetIds: parentIds,
      requestedScopes: Array.isArray(output?.requestedScopes) ? output.requestedScopes : [],
      artifactAssetId: output?.artifactAssetId ?? null,
    });
  }
  return outputReports;
}

/** Rights-scope completeness only; never an automatic legal decision or release approval. */
export function validateBrf38RightsScope(manifest, byteReport) {
  const checks = [], blockers = [];
  const manifestOk = record(manifest) && manifest.schemaVersion === "1.0.0" &&
    safeId(manifest.evaluationId) && timestamp(manifest.evaluatedAt) &&
    Array.isArray(manifest.assets) && manifest.assets.length > 0 &&
    manifest.assets.length <= MAX_ASSETS && Array.isArray(manifest.derivedOutputs);
  add(checks, blockers, "manifest-contract", manifestOk,
    manifestOk ? "Rights scope manifest schema and bounded asset/output collections are valid."
      : "Manifest needs schemaVersion 1.0.0, evaluation ID/time, 1–64 assets and a derivedOutputs array.");
  if (!manifestOk) return blockedResult(manifest, checks, blockers);

  const allAssets = manifest.assets;
  const ids = new Set();
  const allIdsUnique = allAssets.every((asset) => {
    if (!safeId(asset?.id) || ids.has(asset.id)) return false;
    ids.add(asset.id);
    return true;
  });
  add(checks, blockers, "asset-ids-unique", allIdsUnique,
    allIdsUnique ? "All source and evidence asset IDs are unique." : "Asset IDs must be unique safe identifiers.");

  const assetMetadata = allAssets.map((asset, index) =>
    validateRecordMetadata(asset, index, checks, blockers)
  );
  const sourceAssets = allAssets.filter((asset) => asset?.kind === "source");
  const evidenceAssets = allAssets.filter((asset) => asset?.kind === "rights-evidence");
  add(checks, blockers, "source-assets-present", sourceAssets.length > 0,
    sourceAssets.length > 0 ? "At least one source asset is declared." : "No source assets were declared.");
  add(checks, blockers, "rights-evidence-assets-present", evidenceAssets.length > 0,
    evidenceAssets.length > 0 ? "Rights evidence snapshots are declared separately from source assets."
      : "No local rights evidence snapshot has been declared.");

  const byteReportOk = record(byteReport) && Array.isArray(byteReport.assets) &&
    byteReport.schemaVersion === "1.0.0" &&
    byteReport.evaluationId === manifest.evaluationId;
  add(checks, blockers, "source-byte-report-bound", byteReportOk,
    byteReportOk ? "Source-byte verification report has the matching evaluation ID."
      : "A matching BRF-36 local byte-verification report is required.");

  const byteVerifiedCount = byteReportOk
    ? allAssets.filter((asset) => asset.status === "pinned" && verifiedByteAsset(asset, byteReport)).length
    : 0;
  add(checks, blockers, "all-pinned-records-byte-verified",
    byteReportOk && allAssets.filter((asset) => asset.status === "pinned").every((asset) => Boolean(verifiedByteAsset(asset, byteReport))),
    "Rights snapshots and pinned source files must match actual local byte hashes before their evidence can be relied upon.");

  const rightsReports = [];
  for (const asset of sourceAssets) {
    rightsReports.push(validateRights(asset, allAssets, byteReport, manifest.evaluatedAt, checks, blockers));
  }
  for (const evidence of evidenceAssets) {
    const evidenceOk = evidence.status === "pinned" && Boolean(verifiedByteAsset(evidence, byteReport)) &&
      textValue(evidence.source.evidenceType);
    add(checks, blockers, "evidence-asset-" + evidence.id + "-verified",
      evidenceOk,
      evidenceOk ? "Rights evidence snapshot is locally byte-verified and has a stated evidence type."
        : "Rights evidence snapshot is unavailable, not byte-verified or missing its evidence type.");
  }

  const outputReports = validateDerivedOutputs(manifest.derivedOutputs, allAssets, rightsReports, byteReport, checks, blockers);
  const policyOk = record(manifest.releaseFlags) &&
    Object.keys(FLAGS).every((flag) => manifest.releaseFlags[flag] === false);
  add(checks, blockers, "release-flags-false", policyOk,
    policyOk ? "All release flags are explicitly false." : "Requested or missing release flags are not all explicitly false.");

  const uniqueBlockers = unique(blockers);
  const rightsApprovedAssetCount = rightsReports.filter((entry) => entry.status === "rights-evidence-complete").length;
  return {
    ...blockedResult(manifest, checks, uniqueBlockers, {
      rightsApprovedAssetCount,
      byteVerifiedAssetCount: byteVerifiedCount,
      derivedOutputs: outputReports,
    }),
    status: uniqueBlockers.length
      ? "blocked"
      : "evidence-complete-human-review-required",
    sourceRightsStatus: uniqueBlockers.length
      ? "incomplete-or-invalid"
      : "evidence-complete-human-review-required",
    rightsReports,
    derivedOutputs: outputReports,
    sourceRightsApprovedCount: rightsApprovedAssetCount,
    byteVerifiedAssetCount: byteVerifiedCount,
    releaseFlags: { ...FLAGS },
  };
}

export async function verifyAndValidateBrf38RightsScope(manifest, assetRoot) {
  const byteManifest = buildBrf38ByteVerificationManifest(manifest);
  const byteReport = await verifyBrf36SourceAssetBytes(byteManifest, assetRoot);
  const rightsReport = validateBrf38RightsScope(manifest, byteReport);
  return {
    schemaVersion: "1.0.0",
    evaluationId: rightsReport.evaluationId,
    status: rightsReport.status,
    byteVerification: {
      status: byteReport.status,
      assetCount: byteReport.assetCount,
      verifiedAssetCount: byteReport.verifiedAssetCount,
      blockers: byteReport.blockers,
      assets: byteReport.assets,
    },
    rightsScope: rightsReport,
    reportPolicy: "The report contains validation findings only; never adjudicates legal permission or enables release.",
    reportSha256: null,
  };
}
