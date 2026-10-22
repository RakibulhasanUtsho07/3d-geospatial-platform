import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { loadVerifiedSource } from "./source-workflow.mjs";
import { publishReviewedBuildingModel } from "./published-model-catalog.mjs";
import { loadFloorPlanModelCandidate } from "./floor-plan-model-job.mjs";

export const FLOOR_PLAN_REVIEW_DECISIONS = Object.freeze(["approved", "rejected", "changes_requested"]);
export const REQUIRED_FLOOR_PLAN_REVIEW_CHECKS = Object.freeze([
  "rightsVerified",
  "sourceIdentityVerified",
  "architectureReviewed",
  "metricScaleVerified",
  "horizontalGeoreferenceVerified",
  "verticalDatumVerified",
  "qaReportReviewed",
]);

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

function nonEmptyText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new TypeError(label + " must be non-empty and at most " + maximum + " characters.");
  }
  return value.trim();
}

function knownLicence(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    !["unknown", "n/a", "none"].includes(value.trim().toLowerCase());
}

function validateReviewInput(input) {
  if (!isRecord(input)) throw new TypeError("Review request must be a JSON object.");
  if (!FLOOR_PLAN_REVIEW_DECISIONS.includes(input.decision)) {
    throw new TypeError("decision must be approved, rejected or changes_requested.");
  }
  const reviewer = nonEmptyText(input.reviewer, "reviewer", 200);
  const notes = nonEmptyText(input.notes, "notes", 4000);
  if (!isRecord(input.checks)) throw new TypeError("checks must be an object.");
  const checks = {};
  for (const key of REQUIRED_FLOOR_PLAN_REVIEW_CHECKS) {
    if (typeof input.checks[key] !== "boolean") {
      throw new TypeError("checks." + key + " must be an explicit boolean.");
    }
    checks[key] = input.checks[key];
  }
  if (input.decision === "approved" &&
      REQUIRED_FLOOR_PLAN_REVIEW_CHECKS.some((key) => checks[key] !== true)) {
    throw new Error("Approval requires every floor-plan review check to be explicitly true.");
  }

  let publication = null;
  if (input.decision === "approved") {
    const raw = input.publication;
    if (!isRecord(raw)) {
      throw new TypeError("An approved review must include explicit publication model ID, name and surveyed placement.");
    }
    const modelId = nonEmptyText(raw.modelId, "publication.modelId", 160);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(modelId)) {
      throw new TypeError("publication.modelId contains unsupported characters.");
    }
    const modelName = nonEmptyText(raw.modelName, "publication.modelName", 200);
    if (!isRecord(raw.position)) throw new TypeError("publication.position is required.");
    const finiteRange = (value, label, minimum, maximum) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new RangeError(label + " must be a finite number between " + minimum + " and " + maximum + ".");
      }
      return value;
    };
    const position = {
      longitude: finiteRange(raw.position.longitude, "publication.position.longitude", -180, 180),
      latitude: finiteRange(raw.position.latitude, "publication.position.latitude", -90, 90),
      height: finiteRange(raw.position.height, "publication.position.height", -12000, 9000000),
    };
    const headingDegrees = finiteRange(raw.headingDegrees, "publication.headingDegrees", -360, 360);
    const pitchDegrees = finiteRange(raw.pitchDegrees, "publication.pitchDegrees", -90, 90);
    const rollDegrees = finiteRange(raw.rollDegrees, "publication.rollDegrees", -360, 360);
    const scale = finiteRange(raw.scale, "publication.scale", 0.001, 1000);
    if (!["X", "Y", "Z"].includes(raw.upAxis) || !["X", "Y", "Z"].includes(raw.forwardAxis) ||
        raw.upAxis === raw.forwardAxis) {
      throw new TypeError("publication.upAxis and publication.forwardAxis must be different axes from X, Y or Z.");
    }
    publication = {
      modelId,
      modelName,
      position,
      headingDegrees,
      pitchDegrees,
      rollDegrees,
      scale,
      upAxis: raw.upAxis,
      forwardAxis: raw.forwardAxis,
    };
  }

  const evidencePath = safeWorkspaceRelativePath(input.evidencePath, "evidencePath");
  if (typeof input.evidenceSha256 !== "string" || !HASH.test(input.evidenceSha256.toLowerCase())) {
    throw new TypeError("evidenceSha256 must be a 64-character SHA-256 hash.");
  }
  return {
    decision: input.decision,
    reviewer,
    notes,
    checks,
    evidencePath,
    evidenceSha256: input.evidenceSha256.toLowerCase(),
    publication,
  };
}

function safeWorkspaceRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") || value.includes("\0") ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a safe workspace-relative POSIX path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(label + " must not contain empty, dot or parent path segments.");
  }
  return value;
}

async function resolveRegularWorkspaceFile(root, relativePath, label, maximumBytes) {
  safeWorkspaceRelativePath(relativePath, label);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  if (!inside(root, absolute)) throw new TypeError(label + " escapes the workspace.");
  let current = root;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new TypeError(label + " must not contain symbolic links.");
    const last = index === segments.length - 1;
    if (!last && !entry.isDirectory()) throw new TypeError(label + " contains a non-directory path component.");
    if (last && !entry.isFile()) throw new TypeError(label + " must be a regular file.");
    const actual = await realpath(current);
    if (!inside(root, actual)) throw new TypeError(label + " resolves outside the workspace.");
    if (last) {
      const details = await stat(actual);
      if (details.size <= 0 || details.size > maximumBytes) {
        throw new RangeError(label + " is empty or exceeds the " + maximumBytes + "-byte limit.");
      }
      return { absolute: actual, bytes: await readFile(actual) };
    }
  }
  throw new TypeError(label + " is invalid.");
}

async function candidateDirectory(root, buildingId, candidateId) {
  let current = root;
  for (const segment of [".building-engine", "floor-plan-candidates", buildingId, candidateId]) {
    const next = path.join(current, segment);
    const entry = await lstat(next);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError("Floor-plan candidate path must contain only regular directories.");
    }
    current = await realpath(next);
    if (!inside(root, current)) throw new TypeError("Floor-plan candidate path escapes the workspace.");
  }
  return current;
}

async function readCandidateArtifact(directory, name, maximumBytes) {
  const filePath = path.join(directory, name);
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError("Candidate artifact '" + name + "' must be a regular, non-symlink file.");
  }
  if (entry.size <= 0 || entry.size > maximumBytes) {
    throw new RangeError("Candidate artifact '" + name + "' is empty or too large.");
  }
  const actual = await realpath(filePath);
  if (!inside(directory, actual)) {
    throw new TypeError("Candidate artifact '" + name + "' resolves outside its candidate directory.");
  }
  return readFile(actual);
}

async function writeExclusiveAtomically(directory, name, bytes) {
  const target = path.join(directory, name);
  const temporary = target + "." + randomUUID() + ".tmp";
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}

async function sourceForCandidate(workspaceRoot, candidate) {
  const sourceId = candidate.plan.source?.sourceId;
  if (!sourceId) throw new TypeError("Candidate geometry has no verified source ID.");
  const source = await loadVerifiedSource(workspaceRoot, candidate.buildingId, sourceId);
  if (source.sha256 !== candidate.report.input.verifiedSourceSha256 ||
      source.sha256 !== candidate.plan.source.sha256) {
    const error = new Error("The candidate's original uploaded source changed after generation.");
    error.code = "SOURCE_CHECKSUM_MISMATCH";
    throw error;
  }
  return source;
}

