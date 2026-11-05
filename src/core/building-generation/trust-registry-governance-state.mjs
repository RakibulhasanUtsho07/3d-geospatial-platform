import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const TRUST_REGISTRY_GOVERNANCE_STATE_SCHEMA_VERSION = "1.0.0";
export const TRUST_REGISTRY_GOVERNANCE_STATE_RECORD_TYPE = "trusted-survey-registry-governance-state";
export const MAX_TRUST_REGISTRY_GOVERNANCE_STATE_BYTES = 16 * 1024;

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const STATE_FIELDS = Object.freeze([
  "schemaVersion",
  "recordType",
  "registrySetId",
  "governanceKeyFingerprintSha256",
  "minimumAcceptedSequence",
  "revision",
  "lastAcceptedAttestationSha256",
  "lastAcceptedSnapshotSha256",
  "updatedAtUtc",
  "previousStateSha256",
  "stateSha256",
]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalJson(value) {
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

function parsePositiveInteger(value, label) {
  const parsed = typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(label + " must be a positive safe integer.");
  }
  return parsed;
}

function assertIdentity({ registrySetId, governanceKeyFingerprintSha256 }) {
  if (typeof registrySetId !== "string" || !SAFE_ID.test(registrySetId)) {
    throw new TypeError("Trust-registry governance state registrySetId is invalid.");
  }
  if (typeof governanceKeyFingerprintSha256 !== "string" ||
      !HASH.test(governanceKeyFingerprintSha256)) {
    throw new TypeError("Trust-registry governance state key fingerprint is invalid.");
  }
}

function canonicalUtc(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function statePayload(state) {
  const payload = {};
  for (const field of STATE_FIELDS) {
    if (field !== "stateSha256") payload[field] = state[field];
  }
  return payload;
}

function sealState(payload) {
  const state = { ...payload };
  state.stateSha256 = sha256(Buffer.from(canonicalJson(payload), "utf8"));
  return state;
}

function validateState(value, identity) {
  assertIdentity(identity);
  if (!isObject(value) ||
      Object.keys(value).length !== STATE_FIELDS.length ||
      Object.keys(value).some((key) => !STATE_FIELDS.includes(key)) ||
      STATE_FIELDS.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Governance state must contain the exact versioned state fields.");
  }
  if (value.schemaVersion !== TRUST_REGISTRY_GOVERNANCE_STATE_SCHEMA_VERSION ||
      value.recordType !== TRUST_REGISTRY_GOVERNANCE_STATE_RECORD_TYPE) {
    throw new TypeError("Governance state schema or record type is unsupported.");
  }
  if (value.registrySetId !== identity.registrySetId ||
      value.governanceKeyFingerprintSha256 !== identity.governanceKeyFingerprintSha256) {
    throw new Error("Governance state belongs to a different registry set or pinned key.");
  }
  if (typeof value.minimumAcceptedSequence !== "number") {
    throw new TypeError("Persisted minimumAcceptedSequence must be a JSON number.");
  }
  parsePositiveInteger(value.minimumAcceptedSequence, "minimumAcceptedSequence");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new TypeError("Governance state revision must be a non-negative safe integer.");
  }
  if (!canonicalUtc(value.updatedAtUtc)) {
    throw new TypeError("Governance state updatedAtUtc must be a canonical UTC timestamp.");
  }
  for (const field of ["lastAcceptedAttestationSha256", "lastAcceptedSnapshotSha256", "previousStateSha256"]) {
    if (value[field] !== null && (typeof value[field] !== "string" || !HASH.test(value[field]))) {
      throw new TypeError("Governance state field " + field + " is invalid.");
    }
  }
  if (value.revision === 0 && (value.previousStateSha256 !== null ||
      value.lastAcceptedAttestationSha256 !== null || value.lastAcceptedSnapshotSha256 !== null)) {
    throw new TypeError("Initial governance state must not reference a previous state.");
  }
  if (value.revision > 0 && (value.previousStateSha256 === null ||
      value.lastAcceptedAttestationSha256 === null || value.lastAcceptedSnapshotSha256 === null)) {
    throw new TypeError("Advanced governance state must reference its previous state digest.");
  }
  const expectedDigest = sha256(Buffer.from(canonicalJson(statePayload(value)), "utf8"));
  if (value.stateSha256 !== expectedDigest) {
    throw new Error("Governance state digest verification failed.");
  }
  return value;
}

function statePathOf(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("Governance state file path is required.");
  }
  return path.resolve(filePath);
}

function statIdentity(stat) {
  return [
    stat.dev.toString(),
    stat.ino.toString(),
    stat.size.toString(),
    stat.mtimeNs.toString(),
    stat.ctimeNs.toString(),
    stat.mode.toString(),
  ].join(":");
}

