import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS,
  completeReconstructionStage,
  createOrResumeReconstructionJob,
  failReconstructionStage,
  fingerprintStageInput,
  readReconstructionJob,
  startReconstructionStage,
  validateStageArtifact,
} from "./reconstruction-job-state.mjs";
import { readSourceBoundReconstructionHandoff } from "./source-bound-reconstruction-handoff.mjs";
import { analyzeGlbQuality } from "./glb-geometry-qa.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_CANDIDATE_BYTES = 128 * 1024 * 1024;
const GEOMETRY_QA_OPTIONS = Object.freeze({
  maxVertices: 2_000_000,
  maxTopologyVertices: 250_000,
  maxDegenerateTriangleRatio: 0.01,
});
const MAX_REVIEWER_KEYS = 100;
const REVIEW_SCHEMA_VERSION = "1.0.0";
const REVIEW_RECORD_TYPE = "source-bound-reconstruction-human-review-submission";
const GEOMETRY_REPORT_TYPE = "source-bound-candidate-geometry-qa";
const DECISIONS = new Set([
  "continue-to-independent-validation",
  "changes-requested",
  "hold",
  "reject",
]);
const CHECK_ENUMS = Object.freeze({
  rightsUseScope: ["verified", "not-verified", "uncertain", "not-reviewed"],
  sameBuildingIdentity: ["verified", "not-verified", "uncertain", "not-reviewed"],
  cameraCalibration: ["verified", "not-verified", "uncertain", "not-reviewed"],
  groundControlCorrespondence: ["verified", "not-verified", "uncertain", "not-reviewed"],
  metricScale: ["verified", "not-verified", "uncertain", "not-reviewed"],
  verticalDatum: ["verified", "unresolved", "uncertain", "not-reviewed"],
  geometryTopology: ["accepted-for-independent-validation", "changes-required", "not-reviewed"],
  sourceCameraComparison: ["consistent", "mismatched", "not-reviewed"],
});
const REQUIRED_CONTINUE_CHECKS = Object.freeze([
  "rightsUseScope",
  "sameBuildingIdentity",
  "cameraCalibration",
  "groundControlCorrespondence",
  "metricScale",
  "verticalDatum",
  "geometryTopology",
  "sourceCameraComparison",
]);
const REQUIRED_HANDOFF_INTEGRITY_CHECKS = Object.freeze([
  "sourceJobCompleted",
  "sourceJobArtifactsVerified",
  "visualBundleHashRecomputed",
  "reconstructionEvidenceHashRecomputed",
  "candidateGlbHashRecomputed",
  "candidateGlbContainerValid",
  "qaReportHashRecomputed",
  "qaReportMatchesImmutableSourceArtifact",
  "visualSourceMatchesSelectedJobView",
  "exactCandidateHashMatchesEvidenceBundle",
]);
const FALSE_POLICY = Object.freeze({
  candidateGeometryValidated: false,
  groundTruth: false,
  acceptanceEligible: false,
  publicationEligible: false,
  publishable: false,
  mapReady: false,
  automaticApproval: false,
  dispatchAllowed: false,
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Signed review payload must not contain non-finite numbers.");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Signed review payload must not contain circular values.");
    ancestors.add(value);
    const result = value.map((item) => canonicalValue(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (isObject(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Signed review payload must contain plain JSON objects.");
    }
    if (ancestors.has(value)) throw new TypeError("Signed review payload must not contain circular values.");
    ancestors.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError("Signed review payload must not contain undefined fields.");
      result[key] = canonicalValue(value[key], ancestors);
    }
    ancestors.delete(value);
    return result;
  }
  throw new TypeError("Signed review payload must contain JSON-compatible values.");
}

/** Exact UTF-8 bytes that a reviewer must sign with their Ed25519 private key. */
export function canonicalSourceBoundReviewSubmissionBytes(submission) {
  if (!isObject(submission)) throw new TypeError("Review submission must be a JSON object.");
  return Buffer.from(JSON.stringify(canonicalValue(submission)), "utf8");
}

function isCanonicalUtcTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier of at most 80 characters.");
  }
  return value;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() ||
      value.includes("\\") || value.includes("\0") ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a workspace-relative POSIX path.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " contains an unsafe path segment.");
  }
  return parts.join("/");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

async function readWorkspaceFile(root, relativePath, label, maxBytes) {
  const safePath = safeRelativePath(relativePath, label + " path");
  const segments = safePath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " path must not traverse a symlink.");
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new TypeError(label + " path parent must be a real directory.");
    }
  }
  const target = path.resolve(root, ...segments);
  if (!inside(root, target)) throw new TypeError(label + " escapes the workspace.");
  const info = await lstat(target);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) {
    throw new RangeError(label + " must be a non-empty regular file within the configured byte limit.");
  }
  const actual = await realpath(target);
  if (!inside(root, actual)) throw new TypeError(label + " resolves outside the workspace.");
  const bytes = await readFile(actual);
  if (bytes.length !== info.size || bytes.length < 1 || bytes.length > maxBytes) {
    throw new TypeError(label + " changed while it was being read or exceeds the byte limit.");
  }
  return { path: safePath, bytes, byteLength: bytes.length, sha256: sha256(bytes) };
}

function activeHandoffArtifact(job) {
  const stage = job.stages.find((item) => item.id === "candidate-evidence-handoff");
  if (!stage || stage.status !== "completed" || !stage.activeArtifactId) {
    throw new TypeError("The hand-off job has no completed active evidence artifact.");
  }
  const record = stage.artifacts.find((item) => item.artifactId === stage.activeArtifactId);
  if (!record || !HASH.test(record.contentSha256 ?? "")) {
    throw new TypeError("The active hand-off artifact record is invalid.");
  }
  return record;
}

