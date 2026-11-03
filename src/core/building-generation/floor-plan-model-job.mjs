import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { loadVerifiedSource } from "./source-workflow.mjs";
import { normalizeSourceOperationScopes } from "./source-operation-scopes.mjs";
import { generateFloorPlanGlb } from "./floor-plan-model.mjs";
import { canonicalFloorPlanReviewJson } from "./floor-plan-review-payload.mjs";
import {
  calibrateFloorPlanRasterVectors,
  hashFloorPlanRasterProposalReport,
} from "./floor-plan-raster-vector-calibration.mjs";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}

function canonicalSha256(value) {
  return sha256(Buffer.from(canonicalFloorPlanReviewJson(value), "utf8"));
}

function canonicalJsonBytes(value) {
  return Buffer.from(canonicalFloorPlanReviewJson(value), "utf8");
}

function safeId(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

function assertApiGeometryBudget(floorPlan) {
  if (!Array.isArray(floorPlan.rooms) || floorPlan.rooms.length > 100) {
    throw new RangeError("API floor plans may contain at most 100 rooms.");
  }
  if (!Array.isArray(floorPlan.walls) || floorPlan.walls.length > 500) {
    throw new RangeError("API floor plans may contain at most 500 walls.");
  }
  let vertexCount = 0;
  for (const room of floorPlan.rooms) {
    if (!room || !Array.isArray(room.polygon) || room.polygon.length > 64) {
      throw new RangeError("Each API room polygon may contain at most 64 vertices.");
    }
    vertexCount += room.polygon.length;
  }
  if (vertexCount > 4000) throw new RangeError("API floor plans may contain at most 4000 room vertices in total.");
  let openingCount = 0;
  for (const wall of floorPlan.walls) {
    if (!wall || !Array.isArray(wall.openings)) {
      throw new TypeError("Every API wall must provide an openings array.");
    }
    openingCount += wall.openings.length;
  }
  if (openingCount > 1000) throw new RangeError("API floor plans may contain at most 1000 openings.");
}

async function ensurePrivateDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Refusing an unsafe floor-plan candidate directory.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (createError) {
        if (createError?.code !== "EEXIST") throw createError;
      }
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Floor-plan candidate directory must be a real, private directory.");
      }
    }
    const actual = await realpath(current);
    if (!inside(root, actual)) {
      throw new TypeError("Floor-plan candidate directory resolves outside workspaceRoot.");
    }
    current = actual;
  }
  return current;
}