async function readStateFile(filePath, identity) {
  let pathBefore;
  try {
    pathBefore = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error("Governance state path must be a regular non-symlink file.");
  }
  if ((pathBefore.mode & 0o077n) !== 0n) {
    throw new Error("Governance state file permissions must be private (0600 or stricter).");
  }
  if (pathBefore.size < 1n || pathBefore.size > BigInt(MAX_TRUST_REGISTRY_GOVERNANCE_STATE_BYTES)) {
    throw new RangeError("Governance state file size is outside the permitted bound.");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile() ||
        statIdentity(descriptorBefore) !== statIdentity(pathBefore)) {
      throw new Error("Governance state file identity changed before read.");
    }
    const bytes = await handle.readFile();
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    if (pathAfter.isSymbolicLink() ||
        statIdentity(descriptorBefore) !== statIdentity(descriptorAfter) ||
        statIdentity(descriptorAfter) !== statIdentity(pathAfter) ||
        BigInt(bytes.length) !== descriptorAfter.size) {
      throw new Error("Governance state file changed during read.");
    }
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new TypeError("Governance state file JSON is invalid.");
    }
    const validated = validateState(value, identity);
    if (bytes.toString("utf8") !== canonicalJson(validated) + "\n") {
      throw new TypeError("Governance state file is not in canonical serialization form.");
    }
    return validated;
  } finally {
    await handle.close();
  }
}

async function writeStateFile(filePath, state) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(canonicalJson(state) + "\n", "utf8");
  if (bytes.length > MAX_TRUST_REGISTRY_GOVERNANCE_STATE_BYTES) {
    throw new RangeError("Governance state exceeds the permitted file size.");
  }
  const temporaryPath = filePath + "." + process.pid + "." + randomUUID() + ".tmp";
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
    if (process.platform !== "win32") {
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    try { await unlink(temporaryPath); } catch {}
    throw error;
  }
}

