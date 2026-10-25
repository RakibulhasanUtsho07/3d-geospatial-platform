const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_JPEG = /^[a-z0-9][a-z0-9._-]*\.jpg$/i;
const REQUIRED_ROLES = Object.freeze(["front-facade", "side-facade", "high-angle-roof"]);
const ALLOWED_ROLES = new Set(REQUIRED_ROLES);

function isHttpsHost(value, host) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === host;
  } catch {
    return false;
  }
}

/**
 * Validates provenance metadata before any reference image is downloaded.
 * This validates the registry only; it does not establish that a photograph
 * depicts the correct building or that a model is geometrically accurate.
 */
export function validateHeritageReferenceRegistry(registry) {
  const errors = [];
  const pendingHashPins = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return { valid: false, errors: ["registry-must-be-an-object"], pendingHashPins, sourceCount: 0 };
  }
  if (registry.schemaVersion !== "1.0.0") errors.push("unsupported-schema-version");
  if (typeof registry.registryId !== "string" || !registry.registryId.trim()) errors.push("registry-id-missing");
  if (registry.building?.id !== "ahsan-manzil-kumartuli-dhaka") errors.push("unexpected-building-id");
  if (registry.evidenceClass !== "photographic-reference") errors.push("evidence-class-must-be-photographic-reference");
  if (!SHA256.test(registry.candidateModel?.sha256 ?? "")) errors.push("candidate-model-sha256-invalid");
  if (typeof registry.candidateModel?.sourceCommit !== "string" || !/^[a-f0-9]{40}$/i.test(registry.candidateModel.sourceCommit)) {
    errors.push("candidate-model-source-commit-invalid");
  }
  const policy = registry.policy;
  if (!policy || policy.establishesSurveyedDimensions !== false ||
      policy.establishesGeodeticGroundControl !== false ||
      policy.verifiesOccludedOrUnseenGeometry !== false ||
      policy.enablesPublication !== false || policy.humanReviewRequired !== true) {
    errors.push("evidence-policy-must-remain-review-only");
  }
  if (!Array.isArray(registry.sources) || registry.sources.length < REQUIRED_ROLES.length) {
    errors.push("insufficient-reference-sources");
  }
  const sources = Array.isArray(registry.sources) ? registry.sources : [];
  const ids = new Set();
  const filenames = new Set();
  const roles = new Set();
  for (const [index, source] of sources.entries()) {
    const label = "source-" + index;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      errors.push(label + "-must-be-an-object");
      continue;
    }
    if (typeof source.id !== "string" || !source.id.trim()) errors.push(label + "-id-missing");
    else if (ids.has(source.id)) errors.push("duplicate-source-id:" + source.id);
    else ids.add(source.id);

    if (typeof source.fileName !== "string" || !SAFE_JPEG.test(source.fileName) ||
        source.fileName.includes("..") || source.fileName.includes("/") || source.fileName.includes("\\")) {
      errors.push(label + "-filename-invalid");
    } else if (filenames.has(source.fileName)) errors.push("duplicate-source-filename:" + source.fileName);
    else filenames.add(source.fileName);

    if (!ALLOWED_ROLES.has(source.viewRole)) errors.push(label + "-view-role-invalid");
    else roles.add(source.viewRole);
    if (!isHttpsHost(source.sourcePageUrl, "commons.wikimedia.org")) errors.push(label + "-source-page-host-invalid");
    if (!isHttpsHost(source.downloadUrl, "commons.wikimedia.org")) errors.push(label + "-download-host-invalid");
    if (typeof source.attribution !== "string" || !source.attribution.trim()) errors.push(label + "-attribution-missing");
    if (source.license !== "CC BY-SA 4.0" ||
        source.licenseUrl !== "https://creativecommons.org/licenses/by-sa/4.0/") {
      errors.push(label + "-license-metadata-invalid");
    }
    if (typeof source.sourceRevision !== "string" || !/^\d+$/.test(source.sourceRevision)) errors.push(label + "-source-revision-missing");
    if (!Number.isSafeInteger(source.expectedWidth) || source.expectedWidth < 1 ||
        !Number.isSafeInteger(source.expectedHeight) || source.expectedHeight < 1) errors.push(label + "-expected-dimensions-invalid");
    if (source.expectedBytes !== undefined &&
        (!Number.isSafeInteger(source.expectedBytes) || source.expectedBytes < 1)) errors.push(label + "-expected-byte-count-invalid");

    if (source.hashPinStatus === "pinned") {
      if (!SHA1.test(source.expectedSha1 ?? "")) errors.push(label + "-pinned-sha1-invalid");
    } else if (source.hashPinStatus === "capture-and-pin-required") {
      if (source.expectedSha1 !== null) errors.push(label + "-un-pinned-sha1-must-be-null");
      pendingHashPins.push(source.id || label);
    } else {
      errors.push(label + "-hash-pin-status-invalid");
    }
    if (typeof source.sourceNotes !== "string" || !source.sourceNotes.trim()) errors.push(label + "-source-notes-missing");
  }
  for (const role of REQUIRED_ROLES) {
    if (!roles.has(role)) errors.push("required-view-role-missing:" + role);
  }
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    pendingHashPins,
    sourceCount: sources.length,
    requiredRoles: [...REQUIRED_ROLES],
  };
}

export const REQUIRED_HERITAGE_REFERENCE_ROLES = REQUIRED_ROLES;