async function writeAtomically(filePath, bytes) {
  const temporaryPath = filePath + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Create a private review candidate from a measured vector trace whose original
 * source was already ingested through the protected media-intake pipeline.
 * This does not publish the result or assert that its geometry is accurate.
 */
export async function createFloorPlanModelCandidate({ workspaceRoot, floorPlan, calibrationEvidence = undefined, traceEvidence = undefined }) {
  if (!floorPlan || typeof floorPlan !== "object" || Array.isArray(floorPlan)) {
    throw new TypeError("floorPlan must be a JSON object.");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const buildingId = safeId(floorPlan.buildingId, "floorPlan.buildingId");
  const source = floorPlan.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("API floor-plan generation requires source.sourceId and source.sha256 from an uploaded source.");
  }
  const sourceId = safeId(source.sourceId, "source.sourceId");
  if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.sha256)) {
    throw new TypeError("source.sha256 must be a 64-character SHA-256 hash.");
  }

  assertApiGeometryBudget(floorPlan);
  const loadedSource = await loadVerifiedSource(root, buildingId, sourceId);
  if (loadedSource.record.kind !== "floor-plan") {
    const error = new Error("The referenced source must have been uploaded with kind=floor-plan.");
    error.code = "SOURCE_KIND_MISMATCH";
    throw error;
  }
  if (loadedSource.sha256 !== source.sha256.toLowerCase()) {
    const error = new Error("The supplied source SHA-256 does not match the verified uploaded source bytes.");
    error.code = "SOURCE_CHECKSUM_MISMATCH";
    throw error;
  }

  let calibrationResult = null;
  let calibrationSidecars = null;
  if (calibrationEvidence !== undefined) {
    if (!calibrationEvidence || typeof calibrationEvidence !== "object" || Array.isArray(calibrationEvidence) ||
        !calibrationEvidence.proposalReport || typeof calibrationEvidence.proposalReport !== "object" ||
        Array.isArray(calibrationEvidence.proposalReport) ||
        !calibrationEvidence.review || typeof calibrationEvidence.review !== "object" ||
        Array.isArray(calibrationEvidence.review)) {
      throw new TypeError("calibrationEvidence must contain the original proposalReport and completed review objects.");
    }
    const sourceBytes = await readFile(loadedSource.assetPath);
    if (sourceBytes.length !== loadedSource.bytes || sha256(sourceBytes) !== loadedSource.sha256) {
      const error = new Error("Uploaded floor-plan source bytes changed while the calibration candidate was being prepared.");
      error.code = "SOURCE_CHECKSUM_MISMATCH";
      throw error;
    }
    try {
      calibrationResult = calibrateFloorPlanRasterVectors({
        proposalReport: calibrationEvidence.proposalReport,
        review: calibrationEvidence.review,
        sourceBytes,
      });
    } catch (cause) {
      const error = new Error("Calibration evidence could not be independently revalidated against the uploaded source bytes.");
      error.code = "CALIBRATION_EVIDENCE_INVALID";
      error.cause = cause;
      throw error;
    }
    if (canonicalFloorPlanReviewJson(calibrationResult.floorPlan) !== canonicalFloorPlanReviewJson(floorPlan)) {
      const error = new Error("Submitted floorPlan does not exactly match the vectors recomputed from its source-bound proposal and review.");
      error.code = "CALIBRATED_GEOMETRY_MISMATCH";
      throw error;
    }
    calibrationSidecars = {
      proposalReport: canonicalJsonBytes(calibrationEvidence.proposalReport),
      review: canonicalJsonBytes(calibrationEvidence.review),
      audit: jsonBytes(calibrationResult.audit),
    };
    const sidecarLimits = { proposalReport: 10, review: 5, audit: 20 };
    for (const [key, bytes] of Object.entries(calibrationSidecars)) {
      if (bytes.length < 1 || bytes.length > sidecarLimits[key] * 1024 * 1024) {
        throw new RangeError("Calibration evidence sidecar exceeds the supported " + key + " size limit.");
      }
    }
  }

  const generated = generateFloorPlanGlb(floorPlan);
  if (calibrationResult && generated.report.output.sha256 !== calibrationResult.audit.vector.generatedPreviewGlbSha256) {
    const error = new Error("Persisted candidate GLB does not match the independently recomputed calibration preview.");
    error.code = "CALIBRATED_MODEL_MISMATCH";
    throw error;
  }
  const normalizedPlanBytes = Buffer.from(JSON.stringify(generated.plan, null, 2) + "\n", "utf8");
  const geometrySha256 = sha256(normalizedPlanBytes);
  generated.report.input.sourceEvidenceVerified = true;
  generated.report.input.verifiedSourceSha256 = loadedSource.sha256;
  generated.report.input.sourceUsageStatus = loadedSource.record.usageStatus ?? "unreviewed";
  generated.report.input.sourceLicence = loadedSource.record.licence ?? "unknown";
  generated.report.input.sourcePermittedOperations = loadedSource.record.permittedOperations === undefined
    ? []
    : normalizeSourceOperationScopes(loadedSource.record.permittedOperations, "source " + sourceId + " permittedOperations");
  generated.report.input.normalizedGeometrySha256 = geometrySha256;
  generated.report.warnings = generated.report.warnings.filter(
    (warning) => !warning.startsWith("A source SHA-256 is metadata"),
  );
  generated.report.warnings.push(
    "The original uploaded source bytes were verified against the private media-intake record; this does not verify the vector trace, measurements, reuse rights, or geospatial accuracy.",
  );
  if (loadedSource.record.usageStatus !== "approved" ||
      !loadedSource.record.licence ||
      ["unknown", "n/a", "none"].includes(String(loadedSource.record.licence).trim().toLowerCase())) {
    generated.report.warnings.push(
      "Source reuse rights are not marked approved in media intake; resolve permission and attribution before sharing or publishing this candidate.",
    );
  }

  let traceReviewBytes;
  let traceReviewSha256;
  if (traceEvidence !== undefined) {
    if (!traceEvidence || typeof traceEvidence !== "object" || Array.isArray(traceEvidence) ||
        typeof traceEvidence.traceId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(traceEvidence.traceId) ||
        typeof traceEvidence.traceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(traceEvidence.traceSha256) ||
        !traceEvidence.transformation || typeof traceEvidence.transformation !== "object" ||
        Array.isArray(traceEvidence.transformation)) {
      throw new TypeError("traceEvidence must contain a trace ID, trace SHA-256 and reviewed transformation record.");
    }
    const transformation = traceEvidence.transformation;
    if (transformation.traceId !== traceEvidence.traceId ||
        transformation.traceSha256 !== traceEvidence.traceSha256.toLowerCase() ||
        transformation.sourceSha256 !== loadedSource.sha256 ||
        transformation.status !== "measured-draft-needs-independent-QA" ||
        !Array.isArray(transformation.confirmedLineIds) ||
        !Array.isArray(transformation.confirmedRoomIds)) {
      throw new TypeError("traceEvidence does not match this source and measured transformation.");
    }
    traceReviewBytes = Buffer.from(JSON.stringify(transformation, null, 2) + "\n", "utf8");
    traceReviewSha256 = sha256(traceReviewBytes);
    generated.report.input.rasterTrace = {
      traceId: traceEvidence.traceId,
      traceSha256: traceEvidence.traceSha256.toLowerCase(),
      transformationSha256: traceReviewSha256,
      method: transformation.method,
      confirmedLineCount: transformation.confirmedLineIds.length,
      confirmedRoomCount: transformation.confirmedRoomIds.length,
      metresPerSourcePixel: transformation.calibration?.metresPerSourcePixel,
      reviewStatus: transformation.status,
    };
    generated.report.warnings.push(
      "The raster trace and selected pixel-space candidates were operator-confirmed and calibrated; independent architectural, metric-scale and geospatial QA is still required before approval.",
    );
  }

  let calibrationBinding = null;
  if (calibrationResult && calibrationSidecars) {
    calibrationBinding = {
      schemaVersion: "1.0.0",
      engine: "floor-plan-raster-vector-calibration-v1",
      sourceId,
      sourceSha256: loadedSource.sha256,
      proposalReportCanonicalSha256: hashFloorPlanRasterProposalReport(calibrationEvidence.proposalReport),
      reviewCanonicalSha256: canonicalSha256(calibrationEvidence.review),
      floorPlanCanonicalSha256: canonicalSha256(calibrationResult.floorPlan),
      previewGlbSha256: calibrationResult.audit.vector.generatedPreviewGlbSha256,
      artifacts: {
        proposalReport: { file: "proposal-report.json", sha256: sha256(calibrationSidecars.proposalReport), bytes: calibrationSidecars.proposalReport.length },
        review: { file: "floor-plan-review.json", sha256: sha256(calibrationSidecars.review), bytes: calibrationSidecars.review.length },
        audit: { file: "calibration-audit.json", sha256: sha256(calibrationSidecars.audit), bytes: calibrationSidecars.audit.length },
      },
    };
    generated.report.input.calibrationEvidence = calibrationBinding;
    generated.report.input.calibrationEvidenceRevalidated = true;
  }

  const candidateId = "floorplan-" + randomUUID();
  const buildingDirectory = await ensurePrivateDirectory(
    root,
    [".building-engine", "floor-plan-candidates", buildingId],
  );
  const candidateDirectory = path.join(buildingDirectory, candidateId);
  await mkdir(candidateDirectory, { recursive: false, mode: 0o700 });
  const directoryEntry = await lstat(candidateDirectory);
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
    throw new TypeError("Candidate output must be stored in a private regular directory.");
  }
  const realCandidateDirectory = await realpath(candidateDirectory);
  if (!inside(buildingDirectory, realCandidateDirectory)) {
    throw new TypeError("Candidate output directory resolves outside its private building directory.");
  }

  const reportBytes = Buffer.from(JSON.stringify(generated.report, null, 2) + "\n", "utf8");
  try {
    await writeAtomically(path.join(realCandidateDirectory, "floor-plan.json"), normalizedPlanBytes);
    await writeAtomically(path.join(realCandidateDirectory, "model.glb"), generated.glb);
    await writeAtomically(path.join(realCandidateDirectory, "report.json"), reportBytes);
    if (calibrationSidecars) {
      await writeAtomically(path.join(realCandidateDirectory, "proposal-report.json"), calibrationSidecars.proposalReport);
      await writeAtomically(path.join(realCandidateDirectory, "floor-plan-review.json"), calibrationSidecars.review);
      await writeAtomically(path.join(realCandidateDirectory, "calibration-audit.json"), calibrationSidecars.audit);
    }
    if (traceReviewBytes) {
      await writeAtomically(path.join(realCandidateDirectory, "trace-review.json"), traceReviewBytes);
    }
  } catch (error) {
    await rm(realCandidateDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    candidateId,
    buildingId,
    floorPlanId: generated.plan.id,
    sourceId,
    status: generated.report.status,
    modelSha256: generated.report.output.sha256,
    modelBytes: generated.report.output.byteSize,
    geometrySha256,
    sourceSha256: loadedSource.sha256,
    sourceUsageStatus: generated.report.input.sourceUsageStatus,
    sourcePermittedOperations: generated.report.input.sourcePermittedOperations,
    traceReviewSha256: traceReviewSha256 ?? null,
    ...(calibrationBinding ? {
      calibrationEvidenceVerified: true,
      calibrationAuditSha256: calibrationBinding.artifacts.audit.sha256,
    } : {}),
    candidateUrl: "/api/building-generation/floor-plan-models/" + buildingId + "/" + candidateId,
    modelUrl: "/api/building-generation/floor-plan-models/" + buildingId + "/" + candidateId + "/model",
    mapReady: false,
    publicationEligible: false,
    report: generated.report,
  };
}

