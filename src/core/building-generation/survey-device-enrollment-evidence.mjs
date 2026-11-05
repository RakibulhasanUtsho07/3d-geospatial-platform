import { createHash, createPublicKey, verify } from "node:crypto";
import { parseTrustedSurveyDeviceRegistry } from "./survey-observation-device-attestation.mjs";

export const TRUSTED_SURVEY_DEVICE_ENROLLMENT_AUTHORITY_REGISTRY_SCHEMA_VERSION = "1.0.0";
export const SURVEY_DEVICE_ENROLLMENT_EVIDENCE_SCHEMA_VERSION = "1.0.0";
export const MAX_TRUSTED_SURVEY_DEVICE_ENROLLMENT_AUTHORITY_REGISTRY_BYTES = 64 * 1024;
export const MAX_SURVEY_DEVICE_ENROLLMENT_EVIDENCE_BYTES = 32 * 1024;
export const MAX_SURVEY_DEVICE_ENROLLMENT_AUTHORITIES = 100;
export const SURVEY_DEVICE_ENROLLMENT_EVIDENCE_NOTE = "This authority signature associates a device key and privacy-preserving identity commitments with an enrollment statement only. It does not establish a manufacturer certificate chain, secure-element custody, genuine receiver capture, firmware integrity, measurement accuracy or release approval.";

const REGISTRY_TYPE = "trusted-survey-device-enrollment-authority-public-key-registry";
const EVIDENCE_TYPE = "survey-device-enrollment-evidence";
const ENGINE = "survey-device-enrollment-evidence-v1";
const PURPOSE = "survey-device-key-enrollment-association-only";
const DOMAIN = Buffer.from("3d-geospatial-platform/survey-device-enrollment-evidence/v1\0", "utf8");
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const REGISTRY_FIELDS = ["schemaVersion", "recordType", "registryId", "issuedAtUtc", "expiresAtUtc", "entries"];
const AUTHORITY_FIELDS = ["authorityId", "authorityType", "keyId", "status", "publicKeyPem", "validFromUtc", "validUntilUtc", "revokedAtUtc", "replacesKeyId"];
const EVIDENCE_FIELDS = [
  "schemaVersion", "recordType", "engine", "signatureAlgorithm", "signaturePurpose", "enrollmentId",
  "deviceId", "manufacturerId", "modelId", "deviceSerialCommitmentSha256", "keyId",
  "devicePublicKeyFingerprintSha256", "authorityId", "authorityType", "authorityKeyId", "authorityRegistryId",
  "authorityRegistryIssuedAtUtc", "authorityRegistryExpiresAtUtc", "issuedAtUtc", "validFromUtc", "validUntilUtc",
  "publicationEligible", "note", "signatureBase64",
];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonicalUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function normalizeNow(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError("Enrollment evidence verification time must be valid.");
  return date;
}