function makeGeometryReport({ handoff, handoffArtifactSha256, candidateFile }) {
  let geometryQa;
  let geometryStatus = "geometry-qa-failed";
  let geometryError = null;
  try {
    geometryQa = analyzeGlbQuality(candidateFile.bytes, GEOMETRY_QA_OPTIONS);
    geometryStatus = geometryQa.valid === true ? geometryQa.status : "geometry-qa-failed";
  } catch (error) {
    geometryQa = null;
    geometryError = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
  }

  const report = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    recordType: GEOMETRY_REPORT_TYPE,
    handoffJobId: handoff.handoffId,
    handoffArtifactSha256,
    buildingId: handoff.buildingId,
    sourceJobId: handoff.sourceJobId,
    candidate: {
      path: candidateFile.path,
      sha256: candidateFile.sha256,
      byteLength: candidateFile.byteLength,
    },
    geometryQaOptions: { ...GEOMETRY_QA_OPTIONS },
    geometryQa: geometryQa ? {
      engine: geometryQa.engine,
      status: geometryQa.status,
      valid: geometryQa.valid,
      counts: geometryQa.counts,
      bounds: geometryQa.bounds,
      meshDetails: geometryQa.meshDetails,
      warnings: geometryQa.warnings,
      externalUris: geometryQa.externalUris,
      limitations: geometryQa.limitations,
    } : null,
    geometryStatus,
    geometryError,
    independentTruth: {
      status: "not-evaluated",
      independentReferenceVerified: false,
      heldOutCheckpointAccuracyVerified: false,
    },
    policy: { ...FALSE_POLICY },
    limitations: [
      "GLB geometry QA inspects the exact candidate bytes for structural, triangle, topology and model-space bounds diagnostics only.",
      "Topology warnings may be legitimate architectural boundaries or disconnected parts and require human visual review.",
      "Model-space bounds are not metric dimensions unless separately calibrated and independently evidenced.",
      "This report does not establish architectural fidelity, same-building identity, camera truth, survey authority, WGS84 placement or independent accuracy.",
      "A successful geometry QA report is not human acceptance, publication approval or map readiness.",
    ],
  };
  const bytes = Buffer.from(JSON.stringify(canonicalValue(report)) + "\n", "utf8");
  return { report, bytes, sha256: sha256(bytes) };
}

function makeSubmissionTemplate({ handoff, handoffArtifactSha256, geometryReportSha256, candidateSha256 }) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    recordType: REVIEW_RECORD_TYPE,
    buildingId: handoff.buildingId,
    sourceJobId: handoff.sourceJobId,
    handoffJobId: handoff.handoffId,
    handoffArtifactSha256,
    candidateGlbSha256: candidateSha256,
    geometryReportSha256,
    reviewerId: "",
    reviewedAtUtc: "",
    decision: "hold",
    checks: {
      rightsUseScope: "not-reviewed",
      sameBuildingIdentity: "not-reviewed",
      cameraCalibration: "not-reviewed",
      groundControlCorrespondence: "not-reviewed",
      metricScale: "not-reviewed",
      verticalDatum: "not-reviewed",
      geometryTopology: "not-reviewed",
      sourceCameraComparison: "not-reviewed",
    },
    notes: "",
  };
}

/**
 * Verify the exact D3M-01.C hand-off and produce a deterministic GLB geometry-QA
 * report plus an unsigned decision template. No reviewer identity is inferred.
 */
export async function prepareSourceBoundGeometryReview({ workspaceRoot, buildingId, handoffJobId }) {
  const root = await realpath(path.resolve(workspaceRoot ?? ""));
  const building = safeId(buildingId, "buildingId");
  const handoffId = safeId(handoffJobId, "handoffJobId");
  const { job, artifact, handoff } = await readSourceBoundReconstructionHandoff({
    workspaceRoot: root,
    buildingId: building,
    handoffJobId: handoffId,
  });
  const handoffArtifact = activeHandoffArtifact(job);
  if (artifact.contentSha256 !== handoffArtifact.contentSha256 ||
      handoff.handoffId !== handoffId ||
      handoff.buildingId !== building ||
      handoff.recordType !== "source-bound-reconstruction-handoff" ||
      handoff.handoffPrepared !== true ||
      handoff.reviewRequired !== true ||
      REQUIRED_HANDOFF_INTEGRITY_CHECKS.some((key) => handoff.checks?.[key] !== true) ||
      (handoff.policy?.candidateGeometryValidated !== undefined && handoff.policy?.candidateGeometryValidated !== false) ||
      handoff.candidate?.geometryAccuracyEvaluated !== false ||
      handoff.policy?.groundTruth !== false ||
      handoff.policy?.acceptanceEligible !== false ||
      handoff.policy?.publicationEligible !== false ||
      handoff.policy?.publishable !== false ||
      handoff.policy?.mapReady !== false ||
      handoff.policy?.automaticApproval !== false ||
      handoff.policy?.dispatchAllowed !== false) {
    throw new TypeError("The selected hand-off identity or fail-closed policy is invalid.");
  }

  const candidate = await readWorkspaceFile(
    root,
    handoff.candidate?.path,
    "Hand-off candidate GLB",
    MAX_CANDIDATE_BYTES,
  );
  if (candidate.sha256 !== handoff.candidate?.sha256?.toLowerCase() ||
      candidate.byteLength !== handoff.candidate?.bytes) {
    throw new TypeError("Candidate GLB bytes no longer match the immutable hand-off identity.");
  }

  const geometry = makeGeometryReport({
    handoff,
    handoffArtifactSha256: handoffArtifact.contentSha256,
    candidateFile: candidate,
  });
  const template = makeSubmissionTemplate({
    handoff,
    handoffArtifactSha256: handoffArtifact.contentSha256,
    geometryReportSha256: geometry.sha256,
    candidateSha256: candidate.sha256,
  });
  return {
    handoff,
    handoffJobId: handoffId,
    handoffArtifactSha256: handoffArtifact.contentSha256,
    candidateSha256: candidate.sha256,
    candidateByteLength: candidate.byteLength,
    geometryReport: geometry.report,
    geometryReportSha256: geometry.sha256,
    geometryReportBytes: geometry.bytes,
    submissionTemplate: template,
    signingInstructions: {
      algorithm: "Ed25519",
      messageEncoding: "UTF-8",
      messageBytes: "canonical JSON: recursively sort object keys, preserve array order, compact JSON, no trailing newline",
      signatureField: "signatureBase64",
      trustedKeysSource: "server-configured RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON",
    },
  };
}

/**
 * Parse the server-controlled reviewer trust anchors. The request body must never
 * carry or override these public keys. The registry contains public keys only.
 */
