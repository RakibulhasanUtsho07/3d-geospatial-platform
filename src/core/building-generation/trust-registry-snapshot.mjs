import { createHash } from "node:crypto";

export const TRUST_REGISTRY_SNAPSHOT_SCHEMA_VERSION = "1.0.0";
export const MAX_TRUST_REGISTRY_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_TRUST_REGISTRY_SNAPSHOT_TOTAL_BYTES = 192 * 1024;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const REQUIRED_ROLES = Object.freeze([
  Object.freeze({
    role: "surveyor",
    input: "trustedSurveyorRegistry",
    recordType: "trusted-surveyor-public-key-registry",
  }),
  Object.freeze({
    role: "device",
    input: "trustedDeviceRegistry",
    recordType: "trusted-survey-device-public-key-registry",
  }),
  Object.freeze({
    role: "enrollment-authority",
    input: "trustedEnrollmentAuthorityRegistry",
    recordType: "trusted-survey-device-enrollment-authority-public-key-registry",
  }),
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function inventoryBytes(entries) {
  // Property insertion order is fixed by the canonical entry builder below.
  return Buffer.from(JSON.stringify(entries), "utf8");
}

function parseRegistrySnapshot(role, raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("Trust registry snapshot " + role.role + " must be supplied as its exact raw UTF-8 JSON string.");
  }
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_TRUST_REGISTRY_SNAPSHOT_BYTES) {
    throw new RangeError("Trust registry snapshot " + role.role + " must be 1–64 KiB.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("Trust registry snapshot " + role.role + " must be valid JSON.");
  }
  if (!isObject(parsed) ||
      parsed.recordType !== role.recordType ||
      parsed.schemaVersion !== "1.0.0" ||
      typeof parsed.registryId !== "string" ||
      !SAFE_ID.test(parsed.registryId)) {
    throw new TypeError("Trust registry snapshot " + role.role + " has an unexpected record type, schema version or registry ID.");
  }
  return {
    role: role.role,
    recordType: role.recordType,
    registryId: parsed.registryId,
    schemaVersion: parsed.schemaVersion,
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

/**
 * Build a deterministic manifest of the exact three external public-key-only
 * trust-registry documents used by D3M-16/17/18 package verification.
 *
 * Registry contents remain external; only IDs, schema/type and raw-byte
 * digests are recorded in the package metadata.
 */
export function buildTrustRegistrySnapshotInventory({
  trustedSurveyorRegistry,
  trustedDeviceRegistry,
  trustedEnrollmentAuthorityRegistry,
}) {
  const values = {
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
    trustedEnrollmentAuthorityRegistry,
  };
  const entries = REQUIRED_ROLES.map((role) => parseRegistrySnapshot(role, values[role.input]));
  const totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TRUST_REGISTRY_SNAPSHOT_TOTAL_BYTES) {
    throw new RangeError("Combined trust registry snapshots exceed 192 KiB.");
  }
  const bytes = inventoryBytes(entries);
  return Object.freeze({
    schemaVersion: TRUST_REGISTRY_SNAPSHOT_SCHEMA_VERSION,
    count: entries.length,
    totalBytes,
    sha256: sha256(bytes),
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
}

/**
 * Recompute the raw-byte snapshots and compare every serialized metadata field.
 * This is not a signature or identity claim; the package's separate reviewer
 * signature is what authenticates the resulting package manifest.
 */
export function verifyTrustRegistrySnapshotInventory({
  metadata,
  trustedSurveyorRegistry,
  trustedDeviceRegistry,
  trustedEnrollmentAuthorityRegistry,
}) {
  const recomputed = buildTrustRegistrySnapshotInventory({
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
    trustedEnrollmentAuthorityRegistry,
  });
  const expectedEntries = metadata?.trustRegistrySnapshots;
  const entriesMatch = Array.isArray(expectedEntries) &&
    JSON.stringify(expectedEntries) === JSON.stringify(recomputed.entries);
  return {
    valid:
      metadata?.trustRegistrySnapshotSchemaVersion === recomputed.schemaVersion &&
      metadata?.trustRegistrySnapshotCount === recomputed.count &&
      metadata?.trustRegistrySnapshotBytes === recomputed.totalBytes &&
      metadata?.trustRegistrySnapshotsSha256 === recomputed.sha256 &&
      entriesMatch,
    recomputed,
    checks: [
      {
        id: "trust-registry-snapshot-schema",
        status: metadata?.trustRegistrySnapshotSchemaVersion === recomputed.schemaVersion ? "passed" : "failed",
      },
      {
        id: "trust-registry-snapshot-count",
        status: metadata?.trustRegistrySnapshotCount === recomputed.count ? "passed" : "failed",
      },
      {
        id: "trust-registry-snapshot-byte-total",
        status: metadata?.trustRegistrySnapshotBytes === recomputed.totalBytes ? "passed" : "failed",
      },
      {
        id: "trust-registry-snapshot-digest",
        status: metadata?.trustRegistrySnapshotsSha256 === recomputed.sha256 ? "passed" : "failed",
      },
      {
        id: "trust-registry-snapshot-entries",
        status: entriesMatch ? "passed" : "failed",
      },
    ],
  };
}