/** Read sanitized review/publication state without exposing private artifact paths. */
export async function getFloorPlanModelReviewStatus({ workspaceRoot, buildingId, candidateId }) {
  const bid = safeId(buildingId, "buildingId");
  const cid = safeId(candidateId, "candidateId");
  const root = await realpath(path.resolve(workspaceRoot));
  const candidate = await loadFloorPlanModelCandidate({ workspaceRoot: root, buildingId: bid, candidateId: cid });
  const directory = await candidateDirectory(root, bid, cid);
  let review = null;
  let attestationReady = false;
  let publication = null;
  let savedReview = null;

  try {
    const bytes = await readCandidateArtifact(directory, "review.json", 2 * 1024 * 1024);
    savedReview = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (savedReview !== null) {
    if (!isRecord(savedReview) || savedReview.schemaVersion !== "1.0.0" ||
        typeof savedReview.reviewId !== "string" || !savedReview.reviewId.startsWith("floorplan-review-") ||
        savedReview.candidateId !== cid || savedReview.buildingId !== bid ||
        !isRecord(savedReview.candidate) ||
        savedReview.candidate.modelSha256 !== candidate.modelSha256 ||
        savedReview.candidate.reportSha256 !== candidate.reportSha256 ||
        savedReview.candidate.geometrySha256 !== candidate.geometrySha256 ||
        savedReview.candidate.sourceSha256 !== candidate.report.input.verifiedSourceSha256) {
      throw new TypeError("Floor-plan review record does not match the current candidate.");
    }
    review = {
      reviewId: savedReview.reviewId,
      decision: savedReview.decision,
      reviewer: savedReview.reviewer,
      reviewedAt: savedReview.reviewedAt,
      notes: savedReview.notes,
      checks: savedReview.checks,
      candidateSha256: savedReview.candidate.modelSha256,
      mapReady: false,
      publicationEligible: false,
    };
    if (savedReview.decision === "approved") {
      const attestationBytes = await readCandidateArtifact(directory, "attestation.json", 2 * 1024 * 1024);
      const attestation = JSON.parse(attestationBytes.toString("utf8"));
      if (!isRecord(attestation) || attestation.schemaVersion !== "1.0.0" ||
          attestation.candidateSha256 !== candidate.modelSha256 ||
          attestation.model?.id !== savedReview.publication?.modelId ||
          attestation.model?.name !== savedReview.publication?.modelName ||
          attestation.review?.reviewer !== savedReview.reviewer ||
          attestation.review?.reviewedAt !== savedReview.reviewedAt ||
          attestation.review?.evidencePath !== savedReview.evidence?.path ||
          attestation.review?.evidenceSha256 !== savedReview.evidence?.sha256 ||
          REQUIRED_FLOOR_PLAN_REVIEW_CHECKS.some((key) => attestation.review?.checks?.[key] !== true)) {
        throw new TypeError("Floor-plan publication attestation does not match the approved review.");
      }
      attestationReady = true;
    }
  }

  try {
    const receiptBytes = await readCandidateArtifact(directory, "publication.json", 2 * 1024 * 1024);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    if (!review || review.decision !== "approved" ||
        receipt.candidateId !== cid || receipt.buildingId !== bid ||
        receipt.reviewId !== review.reviewId ||
        receipt.modelSha256 !== candidate.modelSha256 ||
        receipt.reportSha256 !== candidate.reportSha256 ||
        !isRecord(receipt.publication) ||
        typeof receipt.publication.versionId !== "string" ||
        receipt.publication.sha256 !== candidate.modelSha256) {
      throw new TypeError("Floor-plan publication receipt does not match the current approved candidate.");
    }
    publication = {
      modelId: receipt.publication.modelId,
      versionId: receipt.publication.versionId,
      assetUrl: receipt.publication.assetUrl,
      sha256: receipt.publication.sha256,
      publishedAt: receipt.publication.publishedAt,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  return {
    candidateId: cid,
    buildingId: bid,
    floorPlanId: candidate.plan.id,
    status: review?.decision ?? "pending-review",
    review,
    attestationReady,
    publication,
    mapReady: false,
    publicationEligible: false,
  };
}

function catalogAttestation({ record, candidate, publication }) {
  return {
    schemaVersion: "1.0.0",
    candidateSha256: candidate.modelSha256,
    model: {
      id: publication.modelId,
      name: publication.modelName,
      position: publication.position,
      headingDegrees: publication.headingDegrees,
      pitchDegrees: publication.pitchDegrees,
      rollDegrees: publication.rollDegrees,
      scale: publication.scale,
      upAxis: publication.upAxis,
      forwardAxis: publication.forwardAxis,
    },
    review: {
      reviewer: record.reviewer,
      reviewedAt: record.reviewedAt,
      evidenceId: record.reviewId,
      evidencePath: record.evidence.path,
      evidenceSha256: record.evidence.sha256,
      checks: Object.fromEntries([
        "rightsVerified",
        "sourceIdentityVerified",
        "architectureReviewed",
        "metricScaleVerified",
        "horizontalGeoreferenceVerified",
        "verticalDatumVerified",
        "qaReportReviewed",
      ].map((key) => [key, true])),
      notes: record.notes,
    },
  };
}

/**
 * Record one immutable human review for a private floor-plan candidate.
 * Approved reviews must have explicitly verified source rights and a placement
 * attestation; they produce a catalog-compatible attestation but never publish.
 */
export async function reviewFloorPlanModelCandidate({ workspaceRoot, buildingId, candidateId, input, now = new Date() }) {
  const bid = safeId(buildingId, "buildingId");
  const cid = safeId(candidateId, "candidateId");
  const parsed = validateReviewInput(input);
  const reviewedAt = new Date(now);
  if (!Number.isFinite(reviewedAt.getTime())) throw new TypeError("now must be a valid timestamp.");
  const timestamp = reviewedAt.toISOString();
  const root = await realpath(path.resolve(workspaceRoot));
  const candidate = await loadFloorPlanModelCandidate({ workspaceRoot: root, buildingId: bid, candidateId: cid });
  const source = await sourceForCandidate(root, candidate);
  const evidence = await resolveRegularWorkspaceFile(root, parsed.evidencePath, "Review evidence", MAX_EVIDENCE_BYTES);
  if (sha256(evidence.bytes) !== parsed.evidenceSha256) {
    const error = new Error("Review evidence SHA-256 does not match the actual evidence file.");
    error.code = "REVIEW_EVIDENCE_CHECKSUM_MISMATCH";
    throw error;
  }
  if (parsed.decision === "approved") {
    if (source.record.usageStatus !== "approved" || !knownLicence(source.record.licence)) {
      const error = new Error("Approve source rights through the existing source-review workflow before approving this candidate; the source record must be usageStatus=approved with a known licence.");
      error.code = "SOURCE_RIGHTS_NOT_APPROVED";
      throw error;
    }
    if (candidate.report.input.sourceUsageStatus !== "approved" ||
        candidate.report.input.sourceLicence !== source.record.licence) {
      const error = new Error("This candidate was created before source rights were approved. Rebuild the candidate after source review so its report captures the approved source metadata.");
      error.code = "CANDIDATE_SOURCE_REVIEW_STALE";
      throw error;
    }
  }

  const directory = await candidateDirectory(root, bid, cid);
  const lock = path.join(directory, "review.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      const conflict = new Error("A floor-plan review is already being recorded.");
      conflict.code = "REVIEW_IN_PROGRESS";
      throw conflict;
    }
    throw error;
  }

  try {
    for (const name of ["review.json", "attestation.json"]) {
      try {
        await lstat(path.join(directory, name));
        const conflict = new Error("Floor-plan candidate review is immutable; create a new candidate to replace it.");
        conflict.code = "REVIEW_ALREADY_RECORDED";
        throw conflict;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    const reviewId = "floorplan-review-" + randomUUID();
    const record = {
      schemaVersion: "1.0.0",
      reviewId,
      candidateId: cid,
      buildingId: bid,
      floorPlanId: candidate.plan.id,
      decision: parsed.decision,
      reviewer: parsed.reviewer,
      reviewedAt: timestamp,
      notes: parsed.notes,
      checks: parsed.checks,
      evidence: {
        path: parsed.evidencePath,
        sha256: parsed.evidenceSha256,
        bytes: evidence.bytes.byteLength,
      },
      candidate: {
        modelSha256: candidate.modelSha256,
        reportSha256: candidate.reportSha256,
        geometrySha256: candidate.geometrySha256,
        sourceSha256: source.sha256,
        sourceUsageStatus: source.record.usageStatus,
        sourceLicence: source.record.licence,
      },
      publication: parsed.publication,
      mapReady: false,
      publicationEligible: false,
      publicationAction: "not-performed",
    };
    const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
    const recordSha256 = sha256(recordBytes);
    const attestation = parsed.decision === "approved"
      ? catalogAttestation({ record, candidate, publication: parsed.publication })
      : null;

    try {
      if (attestation) {
        await writeExclusiveAtomically(directory, "attestation.json", Buffer.from(JSON.stringify(attestation, null, 2) + "\n", "utf8"));
      }
      await writeExclusiveAtomically(directory, "review.json", recordBytes);
    } catch (error) {
      await rm(path.join(directory, "attestation.json"), { force: true }).catch(() => {});
      await rm(path.join(directory, "review.json"), { force: true }).catch(() => {});
      throw error;
    }
    return {
      review: record,
      reviewSha256: recordSha256,
      attestationCreated: Boolean(attestation),
      mapReady: false,
      publicationEligible: false,
    };
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Publish only after an immutable approved review matches the current source,
 * geometry, report and model hashes. The existing catalog publisher rechecks
 * the attestation and evidence bytes and writes a versioned public GLB manifest.
 */
export async function publishReviewedFloorPlanModelCandidate({ workspaceRoot, buildingId, candidateId, publishedAt }) {
  const bid = safeId(buildingId, "buildingId");
  const cid = safeId(candidateId, "candidateId");
  const root = await realpath(path.resolve(workspaceRoot));
  const candidate = await loadFloorPlanModelCandidate({ workspaceRoot: root, buildingId: bid, candidateId: cid });
  const directory = await candidateDirectory(root, bid, cid);
  const reviewBytes = await readCandidateArtifact(directory, "review.json", 2 * 1024 * 1024);
  const review = JSON.parse(reviewBytes.toString("utf8"));
  const actualReviewHash = sha256(reviewBytes);
  if (!isRecord(review) || review.schemaVersion !== "1.0.0" ||
      typeof review.reviewId !== "string" || !review.reviewId.startsWith("floorplan-review-") ||
      review.candidateId !== cid || review.buildingId !== bid ||
      review.decision !== "approved" ||
      !isRecord(review.candidate) ||
      review.candidate.modelSha256 !== candidate.modelSha256 ||
      review.candidate.reportSha256 !== candidate.reportSha256 ||
      review.candidate.geometrySha256 !== candidate.geometrySha256 ||
      review.candidate.sourceSha256 !== candidate.report.input.verifiedSourceSha256) {
    const error = new Error("Floor-plan candidate does not have a current approved review record.");
    error.code = "REVIEW_NOT_APPROVED_OR_STALE";
    throw error;
  }

  const source = await sourceForCandidate(root, candidate);
  if (source.record.usageStatus !== "approved" || !knownLicence(source.record.licence) ||
      review.candidate.sourceUsageStatus !== source.record.usageStatus ||
      review.candidate.sourceLicence !== source.record.licence) {
    const error = new Error("Source rights status changed after review; refusing publication.");
    error.code = "SOURCE_RIGHTS_CHANGED";
    throw error;
  }
  for (const key of REQUIRED_FLOOR_PLAN_REVIEW_CHECKS) {
    if (review.checks?.[key] !== true) {
      const error = new Error("Approved review is missing required check " + key + ".");
      error.code = "REVIEW_CHECK_MISSING";
      throw error;
    }
  }

  const attestationBytes = await readCandidateArtifact(directory, "attestation.json", 2 * 1024 * 1024);
  const attestation = JSON.parse(attestationBytes.toString("utf8"));
  if (!isRecord(attestation) || attestation.schemaVersion !== "1.0.0" ||
      attestation.candidateSha256 !== candidate.modelSha256 ||
      attestation.model?.id !== review.publication?.modelId ||
      attestation.model?.name !== review.publication?.modelName ||
      attestation.review?.reviewer !== review.reviewer ||
      attestation.review?.reviewedAt !== review.reviewedAt ||
      attestation.review?.evidencePath !== review.evidence?.path ||
      attestation.review?.evidenceSha256 !== review.evidence?.sha256 ||
      REQUIRED_FLOOR_PLAN_REVIEW_CHECKS.some((key) => attestation.review?.checks?.[key] !== true) ||
      JSON.stringify(attestation.model?.position) !== JSON.stringify(review.publication?.position) ||
      attestation.model?.headingDegrees !== review.publication?.headingDegrees ||
      attestation.model?.pitchDegrees !== review.publication?.pitchDegrees ||
      attestation.model?.rollDegrees !== review.publication?.rollDegrees ||
      attestation.model?.scale !== review.publication?.scale ||
      attestation.model?.upAxis !== review.publication?.upAxis ||
      attestation.model?.forwardAxis !== review.publication?.forwardAxis ||
      attestation.review?.notes !== review.notes) {
    const error = new Error("Publication attestation does not match the approved review record.");
    error.code = "ATTESTATION_MISMATCH";
    throw error;
  }

  const publicationTimestamp = publishedAt ?? new Date().toISOString();
  const result = await publishReviewedBuildingModel({
    workspaceRoot: root,
    candidatePath: path.posix.join(".building-engine", "floor-plan-candidates", bid, cid, "model.glb"),
    attestationPath: path.posix.join(".building-engine", "floor-plan-candidates", bid, cid, "attestation.json"),
    publishedAt: publicationTimestamp,
  });
  const receipt = {
    schemaVersion: "1.0.0",
    candidateId: cid,
    buildingId: bid,
    floorPlanId: candidate.plan.id,
    reviewId: review.reviewId,
    reviewSha256: actualReviewHash,
    modelSha256: candidate.modelSha256,
    reportSha256: candidate.reportSha256,
    geometrySha256: candidate.geometrySha256,
    publication: {
      modelId: result.modelId,
      versionId: result.versionId,
      assetUrl: result.assetUrl,
      sha256: result.sha256,
      publishedAt: publicationTimestamp,
    },
    mapReady: false,
    publicationEligible: false,
  };
  const receiptPath = path.join(directory, "publication.json");
  try {
    const previous = JSON.parse(await readFile(receiptPath, "utf8"));
    if (previous.reviewSha256 !== actualReviewHash ||
        previous.modelSha256 !== candidate.modelSha256 ||
        previous.publication?.versionId !== result.versionId) {
      const error = new Error("Existing publication receipt does not match this approved version.");
      error.code = "PUBLICATION_RECEIPT_MISMATCH";
      throw error;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeExclusiveAtomically(directory, "publication.json", Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8"));
  }
  return {
    ...result,
    candidateId: cid,
    reviewId: review.reviewId,
    reviewSha256: actualReviewHash,
    mapReady: false,
    publicationEligible: false,
  };
}
