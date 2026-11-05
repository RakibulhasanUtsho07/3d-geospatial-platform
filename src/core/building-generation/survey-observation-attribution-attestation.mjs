import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

export const TRUSTED_SURVEYOR_REGISTRY_SCHEMA_VERSION = "1.0.0";
export const SURVEY_OBSERVATION_ATTESTATION_SCHEMA_VERSION = "1.0.0";
export const MAX_TRUSTED_SURVEYOR_REGISTRY_BYTES = 64 * 1024;
export const MAX_SURVEY_OBSERVATION_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_CONTROL_POINT_MANIFEST_BYTES = 1024 * 1024;
export const MAX_TRUSTED_SURVEYOR_KEYS = 100;

export const SURVEY_OBSERVATION_ATTESTATION_PURPOSE =
  "survey-observation-record-attribution-and-checkpoint-association-only";
const REGISTRY_RECORD_TYPE = "trusted-surveyor-public-key-registry";
const ATTESTATION_ENGINE = "survey-observation-attribution-attestation-v1";
const ATTESTATION_NOTE =
  "This signature attributes exact opaque record bytes to a declared checkpoint context using an active registered key. It is not survey certification, measurement accuracy evidence, receiver authentication or release approval.";
const DOMAIN = Buffer.from(
  "3d-geospatial-platform/survey-observation-attribution/v1\0",
  "utf8",
);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SAFE_CONTEXT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const REGISTRY_FIELDS = [
  "schemaVersion",
  "recordType",
  "registryId",
  "issuedAtUtc",
  "expiresAtUtc",
  "entries",
];
const ENTRY_FIELDS = [
  "surveyorId",
  "keyId",
  "status",
  "publicKeyPem",
  "validFromUtc",
  "validUntilUtc",
  "revokedAtUtc",
  "replacesKeyId",
];
const ATTESTATION_FIELDS = [
  "schemaVersion",
  "engine",
  "algorithm",
  "signaturePurpose",
  "observationId",
  "checkpointId",
  "buildingId",
  "recordSha256",
  "recordBytes",
  "controlPointManifestSha256",
  "surveyorId",
  "keyId",
  "registryId",
  "publicKeyFingerprintSha256",
  "registryIssuedAtUtc",
  "registryExpiresAtUtc",
  "keyValidFromUtc",
  "keyValidUntilUtc",
  "attestedAtUtc",
  "publicationEligible",
  "note",
  "signatureBase64",
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalUtc(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a canonical lowercase safe identifier.");
  }
  return value;
}

function canonicalize(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Signed context contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Signed context must not contain circular arrays.");
    ancestors.add(value);
    const result = value.map((entry) => canonicalize(entry, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (isObject(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Signed context must contain plain JSON objects.");
    }
    if (ancestors.has(value)) throw new TypeError("Signed context must not contain circular objects.");
    ancestors.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError("Signed context must not contain undefined values.");
      result[key] = canonicalize(value[key], ancestors);
    }
    ancestors.delete(value);
    return result;
  }
  throw new TypeError("Signed context must contain JSON-compatible values.");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function parsePublicKey(pem, label) {
  if (typeof pem !== "string" || pem.length < 64 || pem.length > 16 * 1024 ||
      !pem.includes("BEGIN PUBLIC KEY") || /PRIVATE KEY/.test(pem)) {
    throw new TypeError(label + " must contain public-key PEM only.");
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError(label + " must be an Ed25519 public key.");
  }
  return key;
}

function fingerprint(publicKey) {
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

function normalizeNow(value) {
  const now = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new TypeError("Registry validation time must be valid.");
  return now;
}

function parseRegistryInput(input) {
  let registry = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_TRUSTED_SURVEYOR_REGISTRY_BYTES) {
      throw new RangeError("Trusted surveyor registry exceeds the 64 KiB limit.");
    }
    try {
      registry = JSON.parse(input);
    } catch {
      throw new TypeError("Trusted surveyor registry must be valid JSON.");
    }
  } else if (isObject(input)) {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_TRUSTED_SURVEYOR_REGISTRY_BYTES) {
      throw new RangeError("Trusted surveyor registry exceeds the 64 KiB limit.");
    }
  }
  return registry;
}

/**
 * Parse the dedicated trusted-surveyor registry. This registry is intentionally
 * independent from the reconstruction trusted-reviewer registry.
 *
 * A valid result may contain zero active keys only when every entry is revoked;
 * that is an emergency lockout state and authorizes no new signatures.
 */
