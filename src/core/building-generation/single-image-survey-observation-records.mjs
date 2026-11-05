import { createHash } from "node:crypto";

export const MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS_BYTES = 128 * 1024 * 1024;
export const MIN_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS = 6;
export const MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS = 100;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const WINDOWS_RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const HASH = /^[a-f0-9]{64}$/;

function isSafeObservationId(value) {
  return typeof value === "string" && SAFE_ID.test(value) && !value.endsWith(".") &&
    !WINDOWS_RESERVED_DEVICE.test(value.split(".")[0]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The path is derived from the already-validated observation ID. A manifest
 * cannot redirect the reader to arbitrary workspace paths.
 */
export function singleImageSurveyObservationRecordPath(observationId) {
  if (!isSafeObservationId(observationId)) {
    throw new TypeError("Survey observation ID is invalid.");
  }
  return "evidence/survey-observations/" + observationId + ".record";
}

/**
 * Build the canonical inventory used by the review package hand-off.
 * Only metadata is hashed; original observation bytes are hashed separately.
 */
export function buildSingleImageSurveyObservationRecordInventory(records) {
  if (!Array.isArray(records) ||
      records.length < MIN_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS ||
      records.length > MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS) {
    throw new RangeError("A byte-verified survey inventory requires 6–100 observation records.");
  }

  const ids = new Set();
  const paths = new Set();
  let totalBytes = 0;
  const normalized = records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        !isSafeObservationId(record.observationId) ||
        ids.has(record.observationId.toLowerCase()) ||
        typeof record.relativePath !== "string" ||
        record.relativePath !== singleImageSurveyObservationRecordPath(record.observationId) ||
        paths.has(record.relativePath.toLowerCase()) ||
        typeof record.sha256 !== "string" || !HASH.test(record.sha256) ||
        !Number.isSafeInteger(record.bytes) || record.bytes < 1 ||
        record.bytes > MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES) {
      throw new TypeError("Survey observation record inventory entry " + index + " is invalid.");
    }
    ids.add(record.observationId.toLowerCase());
    paths.add(record.relativePath.toLowerCase());
    totalBytes += record.bytes;
    if (!Number.isSafeInteger(totalBytes) ||
        totalBytes > MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS_BYTES) {
      throw new RangeError("Survey observation records exceed the 128 MiB aggregate limit.");
    }
    return {
      observationId: record.observationId,
      relativePath: record.relativePath,
      sha256: record.sha256,
      bytes: record.bytes,
    };
  }).sort((left, right) => left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0);

  return {
    count: normalized.length,
    totalBytes,
    sha256: sha256(Buffer.from(JSON.stringify(normalized), "utf8")),
    records: normalized,
  };
}