export function parseTrustedReconstructionReviewerKeys(input, options = {}) {
  const now = options.now === undefined ? new Date() : new Date(options.now);
  if (!Number.isFinite(now.getTime())) throw new TypeError("Trusted reviewer registry validation time must be a valid date.");
  const allowLegacy = process.env.NODE_ENV === "production" ? false : options.allowLegacy !== false;
  let registry = input;
  if (typeof input === "string") {
    try {
      registry = JSON.parse(input);
    } catch {
      throw new TypeError("RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON must be valid JSON.");
    }
  }

  // The original array format is retained only for local development and
  // deterministic legacy unit fixtures. It has no expiry or revocation model
  // and is deliberately rejected by production runtimes.
  if (Array.isArray(registry)) {
    if (!allowLegacy) {
      throw new TypeError("Production requires a versioned reconstruction trusted-reviewer registry; legacy key arrays are not accepted.");
    }
    if (registry.length < 1 || registry.length > MAX_REVIEWER_KEYS) {
      throw new TypeError("Legacy trusted reviewer key array must contain 1–100 entries.");
    }
    const seenIds = new Set();
    const seenFingerprints = new Set();
    return registry.map((entry, index) => {
      if (!isObject(entry) ||
          Object.keys(entry).some((key) => !["reviewerId", "publicKeyPem"].includes(key)) ||
          typeof entry.reviewerId !== "string" ||
          !SAFE_ID.test(entry.reviewerId) ||
          typeof entry.publicKeyPem !== "string" ||
          entry.publicKeyPem.length < 64 ||
          entry.publicKeyPem.length > 16 * 1024 ||
          /PRIVATE KEY/.test(entry.publicKeyPem)) {
        throw new TypeError("Legacy trusted reviewer key entry " + index + " must contain only a safe reviewerId and an Ed25519 public key PEM.");
      }
      if (seenIds.has(entry.reviewerId)) throw new TypeError("Trusted reviewer IDs must be unique in a legacy registry.");
      seenIds.add(entry.reviewerId);
      const publicKey = parseEd25519PublicKey(entry.publicKeyPem, entry.reviewerId);
      const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
      if (seenFingerprints.has(fingerprint)) {
        throw new TypeError("Trusted reviewer public-key fingerprints must be unique.");
      }
      seenFingerprints.add(fingerprint);
      return Object.freeze({
        reviewerId: entry.reviewerId,
        keyId: "legacy-" + fingerprint.slice(0, 16),
        registryId: "development-legacy-array",
        validFromUtc: null,
        validUntilUtc: null,
        registryIssuedAtUtc: null,
        registryExpiresAtUtc: null,
        publicKey,
        publicKeyFingerprintSha256: fingerprint,
      });
    });
  }

  const registryKeys = ["schemaVersion", "recordType", "registryId", "issuedAtUtc", "expiresAtUtc", "entries"];
  if (!isObject(registry) ||
      Object.keys(registry).length !== registryKeys.length ||
      Object.keys(registry).some((key) => !registryKeys.includes(key)) ||
      registryKeys.some((key) => !Object.prototype.hasOwnProperty.call(registry, key))) {
    throw new TypeError("Trusted reviewer registry must be a versioned JSON object with the documented envelope fields.");
  }
  if (registry.schemaVersion !== "1.0.0" ||
      registry.recordType !== "reconstruction-trusted-reviewer-key-registry") {
    throw new TypeError("Trusted reviewer registry schemaVersion or recordType is unsupported.");
  }
  safeId(registry.registryId, "registryId");
  if (!isCanonicalUtcTimestamp(registry.issuedAtUtc) ||
      !isCanonicalUtcTimestamp(registry.expiresAtUtc)) {
    throw new TypeError("Trusted reviewer registry issuedAtUtc and expiresAtUtc must be canonical UTC timestamps.");
  }
  const issuedAt = Date.parse(registry.issuedAtUtc);
  const expiresAt = Date.parse(registry.expiresAtUtc);
  const nowMs = now.getTime();
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 90 * 24 * 60 * 60 * 1000) {
    throw new TypeError("Trusted reviewer registry validity must be positive and no longer than 90 days.");
  }
  if (nowMs < issuedAt) throw new Error("Trusted reviewer registry is not yet valid.");
  if (nowMs >= expiresAt) throw new Error("Trusted reviewer registry has expired; renew it through the deployment operator.");

  if (!Array.isArray(registry.entries) ||
      registry.entries.length < 1 ||
      registry.entries.length > MAX_REVIEWER_KEYS) {
    throw new TypeError("Trusted reviewer registry entries must contain 1–100 historical/current key records.");
  }

  const entryKeys = [
    "reviewerId", "keyId", "status", "publicKeyPem",
    "validFromUtc", "validUntilUtc", "revokedAtUtc", "replacesKeyId",
  ];
  const seenKeyIds = new Set();
  const seenFingerprints = new Set();
  const parsedEntries = [];
  const activeByReviewer = new Map();

  for (const [index, entry] of registry.entries.entries()) {
    if (!isObject(entry) ||
        Object.keys(entry).length !== entryKeys.length ||
        Object.keys(entry).some((key) => !entryKeys.includes(key)) ||
        entryKeys.some((key) => !Object.prototype.hasOwnProperty.call(entry, key))) {
      throw new TypeError("Trusted reviewer registry entry " + index + " must contain exactly the documented key lifecycle fields.");
    }
    safeId(entry.reviewerId, "reviewerId");
    safeId(entry.keyId, "keyId");
    if (!["active", "revoked"].includes(entry.status)) {
      throw new TypeError("Trusted reviewer key " + entry.keyId + " status must be active or revoked.");
    }
    if (typeof entry.publicKeyPem !== "string" ||
        entry.publicKeyPem.length < 64 ||
        entry.publicKeyPem.length > 16 * 1024 ||
        /PRIVATE KEY/.test(entry.publicKeyPem)) {
      throw new TypeError("Trusted reviewer key " + entry.keyId + " must contain public-key PEM only.");
    }
    if (!isCanonicalUtcTimestamp(entry.validFromUtc) ||
        !isCanonicalUtcTimestamp(entry.validUntilUtc) ||
        Date.parse(entry.validUntilUtc) <= Date.parse(entry.validFromUtc)) {
      throw new TypeError("Trusted reviewer key " + entry.keyId + " must have a valid canonical UTC validity window.");
    }
    if (entry.replacesKeyId !== null) safeId(entry.replacesKeyId, "replacesKeyId");
    if (seenKeyIds.has(entry.keyId)) throw new TypeError("Trusted reviewer key IDs must be globally unique.");
    seenKeyIds.add(entry.keyId);

    const publicKey = parseEd25519PublicKey(entry.publicKeyPem, entry.keyId);
    const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
    if (seenFingerprints.has(fingerprint)) {
      throw new TypeError("Trusted reviewer public-key fingerprints must be unique across active and revoked records.");
    }
    seenFingerprints.add(fingerprint);

    const validFrom = Date.parse(entry.validFromUtc);
    const validUntil = Date.parse(entry.validUntilUtc);
    let revokedAt = null;
    if (entry.status === "active") {
      if (entry.revokedAtUtc !== null) {
        throw new TypeError("Active reviewer key " + entry.keyId + " must have revokedAtUtc set to null.");
      }
      if (validFrom > nowMs || validUntil <= nowMs) {
        throw new Error("Active reviewer key " + entry.keyId + " is outside its validity window.");
      }
      if (validUntil > expiresAt) {
        throw new TypeError("Active reviewer key " + entry.keyId + " must not outlive its registry envelope.");
      }
      activeByReviewer.set(entry.reviewerId, (activeByReviewer.get(entry.reviewerId) ?? 0) + 1);
    } else {
      if (!isCanonicalUtcTimestamp(entry.revokedAtUtc)) {
        throw new TypeError("Revoked reviewer key " + entry.keyId + " must have a canonical revokedAtUtc timestamp.");
      }
      revokedAt = Date.parse(entry.revokedAtUtc);
      if (revokedAt < validFrom || revokedAt > nowMs) {
        throw new TypeError("Revoked reviewer key " + entry.keyId + " must be revoked after activation and not in the future.");
      }
    }

    parsedEntries.push({
      reviewerId: entry.reviewerId,
      keyId: entry.keyId,
      status: entry.status,
      replacesKeyId: entry.replacesKeyId,
      revokedAt,
      validFrom,
      validUntil,
      publicKey,
      publicKeyFingerprintSha256: fingerprint,
    });
  }

  for (const [reviewerId, count] of activeByReviewer) {
    if (count !== 1) {
      throw new TypeError("Reviewer " + reviewerId + " must have exactly one active key during registry validity.");
    }
  }
  // An all-revoked registry is a valid emergency lockout state. It yields
  // zero verifier keys; signing and receipt verification then fail closed.

  const keysById = new Map(parsedEntries.map((entry) => [entry.keyId, entry]));
  const replacedKeyIds = new Set();
  for (const entry of parsedEntries) {
    if (entry.replacesKeyId === null) continue;
    const previous = keysById.get(entry.replacesKeyId);
    if (!previous ||
        previous.reviewerId !== entry.reviewerId ||
        previous.status !== "revoked" ||
        previous.revokedAt === null ||
        previous.revokedAt > entry.validFrom ||
        replacedKeyIds.has(previous.keyId)) {
      throw new TypeError("Reviewer key " + entry.keyId + " must replace one prior revoked key for the same reviewer.");
    }
    replacedKeyIds.add(previous.keyId);
  }

  return parsedEntries
    .filter((entry) => entry.status === "active")
    .map((entry) => Object.freeze({
      reviewerId: entry.reviewerId,
      keyId: entry.keyId,
      registryId: registry.registryId,
      validFromUtc: registry.entries.find((item) => item.keyId === entry.keyId).validFromUtc,
      validUntilUtc: registry.entries.find((item) => item.keyId === entry.keyId).validUntilUtc,
      registryIssuedAtUtc: registry.issuedAtUtc,
      registryExpiresAtUtc: registry.expiresAtUtc,
      publicKey: entry.publicKey,
      publicKeyFingerprintSha256: entry.publicKeyFingerprintSha256,
    }));
}

