const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const ALLOWED_KINDS = new Set(["image", "point-cloud", "reference-model"]);
const ALLOWED_ROLES = new Set(["candidate-image", "candidate-points", "independent-reference", "map-base-data"]);
const RIGHTS_STATUSES = new Set([
  "source-declared-not-independently-authenticated",
  "evidence-incomplete",
  "source-license-conflict",
  "reviewed-exact-scope",
]);
const DEMO_USES = new Set([
  "source-byte-integrity-smoke-test",
  "private-image-ingestion-smoke-test",
  "private-render-smoke-test",
]);
const REQUIRED_DEMO_DENIALS = [
  "independent-reference-truth",
  "held-out-checkpoint",
  "survey-accuracy-claim",
  "public-image-redistribution",
  "derived-model-publication",
  "production-map-publication",
];
const FALSE_RELEASE_FLAGS = Object.freeze({
  acceptanceEligible: false,
  publicationEligible: false,
  mapReady: false,
  automaticApproval: false,
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function textValue(value) {
  return typeof value === "string" && value.trim().length > 0;
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
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => textValue(item)) &&
    value.length === unique(value).length;
}

export function validateBrf41InterimDatasetPolicy(manifest) {
  const checks = [];
  const blockers = [];
  const policy = record(manifest) && record(manifest.policy) ? manifest.policy : {};
  const assets = record(manifest) && Array.isArray(manifest.assets) ? manifest.assets : [];

  add(checks, blockers, "manifest-schema", record(manifest) &&
    manifest.schemaVersion === "1.0.0" &&
    manifest.evaluationId === "BRF-41-INTERIM-DATA-ADMISSION-POLICY",
    "Manifest must use the supported BRF-41 schema and evaluation ID.");
  add(checks, blockers, "commercial-safe-policy", policy.productMode === "potentially-commercial" &&
    policy.noLicenseInferenceFromPublicAvailability === true &&
    policy.humanReviewRequired === true &&
    policy.releaseApprovalAllowed === false &&
    policy.temporaryDataCannotEstablishRealWorldAccuracy === true,
    "Policy must prevent rights inference from availability and keep accuracy and release approval separate.");
  add(checks, blockers, "asset-count", assets.length > 0 && assets.length <= 32,
    "Policy inventory must contain 1–32 bounded asset records.");

  const ids = assets.map((asset) => asset?.id);
  add(checks, blockers, "unique-asset-ids", ids.every((id) => typeof id === "string" && SAFE_ID.test(id)) &&
    ids.length === unique(ids).length,
    "Every asset requires a stable, unique ID.");

  for (const asset of assets) {
    const id = SAFE_ID.test(asset?.id || "") ? asset.id : "invalid-asset";
    const source = record(asset?.source) ? asset.source : {};
    const rights = record(asset?.rights) ? asset.rights : {};
    const allowedUses = Array.isArray(asset?.allowedUses) ? asset.allowedUses : [];
    const deniedUses = Array.isArray(asset?.deniedUses) ? asset.deniedUses : [];

    const metadataOk = record(asset) && ALLOWED_KINDS.has(asset.kind) &&
      ALLOWED_ROLES.has(asset.role) && https(source.recordUrl) &&
      textValue(source.version) && ["demo-only", "blocked"].includes(asset.decision) &&
      RIGHTS_STATUSES.has(rights.status) &&
      isStringArray(allowedUses) && isStringArray(deniedUses);
    add(checks, blockers, "asset-" + id + "-metadata", metadataOk,
      "Asset kind, role, source record/version, decision, rights status and use lists must be explicit and valid.");
    if (!metadataOk) continue;

    const noContradictoryUses = allowedUses.every((use) => !deniedUses.includes(use));
    add(checks, blockers, "asset-" + id + "-use-list-consistency", noContradictoryUses,
      "The same use must not be both allowed and denied.");

    if (asset.decision === "blocked") {
      add(checks, blockers, "asset-" + id + "-blocked-no-uses",
        allowedUses.length === 0 && textValue(asset.blockReason),
        "Blocked assets must have zero allowed uses and a concrete blocking reason.");
      add(checks, blockers, "asset-" + id + "-conflicting-rights-not-admitted",
        rights.status !== "source-license-conflict" || asset.decision === "blocked",
        "Conflicting license declarations cannot be treated as an admitted dataset.");
      continue;
    }

    const sourcePinOk = https(source.assetUrl) && textValue(source.fileName) &&
      textValue(source.version) && Number.isSafeInteger(source.byteSize) && source.byteSize > 0 &&
      typeof source.sha256 === "string" && SHA256.test(source.sha256);
    add(checks, blockers, "asset-" + id + "-exact-source-pin", sourcePinOk,
      "Demo-only assets require an exact filename, version, positive byte size and SHA-256.");

    const licenseOk = rights.status === "source-declared-not-independently-authenticated" &&
      textValue(rights.licenseIdentifier) && https(rights.licenseUrl) &&
      textValue(rights.scope) && textValue(rights.attribution);
    add(checks, blockers, "asset-" + id + "-limited-rights-statement", licenseOk,
      "Demo-only admission requires a source-declared license URL, explicit scope and attribution, but does not authenticate the grant.");

    const byteCheck = record(asset.actualByteVerification) ? asset.actualByteVerification : {};
    const byteEvidenceOk = byteCheck.status === "verified-ephemeral-ci" &&
      https(byteCheck.runUrl) && typeof byteCheck.exactHeadSha === "string" &&
      /^[a-f0-9]{40}$/i.test(byteCheck.exactHeadSha) &&
      byteCheck.actualByteSize === source.byteSize &&
      typeof byteCheck.actualSha256 === "string" &&
      byteCheck.actualSha256.toLowerCase() === source.sha256.toLowerCase() &&
      textValue(byteCheck.note);
    add(checks, blockers, "asset-" + id + "-byte-evidence", byteEvidenceOk,
      "Demo-only assets need matching historic byte evidence, while each new acquisition must be re-hashed.");

    const demoUseOk = asset.role === "candidate-image" && allowedUses.length > 0 &&
      allowedUses.every((use) => DEMO_USES.has(use));
    add(checks, blockers, "asset-" + id + "-demo-use-boundary", demoUseOk,
      "The interim lane allows only private byte, image-ingestion and render smoke tests for candidate images.");

    const denyBoundaryOk = REQUIRED_DEMO_DENIALS.every((use) => deniedUses.includes(use)) &&
      REQUIRED_DEMO_DENIALS.every((use) => !allowedUses.includes(use));
    add(checks, blockers, "asset-" + id + "-claim-and-publication-boundary", denyBoundaryOk,
      "Demo-only imagery must explicitly forbid independent truth, held-out checks, survey accuracy, public redistribution, derived-model publication and production-map publication.");

    const independence = record(asset.independence) ? asset.independence : {};
    const independenceOk = independence.status === "not-independent" && textValue(independence.reason) &&
      deniedUses.includes("independent-reference-truth") &&
      deniedUses.includes("held-out-checkpoint") && deniedUses.includes("survey-accuracy-claim");
    add(checks, blockers, "asset-" + id + "-independent-truth-separation", independenceOk,
      "Demo imagery cannot be admitted as independent reference truth without separate independent evidence.");
  }

  const flags = record(manifest) && record(manifest.releaseFlags) ? manifest.releaseFlags : {};
  const releaseFlagsOk = Object.keys(FALSE_RELEASE_FLAGS).every((key) => flags[key] === false) &&
    Object.keys(flags).every((key) => Object.hasOwn(FALSE_RELEASE_FLAGS, key));
  add(checks, blockers, "release-flags-false", releaseFlagsOk,
    "All release flags must remain present and false in the interim policy register.");

  const demoOnlyAssetCount = assets.filter((asset) => asset?.decision === "demo-only").length;
  const blockedAssetCount = assets.filter((asset) => asset?.decision === "blocked").length;
  return {
    schemaVersion: "1.0.0",
    evaluationId: record(manifest) && textValue(manifest.evaluationId)
      ? manifest.evaluationId
      : "invalid-manifest",
    status: blockers.length ? "blocked" : demoOnlyAssetCount
      ? "policy-compliant-demo-only"
      : "policy-compliant-blocked-only",
    demoOnlyAssetCount,
    blockedAssetCount,
    blockers: unique(blockers),
    checks,
    assets: assets.map((asset) => ({
      id: asset?.id ?? null,
      role: asset?.role ?? null,
      decision: asset?.decision ?? null,
      rightsStatus: asset?.rights?.status ?? null,
      allowedUses: Array.isArray(asset?.allowedUses) ? asset.allowedUses : [],
      deniedUses: Array.isArray(asset?.deniedUses) ? asset.deniedUses : [],
    })),
    releaseFlags: { ...FALSE_RELEASE_FLAGS },
    policy: "interim-use classification only; no legal interpretation, license grant, independent accuracy adjudication or release approval",
  };
}
