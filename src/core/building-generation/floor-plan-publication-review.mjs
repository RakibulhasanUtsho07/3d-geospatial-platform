import { createHash } from "node:crypto";
import {
  canonicalSourceBoundReviewSubmissionBytes,
  parseTrustedReconstructionReviewerKeys,
  verifyTrustedReconstructionReviewerSignature,
} from "./source-bound-authenticated-review.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const FIELDS = Object.freeze([
  "schemaVersion",
  "recordType",
  "buildingId",
  "candidateId",
  "floorPlanId",
  "reviewRecordSha256",
  "publicationAttestationSha256",
  "candidateGlbSha256",
  "qaReportSha256",
  "geometrySha256",
  "sourceSha256",
  "evidenceSha256",
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

function requireSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
}

function requireHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(label + " must be a lowercase SHA-256 hash.");
  }
}

function requireCanonicalTimestamp(value, label) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(label + " must be a canonical UTC timestamp with milliseconds.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(label + " must be a valid canonical UTC timestamp.");
  }
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => expected.includes(key));
}

export function createFloorPlanPublicationReviewSubmission({
  reviewRecord,
  reviewRecordSha256,
  publicationAttestationSha256,
}) {
  if (!isRecord(reviewRecord) ||
      reviewRecord.schemaVersion !== "1.0.0" ||
      reviewRecord.decision !== "approved" ||
      reviewRecord.mapReady !== false ||
      reviewRecord.publicationEligible !== false ||
      reviewRecord.publicationAction !== "not-performed" ||
      !isRecord(reviewRecord.candidate) ||
      !isRecord(reviewRecord.publication) ||
      !isRecord(reviewRecord.evidence)) {
    throw new TypeError("An immutable approved floor-plan review record with publication, candidate and evidence is required.");
  }

  for (const [field, value] of [
    ["buildingId", reviewRecord.buildingId],
    ["candidateId", reviewRecord.candidateId],
    ["floorPlanId", reviewRecord.floorPlanId],
    ["reviewerId", reviewRecord.reviewer],
  ]) requireSafeId(value, field);
  for (const [field, value] of [
    ["reviewRecordSha256", reviewRecordSha256],
    ["publicationAttestationSha256", publicationAttestationSha256],
    ["candidateGlbSha256", reviewRecord.candidate.modelSha256],
    ["qaReportSha256", reviewRecord.candidate.reportSha256],
    ["geometrySha256", reviewRecord.candidate.geometrySha256],
    ["sourceSha256", reviewRecord.candidate.sourceSha256],
    ["evidenceSha256", reviewRecord.evidence.sha256],
  ]) requireHash(value, field);
  requireCanonicalTimestamp(reviewRecord.reviewedAt, "reviewedAt");

  const placementSha256 = sha256(Buffer.from(JSON.stringify(reviewRecord.publication), "utf8"));
  return {
    schemaVersion: "1.0.0",
    recordType: "floor-plan-signed-publication-review",
    buildingId: reviewRecord.buildingId,
    candidateId: reviewRecord.candidateId,
    floorPlanId: reviewRecord.floorPlanId,
    reviewRecordSha256,
    publicationAttestationSha256,
    candidateGlbSha256: reviewRecord.candidate.modelSha256,
    qaReportSha256: reviewRecord.candidate.reportSha256,
    geometrySha256: reviewRecord.candidate.geometrySha256,
    sourceSha256: reviewRecord.candidate.sourceSha256,
    evidenceSha256: reviewRecord.evidence.sha256,
    placementSha256,
    reviewerId: reviewRecord.reviewer,
    reviewedAtUtc: reviewRecord.reviewedAt,
    decision: "approve-for-catalog-handoff",
  };
}

export function verifyFloorPlanPublicationReview({
  receipt,
  reviewRecord,
  reviewRecordSha256,
  publicationAttestationSha256,
}) {
  if (!hasExactKeys(receipt, ["submission", "signatureBase64"])) {
    throw new TypeError("floor-plan signed publication receipt must contain exactly submission and signatureBase64.");
  }
  if (!hasExactKeys(receipt.submission, FIELDS)) {
    throw new TypeError("floor-plan signed publication submission must contain exactly the documented fields.");
  }
  const expected = createFloorPlanPublicationReviewSubmission({
    reviewRecord,
    reviewRecordSha256,
    publicationAttestationSha256,
  });
  const actualBytes = canonicalSourceBoundReviewSubmissionBytes(receipt.submission);
  const expectedBytes = canonicalSourceBoundReviewSubmissionBytes(expected);
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error("Signed floor-plan publication receipt must bind the exact review record, attestation, GLB, QA report, geometry, source, evidence and placement.");
  }

  const registryJson = process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON;
  if (typeof registryJson !== "string" || !registryJson.trim()) {
    throw new Error("RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON is required for floor-plan catalog publication.");
  }
  const trustedReviewerKeys = parseTrustedReconstructionReviewerKeys(registryJson);
  const reviewedAt = Date.parse(receipt.submission.reviewedAtUtc);
  if (!Number.isFinite(reviewedAt) || reviewedAt > Date.now() + 5 * 60 * 1000) {
    throw new TypeError("Signed floor-plan publication review timestamp must be valid and not in the future.");
  }
  const verified = verifyTrustedReconstructionReviewerSignature({
    submission: receipt.submission,
    signatureBase64: receipt.signatureBase64,
    trustedReviewerKeys,
  });
  const receiptBytes = Buffer.from(JSON.stringify({
    signatureBase64: receipt.signatureBase64,
    submission: JSON.parse(actualBytes.toString("utf8")),
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

export function canonicalFloorPlanPublicationReviewBytes(submission) {
  return canonicalSourceBoundReviewSubmissionBytes(submission);
}
