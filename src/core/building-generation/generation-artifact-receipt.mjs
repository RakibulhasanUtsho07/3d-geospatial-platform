import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;
export const GENERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION = "1.0.0";
const MAX_RECEIPT_BYTES = 256 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value, label = "receipt payload") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(label + " contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, label));
  if (!value || typeof value !== "object" ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(label + " must contain only JSON data.");
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(label + " contains an undefined field.");
    result[key] = canonicalize(value[key], label);
  }
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

async function requireSafeDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(next);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(next, { mode: 0o700 });
      entry = await lstat(next);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError("Generation artifact receipt directory must contain only real directories.");
    }
    const actual = await realpath(next);
    const relative = path.relative(root, actual);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new TypeError("Generation artifact receipt directory escapes workspaceRoot.");
    }
    current = actual;
  }
  return current;
}

/**
 * Persist one local, write-once, hash-bound receipt. This is integrity metadata,
 * not a signature, an OS-level immutable store, or an authenticity attestation.
 */
export async function writeGenerationArtifactReceipt({ workspaceRoot, jobId, buildingId, payload }) {
  safeId(jobId, "jobId");
  safeId(buildingId, "buildingId");
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.kind !== "single-image-generation-artifact" ||
      payload.schemaVersion !== GENERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION ||
      payload.jobId !== jobId || payload.buildingId !== buildingId) {
    throw new TypeError("Generation artifact receipt payload identity or schema is invalid.");
  }
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("workspaceRoot is required for the generation artifact receipt.");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const directory = await requireSafeDirectory(root, [".building-engine", "runtime-smokes"]);
  const relativePath = ".building-engine/runtime-smokes/" + jobId + ".artifact.json";
  const filePath = path.join(directory, jobId + ".artifact.json");
  const canonicalPayload = canonicalize(payload);
  const payloadBytes = Buffer.from(canonicalJson(canonicalPayload), "utf8");
  const payloadSha256 = sha256(payloadBytes);
  const envelope = {
    schemaVersion: GENERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION,
    payload: canonicalPayload,
    payloadSha256,
  };
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + "\n", "utf8");
  if (!bytes.length || bytes.length > MAX_RECEIPT_BYTES) {
    throw new RangeError("Generation artifact receipt exceeds its 256 KiB size limit.");
  }
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await chmod(filePath, 0o600);
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size !== bytes.length) {
    throw new TypeError("Generation artifact receipt was not persisted as the expected regular file.");
  }
  if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) {
    throw new TypeError("Generation artifact receipt permissions are not private.");
  }
  const storedBytes = await readFile(filePath);
  if (storedBytes.length !== bytes.length || sha256(storedBytes) !== sha256(bytes)) {
    throw new TypeError("Generation artifact receipt changed immediately after its write.");
  }
  return {
    schemaVersion: GENERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION,
    path: relativePath,
    bytes: storedBytes.length,
    sha256: sha256(storedBytes),
    payloadSha256,
  };
}
