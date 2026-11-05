import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const TRUST_REGISTRY_GOVERNANCE_SCHEMA_VERSION = "1.0.0";
export const TRUST_REGISTRY_GOVERNANCE_RECORD_TYPE = "trusted-survey-registry-governance-attestation";
export const TRUST_REGISTRY_GOVERNANCE_PURPOSE = "approve-exact-survey-trust-registry-snapshot-only";
export const MAX_TRUST_REGISTRY_GOVERNANCE_ATTESTATION_BYTES = 16 * 1024;
export const MAX_TRUST_REGISTRY_GOVERNANCE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const DOMAIN = Buffer.from("3d-geospatial-platform/trust-registry-governance/v1\\0", "utf8");
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const FIELDS = Object.freeze([
  "schemaVersion", "recordType", "signaturePurpose", "algorithm",
  "registrySetId", "sequence", "issuedAtUtc", "expiresAtUtc",
  "governanceKeyId", "governanceKeyFingerprintSha256",
  "snapshotSchemaVersion", "snapshotCount", "snapshotTotalBytes",
  "snapshotSha256", "registryIds", "signatureBase64",
]);
const PAYLOAD_FIELDS = FIELDS.filter((field) => field !== "signatureBase64");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonicalize(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Governance payload contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Governance payload contains a circular array.");
    ancestors.add(value);
    const result = value.map((entry) => canonicalize(entry, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (isObject(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Governance payload must contain plain JSON objects.");
    }
    if (ancestors.has(value)) throw new TypeError("Governance payload contains a circular object.");
    ancestors.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError("Governance payload must not contain undefined values.");
      result[key] = canonicalize(value[key], ancestors);
    }
    ancestors.delete(value);
    return result;
  }
  throw new TypeError("Governance payload must contain JSON-compatible values.");
}
const canonicalJson = (value) => JSON.stringify(canonicalize(value));

function canonicalUtc(value) {
  if (typeof value !== "string" ||
      !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function parseMinimumSequence(value) {
  const parsed = typeof value === "string" && /^(?:0|[1-9]\\d*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError("A separately provisioned positive minimum registry sequence is required.");
  }
  return parsed;
}
function parsePublicKey(value) {
  if (typeof value !== "string" || value.length < 64 || value.length > 16 * 1024 ||
      !value.includes("BEGIN PUBLIC KEY") || /PRIVATE KEY/.test(value)) {
    throw new TypeError("The pinned governance key must be public-key PEM only.");
  }
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("The pinned governance key must use Ed25519.");
  return key;
}
function parsePrivateKey(value) {
  const key = typeof value === "string" ? createPrivateKey(value) : value;
  if (!key || key.asymmetricKeyType !== "ed25519" || key.type !== "private") {
    throw new TypeError("The governance signing key must be an Ed25519 private key.");
  }
  return key;
}
const keyFingerprint = (key) => sha256(key.export({ type: "spki", format: "der" }));

function assertSnapshot(snapshot) {
  if (!isObject(snapshot) || snapshot.schemaVersion !== "1.0.0" ||
      snapshot.count !== 3 || !Number.isSafeInteger(snapshot.totalBytes) ||
      snapshot.totalBytes < 3 || !HASH.test(snapshot.sha256 ?? "") ||
      !Array.isArray(snapshot.entries) || snapshot.entries.length !== 3) {
    throw new TypeError("A valid D3M-20 three-registry snapshot inventory is required.");
  }
  const roles = ["surveyor", "device", "enrollment-authority"];
  const ids = snapshot.entries.map((entry, index) => {
    if (!isObject(entry) || entry.role !== roles[index] ||
        typeof entry.registryId !== "string" || !SAFE_ID.test(entry.registryId)) {
      throw new TypeError("The D3M-20 snapshot role order or registry ID is invalid.");
    }
    return entry.registryId;
  });
  if (new Set(ids).size !== 3) throw new TypeError("Trust registry IDs must be distinct.");
  return ids;
}
function createPayload({
  snapshotInventory, registrySetId, sequence, issuedAtUtc, expiresAtUtc,
  governanceKeyId, governanceKeyFingerprintSha256,
}) {
  const registryIds = assertSnapshot(snapshotInventory);
  if (typeof registrySetId !== "string" || !SAFE_ID.test(registrySetId) ||
      typeof governanceKeyId !== "string" || !SAFE_ID.test(governanceKeyId) ||
      !Number.isSafeInteger(sequence) || sequence < 1 ||
      !canonicalUtc(issuedAtUtc) || !canonicalUtc(expiresAtUtc) ||
      !HASH.test(governanceKeyFingerprintSha256 ?? "")) {
    throw new TypeError("Trust-registry governance statement metadata is invalid.");
  }
  const issued = Date.parse(issuedAtUtc);
  const expires = Date.parse(expiresAtUtc);
  if (expires <= issued || expires - issued > MAX_TRUST_REGISTRY_GOVERNANCE_LIFETIME_MS) {
    throw new RangeError("Governance statement lifetime must be positive and no longer than 30 days.");
  }
  return {
    schemaVersion: TRUST_REGISTRY_GOVERNANCE_SCHEMA_VERSION,
    recordType: TRUST_REGISTRY_GOVERNANCE_RECORD_TYPE,
    signaturePurpose: TRUST_REGISTRY_GOVERNANCE_PURPOSE,
    algorithm: "Ed25519",
    registrySetId,
    sequence,
    issuedAtUtc,
    expiresAtUtc,
    governanceKeyId,
    governanceKeyFingerprintSha256,
    snapshotSchemaVersion: snapshotInventory.schemaVersion,
    snapshotCount: snapshotInventory.count,
    snapshotTotalBytes: snapshotInventory.totalBytes,
    snapshotSha256: snapshotInventory.sha256,
    registryIds,
  };
}
export function trustRegistryGovernanceSigningBytes(payload) {
  const clean = {};
  for (const field of PAYLOAD_FIELDS) clean[field] = payload?.[field];
  return Buffer.concat([DOMAIN, Buffer.from(canonicalJson(clean), "utf8")]);
}

/**
 * Signing helper for controlled governance tooling and synthetic tests.
 * Production private keys belong in an external signer/HSM, never in this repo.
 */
export function signTrustRegistryGovernanceAttestation({
  snapshotInventory, registrySetId, sequence, issuedAtUtc, expiresAtUtc,
  governanceKeyId, privateKey,
}) {
  const key = parsePrivateKey(privateKey);
  const payload = createPayload({
    snapshotInventory, registrySetId, sequence, issuedAtUtc, expiresAtUtc,
    governanceKeyId,
    governanceKeyFingerprintSha256: keyFingerprint(createPublicKey(key)),
  });
  return JSON.stringify({
    ...payload,
    signatureBase64: sign(null, trustRegistryGovernanceSigningBytes(payload), key).toString("base64"),
  });
}
function readAttestation(input) {
  if (typeof input !== "string") throw new TypeError("Governance attestation must be supplied as exact JSON text.");
  const bytes = Buffer.from(input, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_TRUST_REGISTRY_GOVERNANCE_ATTESTATION_BYTES) {
    throw new RangeError("Governance attestation must be 1–16 KiB.");
  }
  let value;
  try { value = JSON.parse(input); } catch {
    throw new TypeError("Governance attestation must be valid JSON.");
  }
  return { value, bytes };
}
export function matchesTrustRegistryGovernanceMetadata(metadata, snapshotInventory) {
  const expectedKeys = [
    "attestationSha256", "registrySetId", "sequence", "issuedAtUtc", "expiresAtUtc",
    "governanceKeyId", "governanceKeyFingerprintSha256", "snapshotSchemaVersion",
    "snapshotCount", "snapshotTotalBytes", "snapshotSha256",
  ];
  if (!isObject(metadata) || Object.keys(metadata).length !== expectedKeys.length ||
      Object.keys(metadata).some((key) => !expectedKeys.includes(key)) || !isObject(snapshotInventory)) return false;
  return HASH.test(metadata.attestationSha256 ?? "") &&
    typeof metadata.registrySetId === "string" && SAFE_ID.test(metadata.registrySetId) &&
    Number.isSafeInteger(metadata.sequence) && metadata.sequence >= 1 &&
    canonicalUtc(metadata.issuedAtUtc) && canonicalUtc(metadata.expiresAtUtc) &&
    Date.parse(metadata.expiresAtUtc) > Date.parse(metadata.issuedAtUtc) &&
    Date.parse(metadata.expiresAtUtc) - Date.parse(metadata.issuedAtUtc) <= MAX_TRUST_REGISTRY_GOVERNANCE_LIFETIME_MS &&
    typeof metadata.governanceKeyId === "string" && SAFE_ID.test(metadata.governanceKeyId) &&
    HASH.test(metadata.governanceKeyFingerprintSha256 ?? "") &&
    metadata.snapshotSchemaVersion === snapshotInventory.schemaVersion &&
    metadata.snapshotCount === snapshotInventory.count &&
    metadata.snapshotTotalBytes === snapshotInventory.totalBytes &&
    metadata.snapshotSha256 === snapshotInventory.sha256;
}

/** Verify the detached statement against an external pinned key and rollback floor. */
export function verifyTrustRegistryGovernanceAttestation({
  attestation, governancePublicKeyPem, minimumSequence, snapshotInventory, now: nowInput,
}) {
  try {
    const { value, bytes } = readAttestation(attestation);
    if (!isObject(value) || Object.keys(value).length !== FIELDS.length ||
        Object.keys(value).some((key) => !FIELDS.includes(key)) ||
        FIELDS.some((key) => !Object.hasOwn(value, key))) {
      throw new TypeError("Governance attestation must use the exact versioned envelope fields.");
    }
    if (value.schemaVersion !== TRUST_REGISTRY_GOVERNANCE_SCHEMA_VERSION ||
        value.recordType !== TRUST_REGISTRY_GOVERNANCE_RECORD_TYPE ||
        value.signaturePurpose !== TRUST_REGISTRY_GOVERNANCE_PURPOSE ||
        value.algorithm !== "Ed25519") {
      throw new TypeError("Governance attestation schema, record type, purpose or algorithm is unsupported.");
    }
    const pinnedKey = parsePublicKey(governancePublicKeyPem);
    const fingerprint = keyFingerprint(pinnedKey);
    if (value.governanceKeyFingerprintSha256 !== fingerprint) {
      throw new Error("Governance attestation key fingerprint does not match the independently pinned key.");
    }
    const floor = parseMinimumSequence(minimumSequence);
    if (!Number.isSafeInteger(value.sequence) || value.sequence < floor) {
      throw new Error("Governance attestation sequence is below the operator-pinned minimum.");
    }
    const now = nowInput instanceof Date ? new Date(nowInput) : new Date(nowInput ?? Date.now());
    if (!Number.isFinite(now.getTime()) || !canonicalUtc(value.issuedAtUtc) || !canonicalUtc(value.expiresAtUtc)) {
      throw new TypeError("Governance attestation timestamps or verifier time are invalid.");
    }
    const issued = Date.parse(value.issuedAtUtc);
    const expires = Date.parse(value.expiresAtUtc);
    if (expires <= issued || expires - issued > MAX_TRUST_REGISTRY_GOVERNANCE_LIFETIME_MS) {
      throw new RangeError("Governance attestation lifetime is invalid or exceeds 30 days.");
    }
    if (now.getTime() < issued || now.getTime() >= expires) {
      throw new Error("Governance attestation is not currently valid.");
    }
    const payload = createPayload({
      snapshotInventory,
      registrySetId: value.registrySetId,
      sequence: value.sequence,
      issuedAtUtc: value.issuedAtUtc,
      expiresAtUtc: value.expiresAtUtc,
      governanceKeyId: value.governanceKeyId,
      governanceKeyFingerprintSha256: fingerprint,
    });
    if (value.snapshotSchemaVersion !== payload.snapshotSchemaVersion ||
        value.snapshotCount !== payload.snapshotCount ||
        value.snapshotTotalBytes !== payload.snapshotTotalBytes ||
        value.snapshotSha256 !== payload.snapshotSha256 ||
        JSON.stringify(value.registryIds) !== JSON.stringify(payload.registryIds)) {
      throw new Error("Governance attestation does not bind the exact D3M-20 trust-registry snapshot.");
    }
    if (!SIGNATURE.test(value.signatureBase64 ?? "")) throw new TypeError("Governance signature encoding is invalid.");
    const signature = Buffer.from(value.signatureBase64, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== value.signatureBase64 ||
        !verify(null, trustRegistryGovernanceSigningBytes(payload), pinnedKey, signature)) {
      throw new Error("Governance attestation Ed25519 signature verification failed.");
    }
    return {
      valid: true,
      metadata: {
        attestationSha256: sha256(bytes),
        registrySetId: payload.registrySetId,
        sequence: payload.sequence,
        issuedAtUtc: payload.issuedAtUtc,
        expiresAtUtc: payload.expiresAtUtc,
        governanceKeyId: payload.governanceKeyId,
        governanceKeyFingerprintSha256: fingerprint,
        snapshotSchemaVersion: payload.snapshotSchemaVersion,
        snapshotCount: payload.snapshotCount,
        snapshotTotalBytes: payload.snapshotTotalBytes,
        snapshotSha256: payload.snapshotSha256,
      },
      errors: [],
    };
  } catch (error) {
    return {
      valid: false,
      metadata: null,
      errors: [{ id: "trust-registry-governance-attestation-invalid", message: error instanceof Error ? error.message : String(error) }],
    };
  }
}