function parseEd25519PublicKey(publicKeyPem, keyId) {
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new TypeError("Trusted reviewer key " + keyId + " is not a valid public key.");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Trusted reviewer key " + keyId + " must use Ed25519.");
  }
  return publicKey;
}

function validateSubmission(submission, prepared) {
  if (!isObject(submission)) throw new TypeError("Review submission must be a JSON object.");
  const allowedKeys = [
    "schemaVersion", "recordType", "buildingId", "sourceJobId", "handoffJobId",
    "handoffArtifactSha256", "candidateGlbSha256", "geometryReportSha256",
    "reviewerId", "reviewedAtUtc", "decision", "checks", "notes",
  ];
  if (Object.keys(submission).some((key) => !allowedKeys.includes(key)) ||
      allowedKeys.some((key) => !Object.prototype.hasOwnProperty.call(submission, key))) {
    throw new TypeError("Review submission must contain exactly the documented fields.");
  }
  if (submission.schemaVersion !== REVIEW_SCHEMA_VERSION ||
      submission.recordType !== REVIEW_RECORD_TYPE) {
    throw new TypeError("Review submission schema or recordType is unsupported.");
  }
  if (submission.buildingId !== prepared.geometryReport.buildingId ||
      submission.sourceJobId !== prepared.geometryReport.sourceJobId ||
      submission.handoffJobId !== prepared.handoffJobId ||
      submission.handoffArtifactSha256 !== prepared.handoffArtifactSha256 ||
      submission.candidateGlbSha256 !== prepared.candidateSha256 ||
      submission.geometryReportSha256 !== prepared.geometryReportSha256) {
    throw new TypeError("Review submission must bind the exact building, hand-off, candidate and geometry report bytes.");
  }
  safeId(submission.reviewerId, "reviewerId");
  if (!isCanonicalUtcTimestamp(submission.reviewedAtUtc)) {
    throw new TypeError("reviewedAtUtc must be a canonical ISO-8601 UTC timestamp with milliseconds.");
  }
  if (!DECISIONS.has(submission.decision)) {
    throw new TypeError("decision must be continue-to-independent-validation, changes-requested, hold or reject.");
  }
  if (!isObject(submission.checks) ||
      Object.keys(submission.checks).length !== Object.keys(CHECK_ENUMS).length ||
      Object.keys(CHECK_ENUMS).some((key) => !Object.prototype.hasOwnProperty.call(submission.checks, key))) {
    throw new TypeError("checks must contain every documented review check and no additional fields.");
  }
  for (const [key, values] of Object.entries(CHECK_ENUMS)) {
    if (!values.includes(submission.checks[key])) {
      throw new TypeError("checks." + key + " must use one of: " + values.join(", ") + ".");
    }
  }
  if (typeof submission.notes !== "string" || !submission.notes.trim() || submission.notes.length > 4000) {
    throw new TypeError("notes are required and must be at most 4000 characters.");
  }

  if (submission.decision === "continue-to-independent-validation") {
    const missing = REQUIRED_CONTINUE_CHECKS.filter((key) => {
      const expected = key === "geometryTopology"
        ? "accepted-for-independent-validation"
        : key === "sourceCameraComparison" ? "consistent" : "verified";
      return submission.checks[key] !== expected;
    });
    if (missing.length) {
      throw new Error("continue-to-independent-validation requires verified decisions for every review check: " + missing.join(", "));
    }
    if (prepared.geometryReport.geometryQa?.valid !== true ||
        prepared.geometryReport.geometryStatus === "geometry-qa-failed") {
      throw new Error("continue-to-independent-validation requires a valid GLB geometry-QA report.");
    }
    const handoffChecks = prepared.handoff.checks ?? {};
    const evidenceReady = handoffChecks.rightsEvidenceCompleteButHumanReviewRequired === true &&
      handoffChecks.cameraEvidenceStructurallyValidButHumanReviewRequired === true &&
      handoffChecks.groundControlRegistrationRecomputedButHumanReviewRequired === true &&
      handoffChecks.verticalDatumResolved === true;
    if (!evidenceReady) {
      throw new Error("continue-to-independent-validation is blocked because the immutable hand-off still contains unresolved rights, camera, ground-control or vertical-datum evidence.");
    }
  }
  return JSON.parse(JSON.stringify(canonicalValue(submission)));
}