function exactFields(value, fields) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safeId(value, label) {
  if (!isSafeId(value)) {
    throw new TypeError(label + " must be a canonical lowercase safe identifier.");
  }
  return value;
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Enrollment evidence contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Enrollment evidence contains a circular array.");
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (isObject(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Enrollment evidence must contain plain JSON objects.");
    }
    if (seen.has(value)) throw new TypeError("Enrollment evidence contains a circular object.");
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError("Enrollment evidence must not contain undefined values.");
      result[key] = canonicalize(value[key], seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError("Enrollment evidence must be JSON-compatible.");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function parseRegistryInput(input) {
  let registry = input;
  if (Buffer.isBuffer(input)) {
    if (input.length > MAX_TRUSTED_SURVEY_DEVICE_ENROLLMENT_AUTHORITY_REGISTRY_BYTES) {
      throw new RangeError("Enrollment-authority registry exceeds 64 KiB.");
    }
    try { registry = JSON.parse(input.toString("utf8")); }
    catch { throw new TypeError("Enrollment-authority registry must be valid UTF-8 JSON."); }
  } else if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_TRUSTED_SURVEY_DEVICE_ENROLLMENT_AUTHORITY_REGISTRY_BYTES) {
      throw new RangeError("Enrollment-authority registry exceeds 64 KiB.");
    }
    try { registry = JSON.parse(input); }
    catch { throw new TypeError("Enrollment-authority registry must be valid JSON."); }
  } else if (isObject(input) && Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_TRUSTED_SURVEY_DEVICE_ENROLLMENT_AUTHORITY_REGISTRY_BYTES) {
    throw new RangeError("Enrollment-authority registry exceeds 64 KiB.");
  }
  return registry;
}

function ed25519PublicKey(pem, label) {
  if (typeof pem !== "string" || pem.length < 64 || pem.length > 16 * 1024 ||
      !pem.includes("BEGIN PUBLIC KEY") || /PRIVATE KEY/.test(pem)) {
    throw new TypeError(label + " must contain a public-key PEM only.");
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(label + " must use Ed25519.");
  return key;
}

function fingerprint(key) {
  return sha256(key.export({ type: "spki", format: "der" }));
}

export function parseTrustedSurveyDeviceEnrollmentAuthorityRegistry(input, { now: nowInput } = {}) {
  const now = normalizeNow(nowInput);
  const registry = parseRegistryInput(input);
  if (!exactFields(registry, REGISTRY_FIELDS)) {
    throw new TypeError("Enrollment-authority registry must use the exact versioned envelope fields.");
  }
  if (registry.schemaVersion !== TRUSTED_SURVEY_DEVICE_ENROLLMENT_AUTHORITY_REGISTRY_SCHEMA_VERSION ||
      registry.recordType !== REGISTRY_TYPE) {
    throw new TypeError("Enrollment-authority registry schema or record type is unsupported.");
  }
  safeId(registry.registryId, "registryId");
  if (!canonicalUtc(registry.issuedAtUtc) || !canonicalUtc(registry.expiresAtUtc)) {
    throw new TypeError("Enrollment-authority registry timestamps must be canonical UTC values.");
  }
  const issued = Date.parse(registry.issuedAtUtc);
  const expires = Date.parse(registry.expiresAtUtc);
  const current = now.getTime();
  if (expires <= issued || expires - issued > 90 * 86400000) {
    throw new RangeError("Enrollment-authority registry lifetime must be positive and no longer than 90 days.");
  }
  if (current < issued) throw new Error("Enrollment-authority registry is not yet valid.");
  if (current >= expires) throw new Error("Enrollment-authority registry has expired.");
  if (!Array.isArray(registry.entries) || registry.entries.length < 1 || registry.entries.length > MAX_SURVEY_DEVICE_ENROLLMENT_AUTHORITIES) {
    throw new RangeError("Enrollment-authority registry must contain 1–100 key-history entries.");
  }

  const keyIds = new Set();
  const fingerprints = new Set();
  const activeByAuthority = new Map();
  const parsed = [];
  for (const [index, entry] of registry.entries.entries()) {
    if (!exactFields(entry, AUTHORITY_FIELDS)) {
      throw new TypeError("Enrollment-authority entry " + index + " must use the exact lifecycle fields.");
    }
    safeId(entry.authorityId, "authorityId");
    safeId(entry.keyId, "authority keyId");
    if (!["manufacturer", "independent-enrollment-authority"].includes(entry.authorityType)) {
      throw new TypeError("Enrollment-authority type is unsupported.");
    }
    if (!["active", "revoked"].includes(entry.status)) throw new TypeError("Enrollment-authority key status must be active or revoked.");
    if (keyIds.has(entry.keyId)) throw new TypeError("Enrollment-authority key IDs must be unique.");
    keyIds.add(entry.keyId);
    if (!canonicalUtc(entry.validFromUtc) || !canonicalUtc(entry.validUntilUtc)) {
      throw new TypeError("Enrollment-authority key validity timestamps must be canonical UTC.");
    }
    const from = Date.parse(entry.validFromUtc);
    const until = Date.parse(entry.validUntilUtc);
    if (until <= from || until > expires) throw new RangeError("Enrollment-authority key validity must end no later than registry expiry.");
    const key = ed25519PublicKey(entry.publicKeyPem, "Enrollment-authority key " + entry.keyId);
    const keyFingerprintSha256 = fingerprint(key);
    if (fingerprints.has(keyFingerprintSha256)) throw new TypeError("Enrollment-authority public-key fingerprints must be unique.");
    fingerprints.add(keyFingerprintSha256);
    if (entry.status === "active") {
      if (entry.revokedAtUtc !== null || from > current || until <= current) {
        throw new Error("Active enrollment-authority key must be unrevoked and currently valid.");
      }
      activeByAuthority.set(entry.authorityId, (activeByAuthority.get(entry.authorityId) ?? 0) + 1);
    } else {
      if (!canonicalUtc(entry.revokedAtUtc)) throw new TypeError("Revoked enrollment-authority keys require a canonical revocation time.");
      const revoked = Date.parse(entry.revokedAtUtc);
      if (revoked < from || revoked > current || revoked > until) {
        throw new RangeError("Enrollment-authority key revocation must be inside its validity window and not in the future.");
      }
    }
    if (entry.replacesKeyId !== null) safeId(entry.replacesKeyId, "replacesKeyId");
    parsed.push(Object.freeze({
      ...entry, publicKey: key, keyFingerprintSha256,
      registryId: registry.registryId, registryIssuedAtUtc: registry.issuedAtUtc,
      registryExpiresAtUtc: registry.expiresAtUtc,
    }));
  }
  for (const [authorityId, count] of activeByAuthority) {
    if (count !== 1) throw new TypeError("Enrollment authority " + authorityId + " must have at most one active key.");
  }
  const byId = new Map(parsed.map((entry) => [entry.keyId, entry]));
  const children = new Map();
  for (const entry of parsed) {
    if (entry.replacesKeyId === null) continue;
    const previous = byId.get(entry.replacesKeyId);
    if (!previous || previous.authorityId !== entry.authorityId || previous.authorityType !== entry.authorityType ||
        previous.status !== "revoked" || Date.parse(previous.revokedAtUtc) > Date.parse(entry.validFromUtc) ||
        children.has(previous.keyId)) {
      throw new TypeError("Enrollment-authority key must replace one earlier revoked key for the same authority.");
    }
    children.set(previous.keyId, entry.keyId);
  }
  const grouped = new Map();
  for (const entry of parsed) {
    const history = grouped.get(entry.authorityId) ?? [];
    history.push(entry);
    grouped.set(entry.authorityId, history);
  }
  for (const [authorityId, entries] of grouped) {
    const roots = entries.filter((entry) => entry.replacesKeyId === null);
    if (roots.length !== 1) throw new TypeError("Enrollment authority " + authorityId + " key history must have exactly one root.");
    let currentEntry = roots[0];
    const visited = new Set();
    while (currentEntry) {
      if (visited.has(currentEntry.keyId)) throw new TypeError("Enrollment-authority key history contains a cycle.");
      visited.add(currentEntry.keyId);
      currentEntry = children.has(currentEntry.keyId) ? byId.get(children.get(currentEntry.keyId)) : null;
    }
    if (visited.size !== entries.length) throw new TypeError("Enrollment-authority key history must form one complete linear chain.");
  }

  return Object.freeze({
    schemaVersion: registry.schemaVersion,
    registryId: registry.registryId,
    issuedAtUtc: registry.issuedAtUtc,
    expiresAtUtc: registry.expiresAtUtc,
    entries: Object.freeze(parsed),
    activeEntries: Object.freeze(parsed.filter((entry) => entry.status === "active")),
  });
}

function unsignedContext(evidence) {
  const { signatureBase64: _signatureBase64, ...context } = evidence;
  return context;
}

export function surveyDeviceEnrollmentEvidenceSigningBytes(evidence) {
  if (!exactFields(evidence, EVIDENCE_FIELDS)) throw new TypeError("Device enrollment evidence fields are invalid.");
  return Buffer.concat([DOMAIN, Buffer.from(canonicalJson(unsignedContext(evidence)), "utf8")]);
}

export function surveyDeviceEnrollmentEvidencePath(deviceId, keyId) {
  safeId(deviceId, "deviceId");
  safeId(keyId, "keyId");
  for (const value of [deviceId, keyId]) {
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value.split(".")[0])) {
      throw new TypeError("Device enrollment evidence identifier is unsafe for a cross-platform file path.");
    }
  }
  return "evidence/device-enrollments/" + deviceId + "." + keyId + ".enrollment.json";
}

