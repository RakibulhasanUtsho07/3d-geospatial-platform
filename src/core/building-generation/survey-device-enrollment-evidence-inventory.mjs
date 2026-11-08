import { createHash } from "node:crypto";
import { surveyDeviceEnrollmentEvidencePath } from "./survey-device-enrollment-evidence.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonicalJson(value) {
  return JSON.stringify(value);
}

/**
 * Deterministic package inventory for device-level enrollment statements.
 * D3M-18 evidence binds a physical-device identity, not an individual key;
 * multiple D3M-17 key rotations therefore share one enrollment document.
 */
export function buildSurveyDeviceEnrollmentEvidenceInventory(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) {
    throw new RangeError("Device enrollment evidence inventory must contain 1–100 devices.");
  }
  const seenDevices = new Set();
  const seenPaths = new Set();
  let authorityRegistryId = null;
  const entries = input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.deviceId !== "string" || !SAFE_ID.test(entry.deviceId) ||
        entry.relativePath !== surveyDeviceEnrollmentEvidencePath(entry.deviceId) ||
        typeof entry.sha256 !== "string" || !HASH.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 ||
        typeof entry.authorityId !== "string" || !SAFE_ID.test(entry.authorityId) ||
        !["manufacturer", "independent-enrollment-authority"].includes(entry.authorityType) ||
        typeof entry.authorityRegistryId !== "string" || !SAFE_ID.test(entry.authorityRegistryId)) {
      throw new TypeError("Device enrollment evidence inventory entry is invalid.");
    }
    if (seenDevices.has(entry.deviceId) || seenPaths.has(entry.relativePath)) {
      throw new Error("Device enrollment evidence inventory contains a duplicated device or path.");
    }
    seenDevices.add(entry.deviceId);
    seenPaths.add(entry.relativePath);
    if (authorityRegistryId !== null && authorityRegistryId !== entry.authorityRegistryId) {
      throw new Error("Device enrollment evidence entries must use the same authority registry.");
    }
    authorityRegistryId = entry.authorityRegistryId;
    return {
      deviceId: entry.deviceId,
      relativePath: entry.relativePath,
      sha256: entry.sha256,
      bytes: entry.bytes,
      authorityId: entry.authorityId,
      authorityType: entry.authorityType,
      authorityRegistryId: entry.authorityRegistryId,
    };
  }).sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  return {
    count: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    sha256: sha256(Buffer.from(canonicalJson(entries), "utf8")),
    entries,
  };
}
