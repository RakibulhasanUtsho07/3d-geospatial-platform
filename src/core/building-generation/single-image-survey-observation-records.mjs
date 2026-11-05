import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./generation-artifact-receipt.mjs";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;
export const SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_ARTIFACT_TYPE =
  "single-image-survey-observation-record";
export const MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_TOTAL_BYTES = 64 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSignature = (info) =>
  [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

async function readStableObservationRecord(root, relativePath) {
  let current = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new TypeError("Survey observation record path must not contain symbolic links.");
    }
    if (index < segments.length - 1 && !entry.isDirectory()) {
      throw new TypeError("Survey observation record parent must be a real directory.");
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      throw new TypeError("Survey observation record must be a regular file.");
    }
  }
  const actual = await realpath(current);
  if (!inside(root, actual)) throw new TypeError("Survey observation record resolves outside the private workspace.");
  const handle = await open(actual, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 ||
        before.size > MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES) {
      throw new RangeError("Survey observation record is empty or exceeds the 8 MiB per-record limit.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(actual);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        fileSignature(before) !== fileSignature(after) ||
        fileSignature(after) !== fileSignature(pathAfter) ||
        bytes.length !== after.size) {
      throw new Error("Survey observation record changed while being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Read opaque source record bytes from deterministic observation-ID paths. */
export async function collectSingleImageSurveyObservationRecords({ workspaceRoot, checkpoints }) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("A private survey observation workspace is required.");
  }
  if (!Array.isArray(checkpoints) || checkpoints.length < 6 || checkpoints.length > 100) {
    throw new RangeError("Survey observation records require 6–100 held-out checkpoints.");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const checkpointIds = new Set();
  const observationIds = new Set();
  const files = [];
  const inventory = [];
  let totalBytes = 0;
  for (const checkpoint of checkpoints) {
    if (!checkpoint || typeof checkpoint !== "object" ||
        typeof checkpoint.id !== "string" || !SAFE_ID.test(checkpoint.id) ||
        typeof checkpoint.observationId !== "string" || !SAFE_ID.test(checkpoint.observationId) ||
        !HASH.test(checkpoint.observationRecordSha256 ?? "") ||
        checkpointIds.has(checkpoint.id) || observationIds.has(checkpoint.observationId)) {
      throw new TypeError("Survey observation record checkpoint IDs, observation IDs and declared hashes must be valid and unique.");
    }
    checkpointIds.add(checkpoint.id);
    observationIds.add(checkpoint.observationId);
    const relativePath = "evidence/survey-observations/" + checkpoint.observationId + ".record";
    const bytes = await readStableObservationRecord(root, relativePath);
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== checkpoint.observationRecordSha256) {
      throw new Error("Survey observation record SHA-256 does not match held-out checkpoint " + checkpoint.id + ".");
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_TOTAL_BYTES) {
      throw new RangeError("Survey observation records exceed the 64 MiB aggregate limit.");
    }
    files.push({
      artifactType: SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_ARTIFACT_TYPE,
      relativePath,
      bytes,
    });
    inventory.push({ observationId: checkpoint.observationId, relativePath, bytes: bytes.length, sha256: actualSha256 });
  }
  inventory.sort((a, b) => a.observationId.localeCompare(b.observationId));
  return {
    files,
    inventory,
    count: files.length,
    totalBytes,
    inventorySha256: sha256(Buffer.from(canonicalJson(inventory), "utf8")),
  };
}

/** Re-hash the actual package bytes and enforce one record per manifest observation. */
export function verifyPackagedSingleImageSurveyObservationRecords({
  checkpoints, packageArtifacts, actualFiles, expectedCount, expectedTotalBytes, expectedInventorySha256,
}) {
  if (!Array.isArray(checkpoints) || checkpoints.length < 6 || checkpoints.length > 100 ||
      !Array.isArray(packageArtifacts) || !Array.isArray(actualFiles)) {
    throw new TypeError("Packaged survey observation record inputs are invalid.");
  }
  if (!Number.isSafeInteger(expectedCount) ||
      !Number.isSafeInteger(expectedTotalBytes) || expectedTotalBytes < 1 ||
      !HASH.test(expectedInventorySha256 ?? "")) {
    throw new TypeError("Packaged survey observation record inventory metadata is invalid.");
  }
  const recordArtifacts = packageArtifacts.filter((item) =>
    item?.artifactType === SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_ARTIFACT_TYPE);
  if (recordArtifacts.length !== checkpoints.length || expectedCount !== checkpoints.length) {
    throw new Error("Packaged survey observation record count does not match held-out checkpoints.");
  }
  const artifactByPath = new Map();
  for (const artifact of recordArtifacts) {
    if (typeof artifact.relativePath !== "string" || artifactByPath.has(artifact.relativePath)) {
      throw new Error("Packaged survey observation record paths are invalid or duplicated.");
    }
    artifactByPath.set(artifact.relativePath, artifact);
  }
  const actualByPath = new Map();
  for (const file of actualFiles) {
    if (file && typeof file.relativePath === "string" && !actualByPath.has(file.relativePath)) {
      actualByPath.set(file.relativePath, file);
    }
  }
  const checkpointIds = new Set();
  const observationIds = new Set();
  const inventory = [];
  let totalBytes = 0;
  for (const checkpoint of checkpoints) {
    if (!checkpoint || typeof checkpoint.id !== "string" || !SAFE_ID.test(checkpoint.id) ||
        typeof checkpoint.observationId !== "string" || !SAFE_ID.test(checkpoint.observationId) ||
        !HASH.test(checkpoint.observationRecordSha256 ?? "") ||
        checkpointIds.has(checkpoint.id) || observationIds.has(checkpoint.observationId)) {
      throw new TypeError("Packaged held-out checkpoint identity or observation hash is invalid.");
    }
    checkpointIds.add(checkpoint.id);
    observationIds.add(checkpoint.observationId);
    const relativePath = "evidence/survey-observations/" + checkpoint.observationId + ".record";
    const artifact = artifactByPath.get(relativePath);
    const file = actualByPath.get(relativePath);
    if (!artifact || artifact.artifactType !== SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_ARTIFACT_TYPE ||
        !file || !Buffer.isBuffer(file.content) || file.isRegularFile === false) {
      throw new Error("A required raw survey observation record is missing from the review package.");
    }
    const bytes = file.content;
    if (bytes.length < 1 || bytes.length > MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES ||
        artifact.bytes !== bytes.length || !HASH.test(artifact.sha256 ?? "")) {
      throw new Error("Packaged survey observation record size or artifact metadata is invalid.");
    }
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== artifact.sha256 || actualSha256 !== checkpoint.observationRecordSha256) {
      throw new Error("Packaged raw survey observation record does not match its checkpoint-declared SHA-256.");
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_TOTAL_BYTES) {
      throw new RangeError("Packaged survey observation records exceed the 64 MiB aggregate limit.");
    }
    inventory.push({ observationId: checkpoint.observationId, relativePath, bytes: bytes.length, sha256: actualSha256 });
  }
  if (artifactByPath.size !== checkpoints.length) {
    throw new Error("Review package contains orphaned or substituted survey observation record artifacts.");
  }
  inventory.sort((a, b) => a.observationId.localeCompare(b.observationId));
  const inventorySha256 = sha256(Buffer.from(canonicalJson(inventory), "utf8"));
  if (totalBytes !== expectedTotalBytes || inventorySha256 !== expectedInventorySha256) {
    throw new Error("Packaged survey observation record inventory metadata does not match exact included bytes.");
  }
  return { count: checkpoints.length, totalBytes, inventorySha256 };
}