export function parseTrustedSurveyorRegistry(input, { now: nowInput } = {}) {
  const now = normalizeNow(nowInput);
  const registry = parseRegistryInput(input);
  if (!isObject(registry) ||
      Object.keys(registry).length !== REGISTRY_FIELDS.length ||
      Object.keys(registry).some((key) => !REGISTRY_FIELDS.includes(key)) ||
      REGISTRY_FIELDS.some((key) => !Object.hasOwn(registry, key))) {
    throw new TypeError("Trusted surveyor registry must use the exact versioned envelope fields.");
  }
  if (registry.schemaVersion !== TRUSTED_SURVEYOR_REGISTRY_SCHEMA_VERSION ||
      registry.recordType !== REGISTRY_RECORD_TYPE) {
    throw new TypeError("Trusted surveyor registry schema or record type is unsupported.");
  }
  safeId(registry.registryId, "registryId");
  if (!canonicalUtc(registry.issuedAtUtc) || !canonicalUtc(registry.expiresAtUtc)) {
    throw new TypeError("Registry timestamps must be canonical UTC timestamps with milliseconds.");
  }

  const issued = Date.parse(registry.issuedAtUtc);
  const expires = Date.parse(registry.expiresAtUtc);
  const current = now.getTime();
  const maxLifetime = 90 * 24 * 60 * 60 * 1000;
  if (expires <= issued || expires - issued > maxLifetime) {
    throw new RangeError("Registry lifetime must be positive and no longer than 90 days.");
  }
  if (current < issued) throw new Error("Trusted surveyor registry is not yet valid.");
  if (current >= expires) throw new Error("Trusted surveyor registry has expired.");

  if (!Array.isArray(registry.entries) ||
      registry.entries.length < 1 ||
      registry.entries.length > MAX_TRUSTED_SURVEYOR_KEYS) {
    throw new RangeError("Trusted surveyor registry must contain 1–100 key history entries.");
  }

  const keyIds = new Set();
  const fingerprints = new Set();
  const parsed = [];
  const activeBySurveyor = new Map();
  for (const [index, entry] of registry.entries.entries()) {
    if (!isObject(entry) ||
        Object.keys(entry).length !== ENTRY_FIELDS.length ||
        Object.keys(entry).some((key) => !ENTRY_FIELDS.includes(key)) ||
        ENTRY_FIELDS.some((key) => !Object.hasOwn(entry, key))) {
      throw new TypeError("Surveyor key entry " + index + " must contain exactly the documented lifecycle fields.");
    }
    safeId(entry.surveyorId, "surveyorId");
    safeId(entry.keyId, "keyId");
    if (!["active", "revoked"].includes(entry.status)) {
      throw new TypeError("Surveyor key status must be active or revoked.");
    }
    if (keyIds.has(entry.keyId)) throw new TypeError("Surveyor key IDs must be globally unique.");
    keyIds.add(entry.keyId);

    if (!canonicalUtc(entry.validFromUtc) || !canonicalUtc(entry.validUntilUtc)) {
      throw new TypeError("Surveyor key validity timestamps must be canonical UTC values.");
    }
    const validFrom = Date.parse(entry.validFromUtc);
    const validUntil = Date.parse(entry.validUntilUtc);
    if (validUntil <= validFrom || validUntil > expires) {
      throw new RangeError("Surveyor key validity must be positive and end no later than registry expiry.");
    }
    const publicKey = parsePublicKey(entry.publicKeyPem, "Surveyor key " + entry.keyId);
    const publicKeyFingerprintSha256 = fingerprint(publicKey);
    if (fingerprints.has(publicKeyFingerprintSha256)) {
      throw new TypeError("Surveyor public-key fingerprints must be unique across active and revoked keys.");
    }
    fingerprints.add(publicKeyFingerprintSha256);

    let revokedAt = null;
    if (entry.status === "active") {
      if (entry.revokedAtUtc !== null || validFrom > current || validUntil <= current) {
        throw new Error("Active surveyor key must be unrevoked and currently within its validity interval.");
      }
      activeBySurveyor.set(entry.surveyorId, (activeBySurveyor.get(entry.surveyorId) ?? 0) + 1);
    } else {
      if (!canonicalUtc(entry.revokedAtUtc)) {
        throw new TypeError("Revoked surveyor keys require a canonical revokedAtUtc timestamp.");
      }
      revokedAt = Date.parse(entry.revokedAtUtc);
      if (revokedAt < validFrom || revokedAt > current || revokedAt > validUntil) {
        throw new RangeError("Surveyor key revocation must occur during its validity interval and not in the future.");
      }
    }
    if (entry.replacesKeyId !== null) safeId(entry.replacesKeyId, "replacesKeyId");

    parsed.push(Object.freeze({
      surveyorId: entry.surveyorId,
      keyId: entry.keyId,
      status: entry.status,
      replacesKeyId: entry.replacesKeyId,
      revokedAtUtc: entry.revokedAtUtc,
      validFromUtc: entry.validFromUtc,
      validUntilUtc: entry.validUntilUtc,
      registryId: registry.registryId,
      registryIssuedAtUtc: registry.issuedAtUtc,
      registryExpiresAtUtc: registry.expiresAtUtc,
      publicKey,
      publicKeyFingerprintSha256,
    }));
  }

  for (const [surveyorId, count] of activeBySurveyor) {
    if (count !== 1) {
      throw new TypeError("Surveyor " + surveyorId + " must have at most one active key.");
    }
  }

  const byId = new Map(parsed.map((entry) => [entry.keyId, entry]));
  const children = new Map();
  for (const entry of parsed) {
    if (entry.replacesKeyId === null) continue;
    const previous = byId.get(entry.replacesKeyId);
    if (!previous ||
        previous.surveyorId !== entry.surveyorId ||
        previous.status !== "revoked" ||
        previous.revokedAtUtc === null ||
        Date.parse(previous.revokedAtUtc) > Date.parse(entry.validFromUtc) ||
        children.has(previous.keyId)) {
      throw new TypeError("Each surveyor key must replace one earlier revoked key for the same surveyor.");
    }
    children.set(previous.keyId, entry.keyId);
  }

  const bySurveyor = new Map();
  for (const entry of parsed) {
    const list = bySurveyor.get(entry.surveyorId) ?? [];
    list.push(entry);
    bySurveyor.set(entry.surveyorId, list);
  }
  for (const [surveyorId, entries] of bySurveyor) {
    const roots = entries.filter((entry) => entry.replacesKeyId === null);
    if (roots.length !== 1) {
      throw new TypeError("Surveyor " + surveyorId + " key history must have exactly one root.");
    }
    let cursor = roots[0];
    const visited = new Set();
    while (cursor) {
      if (visited.has(cursor.keyId)) throw new TypeError("Surveyor key rotation history contains a cycle.");
      visited.add(cursor.keyId);
      cursor = children.has(cursor.keyId) ? byId.get(children.get(cursor.keyId)) : null;
    }
    if (visited.size !== entries.length) {
      throw new TypeError("Surveyor key rotation history must form one complete linear chain.");
    }
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

function validateBytes({ recordBytes, controlPointManifestBytes }) {
  if (!Buffer.isBuffer(recordBytes) || recordBytes.length < 1 ||
      recordBytes.length > MAX_SURVEY_OBSERVATION_RECORD_BYTES) {
    throw new RangeError("Survey observation record must be a non-empty Buffer within the 16 MiB limit.");
  }
  if (!Buffer.isBuffer(controlPointManifestBytes) ||
      controlPointManifestBytes.length < 1 ||
      controlPointManifestBytes.length > MAX_CONTROL_POINT_MANIFEST_BYTES) {
    throw new RangeError("Control-point manifest must be a non-empty Buffer within the 1 MiB limit.");
  }
}

function validateContextIds({ observationId, checkpointId, buildingId, surveyorId }) {
  safeId(observationId, "observationId");
  safeId(checkpointId, "checkpointId");
  safeId(buildingId, "buildingId");
  safeId(surveyorId, "surveyorId");
}

function unsignedContext(envelope) {
  const context = {};
  for (const field of ATTESTATION_FIELDS) {
    if (field !== "signatureBase64") context[field] = envelope[field];
  }
  return context;
}

function signingBytes(context) {
  return Buffer.concat([
    DOMAIN,
    Buffer.from(canonicalJson(context), "utf8"),
  ]);
}

function exactFields(value, fields) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

/**
 * Create a detached attribution signature for exact record and manifest bytes.
 * The private key is accepted only in-process and is never returned or stored.
 */
export function createSurveyObservationAttributionAttestation({
  recordBytes,
  controlPointManifestBytes,
  observationId,
  checkpointId,
  buildingId,
  surveyorId,
  privateKeyPem,
  trustedSurveyorRegistry,
  attestedAtUtc,
}) {
  validateBytes({ recordBytes, controlPointManifestBytes });
  validateContextIds({ observationId, checkpointId, buildingId, surveyorId });
  if (typeof privateKeyPem !== "string" || !privateKeyPem.includes("PRIVATE KEY")) {
    throw new TypeError("privateKeyPem must be a local PEM private key.");
  }
  if (!canonicalUtc(attestedAtUtc)) {
    throw new TypeError("attestedAtUtc must be a canonical UTC timestamp with milliseconds.");
  }

  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Survey observation attestations require an Ed25519 private key.");
  }
  const active = parseTrustedSurveyorRegistry(trustedSurveyorRegistry, { now: attestedAtUtc });
  const derivedFingerprint = fingerprint(createPublicKey(privateKey));
  const matches = active.activeEntries.filter((entry) =>
    entry.surveyorId === surveyorId &&
    entry.publicKeyFingerprintSha256 === derivedFingerprint,
  );
  if (matches.length !== 1) {
    throw new Error("Surveyor private key does not resolve to exactly one active trusted-surveyor registry entry.");
  }
  const signer = matches[0];
  const context = {
    schemaVersion: SURVEY_OBSERVATION_ATTESTATION_SCHEMA_VERSION,
    engine: ATTESTATION_ENGINE,
    algorithm: "Ed25519",
    signaturePurpose: SURVEY_OBSERVATION_ATTESTATION_PURPOSE,
    observationId,
    checkpointId,
    buildingId,
    recordSha256: sha256(recordBytes),
    recordBytes: recordBytes.length,
    controlPointManifestSha256: sha256(controlPointManifestBytes),
    surveyorId: signer.surveyorId,
    keyId: signer.keyId,
    registryId: signer.registryId,
    publicKeyFingerprintSha256: signer.publicKeyFingerprintSha256,
    registryIssuedAtUtc: signer.registryIssuedAtUtc,
    registryExpiresAtUtc: signer.registryExpiresAtUtc,
    keyValidFromUtc: signer.validFromUtc,
    keyValidUntilUtc: signer.validUntilUtc,
    attestedAtUtc,
    publicationEligible: false,
    note: ATTESTATION_NOTE,
  };
  const signatureBase64 = sign(null, signingBytes(context), privateKey).toString("base64");
  return Object.freeze({ ...context, signatureBase64 });
}

/**
 * Verify an attribution envelope against actual record/manifest bytes and the
 * currently trusted-surveyor registry. Revoked keys are not accepted, even
 * when the historical signature time predates revocation.
 */
export function verifySurveyObservationAttributionAttestation({
  attestation,
  recordBytes,
  controlPointManifestBytes,
  observationId,
  checkpointId,
  buildingId,
  trustedSurveyorRegistry,
  now: nowInput,
}) {
  validateBytes({ recordBytes, controlPointManifestBytes });
  safeId(observationId, "observationId");
  safeId(checkpointId, "checkpointId");
  safeId(buildingId, "buildingId");
  const now = normalizeNow(nowInput);
  const checks = [];
  const errors = [];
  const check = (id, passed, message) => {
    const result = { id, status: passed ? "passed" : "failed", message };
    checks.push(result);
    if (!passed) errors.push(result);
  };

  const fieldsValid = exactFields(attestation, ATTESTATION_FIELDS);
  check("attestation-envelope-fields", fieldsValid,
    "Attestation must contain exactly the documented fields.");
  if (!fieldsValid) {
    return { schemaVersion: "1.0.0", status: "invalid", valid: false, checks, errors, publicationEligible: false };
  }

  const shapeValid =
    attestation.schemaVersion === SURVEY_OBSERVATION_ATTESTATION_SCHEMA_VERSION &&
    attestation.engine === ATTESTATION_ENGINE &&
    attestation.algorithm === "Ed25519" &&
    attestation.signaturePurpose === SURVEY_OBSERVATION_ATTESTATION_PURPOSE &&
    SAFE_ID.test(attestation.observationId ?? "") &&
    SAFE_ID.test(attestation.checkpointId ?? "") &&
    SAFE_ID.test(attestation.buildingId ?? "") &&
    HASH.test(attestation.recordSha256 ?? "") &&
    Number.isSafeInteger(attestation.recordBytes) && attestation.recordBytes > 0 &&
    HASH.test(attestation.controlPointManifestSha256 ?? "") &&
    SAFE_ID.test(attestation.surveyorId ?? "") &&
    SAFE_ID.test(attestation.keyId ?? "") &&
    SAFE_ID.test(attestation.registryId ?? "") &&
    HASH.test(attestation.publicKeyFingerprintSha256 ?? "") &&
    canonicalUtc(attestation.registryIssuedAtUtc) &&
    canonicalUtc(attestation.registryExpiresAtUtc) &&
    canonicalUtc(attestation.keyValidFromUtc) &&
    canonicalUtc(attestation.keyValidUntilUtc) &&
    canonicalUtc(attestation.attestedAtUtc) &&
    attestation.publicationEligible === false &&
    attestation.note === ATTESTATION_NOTE &&
    typeof attestation.signatureBase64 === "string" &&
    BASE64_SIGNATURE.test(attestation.signatureBase64);
  check("attestation-envelope", shapeValid,
    "Attestation metadata, identifiers, hashes, timestamps, purpose and signature encoding must be canonical.");
  check("observation-binding", attestation.observationId === observationId &&
    attestation.checkpointId === checkpointId && attestation.buildingId === buildingId,
  "Observation, held-out checkpoint and building IDs must match the caller's exact manifest context.");
  check("record-byte-binding", attestation.recordSha256 === sha256(recordBytes) &&
    attestation.recordBytes === recordBytes.length,
  "Record SHA-256 and byte length must match the exact opaque bytes.");
  check("control-manifest-binding",
    attestation.controlPointManifestSha256 === sha256(controlPointManifestBytes),
    "Control-point manifest SHA-256 must match the exact manifest bytes.");

  let registry = null;
  try {
    registry = parseTrustedSurveyorRegistry(trustedSurveyorRegistry, { now });
    check("trusted-surveyor-registry", true,
      "Trusted-surveyor registry is structurally valid and within its current validity window.");
  } catch {
    check("trusted-surveyor-registry", false,
      "Trusted-surveyor registry is missing, malformed, expired, not yet valid or revoked into an invalid state.");
  }

  let signer = null;
  if (registry && shapeValid) {
    const matches = registry.activeEntries.filter((entry) =>
      entry.surveyorId === attestation.surveyorId &&
      entry.keyId === attestation.keyId &&
      entry.registryId === attestation.registryId &&
      entry.publicKeyFingerprintSha256 === attestation.publicKeyFingerprintSha256 &&
      entry.registryIssuedAtUtc === attestation.registryIssuedAtUtc &&
      entry.registryExpiresAtUtc === attestation.registryExpiresAtUtc &&
      entry.validFromUtc === attestation.keyValidFromUtc &&
      entry.validUntilUtc === attestation.keyValidUntilUtc,
    );
    signer = matches.length === 1 ? matches[0] : null;
  }
  check("active-surveyor-key", Boolean(signer),
    "Signer surveyorId, keyId, registry, fingerprint and validity interval must resolve to one currently active trusted key.");

  const signedAt = Date.parse(attestation.attestedAtUtc);
  const signerWindowValid = shapeValid && signer !== null &&
    signedAt >= Date.parse(attestation.registryIssuedAtUtc) &&
    signedAt < Date.parse(attestation.registryExpiresAtUtc) &&
    signedAt >= Date.parse(attestation.keyValidFromUtc) &&
    signedAt < Date.parse(attestation.keyValidUntilUtc) &&
    signedAt <= now.getTime();
  check("attestation-time-window", signerWindowValid,
    "Attestation time must be inside the registry/key windows and must not be in the future.");

  let signatureValid = false;
  if (shapeValid && signer && signerWindowValid) {
    try {
      const signatureBytes = Buffer.from(attestation.signatureBase64, "base64");
      signatureValid = signatureBytes.length === 64 &&
        signatureBytes.toString("base64") === attestation.signatureBase64 &&
        verify(null, signingBytes(unsignedContext(attestation)), signer.publicKey, signatureBytes);
    } catch {
      signatureValid = false;
    }
  }
  check("ed25519-signature", signatureValid,
    "Ed25519 signature must authenticate the exact record, manifest and checkpoint attribution context.");

  return {
    schemaVersion: "1.0.0",
    engine: "survey-observation-attribution-verification-v1",
    status: errors.length === 0 ? "attribution-signature-verified" : "attribution-signature-invalid",
    valid: errors.length === 0,
    observationId,
    checkpointId,
    buildingId,
    recordSha256: sha256(recordBytes),
    controlPointManifestSha256: sha256(controlPointManifestBytes),
    surveyorId: signer?.surveyorId ?? null,
    keyId: signer?.keyId ?? null,
    registryId: registry?.registryId ?? null,
    checks,
    errors,
    publicationEligible: false,
    note: "A valid attestation binds a trusted key to exact record bytes and checkpoint context only. It does not authenticate civil identity, qualification, receiver hardware, measurement accuracy, source rights or physical feature correspondence.",
  };
}

/**
 * Deterministic detached-sidecar path. Callers cannot choose an arbitrary
 * output path for a survey observation attribution envelope.
 */
export function surveyObservationAttributionAttestationPath(observationId) {
  safeContextId(observationId, "observationId");
  return "evidence/survey-observations/" + observationId + ".attestation.json";
}