async function withExclusiveLock(filePath, callback) {
  const lockPath = filePath + ".lock";
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Governance state is locked by another operation; retry after the lock owner exits.");
    }
    throw error;
  }
  let lockIdentity;
  try {
    await handle.writeFile(canonicalJson({
      pid: process.pid,
      createdAtUtc: new Date().toISOString(),
    }) + "\n");
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    lockIdentity = { dev: stat.dev, ino: stat.ino };
    return await callback();
  } finally {
    await handle.close();
    if (lockIdentity) {
      try {
        const current = await lstat(lockPath, { bigint: true });
        if (!current.isSymbolicLink() && current.isFile() &&
            current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
          await unlink(lockPath);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

function createInitialState(identity, minimumAcceptedSequence, now) {
  return sealState({
    schemaVersion: TRUST_REGISTRY_GOVERNANCE_STATE_SCHEMA_VERSION,
    recordType: TRUST_REGISTRY_GOVERNANCE_STATE_RECORD_TYPE,
    registrySetId: identity.registrySetId,
    governanceKeyFingerprintSha256: identity.governanceKeyFingerprintSha256,
    minimumAcceptedSequence: parsePositiveInteger(minimumAcceptedSequence, "bootstrapMinimumSequence"),
    revision: 0,
    lastAcceptedAttestationSha256: null,
    lastAcceptedSnapshotSha256: null,
    updatedAtUtc: now.toISOString(),
    previousStateSha256: null,
  });
}

/** Validate a state envelope against the independently supplied trust identity. */
export function validateTrustRegistryGovernanceState(value, identity) {
  return validateState(value, identity);
}

/** Build the first state envelope for an external atomic initialize-if-absent store. */
export function createTrustRegistryGovernanceInitialState({
  registrySetId,
  governanceKeyFingerprintSha256,
  bootstrapMinimumSequence,
  now: nowInput,
}) {
  const identity = { registrySetId, governanceKeyFingerprintSha256 };
  assertIdentity(identity);
  const now = nowInput instanceof Date ? new Date(nowInput) : new Date(nowInput ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new TypeError("Governance state clock is invalid.");
  return createInitialState(identity, bootstrapMinimumSequence, now);
}

/** Pure transition builder shared by the file store and external CAS providers. */
export function createNextTrustRegistryGovernanceState({
  current,
  registrySetId,
  governanceKeyFingerprintSha256,
  expectedRevision,
  acceptedSequence,
  acceptedAttestationSha256,
  acceptedSnapshotSha256,
  now: nowInput,
}) {
  const identity = { registrySetId, governanceKeyFingerprintSha256 };
  const validated = validateState(current, identity);
  const sequence = parsePositiveInteger(acceptedSequence, "acceptedSequence");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative safe integer.");
  }
  if (validated.revision !== expectedRevision) {
    throw new Error("Governance state compare-and-set revision conflict.");
  }
  if (!HASH.test(acceptedAttestationSha256 ?? "") || !HASH.test(acceptedSnapshotSha256 ?? "")) {
    throw new TypeError("Accepted governance attestation and snapshot digests must be SHA-256.");
  }
  const now = nowInput instanceof Date ? new Date(nowInput) : new Date(nowInput ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new TypeError("Governance state clock is invalid.");
  if (sequence < validated.minimumAcceptedSequence) {
    throw new Error("Governance sequence downgrade is not permitted.");
  }
  if (sequence === validated.minimumAcceptedSequence) {
    if (validated.lastAcceptedAttestationSha256 === acceptedAttestationSha256 &&
        validated.lastAcceptedSnapshotSha256 === acceptedSnapshotSha256) {
      return { state: validated, changed: false };
    }
    if (validated.lastAcceptedAttestationSha256 !== null ||
        validated.lastAcceptedSnapshotSha256 !== null) {
      throw new Error("A governance sequence cannot be reused for a different statement or snapshot.");
    }
  }
  if (validated.revision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Governance state revision space is exhausted.");
  }
  const next = sealState({
    schemaVersion: TRUST_REGISTRY_GOVERNANCE_STATE_SCHEMA_VERSION,
    recordType: TRUST_REGISTRY_GOVERNANCE_STATE_RECORD_TYPE,
    registrySetId: validated.registrySetId,
    governanceKeyFingerprintSha256: validated.governanceKeyFingerprintSha256,
    minimumAcceptedSequence: sequence,
    revision: validated.revision + 1,
    lastAcceptedAttestationSha256: acceptedAttestationSha256,
    lastAcceptedSnapshotSha256: acceptedSnapshotSha256,
    updatedAtUtc: now.toISOString(),
    previousStateSha256: validated.stateSha256,
  });
  return { state: next, changed: true };
}


/**
 * Load the operator's persisted floor, or bootstrap exactly once from an
 * explicit operator-supplied floor. Corrupt or mismatched state is never reset.
 */
export async function loadOrInitializeTrustRegistryGovernanceState({
  stateFilePath,
  registrySetId,
  governanceKeyFingerprintSha256,
  bootstrapMinimumSequence = null,
  now: nowInput,
}) {
  const filePath = statePathOf(stateFilePath);
  const identity = { registrySetId, governanceKeyFingerprintSha256 };
  assertIdentity(identity);
  return withExclusiveLock(filePath, async () => {
    const existing = await readStateFile(filePath, identity);
    if (existing) return { state: existing, created: false };
    if (bootstrapMinimumSequence === null || bootstrapMinimumSequence === undefined) {
      throw new Error("Governance state does not exist and an explicit operator bootstrap floor was not supplied.");
    }
    const now = nowInput instanceof Date ? new Date(nowInput) : new Date(nowInput ?? Date.now());
    if (!Number.isFinite(now.getTime())) throw new TypeError("Governance state clock is invalid.");
    const initial = createInitialState(identity, bootstrapMinimumSequence, now);
    await writeStateFile(filePath, initial);
    return { state: initial, created: true };
  });
}

/**
 * Atomically advances the stored floor after successful verification.
 * The expectedRevision check prevents concurrent stale writers.
 */
export async function advanceTrustRegistryGovernanceState({
  stateFilePath,
  registrySetId,
  governanceKeyFingerprintSha256,
  expectedRevision,
  acceptedSequence,
  acceptedAttestationSha256,
  acceptedSnapshotSha256,
  now: nowInput,
}) {
  const filePath = statePathOf(stateFilePath);
  const identity = { registrySetId, governanceKeyFingerprintSha256 };
  assertIdentity(identity);
  const sequence = parsePositiveInteger(acceptedSequence, "acceptedSequence");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative safe integer.");
  }
  if (!HASH.test(acceptedAttestationSha256 ?? "") || !HASH.test(acceptedSnapshotSha256 ?? "")) {
    throw new TypeError("Accepted governance attestation and snapshot digests must be SHA-256.");
  }
  const now = nowInput instanceof Date ? new Date(nowInput) : new Date(nowInput ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new TypeError("Governance state clock is invalid.");

  return withExclusiveLock(filePath, async () => {
    const current = await readStateFile(filePath, identity);
    if (!current) throw new Error("Governance state disappeared before its monotonic update.");
    if (current.revision !== expectedRevision) {
      throw new Error("Governance state compare-and-set revision conflict.");
    }
    if (sequence < current.minimumAcceptedSequence) {
      throw new Error("Governance sequence downgrade is not permitted.");
    }
    if (sequence === current.minimumAcceptedSequence) {
      if (current.lastAcceptedAttestationSha256 === acceptedAttestationSha256 &&
          current.lastAcceptedSnapshotSha256 === acceptedSnapshotSha256) {
        return { state: current, changed: false };
      }
      if (current.lastAcceptedAttestationSha256 !== null ||
          current.lastAcceptedSnapshotSha256 !== null) {
        throw new Error("A governance sequence cannot be reused for a different statement or snapshot.");
      }
    }
    if (current.revision >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Governance state revision space is exhausted.");
    }
    const next = sealState({
      schemaVersion: TRUST_REGISTRY_GOVERNANCE_STATE_SCHEMA_VERSION,
      recordType: TRUST_REGISTRY_GOVERNANCE_STATE_RECORD_TYPE,
      registrySetId: current.registrySetId,
      governanceKeyFingerprintSha256: current.governanceKeyFingerprintSha256,
      minimumAcceptedSequence: sequence,
      revision: current.revision + 1,
      lastAcceptedAttestationSha256: acceptedAttestationSha256,
      lastAcceptedSnapshotSha256: acceptedSnapshotSha256,
      updatedAtUtc: now.toISOString(),
      previousStateSha256: current.stateSha256,
    });
    await writeStateFile(filePath, next);
    return { state: next, changed: true };
  });
}