function verifyReviewerSignature({ submission, signatureBase64, reviewerKeys }) {
  if (!Array.isArray(reviewerKeys) || reviewerKeys.length < 1) {
    throw new TypeError("Trusted reviewer public keys are not configured.");
  }
  if (typeof signatureBase64 !== "string" ||
      signatureBase64.length > 1024 ||
      !BASE64.test(signatureBase64)) {
    throw new TypeError("signatureBase64 must contain a valid base64 Ed25519 signature.");
  }
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== signatureBase64) {
    throw new TypeError("signatureBase64 must decode to exactly 64 canonical Ed25519 signature bytes.");
  }
  const trustedMatches = reviewerKeys.filter((item) => item.reviewerId === submission.reviewerId);
  if (trustedMatches.length !== 1) {
    throw new Error(trustedMatches.length === 0
      ? "reviewerId is not present in the server-configured trusted reviewer key registry as a currently active key."
      : "reviewerId maps to multiple active keys; the registry must be corrected.");
  }
  const trusted = trustedMatches[0];
  if (trusted.validFromUtc && trusted.validUntilUtc) {
    const reviewedAt = Date.parse(submission.reviewedAtUtc);
    if (!Number.isFinite(reviewedAt) ||
        reviewedAt < Date.parse(trusted.validFromUtc) ||
        reviewedAt >= Date.parse(trusted.validUntilUtc)) {
      throw new Error("reviewedAtUtc is outside the trusted reviewer key validity window.");
    }
  }

  const payloadBytes = canonicalSourceBoundReviewSubmissionBytes(submission);
  let signatureValid = false;
  try {
    signatureValid = verify(null, payloadBytes, trusted.publicKey, signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new Error("Ed25519 signature is invalid for this exact review payload and trusted reviewer key.");
  }
  return {
    payloadBytes,
    payloadSha256: sha256(payloadBytes),
    signatureBytes: signature,
    signatureSha256: sha256(signature),
    reviewerId: trusted.reviewerId,
    keyId: trusted.keyId ?? "legacy-" + trusted.publicKeyFingerprintSha256.slice(0, 16),
    registryId: trusted.registryId ?? "development-legacy-array",
    validFromUtc: trusted.validFromUtc ?? null,
    validUntilUtc: trusted.validUntilUtc ?? null,
    registryIssuedAtUtc: trusted.registryIssuedAtUtc ?? null,
    registryExpiresAtUtc: trusted.registryExpiresAtUtc ?? null,
    publicKeyFingerprintSha256: trusted.publicKeyFingerprintSha256,
  };
}

async function completeImmutableStage({
  workspaceRoot,
  buildingId,
  jobId,
  stageId,
  inputFingerprint,
  payload,
  outputs,
  now,
}) {
  const stageArgs = { workspaceRoot, buildingId, jobId, stageId, inputFingerprint, now };
  const started = await startReconstructionStage(stageArgs);
  if (started.reused) {
    const stage = started.job.stages.find((item) => item.id === stageId);
    const artifactRecord = stage?.artifacts.find((item) => item.artifactId === stage.activeArtifactId);
    if (!artifactRecord) throw new TypeError("Reused authenticated-review stage is missing its active artifact.");
    return { job: started.job, artifact: started.artifact, artifactRecord, reused: true };
  }
  try {
    const completed = await completeReconstructionStage({
      workspaceRoot,
      buildingId,
      jobId,
      stageId,
      payload,
      outputs,
      now,
    });
    return { ...completed, reused: false };
  } catch (error) {
    await failReconstructionStage({
      workspaceRoot,
      buildingId,
      jobId,
      stageId,
      error,
      now,
    }).catch(() => {});
    throw error;
  }
}

/**
 * Verify a trusted Ed25519 reviewer signature and append an immutable child job.
 * The decision can continue only to independent truth/geometry evaluation; this
 * function never enables candidate acceptance, publication or map readiness.
 */
