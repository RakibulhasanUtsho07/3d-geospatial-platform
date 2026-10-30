import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS,
  MEDIA_TO_MODEL_STAGE_IDS,
  completeReconstructionStage,
  createOrResumeReconstructionJob,
  fingerprintStageInput,
  readReconstructionJob,
  startReconstructionStage,
  validateStageArtifact,
  failReconstructionStage,
} from "./reconstruction-job-state.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const CONTRACT_VERSION = "1.0.0";
const FALSE_POLICY_FLAGS = [
  "groundTruth",
  "acceptanceEligible",
  "publicationEligible",
  "publishable",
  "mapReady",
  "automaticApproval",
];
const MAX_VISUAL_BUNDLE_BYTES = 40 * 1024 * 1024;
const MAX_RECONSTRUCTION_EVIDENCE_BYTES = 20 * 1024 * 1024;
const MAX_CANDIDATE_GLB_BYTES = 256 * 1024 * 1024;
const MAX_QA_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_JOB_ARTIFACT_BYTES = 20 * 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier of at most 80 characters.");
  }
  return value;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a workspace-relative POSIX path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(label + " contains an unsafe path segment.");
  }
  return segments.join("/");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

async function assertNoSymlinkSegments(root, relativePath, label) {
  let current = root;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new TypeError(label + " path must not traverse symlink: " + segments[index]);
    }
    if (index < segments.length - 1 && !entry.isDirectory()) {
      throw new TypeError(label + " path parent must be a real directory.");
    }
  }
  return current;
}

async function readWorkspaceFile(root, relativePath, label, maximumBytes) {
  const safePath = safeRelativePath(relativePath, label + " path");
  const target = path.resolve(root, ...safePath.split("/"));
  if (!inside(root, target)) throw new TypeError(label + " path escapes workspaceRoot.");
  await assertNoSymlinkSegments(root, safePath, label);
  const entry = await lstat(target);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError(label + " must be a regular non-symlink file.");
  }
  const actual = await realpath(target);
  if (!inside(root, actual)) throw new TypeError(label + " resolves outside workspaceRoot.");
  if (entry.size < 1 || entry.size > maximumBytes) {
    throw new RangeError(label + " is empty or exceeds the configured byte limit.");
  }
  const bytes = await readFile(actual);
  if (bytes.length !== entry.size || bytes.length < 1 || bytes.length > maximumBytes) {
    throw new TypeError(label + " changed while it was being read or exceeds its byte limit.");
  }
  return { path: safePath, bytes, sha256: sha256(bytes), byteLength: bytes.length };
}

async function readJobArtifact(jobDirectory, record, label) {
  if (!isObject(record) || typeof record.path !== "string" || !HASH.test(record.contentSha256 ?? "")) {
    throw new TypeError(label + " stage artifact record is invalid.");
  }
  const relative = safeRelativePath(record.path, label + " artifact");
  const target = path.resolve(jobDirectory, ...relative.split("/"));
  if (!inside(jobDirectory, target)) throw new TypeError(label + " stage artifact escapes the job directory.");
  await assertNoSymlinkSegments(jobDirectory, relative, label + " stage artifact");
  const entry = await lstat(target);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size < 1 || entry.size > MAX_JOB_ARTIFACT_BYTES) {
    throw new TypeError(label + " stage artifact must be a bounded regular file.");
  }
  const actual = await realpath(target);
  if (!inside(jobDirectory, actual)) throw new TypeError(label + " stage artifact resolves outside the job directory.");
  const bytes = await readFile(actual);
  if (bytes.length !== entry.size || bytes.length < 1 || bytes.length > MAX_JOB_ARTIFACT_BYTES) {
    throw new TypeError(label + " stage artifact changed while it was being read or exceeds its byte limit.");
  }
  let artifact;
  try {
    artifact = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(label + " stage artifact is not valid JSON.");
  }
  try {
    validateStageArtifact(artifact);
  } catch (error) {
    throw new TypeError(label + " stage artifact failed checksum/schema validation: " + error.message);
  }
  if (artifact.stageId === undefined ||
      artifact.contentSha256 !== record.contentSha256 ||
      artifact.inputFingerprint !== record.inputFingerprint ||
      artifact.revision !== record.revision) {
    throw new TypeError(label + " stage artifact does not match its immutable record.");
  }
  return artifact;
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!isObject(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new TypeError(label + " must contain a valid JSON object.");
  }
}