export function buildSurveyDeviceEnrollmentEvidenceInventory(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_SURVEY_DEVICE_ENROLLMENT_AUTHORITIES) {
    throw new RangeError("Device enrollment evidence inventory requires 1–100 unique device-key entries.");
  }
  const pairs = new Set();
  const paths = new Set();
  const normalized = entries.map((entry, index) => {
    if (!isObject(entry)) throw new TypeError("Device enrollment evidence inventory entry " + index + " is invalid.");
    const deviceId = safeId(entry.deviceId, "deviceId");
    const keyId = safeId(entry.keyId, "keyId");
    const relativePath = surveyDeviceEnrollmentEvidencePath(deviceId, keyId);
    if (entry.relativePath !== relativePath || paths.has(relativePath) || pairs.has(deviceId + "\0" + keyId) ||
        !HASH.test(entry.sha256 ?? "") || !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 1 || entry.bytes > MAX_SURVEY_DEVICE_ENROLLMENT_EVIDENCE_BYTES ||
        !isSafeId(entry.authorityId) ||
        !["manufacturer", "independent-enrollment-authority"].includes(entry.authorityType) ||
        !isSafeId(entry.authorityRegistryId)) {
      throw new TypeError("Device enrollment evidence inventory entry " + index + " is invalid or duplicated.");
    }
    pairs.add(deviceId + "\0" + keyId);
    paths.add(relativePath);
    return {
      deviceId, keyId, relativePath, sha256: entry.sha256, bytes: entry.bytes,
      authorityId: entry.authorityId, authorityType: entry.authorityType,
      authorityRegistryId: entry.authorityRegistryId,
    };
  }).sort((left, right) => left.deviceId.localeCompare(right.deviceId) || left.keyId.localeCompare(right.keyId));
  const registryIds = new Set(normalized.map((entry) => entry.authorityRegistryId));
  if (registryIds.size !== 1) throw new TypeError("All enrollment evidence in one inventory must use the same authority registry.");
  const totalBytes = normalized.reduce((sum, entry) => sum + entry.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_SURVEY_DEVICE_ENROLLMENT_AUTHORITIES * MAX_SURVEY_DEVICE_ENROLLMENT_EVIDENCE_BYTES) {
    throw new RangeError("Device enrollment evidence inventory exceeds the aggregate byte limit.");
  }
  return {
    count: normalized.length,
    totalBytes,
    sha256: sha256(Buffer.from(JSON.stringify(normalized), "utf8")),
    entries: normalized,
  };
}