export async function recordSourceBoundAuthenticatedReview({
  workspaceRoot,
  buildingId,
  handoffJobId,
  submission,
  signatureBase64,
  trustedReviewerKeys,
  now,
}) {
  const root = await realpath(path.resolve(workspaceRoot ?? ""));
  const building = safeId(buildingId, "buildingId");
  const handoff = safeId(handoffJobId, "handoffJobId");
  const prepared = await prepareSourceBoundGeometryReview({
    workspaceRoot: root,
    buildingId: building,
    handoffJobId: handoff,
  });
  const normalizedSubmission = validateSubmission(submission, prepared);
  const signature = verifyReviewerSignature({
    submission: normalizedSubmission,
    signatureBase64,
    reviewerKeys: trustedReviewerKeys,
  });
  const recordedAt = now === undefined ? new Date().toISOString() : new Date(now).toISOString();
  if (!isCanonicalUtcTimestamp(recordedAt)) throw new TypeError("now must resolve to a canonical UTC timestamp.");

  const decisionJobId = "review-" + sha256(Buffer.concat([
    signature.payloadBytes,
    Buffer.from("\n", "utf8"),
    signature.signatureBytes,
  ])).slice(0, 32);
  const sourceManifest = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    recordType: "source-bound-authenticated-review-job-source",
    handoffJobId: handoff,
    handoffArtifactSha256: prepared.handoffArtifactSha256,
    candidateGlbSha256: prepared.candidateSha256,
    geometryReportSha256: prepared.geometryReportSha256,
    reviewerId: signature.reviewerId,
    reviewerKeyId: signature.keyId,
    reviewerRegistryId: signature.registryId,
    reviewerKeyValidFromUtc: signature.validFromUtc,
    reviewerKeyValidUntilUtc: signature.validUntilUtc,
    reviewerRegistryIssuedAtUtc: signature.registryIssuedAtUtc,
    reviewerRegistryExpiresAtUtc: signature.registryExpiresAtUtc,
    reviewerPublicKeyFingerprintSha256: signature.publicKeyFingerprintSha256,
    signedPayloadSha256: signature.payloadSha256,
    signatureSha256: signature.signatureSha256,
  };
  const config = {
    reviewContractVersion: REVIEW_SCHEMA_VERSION,
    decision: normalizedSubmission.decision,
    reviewerId: signature.reviewerId,
    reviewerKeyId: signature.keyId,
    reviewerRegistryId: signature.registryId,
    reviewerKeyValidUntilUtc: signature.validUntilUtc,
    reviewerRegistryExpiresAtUtc: signature.registryExpiresAtUtc,
    reviewerPublicKeyFingerprintSha256: signature.publicKeyFingerprintSha256,
    candidateGeometryValidated: false,
    groundTruth: false,
    acceptanceEligible: false,
    publicationEligible: false,
    publishable: false,
    mapReady: false,
    automaticApproval: false,
    dispatchAllowed: false,
  };
  const created = await createOrResumeReconstructionJob({
    workspaceRoot: root,
    buildingId: building,
    jobId: decisionJobId,
    sourceManifest,
    config,
    stageIds: SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS,
    now: recordedAt,
  });
  const createdAt = created.job.createdAt;
  const geometryFingerprint = fingerprintStageInput({
    stageId: SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS[0],
    inputs: {
      handoffArtifactSha256: prepared.handoffArtifactSha256,
      candidateGlbSha256: prepared.candidateSha256,
      geometryReportSha256: prepared.geometryReportSha256,
    },
    parameters: { engine: "glb-geometry-qa-v2", schemaVersion: REVIEW_SCHEMA_VERSION },
  });
  const geometryStage = await completeImmutableStage({
    workspaceRoot: root,
    buildingId: building,
    jobId: decisionJobId,
    stageId: SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS[0],
    inputFingerprint: geometryFingerprint,
    payload: {
      report: prepared.geometryReport,
      reportSha256: prepared.geometryReportSha256,
      reportByteLength: prepared.geometryReportBytes.length,
    },
    outputs: {
      candidateGlbSha256: prepared.candidateSha256,
      geometryReportSha256: prepared.geometryReportSha256,
      geometryStatus: prepared.geometryReport.geometryStatus,
      geometryValid: prepared.geometryReport.geometryQa?.valid === true,
    },
    now: createdAt,
  });

  const decisionRecord = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    recordType: "source-bound-authenticated-reconstruction-review",
    reviewJobId: decisionJobId,
    recordedAtUtc: createdAt,
    reviewedAtUtc: normalizedSubmission.reviewedAtUtc,
    buildingId: building,
    sourceJobId: prepared.geometryReport.sourceJobId,
    handoffJobId: handoff,
    handoffArtifactSha256: prepared.handoffArtifactSha256,
    candidateGlbSha256: prepared.candidateSha256,
    geometryReportSha256: prepared.geometryReportSha256,
    decision: normalizedSubmission.decision,
    checks: normalizedSubmission.checks,
    notes: normalizedSubmission.notes,
    authentication: {
      method: "ed25519-signature-over-canonical-review-payload",
      status: "signature-verified-against-server-trusted-reviewer-key",
      reviewerId: signature.reviewerId,
      reviewerKeyId: signature.keyId,
      reviewerRegistryId: signature.registryId,
      reviewerKeyValidFromUtc: signature.validFromUtc,
      reviewerKeyValidUntilUtc: signature.validUntilUtc,
      reviewerRegistryIssuedAtUtc: signature.registryIssuedAtUtc,
      reviewerRegistryExpiresAtUtc: signature.registryExpiresAtUtc,
      reviewerPublicKeyFingerprintSha256: signature.publicKeyFingerprintSha256,
      signedPayloadSha256: signature.payloadSha256,
      signatureAlgorithm: "Ed25519",
      signatureBase64,
      identityAssurance: "possession-of-server-trusted-private-key-only",
    },
    geometryQa: {
      status: prepared.geometryReport.geometryStatus,
      valid: prepared.geometryReport.geometryQa?.valid === true,
      warnings: prepared.geometryReport.geometryQa?.warnings ?? [],
      reportSha256: prepared.geometryReportSha256,
    },
    independentTruth: {
      status: "not-evaluated",
      independentReferenceVerified: false,
      heldOutCheckpointAccuracyVerified: false,
    },
    policy: { ...FALSE_POLICY },
    limitations: [
      "The signature verifies possession of the private key mapped to reviewerId in the server-configured trust registry; it does not prove a person's civil identity or authority beyond that provisioning.",
      "The human review fields are signed reviewer attestations; they do not independently prove legal rights, building identity, calibration truth, survey accuracy or architectural correctness.",
      "GLB geometry QA is structural/topology diagnostics only; independent physical reference and held-out accuracy evaluation remain separate.",
      "continue-to-independent-validation is not candidate acceptance, publication approval, map readiness or permission to dispatch a worker.",
    ],
  };
  const decisionFingerprint = fingerprintStageInput({
    stageId: SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS[1],
    inputs: {
      geometryArtifactSha256: geometryStage.artifact.contentSha256,
      signedPayloadSha256: signature.payloadSha256,
      signatureSha256: signature.signatureSha256,
    },
    parameters: {
      reviewerId: signature.reviewerId,
      reviewerKeyId: signature.keyId,
      reviewerRegistryId: signature.registryId,
      reviewerPublicKeyFingerprintSha256: signature.publicKeyFingerprintSha256,
      reviewerKeyValidFromUtc: signature.validFromUtc,
      reviewerKeyValidUntilUtc: signature.validUntilUtc,
      reviewerRegistryIssuedAtUtc: signature.registryIssuedAtUtc,
      reviewerRegistryExpiresAtUtc: signature.registryExpiresAtUtc,
      decision: normalizedSubmission.decision,
    },
  });
  const decisionStage = await completeImmutableStage({
    workspaceRoot: root,
    buildingId: building,
    jobId: decisionJobId,
    stageId: SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS[1],
    inputFingerprint: decisionFingerprint,
    payload: {
      decisionRecord,
      signedPayload: normalizedSubmission,
      signedPayloadBytesBase64: signature.payloadBytes.toString("base64"),
    },
    outputs: {
      reviewJobId: decisionJobId,
      handoffJobId: handoff,
      candidateGlbSha256: prepared.candidateSha256,
      reviewerId: signature.reviewerId,
      decision: normalizedSubmission.decision,
      signatureVerified: true,
      publicationEligible: false,
      mapReady: false,
    },
    now: createdAt,
  });
  return {
    reviewJobId: decisionJobId,
    decision: normalizedSubmission.decision,
    signatureVerified: true,
    reviewerId: signature.reviewerId,
    reviewerPublicKeyFingerprintSha256: signature.publicKeyFingerprintSha256,
    geometryReportSha256: prepared.geometryReportSha256,
    reused: created.resumed && geometryStage.reused && decisionStage.reused,
    job: decisionStage.job,
    artifact: decisionStage.artifact,
    decisionRecord,
  };
}