function requireFalsePolicy(policy, label) {
  if (!isObject(policy) || FALSE_POLICY_FLAGS.some((key) => policy[key] !== false)) {
    throw new TypeError(label + " must explicitly keep every truth and release flag false.");
  }
}

function inspectGlb2(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 ||
      bytes.readUInt32LE(0) !== 0x46546c67 ||
      bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length) {
    throw new TypeError("candidate must be a structurally valid GLB 2.0 container with an exact declared length.");
  }

  let offset = 12;
  let jsonChunkCount = 0;
  let binaryChunkCount = 0;
  let json = null;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new TypeError("candidate GLB has a truncated chunk header.");
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length < 1 || length % 4 !== 0 || offset + length > bytes.length) {
      throw new TypeError("candidate GLB contains an invalid or truncated chunk.");
    }
    if (jsonChunkCount === 0 && type !== 0x4e4f534a) {
      throw new TypeError("candidate GLB must begin with its JSON chunk.");
    }
    if (type === 0x4e4f534a) {
      jsonChunkCount += 1;
      if (jsonChunkCount !== 1) throw new TypeError("candidate GLB must contain exactly one JSON chunk.");
      try {
        json = JSON.parse(bytes.subarray(offset, offset + length).toString("utf8").trim());
      } catch {
        throw new TypeError("candidate GLB JSON chunk is invalid.");
      }
    } else if (type === 0x004e4942) {
      binaryChunkCount += 1;
      if (binaryChunkCount > 1) throw new TypeError("candidate GLB contains duplicate BIN chunks.");
    } else {
      throw new TypeError("candidate GLB contains an unsupported chunk type.");
    }
    offset += length;
  }
  if (offset !== bytes.length || jsonChunkCount !== 1 ||
      !isObject(json?.asset) || json.asset.version !== "2.0") {
    throw new TypeError("candidate GLB chunk layout or asset.version is invalid.");
  }
  return {
    format: "glTF",
    version: "2.0",
    jsonChunkCount,
    binaryChunkCount,
    declaredByteLength: bytes.length,
    meshCount: Array.isArray(json.meshes) ? json.meshes.length : 0,
    nodeCount: Array.isArray(json.nodes) ? json.nodes.length : 0,
    geometryAccuracyEvaluated: false,
  };
}

function activeStageRecord(job, stageId) {
  const stage = job.stages.find((item) => item.id === stageId);
  if (!stage || stage.status !== "completed" || !stage.activeArtifactId) {
    throw new TypeError("source reconstruction job must have a completed active " + stageId + " artifact.");
  }
  const record = stage.artifacts.find((item) => item.artifactId === stage.activeArtifactId);
  if (!record) throw new TypeError("source reconstruction job is missing the active " + stageId + " artifact record.");
  return { stage, record };
}

function isoTimestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid timestamp.");
  return date.toISOString();
}

