import { createHash } from "node:crypto";
import {
  canonicalSourceBoundReviewSubmissionBytes,
  parseTrustedReconstructionReviewerKeys,
  verifyTrustedReconstructionReviewerSignature,
} from "./source-bound-authenticated-review.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SCHEMA_VERSION = "1.0.0";
const RECORD_TYPE = "d3m02-generation-job-signed-publication-review";
const SUBMISSION_FIELDS = Object.freeze([
  "schemaVersion",
  "recordType",
  "jobId",
  "buildingId",
  "reviewRecordSha256",
  "candidateGlbSha256",
  "qaReportSha256",
  "placementSha256",
  "reviewerId",
  "reviewedAtUtc",
  "decision",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every((key) => expected.includes(key));
}

function requireSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
}

function requireHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(label + " must be a lowercase SHA-256 hash.");
  }
}

function requireCanonicalUtc(value, label) {
  if (typeof value !== "string" ||
      !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value)) {
    throw new TypeError(label + " must be a canonical UTC timestamp with milliseconds.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(label + " must be a valid canonical UTC timestamp.");
  }
}

/**
 * Build the one review decision that a trusted reviewer must sign before the
 * D3M-02 generation-job GLB can be placed in the public Cesium catalog.
 */
export function createGenerationJobPublicationReviewSubmission({
  jobId,
  buildingId,
  reviewRecord,
  reviewRecordSha256,
}) {
  requireSafeId(jobId, "jobId");
  requireSafeId(buildingId, "buildingId");
  requireHash(reviewRecordSha256, "reviewRecordSha256");
  if (!isRecord(reviewRecord) ||
      reviewRecord.jobId !== jobId ||
      reviewRecord.buildingId !== buildingId ||
      reviewRecord.decision !== "approved" ||
      reviewRecord.mapReady !== false ||
      reviewRecord.publicationEligible !== false ||
      reviewRecord.publicationAction !== "not-performed") {
    throw new TypeError("A matching immutable approved generation-job review record is required.");
  }
  requireSafeId(reviewRecord.reviewer, "reviewerId");
  requireCanonicalUtc(reviewRecord.reviewedAt, "reviewedAt");
  requireHash(reviewRecord.candidate?.modelSha256, "candidate GLB SHA-256");
  requireHash(reviewRecord.candidate?.reportSha256, "QA report SHA-256");
  requireHash(reviewRecord.placementSha256, "reviewed placement SHA-256");

  if (reviewRecord.candidate.modelSha256 !== reviewRecord.candidateSha256) {
    throw new Error("Immutable review candidate GLB hashes do not agree.");
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    recordType: RECORD_TYPE,
    jobId,
    buildingId,
    reviewRecordSha256,
    candidateGlbSha256: reviewRecord.candidate.modelSha256,
    qaReportSha256: reviewRecord.candidate.reportSha256,
    placementSha256: reviewRecord.placementSha256,
    reviewerId: reviewRecord.reviewer,
    reviewedAtUtc: reviewRecord.reviewedAt,
    decision: "approve-for-catalog-handoff",
  };
}

/**
 * Verify a signed receipt against server-configured trust anchors and the exact
 * immutable review record. Public keys never come from the request body.
 */
export function verifyGenerationJobPublicationReview({
  receipt,
  jobId,
  buildingId,
  reviewRecord,
  reviewRecordSha256,
}) {
  if (!hasExactKeys(receipt, ["submission", "signatureBase64"])) {
    throw new TypeError("generation-job signed review receipt must contain exactly submission and signatureBase64.");
  }
  if (!hasExactKeys(receipt.submission, SUBMISSION_FIELDS)) {
    throw new TypeError("generation-job signed review submission must contain exactly the documented fields.");
  }

  const expected = createGenerationJobPublicationReviewSubmission({
    jobId,
    buildingId,
    reviewRecord,
    reviewRecordSha256,
  });
  const payloadBytes = canonicalSourceBoundReviewSubmissionBytes(receipt.submission);
  const expectedBytes = canonicalSourceBoundReviewSubmissionBytes(expected);
  if (!payloadBytes.equals(expectedBytes)) {
    throw new Error("Signed generation-job review must bind the exact immutable review record, GLB, QA report, placement, reviewer and timestamp.");
  }

  const registryJson = process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON;
  if (typeof registryJson !== "string" || !registryJson.trim()) {
    throw new Error("RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON is required for approved generation-job publication.");
  }
  const trustedReviewerKeys = parseTrustedReconstructionReviewerKeys(registryJson);
  const reviewedAt = Date.parse(receipt.submission.reviewedAtUtc);
  if (!Number.isFinite(reviewedAt) || reviewedAt > Date.now() + 5 * 60 * 1000) {
    throw new TypeError("Signed generation-job review timestamp must be valid and not in the future.");
  }

  const verified = verifyTrustedReconstructionReviewerSignature({
    submission: receipt.submission,
    signatureBase64: receipt.signatureBase64,
    trustedReviewerKeys,
  });
  const receiptBytes = Buffer.from(JSON.stringify({
    signatureBase64: receipt.signatureBase64,
    submission: JSON.parse(payloadBytes.toString("utf8")),
  }), "utf8");

  return {
    scheme: "Ed25519",
    reviewerId: verified.reviewerId,
    keyId: verified.keyId,
    registryId: verified.registryId,
    reviewedAtUtc: receipt.submission.reviewedAtUtc,
    publicKeyFingerprintSha256: verified.publicKeyFingerprintSha256,
    signatureSha256: verified.signatureSha256,
    signedPayloadSha256: verified.payloadSha256,
    signedReviewReceiptSha256: sha256(receiptBytes),
  };
}

export function canonicalGenerationJobPublicationReviewBytes(submission) {
  return canonicalSourceBoundReviewSubmissionBytes(submission);
}