/** Read and checksum-verify a previously recorded signed review decision. */
export async function readSourceBoundAuthenticatedReview({ workspaceRoot, buildingId, reviewJobId }) {
  const root = await realpath(path.resolve(workspaceRoot ?? ""));
  const building = safeId(buildingId, "buildingId");
  const id = safeId(reviewJobId, "reviewJobId");
  const { job, jobDirectory } = await readReconstructionJob({
    workspaceRoot: root,
    buildingId: building,
    jobId: id,
    recoverInterrupted: false,
  });
  if (JSON.stringify(job.stageIds) !== JSON.stringify(SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS) ||
      job.status !== "completed") {
    throw new TypeError("Requested job is not a completed authenticated-review decision job.");
  }
  const stage = job.stages.find((item) => item.id === SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS[1]);
  const record = stage?.artifacts.find((item) => item.artifactId === stage.activeArtifactId);
  if (!record || !HASH.test(record.contentSha256 ?? "")) {
    throw new TypeError("Authenticated-review decision artifact is missing.");
  }
  const artifactFile = await readWorkspaceFile(
    jobDirectory,
    record.path,
    "Authenticated-review decision artifact",
    20 * 1024 * 1024,
  );
  let artifact;
  try {
    artifact = JSON.parse(artifactFile.bytes.toString("utf8"));
    validateStageArtifact(artifact);
  } catch (error) {
    throw new TypeError("Authenticated-review decision artifact failed schema/checksum validation: " +
      (error instanceof Error ? error.message : String(error)));
  }
  if (artifact.stageId !== SOURCE_BOUND_AUTHENTICATED_REVIEW_STAGE_IDS[1] ||
      artifact.contentSha256 !== record.contentSha256 ||
      artifact.inputFingerprint !== record.inputFingerprint ||
      artifact.revision !== record.revision) {
    throw new TypeError("Authenticated-review decision artifact does not match its immutable job-state record.");
  }
  const decisionRecord = artifact.payload?.decisionRecord;
  if (!isObject(decisionRecord) ||
      decisionRecord.authentication?.status !== "signature-verified-against-server-trusted-reviewer-key" ||
      decisionRecord.policy?.candidateGeometryValidated !== false ||
      decisionRecord.policy?.groundTruth !== false ||
      decisionRecord.policy?.acceptanceEligible !== false ||
      decisionRecord.policy?.publicationEligible !== false ||
      decisionRecord.policy?.publishable !== false ||
      decisionRecord.policy?.mapReady !== false ||
      decisionRecord.policy?.automaticApproval !== false ||
      decisionRecord.policy?.dispatchAllowed !== false) {
    throw new TypeError("Authenticated-review decision artifact violates its signed review-only contract.");
  }
  return { job, artifact, decisionRecord };
}


/**
 * Re-verify a stored D3M-01.D decision immediately before BRF-25 consumes it.
 * This deliberately replays the hand-off and geometry report from workspace
 * bytes, reconstructs the exact signed submission, and verifies Ed25519 against
 * the current server-controlled trust registry. A persisted "verified" label
 * or caller-provided decision string is not sufficient authorization.
 */