async function completeStage({
  workspaceRoot,
  buildingId,
  jobId,
  stageId,
  inputFingerprint,
  payload,
  outputs,
  now,
}) {
  const started = await startReconstructionStage({
    workspaceRoot,
    buildingId,
    jobId,
    stageId,
    inputFingerprint,
    now,
  });
  if (started.reused) return { artifact: started.artifact, artifactRecord: started.job.stages.find((item) => item.id === stageId).artifacts.find((item) => item.artifactId === started.job.stages.find((item) => item.id === stageId).activeArtifactId), reused: true };
  try {
    const result = await completeReconstructionStage({
      workspaceRoot,
      buildingId,
      jobId,
      stageId,
      payload,
      outputs,
      now,
    });
    return { ...result, reused: false };
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
 * Prepare a review-only hand-off from a completed media-to-model job.
 *
 * The source job must already contain an immutable model-generation artifact
 * and report-finalization artifact. Candidate GLB bytes are read and hashed
 * after generation; the supplied D3M-01.B evidence bundle must bind that exact
 * candidate hash. The output is a separate immutable two-stage reconstruction
 * job linked to the original job/artifacts. It never dispatches a worker or
 * changes model publication/readiness flags.
 */
export async function prepareSourceBoundReconstructionHandoff(input = {}) {
  if (!isObject(input)) throw new TypeError("handoff input must be an object.");
  const workspaceRoot = await realpath(path.resolve(input.workspaceRoot ?? ""));
  const buildingId = safeId(input.buildingId, "buildingId");
  const sourceJobId = safeId(input.sourceJobId, "sourceJobId");
  const now = isoTimestamp(input.now);

  const sourceJobResult = await readReconstructionJob({
    workspaceRoot,
    buildingId,
    jobId: sourceJobId,
    recoverInterrupted: false,
    now,
  });
  const sourceJob = sourceJobResult.job;
  if (sourceJob.status !== "completed" ||
      JSON.stringify(sourceJob.stageIds) !== JSON.stringify(MEDIA_TO_MODEL_STAGE_IDS)) {
    throw new TypeError("source job must be a completed media-to-model workflow using the supported stage profile.");
  }

  const modelStageRef = activeStageRecord(sourceJob, "model-generation");
  const reportStageRef = activeStageRecord(sourceJob, "report-finalization");
  const modelArtifact = await readJobArtifact(sourceJobResult.jobDirectory, modelStageRef.record, "model-generation");
  const reportArtifact = await readJobArtifact(sourceJobResult.jobDirectory, reportStageRef.record, "report-finalization");

  if (modelArtifact.buildingId !== buildingId || modelArtifact.jobId !== sourceJobId ||
      reportArtifact.buildingId !== buildingId || reportArtifact.jobId !== sourceJobId) {
    throw new TypeError("source stage artifacts do not match the requested building and job identity.");
  }

  const visualFile = await readWorkspaceFile(
    workspaceRoot, input.visualBundlePath, "visual evidence bundle", MAX_VISUAL_BUNDLE_BYTES,
  );
  const evidenceFile = await readWorkspaceFile(
    workspaceRoot, input.reconstructionEvidencePath, "reconstruction evidence bundle", MAX_RECONSTRUCTION_EVIDENCE_BYTES,
  );
  const candidateFile = await readWorkspaceFile(
    workspaceRoot, input.candidateGlbPath, "candidate GLB", MAX_CANDIDATE_GLB_BYTES,
  );
  const reportFile = await readWorkspaceFile(
    workspaceRoot, input.qaReportPath, "QA report", MAX_QA_REPORT_BYTES,
  );

  const visual = parseJson(visualFile.bytes, "visual evidence bundle");
  const evidence = parseJson(evidenceFile.bytes, "reconstruction evidence bundle");
  const qaReport = parseJson(reportFile.bytes, "QA report");
  const glbStructure = inspectGlb2(candidateFile.bytes);

  if (visual.schemaVersion !== "1.0.0" ||
      visual.bundleType !== "source-bound-visual-evidence" ||
      !SAFE_ID.test(visual.buildingId ?? "") ||
      visual.buildingId !== buildingId ||
      !isObject(visual.source) ||
      !SAFE_ID.test(visual.source.id ?? "") ||
      !HASH.test(visual.source.sha256 ?? "")) {
    throw new TypeError("visual evidence bundle identity is invalid or does not match the requested building.");
  }
  requireFalsePolicy(visual.policy, "visual evidence bundle policy");

  if (evidence.schemaVersion !== "1.0.0" ||
      evidence.bundleType !== "source-bound-reconstruction-evidence" ||
      evidence.buildingId !== buildingId ||
      evidence.visualBundle?.bundleId !== visual.bundleId ||
      evidence.visualBundle?.sha256 !== visualFile.sha256 ||
      evidence.visualBundle?.sourceId !== visual.source.id ||
      evidence.visualBundle?.sourceSha256 !== visual.source.sha256 ||
      evidence.candidateGlbSha256?.toLowerCase() !== candidateFile.sha256) {
    throw new TypeError("reconstruction evidence bundle does not bind the exact visual bundle, source and candidate GLB bytes.");
  }
  requireFalsePolicy(evidence.policy, "reconstruction evidence bundle policy");

  if (modelArtifact.stageId !== "model-generation" ||
      modelArtifact.payload?.modelPath !== candidateFile.path ||
      modelArtifact.payload?.modelSha256 !== candidateFile.sha256 ||
      modelArtifact.outputs?.modelPath !== candidateFile.path ||
      modelArtifact.outputs?.modelSha256 !== candidateFile.sha256 ||
      modelArtifact.payload?.modelBytes !== candidateFile.byteLength) {
    throw new TypeError("candidate GLB does not match the exact immutable model-generation stage artifact.");
  }
  if (reportArtifact.stageId !== "report-finalization" ||
      reportArtifact.outputs?.workflowReportPath !== reportFile.path ||
      reportArtifact.outputs?.modelSha256 !== candidateFile.sha256 ||
      !isDeepStrictEqual(reportArtifact.payload?.report, qaReport)) {
    throw new TypeError("QA report does not match the exact immutable report-finalization stage artifact.");
  }
  if (qaReport.status !== "completed-requires-review" ||
      qaReport.mapReady !== false ||
      qaReport.publicationEligible !== false ||
      qaReport.output?.modelSha256 !== candidateFile.sha256) {
    throw new TypeError("QA report must describe this exact candidate as completed-requires-review with release flags false.");
  }

  const selectedViewIds = qaReport.inputs?.selectedViewIds;
  const selectedSource = Array.isArray(qaReport.selectedSourceManifest)
    ? qaReport.selectedSourceManifest.find((item) => item?.id === visual.source.id)
    : null;
  if (!Array.isArray(selectedViewIds) || !selectedViewIds.includes(visual.source.id) ||
      !selectedSource || selectedSource.sha256?.toLowerCase() !== visual.source.sha256.toLowerCase()) {
    throw new TypeError("visual evidence source must be the exact hash-verified selected view in the completed source job.");
  }

  const sourceJobStateFile = await readWorkspaceFile(
    workspaceRoot,
    path.posix.join(".building-engine", "reconstruction-jobs", buildingId, sourceJobId, "job-state.json"),
    "source reconstruction job state",
    MAX_JOB_ARTIFACT_BYTES,
  );
  const sourceJobState = parseJson(sourceJobStateFile.bytes, "source reconstruction job state");
  if (sourceJobState.jobId !== sourceJobId ||
      sourceJobState.buildingId !== buildingId ||
      sourceJobState.sourceManifestSha256 !== sourceJob.sourceManifestSha256 ||
      sourceJobState.configSha256 !== sourceJob.configSha256) {
    throw new TypeError("source job-state bytes do not match the validated reconstruction job.");
  }

  const rightsComplete =
    evidence.checks?.exactSourceRightsLink === true &&
    evidence.checks?.rightsValidatorReportComplete === true &&
    evidence.rightsEvidence?.linkedToExactSource === true &&
    evidence.rightsEvidence?.independentlyRecomputed === false &&
    evidence.rightsEvidence?.status === "validator-report-linked-human-review-required";
  const cameraComplete =
    evidence.checks?.cameraEvidenceByteBound === true &&
    evidence.checks?.cameraProjectionValidationRecomputed === true &&
    evidence.cameraCalibration?.status === "structurally-valid-evidence-linked-human-review-required" &&
    evidence.cameraCalibration?.report?.status === "structurally-valid";
  const groundControlComplete =
    evidence.checks?.groundControlEvidenceByteBound === true &&
    evidence.checks?.groundControlRegistrationRecomputed === true &&
    evidence.groundControl?.status === "calibrated-needs-human-review" &&
    evidence.groundControl?.registration?.status === "calibrated-needs-human-review";
  const reviewReady = rightsComplete && cameraComplete && groundControlComplete;

  const handoffSeed = {
    contractVersion: CONTRACT_VERSION,
    buildingId,
    sourceJobId,
    sourceJobStateSha256: sourceJobStateFile.sha256,
    sourceModelArtifactId: modelStageRef.record.artifactId,
    sourceModelArtifactSha256: modelStageRef.record.contentSha256,
    sourceReportArtifactId: reportStageRef.record.artifactId,
    sourceReportArtifactSha256: reportStageRef.record.contentSha256,
    visualBundleSha256: visualFile.sha256,
    reconstructionEvidenceSha256: evidenceFile.sha256,
    candidateGlbSha256: candidateFile.sha256,
    qaReportSha256: reportFile.sha256,
  };
  const handoffJobId = "handoff-" + sha256(Buffer.from(JSON.stringify(handoffSeed))).slice(0, 32);
  const sourceManifest = {
    schemaVersion: CONTRACT_VERSION,
    recordType: "source-bound-reconstruction-handoff-source",
    ...handoffSeed,
    visualBundle: {
      path: visualFile.path,
      sha256: visualFile.sha256,
      bytes: visualFile.byteLength,
      bundleId: visual.bundleId,
      sourceId: visual.source.id,
      sourceSha256: visual.source.sha256,
    },
    reconstructionEvidence: {
      path: evidenceFile.path,
      sha256: evidenceFile.sha256,
      bytes: evidenceFile.byteLength,
      bundleId: evidence.bundleId,
    },
    candidate: {
      path: candidateFile.path,
      sha256: candidateFile.sha256,
      bytes: candidateFile.byteLength,
    },
    qaReport: {
      path: reportFile.path,
      sha256: reportFile.sha256,
      bytes: reportFile.byteLength,
    },
    sourceArtifacts: {
      modelGeneration: {
        artifactId: modelStageRef.record.artifactId,
        contentSha256: modelStageRef.record.contentSha256,
        inputFingerprint: modelStageRef.record.inputFingerprint,
      },
      reportFinalization: {
        artifactId: reportStageRef.record.artifactId,
        contentSha256: reportStageRef.record.contentSha256,
        inputFingerprint: reportStageRef.record.inputFingerprint,
      },
    },
  };
  const config = {
    handoffContractVersion: CONTRACT_VERSION,
    disposition: reviewReady ? "prepared-for-human-review" : "blocked",
    handoffPrepared: true,
    dispatchAllowed: false,
    groundTruth: false,
    acceptanceEligible: false,
    publicationEligible: false,
    publishable: false,
    mapReady: false,
    automaticApproval: false,
  };

  const created = await createOrResumeReconstructionJob({
    workspaceRoot,
    buildingId,
    jobId: handoffJobId,
    sourceManifest,
    config,
    stageIds: CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS,
    now,
  });

  const handoffCreatedAt = created.job.createdAt;

  const verificationFingerprint = fingerprintStageInput({
    stageId: CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS[0],
    inputs: {
      sourceJobStateSha256: sourceJobStateFile.sha256,
      sourceModelArtifactSha256: modelStageRef.record.contentSha256,
      sourceReportArtifactSha256: reportStageRef.record.contentSha256,
      visualBundleSha256: visualFile.sha256,
      reconstructionEvidenceSha256: evidenceFile.sha256,
      candidateGlbSha256: candidateFile.sha256,
      qaReportSha256: reportFile.sha256,
    },
    parameters: { contractVersion: CONTRACT_VERSION, reviewReady },
  });
  const verification = await completeStage({
    workspaceRoot,
    buildingId,
    jobId: handoffJobId,
    stageId: CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS[0],
    inputFingerprint: verificationFingerprint,
    payload: {
      verificationStatus: reviewReady ? "review-ready" : "blocked",
      sourceJobId,
      sourceJobStateSha256: sourceJobStateFile.sha256,
      sourceModelArtifactId: modelStageRef.record.artifactId,
      sourceModelArtifactSha256: modelStageRef.record.contentSha256,
      sourceReportArtifactId: reportStageRef.record.artifactId,
      sourceReportArtifactSha256: reportStageRef.record.contentSha256,
      visualBundleSha256: visualFile.sha256,
      reconstructionEvidenceSha256: evidenceFile.sha256,
      candidateGlbSha256: candidateFile.sha256,
      qaReportSha256: reportFile.sha256,
      glbStructure,
      evidenceChecks: {
        rightsEvidenceCompleteButHumanReviewRequired: rightsComplete,
        cameraEvidenceStructurallyValidButHumanReviewRequired: cameraComplete,
        groundControlRegistrationRecomputedButHumanReviewRequired: groundControlComplete,
        verticalDatumResolved: evidence.groundControl?.registration?.vertical?.status === "solved",
      },
    },
    outputs: {
      disposition: reviewReady ? "prepared-for-human-review" : "blocked",
      candidateGlbSha256: candidateFile.sha256,
      sourceJobId,
    },
    now,
  });

  const verificationArtifactSha256 = verification.artifact.contentSha256;
  const handoffFingerprint = fingerprintStageInput({
    stageId: CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS[1],
    inputs: { verificationArtifactSha256 },
    parameters: { handoffJobId, disposition: reviewReady ? "prepared-for-human-review" : "blocked" },
  });
  const handoff = {
    schemaVersion: CONTRACT_VERSION,
    recordType: "source-bound-reconstruction-handoff",
    handoffId: handoffJobId,
    createdAt: handoffCreatedAt,
    buildingId,
    sourceJobId,
    disposition: reviewReady ? "prepared-for-human-review" : "blocked",
    handoffPrepared: true,
    reviewRequired: true,
    dispatchAllowed: false,
    sourceJob: {
      jobStateSha256: sourceJobStateFile.sha256,
      modelGenerationArtifactId: modelStageRef.record.artifactId,
      modelGenerationArtifactSha256: modelStageRef.record.contentSha256,
      reportFinalizationArtifactId: reportStageRef.record.artifactId,
      reportFinalizationArtifactSha256: reportStageRef.record.contentSha256,
    },
    visualBundle: sourceManifest.visualBundle,
    reconstructionEvidence: sourceManifest.reconstructionEvidence,
    candidate: {
      ...sourceManifest.candidate,
      structure: glbStructure,
      geometryAccuracyEvaluated: false,
    },
    qaReport: {
      ...sourceManifest.qaReport,
      status: qaReport.status,
      modelSha256: qaReport.output.modelSha256,
    },
    verification: {
      artifactId: verification.artifactRecord.artifactId,
      contentSha256: verificationArtifactSha256,
      inputFingerprint: verification.artifact.inputFingerprint,
      evidenceChecks: verification.artifact.payload.evidenceChecks,
    },
    checks: {
      sourceJobCompleted: true,
      sourceJobArtifactsVerified: true,
      visualBundleHashRecomputed: true,
      reconstructionEvidenceHashRecomputed: true,
      candidateGlbHashRecomputed: true,
      candidateGlbContainerValid: true,
      qaReportHashRecomputed: true,
      qaReportMatchesImmutableSourceArtifact: true,
      visualSourceMatchesSelectedJobView: true,
      exactCandidateHashMatchesEvidenceBundle: true,
      rightsEvidenceCompleteButHumanReviewRequired: rightsComplete,
      cameraEvidenceStructurallyValidButHumanReviewRequired: cameraComplete,
      groundControlRegistrationRecomputedButHumanReviewRequired: groundControlComplete,
      verticalDatumResolved: evidence.groundControl?.registration?.vertical?.status === "solved",
    },
    policy: {
      groundTruth: false,
      acceptanceEligible: false,
      publicationEligible: false,
      publishable: false,
      mapReady: false,
      automaticApproval: false,
      dispatchAllowed: false,
      independentlyAuthenticatedReviewer: false,
    },
    requiredHumanReviews: [
      "exact-asset rights scope and grantor authority",
      "same-building identity and source-view coverage",
      "camera calibration truth and source-camera correspondence",
      "ground-control point physical correspondence and survey authority",
      "metric scale, horizontal reference frame and vertical datum",
      "candidate GLB geometry/topology and architectural accuracy",
      "source-camera visual comparison and explicit acceptance decision",
    ],
    limitations: [
      "A prepared hand-off records exact bytes and immutable provenance; it is not a worker-dispatch authorization.",
      "The BRF-45 report is hash-linked, not re-run here; grantor authority and legal interpretation require independent human review.",
      "Camera and ground-control computations are carried from D3M-01.B and do not independently authenticate calibration or survey authority.",
      "Vertical datum remains unresolved unless separately demonstrated by evidence; horizontal WGS84 registration alone is insufficient.",
      "GLB container validity and SHA-256 identity do not establish same-building truth, geometric quality or architectural accuracy.",
      "No automatic approval, catalog publication, model activation or map placement is performed.",
    ],
  };

  const handoffStage = await completeStage({
    workspaceRoot,
    buildingId,
    jobId: handoffJobId,
    stageId: CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS[1],
    inputFingerprint: handoffFingerprint,
    payload: { handoff },
    outputs: {
      handoffId: handoffJobId,
      disposition: handoff.disposition,
      candidateGlbSha256: candidateFile.sha256,
      handoffPrepared: true,
      dispatchAllowed: false,
    },
    now,
  });

  return {
    handoffJobId,
    disposition: handoff.disposition,
    handoffPrepared: true,
    reused: created.resumed && verification.reused && handoffStage.reused,
    job: handoffStage.job,
    artifact: handoffStage.artifact,
    handoff,
  };
}

/** Read and checksum-verify a previously prepared immutable hand-off job. */
export async function readSourceBoundReconstructionHandoff({ workspaceRoot, buildingId, handoffJobId }) {
  const root = await realpath(path.resolve(workspaceRoot ?? ""));
  const building = safeId(buildingId, "buildingId");
  const id = safeId(handoffJobId, "handoffJobId");
  const { job, jobDirectory } = await readReconstructionJob({
    workspaceRoot: root,
    buildingId: building,
    jobId: id,
    recoverInterrupted: false,
  });
  if (JSON.stringify(job.stageIds) !== JSON.stringify(CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS) ||
      job.status !== "completed") {
    throw new TypeError("requested job is not a completed candidate evidence hand-off.");
  }
  const stage = job.stages.find((item) => item.id === CANDIDATE_EVIDENCE_HANDOFF_STAGE_IDS[1]);
  const record = stage?.artifacts.find((item) => item.artifactId === stage.activeArtifactId);
  if (!record) throw new TypeError("candidate evidence hand-off artifact is missing.");
  const artifact = await readJobArtifact(jobDirectory, record, "candidate evidence hand-off");
  const handoff = artifact.payload?.handoff;
  if (!isObject(handoff) ||
      handoff.recordType !== "source-bound-reconstruction-handoff" ||
      handoff.handoffId !== id ||
      handoff.policy?.mapReady !== false ||
      handoff.policy?.publicationEligible !== false ||
      handoff.policy?.automaticApproval !== false ||
      handoff.policy?.dispatchAllowed !== false) {
    throw new TypeError("candidate evidence hand-off artifact violates its fail-closed contract.");
  }
  return { job, artifact, handoff };
}