export function verifySurveyDeviceEnrollmentEvidence({
  evidenceBytes,
  trustedDeviceRegistry,
  trustedEnrollmentAuthorityRegistry,
  deviceId,
  keyId,
  now: nowInput,
}) {
  if (!Buffer.isBuffer(evidenceBytes) || evidenceBytes.length < 1 || evidenceBytes.length > MAX_SURVEY_DEVICE_ENROLLMENT_EVIDENCE_BYTES) {
    throw new RangeError("Device enrollment evidence must be a non-empty Buffer no larger than 32 KiB.");
  }
  safeId(deviceId, "deviceId");
  safeId(keyId, "keyId");
  const now = normalizeNow(nowInput);
  const checks = [];
  const errors = [];
  const check = (id, passed, message) => {
    const result = { id, status: passed ? "passed" : "failed", message };
    checks.push(result);
    if (!passed) errors.push(result);
  };

  let evidence = null;
  try { evidence = JSON.parse(evidenceBytes.toString("utf8")); }
  catch { check("evidence-json", false, "Enrollment evidence must be valid UTF-8 JSON."); }
  const fieldsValid = exactFields(evidence, EVIDENCE_FIELDS);
  check("evidence-fields", fieldsValid, "Enrollment evidence must contain exactly the documented versioned fields.");
  const canonicalBytes = Boolean(fieldsValid) && canonicalJson(evidence) === evidenceBytes.toString("utf8");
  check("evidence-canonical-json", canonicalBytes, "Enrollment evidence bytes must be canonical JSON with no extra whitespace or alternate field ordering.");

  let deviceRegistry = null;
  try {
    // D3M-17's parser accepts a JSON string or object, not a Buffer. The CLI
    // deliberately performs bounded stable reads and passes immutable bytes.
    const deviceRegistryInput = Buffer.isBuffer(trustedDeviceRegistry)
      ? trustedDeviceRegistry.toString("utf8")
      : trustedDeviceRegistry;
    deviceRegistry = parseTrustedSurveyDeviceRegistry(deviceRegistryInput, { now });
  }
  catch (error) { check("trusted-device-registry", false, error instanceof Error ? error.message : "Trusted device registry is invalid."); }
  const deviceMatches = deviceRegistry?.activeEntries.filter((entry) => entry.deviceId === deviceId && entry.keyId === keyId) ?? [];
  const deviceEntry = deviceMatches.length === 1 ? deviceMatches[0] : null;
  check("active-device-registry-entry", Boolean(deviceEntry), "Device and key must resolve to one currently active D3M-17 registry entry.");

  const shapeValid = fieldsValid && evidence.schemaVersion === SURVEY_DEVICE_ENROLLMENT_EVIDENCE_SCHEMA_VERSION &&
    evidence.recordType === EVIDENCE_TYPE && evidence.engine === ENGINE && evidence.signatureAlgorithm === "Ed25519" &&
    evidence.signaturePurpose === PURPOSE && isSafeId(evidence.enrollmentId) &&
    isSafeId(evidence.deviceId) && isSafeId(evidence.manufacturerId) && isSafeId(evidence.modelId) &&
    HASH.test(evidence.deviceSerialCommitmentSha256 ?? "") && isSafeId(evidence.keyId) &&
    HASH.test(evidence.devicePublicKeyFingerprintSha256 ?? "") && isSafeId(evidence.authorityId) &&
    ["manufacturer", "independent-enrollment-authority"].includes(evidence.authorityType) &&
    isSafeId(evidence.authorityKeyId) && isSafeId(evidence.authorityRegistryId) &&
    [evidence.authorityRegistryIssuedAtUtc, evidence.authorityRegistryExpiresAtUtc, evidence.issuedAtUtc,
      evidence.validFromUtc, evidence.validUntilUtc].every(canonicalUtc) &&
    evidence.publicationEligible === false && evidence.note === SURVEY_DEVICE_ENROLLMENT_EVIDENCE_NOTE &&
    typeof evidence.signatureBase64 === "string" && SIGNATURE.test(evidence.signatureBase64);
  check("evidence-envelope", shapeValid, "Enrollment evidence identifiers, purpose, digests, timestamps and signature encoding must be canonical.");
  check("evidence-request-binding", shapeValid && evidence.deviceId === deviceId && evidence.keyId === keyId,
    "Enrollment evidence must name the requested device and key.");
  const evidenceDigest = sha256(evidenceBytes);
  check("registry-evidence-digest", Boolean(deviceEntry) && deviceEntry.enrollmentEvidenceSha256 === evidenceDigest,
    "Exact enrollment evidence bytes must match the digest in the D3M-17 device registry.");

  check("device-identity-binding", Boolean(deviceEntry && shapeValid) &&
    evidence.manufacturerId === deviceEntry.manufacturerId && evidence.modelId === deviceEntry.modelId &&
    evidence.deviceSerialCommitmentSha256 === deviceEntry.deviceSerialCommitmentSha256 &&
    evidence.devicePublicKeyFingerprintSha256 === deviceEntry.keyFingerprintSha256 &&
    evidence.validFromUtc === deviceEntry.validFromUtc && evidence.validUntilUtc === deviceEntry.validUntilUtc,
    "Enrollment evidence must bind the exact D3M-17 manufacturer/model, serial commitment, public-key fingerprint and key-validity interval.");

  let authorityRegistry = null;
  try { authorityRegistry = parseTrustedSurveyDeviceEnrollmentAuthorityRegistry(trustedEnrollmentAuthorityRegistry, { now }); }
  catch (error) {
    check("trusted-enrollment-authority-registry", false,
      error instanceof Error ? error.message : "Enrollment authority registry is invalid.");
  }
  const authorityMatches = authorityRegistry && shapeValid ? authorityRegistry.activeEntries.filter((entry) =>
    entry.authorityId === evidence.authorityId && entry.authorityType === evidence.authorityType &&
    entry.keyId === evidence.authorityKeyId && entry.registryId === evidence.authorityRegistryId &&
    entry.registryIssuedAtUtc === evidence.authorityRegistryIssuedAtUtc &&
    entry.registryExpiresAtUtc === evidence.authorityRegistryExpiresAtUtc) : [];
  const authority = authorityMatches?.length === 1 ? authorityMatches[0] : null;
  check("trusted-enrollment-authority", Boolean(authority),
    "Issuer and signing key must resolve to one active entry in the separately provisioned authority registry.");

  const issuedAt = shapeValid ? Date.parse(evidence.issuedAtUtc) : NaN;
  const validFrom = shapeValid ? Date.parse(evidence.validFromUtc) : NaN;
  const validUntil = shapeValid ? Date.parse(evidence.validUntilUtc) : NaN;
  const timeValid = Boolean(authority && deviceEntry) &&
    issuedAt >= Date.parse(authority.validFromUtc) && issuedAt < Date.parse(authority.validUntilUtc) && issuedAt <= now.getTime() &&
    issuedAt >= validFrom && issuedAt < validUntil && validFrom <= now.getTime() && validUntil > now.getTime() &&
    validFrom === Date.parse(deviceEntry.validFromUtc) && validUntil === Date.parse(deviceEntry.validUntilUtc);
  check("enrollment-evidence-time-window", timeValid,
    "Enrollment evidence must be currently valid and issued inside the authority-key window; its validity must match the registered device key.");

  let signatureValid = false;
  if (authority && shapeValid && canonicalBytes && timeValid) {
    try {
      const signature = Buffer.from(evidence.signatureBase64, "base64");
      signatureValid = signature.length === 64 && signature.toString("base64") === evidence.signatureBase64 &&
        verify(null, surveyDeviceEnrollmentEvidenceSigningBytes(evidence), authority.publicKey, signature);
    } catch { signatureValid = false; }
  }
  check("enrollment-authority-ed25519-signature", signatureValid,
    "Ed25519 authority signature must authenticate the canonical device enrollment statement.");

  return {
    schemaVersion: "1.0.0",
    engine: "survey-device-enrollment-evidence-verification-v1",
    status: errors.length === 0 ? "device-enrollment-evidence-verified" : "device-enrollment-evidence-invalid",
    valid: errors.length === 0,
    evidenceSha256: evidenceDigest,
    enrollmentId: shapeValid ? evidence.enrollmentId : null,
    deviceId,
    keyId,
    authorityId: authority?.authorityId ?? null,
    authorityType: authority?.authorityType ?? null,
    authorityRegistryId: authorityRegistry?.registryId ?? null,
    checks,
    errors,
    publicationEligible: false,
    note: "Verification establishes that an operator-provisioned authority key signed this exact enrollment statement and that it matches the current D3M-17 device registry. It does not independently establish manufacturer certification, hardware identity, secure-element custody, genuine receiver capture, firmware integrity or measurement accuracy.",
  };
}