async function resolveCandidateDirectory(root, buildingId, candidateId) {
  let current = root;
  for (const segment of [".building-engine", "floor-plan-candidates", buildingId, candidateId]) {
    const next = path.join(current, segment);
    const entry = await lstat(next);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError("Floor-plan candidate path must contain only regular directories.");
    }
    const actual = await realpath(next);
    if (!inside(root, actual)) throw new TypeError("Floor-plan candidate resolves outside workspaceRoot.");
    current = actual;
  }
  return current;
}

async function readCandidateFile(candidateDirectory, name, maximumBytes) {
  const filePath = path.join(candidateDirectory, name);
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError("Floor-plan candidate artifact must be a regular file.");
  }
  if (entry.size <= 0 || entry.size > maximumBytes) {
    throw new RangeError("Floor-plan candidate artifact size is invalid.");
  }
  const actual = await realpath(filePath);
  if (!inside(candidateDirectory, actual)) {
    throw new TypeError("Floor-plan candidate artifact resolves outside its candidate directory.");
  }
  return readFile(actual);
}

/** Load a private candidate and verify its GLB bytes against the saved report before serving it. */
export async function loadFloorPlanModelCandidate({ workspaceRoot, buildingId, candidateId }) {
  const root = await realpath(path.resolve(workspaceRoot));
  const bid = safeId(buildingId, "buildingId");
  const cid = safeId(candidateId, "candidateId");
  const directory = await resolveCandidateDirectory(root, bid, cid);
  const reportBytes = await readCandidateFile(directory, "report.json", 2 * 1024 * 1024);
  const report = JSON.parse(reportBytes.toString("utf8"));
  if (!report || typeof report !== "object" ||
      report.input?.buildingId !== bid ||
      report.input?.floorPlanId === undefined ||
      report.output?.format !== "glb" ||
      typeof report.output?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(report.output.sha256) ||
      typeof report.input?.verifiedSourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(report.input.verifiedSourceSha256) ||
      typeof report.input?.normalizedGeometrySha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(report.input.normalizedGeometrySha256)) {
    throw new TypeError("Floor-plan candidate report is invalid.");
  }
  const planBytes = await readCandidateFile(directory, "floor-plan.json", 2 * 1024 * 1024);
  const plan = JSON.parse(planBytes.toString("utf8"));
  if (!plan || typeof plan !== "object" || plan.id !== report.input.floorPlanId ||
      plan.buildingId !== bid || plan.evidence?.sha256 !== report.input.verifiedSourceSha256 ||
      sha256(planBytes) !== report.input.normalizedGeometrySha256) {
    throw new TypeError("Floor-plan candidate geometry checksum or identity does not match its report.");
  }
  let traceReview = null;
  if (report.input.rasterTrace !== undefined) {
    const evidence = report.input.rasterTrace;
    if (!evidence || typeof evidence !== "object" ||
        typeof evidence.traceId !== "string" ||
        typeof evidence.traceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.traceSha256) ||
        typeof evidence.transformationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.transformationSha256)) {
      throw new TypeError("Floor-plan raster trace metadata in candidate report is invalid.");
    }
    const evidenceBytes = await readCandidateFile(directory, "trace-review.json", 2 * 1024 * 1024);
    if (sha256(evidenceBytes) !== evidence.transformationSha256) {
      const error = new Error("Stored raster trace transformation checksum does not match its report.");
      error.code = "TRACE_CHECKSUM_MISMATCH";
      throw error;
    }
    traceReview = JSON.parse(evidenceBytes.toString("utf8"));
    if (!traceReview || traceReview.traceId !== evidence.traceId ||
        traceReview.traceSha256 !== evidence.traceSha256 ||
        traceReview.sourceSha256 !== report.input.verifiedSourceSha256 ||
        traceReview.status !== "measured-draft-needs-independent-QA") {
      throw new TypeError("Stored raster trace transformation identity does not match its report.");
    }
  }
  const modelBytes = await readCandidateFile(directory, "model.glb", 200 * 1024 * 1024);
  const actualSha256 = sha256(modelBytes);
  if (actualSha256 !== report.output.sha256) {
    const error = new Error("Stored floor-plan candidate GLB checksum does not match its report.");
    error.code = "CANDIDATE_CHECKSUM_MISMATCH";
    throw error;
  }
  let calibrationEvidenceVerified = false;
  const calibrationBinding = report.input.calibrationEvidence;
  if (report.input.calibrationEvidenceRevalidated === true && calibrationBinding === undefined) {
    throw new TypeError("Floor-plan candidate report claims revalidated calibration evidence but has no provenance binding.");
  }
  if (calibrationBinding !== undefined) {
    const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (!calibrationBinding || typeof calibrationBinding !== "object" ||
        calibrationBinding.schemaVersion !== "1.0.0" ||
        calibrationBinding.engine !== "floor-plan-raster-vector-calibration-v1" ||
        typeof calibrationBinding.sourceId !== "string" ||
        !validHash(calibrationBinding.sourceSha256) ||
        !validHash(calibrationBinding.proposalReportCanonicalSha256) ||
        !validHash(calibrationBinding.reviewCanonicalSha256) ||
        !validHash(calibrationBinding.floorPlanCanonicalSha256) ||
        !validHash(calibrationBinding.previewGlbSha256) ||
        !calibrationBinding.artifacts || typeof calibrationBinding.artifacts !== "object" ||
        report.input.calibrationEvidenceRevalidated !== true ||
        report.input.verifiedSourceSha256 !== calibrationBinding.sourceSha256 ||
        plan.evidence?.sourceId !== calibrationBinding.sourceId) {
      throw new TypeError("Floor-plan calibration provenance metadata is invalid.");
    }
    const artifactSpecs = [
      ["proposalReport", "proposal-report.json", 10 * 1024 * 1024],
      ["review", "floor-plan-review.json", 5 * 1024 * 1024],
      ["audit", "calibration-audit.json", 20 * 1024 * 1024],
    ];
    const artifactBytes = {};
    for (const [key, filename, maximumBytes] of artifactSpecs) {
      const metadata = calibrationBinding.artifacts[key];
      if (!metadata || metadata.file !== filename ||
          !validHash(metadata.sha256) || !Number.isSafeInteger(metadata.bytes) ||
          metadata.bytes < 1 || metadata.bytes > maximumBytes) {
        throw new TypeError("Floor-plan calibration artifact metadata is invalid: " + key + ".");
      }
      const bytes = await readCandidateFile(directory, filename, maximumBytes);
      if (bytes.length !== metadata.bytes || sha256(bytes) !== metadata.sha256) {
        const error = new Error("Stored calibration artifact checksum does not match its candidate report: " + key + ".");
        error.code = "CALIBRATION_ARTIFACT_CHECKSUM_MISMATCH";
        throw error;
      }
      artifactBytes[key] = bytes;
    }
    const proposalReport = JSON.parse(artifactBytes.proposalReport.toString("utf8"));
    const review = JSON.parse(artifactBytes.review.toString("utf8"));
    const savedAudit = JSON.parse(artifactBytes.audit.toString("utf8"));
    if (hashFloorPlanRasterProposalReport(proposalReport) !== calibrationBinding.proposalReportCanonicalSha256 ||
        canonicalSha256(review) !== calibrationBinding.reviewCanonicalSha256) {
      throw new TypeError("Stored floor-plan proposal or review canonical digest does not match its candidate report.");
    }
    const loadedCalibrationSource = await loadVerifiedSource(root, bid, calibrationBinding.sourceId);
    if (loadedCalibrationSource.record.kind !== "floor-plan" || loadedCalibrationSource.sha256 !== calibrationBinding.sourceSha256) {
      throw new TypeError("The source record for this calibrated floor-plan candidate has changed.");
    }
    const sourceBytes = await readFile(loadedCalibrationSource.assetPath);
    if (sourceBytes.length !== loadedCalibrationSource.bytes || sha256(sourceBytes) !== calibrationBinding.sourceSha256) {
      throw new TypeError("The original source bytes for this calibrated floor-plan candidate have changed.");
    }
    const recalibrated = calibrateFloorPlanRasterVectors({ proposalReport, review, sourceBytes });
    const regenerated = generateFloorPlanGlb(recalibrated.floorPlan);
    if (canonicalSha256(recalibrated.floorPlan) !== calibrationBinding.floorPlanCanonicalSha256 ||
        canonicalSha256(regenerated.plan) !== canonicalSha256(plan) ||
        regenerated.report.output.sha256 !== calibrationBinding.previewGlbSha256 ||
        regenerated.report.output.sha256 !== actualSha256 ||
        sha256(jsonBytes(recalibrated.audit)) !== calibrationBinding.artifacts.audit.sha256 ||
        canonicalSha256(savedAudit) !== canonicalSha256(recalibrated.audit)) {
      const error = new Error("Recomputed calibration, source review, stored geometry and candidate GLB no longer match.");
      error.code = "CALIBRATION_LINEAGE_MISMATCH";
      throw error;
    }
    calibrationEvidenceVerified = true;
  }

  return {
    candidateId: cid,
    buildingId: bid,
    plan,
    report,
    traceReview,
    ...(calibrationEvidenceVerified ? { calibrationEvidenceVerified: true } : {}),
    reportSha256: sha256(reportBytes),
    geometrySha256: report.input.normalizedGeometrySha256,
    modelBytes,
    modelSha256: actualSha256,
    mapReady: false,
    publicationEligible: false,
  };
}