export async function verifySourceBoundAuthenticatedReviewForIndependentValidation({
  workspaceRoot,
  buildingId,
  reviewJobId,
  expectedCandidateGlbSha256,
  trustedReviewerKeys,
}) {
  if (typeof expectedCandidateGlbSha256 !== "string" ||
      !HASH.test(expectedCandidateGlbSha256)) {
    throw new TypeError("expectedCandidateGlbSha256 must be a lowercase SHA-256 hash.");
  }
  const stored = await readSourceBoundAuthenticatedReview({
    workspaceRoot,
    buildingId,
    reviewJobId,
  });
  const prepared = await prepareSourceBoundGeometryReview({
    workspaceRoot,
    buildingId,
    handoffJobId: stored.decisionRecord.handoffJobId,
  });
  const decisionRecord = stored.decisionRecord;
  const authentication = decisionRecord.authentication;
  const sourceManifest = stored.job.sourceManifest;
  const jobConfig = stored.job.config;
  const expectedHash = expectedCandidateGlbSha256.toLowerCase();

  const metadataMismatches = [];
  const requireMetadata = (id, passed) => {
    if (!passed) metadataMismatches.push(id);
  };
  requireMetadata("job-source-manifest-object", isObject(sourceManifest));
  requireMetadata("job-config-object", isObject(jobConfig));
  requireMetadata("source-manifest-schema", sourceManifest?.schemaVersion === REVIEW_SCHEMA_VERSION);
  requireMetadata("source-manifest-record-type", sourceManifest?.recordType === "source-bound-authenticated-review-job-source");
  requireMetadata("source-manifest-handoff-id", sourceManifest?.handoffJobId === prepared.handoffJobId);
  requireMetadata("source-manifest-handoff-hash", sourceManifest?.handoffArtifactSha256 === prepared.handoffArtifactSha256);
  requireMetadata("source-manifest-candidate-hash", sourceManifest?.candidateGlbSha256 === prepared.candidateSha256);
  requireMetadata("source-manifest-geometry-report-hash", sourceManifest?.geometryReportSha256 === prepared.geometryReportSha256);
  requireMetadata("source-manifest-reviewer-id", sourceManifest?.reviewerId === authentication?.reviewerId);
  requireMetadata("source-manifest-key-id", sourceManifest?.reviewerKeyId === authentication?.reviewerKeyId);
  requireMetadata("source-manifest-registry-id", sourceManifest?.reviewerRegistryId === authentication?.reviewerRegistryId);
  requireMetadata("source-manifest-key-valid-from", sourceManifest?.reviewerKeyValidFromUtc === authentication?.reviewerKeyValidFromUtc);
  requireMetadata("source-manifest-key-valid-until", sourceManifest?.reviewerKeyValidUntilUtc === authentication?.reviewerKeyValidUntilUtc);
  requireMetadata("source-manifest-registry-issued-at", sourceManifest?.reviewerRegistryIssuedAtUtc === authentication?.reviewerRegistryIssuedAtUtc);
  requireMetadata("source-manifest-registry-expires-at", sourceManifest?.reviewerRegistryExpiresAtUtc === authentication?.reviewerRegistryExpiresAtUtc);
  requireMetadata("source-manifest-key-fingerprint", sourceManifest?.reviewerPublicKeyFingerprintSha256 === authentication?.reviewerPublicKeyFingerprintSha256);
  requireMetadata("source-manifest-signed-payload-hash", sourceManifest?.signedPayloadSha256 === authentication?.signedPayloadSha256);
  requireMetadata("job-config-review-contract", jobConfig?.reviewContractVersion === REVIEW_SCHEMA_VERSION);
  requireMetadata("job-config-decision", jobConfig?.decision === decisionRecord.decision);
  requireMetadata("job-config-reviewer-id", jobConfig?.reviewerId === authentication?.reviewerId);
  requireMetadata("job-config-key-id", jobConfig?.reviewerKeyId === authentication?.reviewerKeyId);
  requireMetadata("job-config-registry-id", jobConfig?.reviewerRegistryId === authentication?.reviewerRegistryId);
  requireMetadata("job-config-key-valid-until", jobConfig?.reviewerKeyValidUntilUtc === authentication?.reviewerKeyValidUntilUtc);
  requireMetadata("job-config-registry-expires-at", jobConfig?.reviewerRegistryExpiresAtUtc === authentication?.reviewerRegistryExpiresAtUtc);
  requireMetadata("job-config-key-fingerprint", jobConfig?.reviewerPublicKeyFingerprintSha256 === authentication?.reviewerPublicKeyFingerprintSha256);
  for (const flag of ["candidateGeometryValidated", "groundTruth", "acceptanceEligible", "publicationEligible", "publishable", "mapReady", "automaticApproval", "dispatchAllowed"]) {
    requireMetadata("job-config-" + flag + "-false", jobConfig?.[flag] === false);
  }
  requireMetadata("job-building-id", stored.job.buildingId === buildingId);
  requireMetadata("job-id", stored.job.jobId === reviewJobId);
  requireMetadata("job-created-at", stored.job.createdAt === decisionRecord.recordedAtUtc);
  if (metadataMismatches.length) {
    throw new TypeError("Authenticated-review job metadata mismatch: " + metadataMismatches.join(", ") + ".");
  }

  if (decisionRecord.schemaVersion !== REVIEW_SCHEMA_VERSION ||
      decisionRecord.recordType !== "source-bound-authenticated-reconstruction-review" ||
      decisionRecord.reviewJobId !== reviewJobId ||
      decisionRecord.buildingId !== buildingId ||
      decisionRecord.sourceJobId !== prepared.geometryReport.sourceJobId ||
      decisionRecord.handoffJobId !== prepared.handoffJobId ||
      decisionRecord.handoffArtifactSha256 !== prepared.handoffArtifactSha256 ||
      decisionRecord.candidateGlbSha256 !== prepared.candidateSha256 ||
      decisionRecord.geometryReportSha256 !== prepared.geometryReportSha256 ||
      prepared.candidateSha256 !== expectedHash) {
    throw new TypeError("Authenticated review receipt does not bind the exact BRF-25 building, hand-off, geometry report and candidate GLB bytes.");
  }

  if (decisionRecord.decision !== "continue-to-independent-validation") {
    throw new Error("BRF-25 requires a signed continue-to-independent-validation decision; the stored reviewer disposition is " +
      String(decisionRecord.decision) + ".");
  }

  if (authentication?.method !== "ed25519-signature-over-canonical-review-payload" ||
      authentication?.signatureAlgorithm !== "Ed25519" ||
      authentication?.identityAssurance !== "possession-of-server-trusted-private-key-only" ||
      typeof authentication.signatureBase64 !== "string") {
    throw new TypeError("Authenticated review receipt has incomplete or unsupported signature metadata.");
  }

  const reconstructedSubmission = {
    ...prepared.submissionTemplate,
    reviewerId: authentication.reviewerId,
    reviewedAtUtc: decisionRecord.reviewedAtUtc,
    decision: decisionRecord.decision,
    checks: decisionRecord.checks,
    notes: decisionRecord.notes,
  };
  const normalizedSubmission = validateSubmission(reconstructedSubmission, prepared);
  const signature = verifyReviewerSignature({
    submission: normalizedSubmission,
    signatureBase64: authentication.signatureBase64,
    reviewerKeys: trustedReviewerKeys,
  });

  if (authentication.status !== "signature-verified-against-server-trusted-reviewer-key" ||
      authentication.reviewerId !== signature.reviewerId ||
      authentication.reviewerPublicKeyFingerprintSha256 !== signature.publicKeyFingerprintSha256 ||
      authentication.signedPayloadSha256 !== signature.payloadSha256 ||
      sourceManifest.signatureSha256 !== signature.signatureSha256 ||
      (authentication.signatureSha256 !== undefined &&
        authentication.signatureSha256 !== signature.signatureSha256)) {
    throw new TypeError("Stored authenticated-review signature, payload digest or trusted reviewer-key fingerprint does not verify against the current registry.");
  }

  const receipt = Object.freeze({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    status: "cryptographically-reverified",
    decision: decisionRecord.decision,
    buildingId,
    reviewJobId,
    handoffJobId: prepared.handoffJobId,
    handoffArtifactSha256: prepared.handoffArtifactSha256,
    candidateGlbSha256: prepared.candidateSha256,
    geometryReportSha256: prepared.geometryReportSha256,
    reviewerId: signature.reviewerId,
    reviewerKeyId: signature.keyId,
    reviewerRegistryId: signature.registryId,
    reviewerKeyValidFromUtc: signature.validFromUtc,
    reviewerKeyValidUntilUtc: signature.validUntilUtc,
    reviewerRegistryIssuedAtUtc: signature.registryIssuedAtUtc,
    reviewerRegistryExpiresAtUtc: signature.registryExpiresAtUtc,
    reviewerPublicKeyFingerprintSha256: signature.publicKeyFingerprintSha256,
    signedPayloadSha256: signature.payloadSha256,
    signatureSha256: signature.signatureSha256,
    reviewDecisionArtifactSha256: stored.artifact.contentSha256,
    reviewedAtUtc: decisionRecord.reviewedAtUtc,
    recordedAtUtc: decisionRecord.recordedAtUtc,
    identityAssurance: "possession-of-server-trusted-private-key-only",
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });

  return { receipt, job: stored.job, artifact: stored.artifact, decisionRecord };
}
