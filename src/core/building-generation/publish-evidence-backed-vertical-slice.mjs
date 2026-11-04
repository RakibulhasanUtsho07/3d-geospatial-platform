import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  parseTrustedReconstructionReviewerKeys,
  verifyTrustedReconstructionReviewerSignature,
} from "./source-bound-authenticated-review.mjs";
import { publishReviewedBuildingModel } from "./published-model-catalog.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const PUBLICATION_REVIEW_FIELDS = Object.freeze([
  "schemaVersion",
  "recordType",
  "buildingId",
  "verticalSliceReportSha256",
  "sourceSetSha256",
  "candidateGlbSha256",
  "publicationAttestationSha256",
  "reviewerId",
  "reviewedAtUtc",
  "decision",
]);
const PUBLICATION_REVIEW_SCHEMA_VERSION = "1.0.0";
const PUBLICATION_REVIEW_RECORD_TYPE = "d3m-engine-03-signed-publication-review";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every((key) => expected.includes(key));
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim() ||
      value.includes("\\") || path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(label + " must be a workspace-relative POSIX path");
  }
  if (value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " contains an unsafe path segment");
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

async function readRegularFile(root, relativePath, label, maxBytes) {
  const safePath = safeRelative(relativePath, label);
  const candidate = path.resolve(root, ...safePath.split("/"));
  if (!inside(root, candidate)) throw new TypeError(label + " escapes workspaceRoot");
  const entry = await lstat(candidate);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError(label + " must be a regular non-symlink file");
  }
  if (entry.size <= 0 || entry.size > maxBytes) {
    throw new RangeError(label + " must be non-empty and no larger than " + maxBytes + " bytes");
  }
  const resolved = await realpath(candidate);
  if (!inside(root, resolved)) throw new TypeError(label + " resolves outside workspaceRoot");
  const bytes = await readFile(resolved);
  return {
    relativePath: path.relative(root, resolved).split(path.sep).join("/"),
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function verifySignedPublicationReview({
  receipt,
  report,
  reportSha256,
  attestationSha256,
  attestation,
  reviewReceiptSha256,
  candidateSha256,
}) {
  if (!hasExactKeys(receipt, ["submission", "signatureBase64"])) {
    throw new TypeError("signed publication review must contain exactly submission and signatureBase64");
  }
  const submission = receipt.submission;
  if (!hasExactKeys(submission, PUBLICATION_REVIEW_FIELDS)) {
    throw new TypeError("signed publication review submission must contain exactly the documented fields");
  }
  if (submission.schemaVersion !== PUBLICATION_REVIEW_SCHEMA_VERSION ||
      submission.recordType !== PUBLICATION_REVIEW_RECORD_TYPE) {
    throw new TypeError("signed publication review schemaVersion or recordType is unsupported");
  }
  if (submission.buildingId !== report.buildingId ||
      submission.verticalSliceReportSha256 !== reportSha256 ||
      submission.sourceSetSha256 !== report.sourceEvidence?.sourceSetSha256 ||
      submission.candidateGlbSha256 !== candidateSha256 ||
      submission.publicationAttestationSha256 !== attestationSha256) {
    throw new Error("signed publication review must bind the exact building, parent report, source set, candidate GLB and publication attestation hashes");
  }
  for (const key of [
    "verticalSliceReportSha256",
    "sourceSetSha256",
    "candidateGlbSha256",
    "publicationAttestationSha256",
  ]) {
    if (!SHA256.test(submission[key] ?? "")) {
      throw new TypeError("signed publication review " + key + " must be a lowercase SHA-256 hash");
    }
  }
  if (typeof submission.reviewerId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(submission.reviewerId)) {
    throw new TypeError("signed publication review reviewerId must be a safe identifier");
  }
  if (submission.decision !== "approve-for-catalog-handoff") {
    throw new Error("signed publication review decision must be approve-for-catalog-handoff");
  }
  const reviewedAt = Date.parse(submission.reviewedAtUtc);
  if (!Number.isFinite(reviewedAt) || reviewedAt > Date.now() + 5 * 60 * 1000) {
    throw new TypeError("signed publication review reviewedAtUtc must be a valid non-future review timestamp");
  }

  const registryJson = process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON;
  if (typeof registryJson !== "string" || !registryJson.trim()) {
    throw new Error("RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON is required for D3M-ENGINE-03 catalog publication");
  }
  const trustedReviewerKeys = parseTrustedReconstructionReviewerKeys(registryJson);
  if (attestation.review?.reviewer !== submission.reviewerId ||
      attestation.review?.reviewedAt !== submission.reviewedAtUtc) {
    throw new Error("publication attestation reviewer and reviewedAt must exactly match the signed reviewer identity and timestamp");
  }
  const verified = verifyTrustedReconstructionReviewerSignature({
    submission,
    signatureBase64: receipt.signatureBase64,
    trustedReviewerKeys,
  });
  return {
    scheme: "Ed25519",
    reviewerId: verified.reviewerId,
    keyId: verified.keyId,
    registryId: verified.registryId,
    reviewedAtUtc: submission.reviewedAtUtc,
    publicKeyFingerprintSha256: verified.publicKeyFingerprintSha256,
    signatureSha256: verified.signatureSha256,
    signedPayloadSha256: verified.payloadSha256,
    signedReviewReceiptSha256: reviewReceiptSha256,
  };
}

/**
 * Publish only the exact textured geometry candidate produced by a completed
 * D3M-ENGINE-03 parent report. Publication now also requires an Ed25519 review
 * receipt signed by a currently trusted D3M-01 reviewer key. The signature binds
 * the exact parent report, source set, candidate GLB and publication attestation.
 *
 * A valid signature proves possession of a key in the server-configured trust
 * registry; it does not establish civil identity, legal authority, source rights,
 * independent truth or survey accuracy. Release flags remain fail-closed.
 */
export async function publishEvidenceBackedVerticalSlice({
  workspaceRoot,
  reportPath,
  attestationPath,
  reviewReceiptPath,
  publicRoot,
  publishedAt,
}) {
  if (!workspaceRoot || !reportPath || !attestationPath || !reviewReceiptPath || !publicRoot) {
    throw new TypeError("workspaceRoot, reportPath, attestationPath, reviewReceiptPath and publicRoot are required");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const reportFile = await readRegularFile(root, reportPath, "vertical-slice report", 16 * 1024 * 1024);
  const attestationFile = await readRegularFile(root, attestationPath, "publication attestation", 2 * 1024 * 1024);
  const reviewReceiptFile = await readRegularFile(root, reviewReceiptPath, "signed publication review receipt", 1024 * 1024);

  let report;
  let attestation;
  let reviewReceipt;
  try {
    report = JSON.parse(reportFile.bytes.toString("utf8"));
    attestation = JSON.parse(attestationFile.bytes.toString("utf8"));
    reviewReceipt = JSON.parse(reviewReceiptFile.bytes.toString("utf8"));
  } catch (error) {
    throw new TypeError("vertical-slice report, attestation and signed review receipt must be valid JSON: " + error.message);
  }

  if (!isRecord(report) ||
      report.workflow !== "D3M-ENGINE-03" ||
      report.status !== "completed-requires-human-review") {
    throw new TypeError("only a completed D3M-ENGINE-03 human-review candidate can be published");
  }
  if (!report.acceptance || report.acceptance.sourceEvidenceBound !== true ||
      report.acceptance.candidateGlbAvailable !== true ||
      report.acceptance.texturedGlbAvailable !== true ||
      report.acceptance.geometryWorkflowChecksPassed !== true) {
    throw new TypeError("vertical-slice technical and source-binding checks must pass before publication");
  }
  if (report.acceptance.acceptanceEligible !== false ||
      report.acceptance.publicationEligible !== false ||
      report.acceptance.mapReady !== false ||
      report.acceptance.automaticApproval !== false) {
    throw new TypeError("vertical-slice release flags must remain fail-closed");
  }

  const geometry = report.childJobs?.geometry?.output;
  const model = geometry?.texturedModel;
  if (!model || typeof model.path !== "string" ||
      typeof model.sha256 !== "string" || !SHA256.test(model.sha256) ||
      !Number.isSafeInteger(model.texturedTriangleCount) || model.texturedTriangleCount < 1 ||
      model.untexturedTriangleCount !== 0 ||
      (geometry.blockerCount ?? 0) !== 0 ||
      (geometry.blockers ?? []).length !== 0) {
    throw new TypeError("geometry child must have a zero-blocker fully textured GLB candidate");
  }

  const candidate = await readRegularFile(root, model.path, "textured geometry candidate", 512 * 1024 * 1024);
  if (candidate.sha256 !== model.sha256) {
    throw new Error("textured geometry candidate SHA-256 does not match the parent report");
  }
  if (!isRecord(attestation) ||
      attestation.candidateSha256 !== candidate.sha256) {
    throw new Error("publication attestation must bind the exact D3M-ENGINE-03 textured GLB hash");
  }
  if (attestation.verticalSliceReportSha256 !== reportFile.sha256 ||
      attestation.sourceSetSha256 !== report.sourceEvidence?.sourceSetSha256) {
    throw new Error("publication attestation must bind the exact parent report and source-set hashes");
  }
  if (!attestation.model || attestation.model.id !== report.buildingId) {
    throw new Error("publication attestation model.id must exactly match the parent buildingId");
  }

  const reviewerAuthentication = verifySignedPublicationReview({
    receipt: reviewReceipt,
    report,
    reportSha256: reportFile.sha256,
    attestationSha256: attestationFile.sha256,
    attestation,
    reviewReceiptSha256: reviewReceiptFile.sha256,
    candidateSha256: candidate.sha256,
  });

  const effectivePublishedAt = publishedAt ?? new Date().toISOString();
  const publicationTime = Date.parse(effectivePublishedAt);
  const signedReviewTime = Date.parse(reviewReceipt.submission.reviewedAtUtc);
  if (!Number.isFinite(publicationTime) || publicationTime < signedReviewTime) {
    throw new TypeError("publishedAt must be a valid timestamp no earlier than the signed reviewer decision");
  }

  const published = await publishReviewedBuildingModel({
    workspaceRoot: root,
    candidatePath: candidate.relativePath,
    attestationPath: attestationFile.relativePath,
    publicRoot,
    publishedAt: effectivePublishedAt,
    reviewerAuthentication,
    expectedCandidateSha256: candidate.sha256,
    expectedAttestationSha256: attestationFile.sha256,
  });
  if (published.sha256 !== candidate.sha256 || published.modelId !== report.buildingId) {
    throw new Error("published catalog result does not match the bound D3M-ENGINE-03 candidate");
  }
  return {
    ...published,
    candidatePath: candidate.relativePath,
    candidateSha256: candidate.sha256,
    sourceSetSha256: report.sourceEvidence?.sourceSetSha256 ?? null,
    parentReportSha256: reportFile.sha256,
    publicationAttestationSha256: attestationFile.sha256,
    signedReviewPayloadSha256: reviewerAuthentication.signedPayloadSha256,
    signedReviewReceiptSha256: reviewerAuthentication.signedReviewReceiptSha256,
    reviewerAuthentication,
    mapReady: false,
    publicationEligible: false,
    note: "The exact candidate was written to the static catalog after a trusted Ed25519 publication-review receipt was verified. Key possession is authenticated; civil identity, legal authority, independent survey accuracy and map readiness are not established. Parent release flags remain false.",
  };
}
