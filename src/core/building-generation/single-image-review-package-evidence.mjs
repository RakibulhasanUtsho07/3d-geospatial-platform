import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./generation-artifact-receipt.mjs";
import { verifySingleImageRuntimeSmoke } from "./verify-single-image-runtime-smoke.mjs";
import {
  buildSingleImageSurveyObservationRecordInventory,
  MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES,
  MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS_BYTES,
  singleImageSurveyObservationRecordPath,
} from "./single-image-survey-observation-records.mjs";

const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must be a workspace-relative POSIX path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(label + " contains an unsafe path segment.");
  }
  return value;
}

function fileSignature(info) {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

async function readStableWorkspaceFile(root, relativePath, label, maxBytes) {
  const safePath = safeRelativePath(relativePath, label);
  let current = root;
  const segments = safePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new TypeError(label + " must not contain symbolic links.");
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw new TypeError(label + " contains a non-directory path segment.");
    }
    if (index === segments.length - 1 && !details.isFile()) {
      throw new TypeError(label + " must be a regular file.");
    }
  }
  const actual = await realpath(current);
  if (!inside(root, actual)) throw new TypeError(label + " resolves outside the smoke workspace.");
  const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new RangeError(label + " is empty or exceeds its size limit.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const actualAfter = await realpath(current);
    const pathAfter = await lstat(actual);
    if (actualAfter !== actual || pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        fileSignature(before) !== fileSignature(after) ||
        fileSignature(after) !== fileSignature(pathAfter) ||
        bytes.length !== after.size) {
      throw new Error(label + " changed while being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readStableSingleImageSurveyObservationRecord({ workspaceRoot, observationId }) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("Survey observation workspace root is required.");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const relativePath = singleImageSurveyObservationRecordPath(observationId);
  const bytes = await readStableWorkspaceFile(
    root,
    relativePath,
    "Held-out survey observation record " + observationId,
    MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORD_BYTES,
  );
  return { observationId, relativePath, sha256: sha256(bytes), bytes };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(label + " is not valid UTF-8 JSON.");
  }
}

function addFile(artifactType, relativePath, bytes) {
  return { artifactType, relativePath, bytes, sha256: sha256(bytes) };
}

/**
 * Verify a D3M-08 smoke in its private workspace and return the exact bytes
 * required to carry its horizontal registration into a signed review package.
 */
export async function prepareSingleImageReviewPackageEvidence({
  workspaceRoot,
  jobId,
  buildingId,
  candidateGlbSha256,
}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw new TypeError("single-image smoke workspace is required.");
  if (typeof jobId !== "string" || !SAFE_ID.test(jobId)) throw new TypeError("single-image smoke jobId is invalid.");
  if (typeof buildingId !== "string" || !SAFE_ID.test(buildingId)) throw new TypeError("buildingId is invalid.");
  if (!HASH.test(candidateGlbSha256 ?? "")) throw new TypeError("candidateGlbSha256 must be a SHA-256 digest.");

  const root = await realpath(path.resolve(workspaceRoot));
  const before = await verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId });
  const reportPath = ".building-engine/runtime-smokes/" + jobId + ".json";
  const reportBytes = await readStableWorkspaceFile(root, reportPath, "Single-image smoke report", MAX_REPORT_BYTES);
  const report = parseJson(reportBytes, "Single-image smoke report");
  if (!["1.5.0", "1.6.0"].includes(report.schemaVersion) || report.kind !== "single-image-runtime-smoke" ||
      report.status !== "passed" || report.jobId !== jobId || report.buildingId !== buildingId ||
      report.output?.sha256 !== candidateGlbSha256 ||
      before.model?.sha256 !== candidateGlbSha256 ||
      before.generationArtifactReceiptStatus !== "verified" ||
      before.georeferenceEvidenceStatus !== "calibrated-needs-human-review" ||
      report.georeferenceEvidence?.status !== "calibrated-needs-human-review" ||
      report.georeferenceEvidence?.modelSha256 !== candidateGlbSha256 ||
      report.georeferenceEvidence?.manifest === null ||
      report.georeferenceEvidence?.registration?.vertical?.status !== "not-solved" ||
      (report.georeferenceEvidence?.verticalEvidence?.status !== undefined &&
       !["not-requested", "calibrated-needs-human-review"].includes(report.georeferenceEvidence.verticalEvidence.status)) ||
      (report.georeferenceEvidence?.schemaVersion === "1.2.0" &&
       report.georeferenceEvidence?.independentCheckpointEvidence?.status !== "validated-needs-human-review") ||
      report.mapReady !== false || report.publicationEligible !== false || report.automaticApproval !== false) {
    throw new Error("Single-image smoke must be a verified D3M-08 run with successful horizontal control-point registration for the exact candidate GLB.");
  }

  const receiptPath = safeRelativePath(report.generationArtifactReceipt?.path, "Generation artifact receipt path");
  const receiptBytes = await readStableWorkspaceFile(root, receiptPath, "Generation artifact receipt", MAX_RECEIPT_BYTES);
  const receipt = parseJson(receiptBytes, "Generation artifact receipt");
  const workflowPath = safeRelativePath(receipt?.payload?.workflowReport?.path, "Generation workflow report path");
  const workflowBytes = await readStableWorkspaceFile(root, workflowPath, "Generation workflow report", MAX_WORKFLOW_BYTES);
  const workflowReport = parseJson(workflowBytes, "Generation workflow report");
  const manifestPath = safeRelativePath(report.georeferenceEvidence.manifest.path, "Control-point manifest path");
  const manifestBytes = await readStableWorkspaceFile(root, manifestPath, "Control-point manifest", MAX_MANIFEST_BYTES);
  const controlManifest = parseJson(manifestBytes, "Control-point manifest");
  const observationRecordFiles = [];
  let observationRecordInventory = null;
  if (report.georeferenceEvidence?.schemaVersion === "1.2.0") {
    const checkpoints = controlManifest.heldOutCheckpoints?.points;
    if (controlManifest.schemaVersion !== "1.2.0" || !Array.isArray(checkpoints) ||
        checkpoints.length < 6 || checkpoints.length > 100 ||
        checkpoints.length !== report.georeferenceEvidence.independentCheckpointEvidence?.controls?.count) {
      throw new Error("Held-out control manifest does not declare the exact 6–100 checkpoints required by its georeference evidence.");
    }
    let totalRecordBytes = 0;
    for (const checkpoint of checkpoints) {
      const record = await readStableSingleImageSurveyObservationRecord({
        workspaceRoot: root,
        observationId: checkpoint.observationId,
      });
      const { relativePath, bytes: recordBytes, sha256: actualSha256 } = record;
      if (typeof checkpoint.observationRecordSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(checkpoint.observationRecordSha256)) {
        throw new Error("Held-out checkpoint is missing a valid observation-record SHA-256: " + checkpoint.id);
      }
      if (actualSha256 !== checkpoint.observationRecordSha256) {
        throw new Error("Held-out survey observation record SHA-256 does not match checkpoint " + checkpoint.id + ".");
      }
      totalRecordBytes += recordBytes.length;
      if (!Number.isSafeInteger(totalRecordBytes) ||
          totalRecordBytes > MAX_SINGLE_IMAGE_SURVEY_OBSERVATION_RECORDS_BYTES) {
        throw new RangeError("Held-out survey observation records exceed the 128 MiB aggregate limit.");
      }
      observationRecordFiles.push({
        artifactType: "single-image-survey-observation-record",
        observationId: checkpoint.observationId,
        relativePath,
        sha256: actualSha256,
        bytes: recordBytes,
      });
    }
    observationRecordInventory = buildSingleImageSurveyObservationRecordInventory(
      observationRecordFiles.map((file) => ({
        observationId: file.observationId,
        relativePath: file.relativePath,
        sha256: file.sha256,
        bytes: file.bytes.length,
      })),
    );
  }

  const expectedReceiptSchema = report.schemaVersion === "1.6.0" ? "1.2.0" : "1.1.0";
  if (receipt.schemaVersion !== expectedReceiptSchema || receipt.payload?.georeference === undefined ||
      receipt.payload?.buildingId !== buildingId || receipt.payload?.jobId !== jobId ||
      receipt.payload?.output?.sha256 !== candidateGlbSha256 ||
      receipt.payload?.source?.sourceId !== report.source?.sourceId ||
      receipt.payload?.source?.sha256 !== report.source?.sha256 ||
      receipt.payload?.workflowReport?.bytes !== workflowBytes.length ||
      receipt.payload?.workflowReport?.sha256 !== sha256(workflowBytes) ||
      sha256(receiptBytes) !== report.generationArtifactReceipt.sha256 ||
      receiptBytes.length !== report.generationArtifactReceipt.bytes ||
      sha256(manifestBytes) !== report.georeferenceEvidence.manifest.sha256 ||
      manifestBytes.length !== report.georeferenceEvidence.manifest.bytes ||
      workflowReport.jobId !== jobId || workflowReport.buildingId !== buildingId ||
      workflowReport.output?.modelSha256 !== candidateGlbSha256 ||
      canonicalJson(workflowReport.georeference) !== canonicalJson(report.georeferenceEvidence.registration) ||
      canonicalJson(receipt.payload.georeference) !== canonicalJson(report.georeferenceEvidence)) {
    throw new Error("Single-image smoke, generation receipt, workflow report and control-point manifest are not cross-bound.");
  }

  const after = await verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId });
  const reportBytesAfter = await readStableWorkspaceFile(root, reportPath, "Single-image smoke report", MAX_REPORT_BYTES);
  const receiptBytesAfter = await readStableWorkspaceFile(root, receiptPath, "Generation artifact receipt", MAX_RECEIPT_BYTES);
  const workflowBytesAfter = await readStableWorkspaceFile(root, workflowPath, "Generation workflow report", MAX_WORKFLOW_BYTES);
  const manifestBytesAfter = await readStableWorkspaceFile(root, manifestPath, "Control-point manifest", MAX_MANIFEST_BYTES);
  const observationRecordBytesAfter = [];
  for (const file of observationRecordFiles) {
    observationRecordBytesAfter.push(await readStableSingleImageSurveyObservationRecord({
      workspaceRoot: root,
      observationId: file.observationId,
    }));
  }
  if (after.model?.sha256 !== candidateGlbSha256 ||
      sha256(reportBytesAfter) !== sha256(reportBytes) ||
      sha256(receiptBytesAfter) !== sha256(receiptBytes) ||
      sha256(workflowBytesAfter) !== sha256(workflowBytes) ||
      sha256(manifestBytesAfter) !== sha256(manifestBytes) ||
      observationRecordBytesAfter.some((record, index) =>
        record.relativePath !== observationRecordFiles[index].relativePath ||
        record.bytes.length !== observationRecordFiles[index].bytes.length ||
        record.sha256 !== observationRecordFiles[index].sha256)) {
    throw new Error("Single-image smoke or survey observation evidence changed during review-package preparation.");
  }

  const files = [
    addFile("single-image-smoke-report", "reports/single-image-runtime-smoke.json", reportBytes),
    addFile("single-image-generation-artifact-receipt", "reports/single-image-generation-artifact-receipt.json", receiptBytes),
    addFile("single-image-workflow-report", "reports/single-image-workflow-report.json", workflowBytes),
    addFile("single-image-control-point-manifest", "evidence/single-image-control-points.json", manifestBytes),
    ...observationRecordFiles.map((file) => ({
      artifactType: file.artifactType,
      observationId: file.observationId,
      relativePath: file.relativePath,
      sha256: file.sha256,
      bytes: file.bytes,
    })),
  ];
  const verticalEvidence = report.georeferenceEvidence.verticalEvidence;
  const hasVerticalCalibration = verticalEvidence?.status === "calibrated-needs-human-review";
  const checkpointEvidence = report.georeferenceEvidence.independentCheckpointEvidence;
  const hasIndependentCheckpoints = checkpointEvidence?.status === "validated-needs-human-review";
  return {
    schemaVersion: hasIndependentCheckpoints ? "1.3.0" : hasVerticalCalibration ? "1.1.0" : "1.0.0",
    jobId,
    buildingId,
    sourceId: report.source.sourceId,
    sourceSha256: report.source.sha256,
    candidateGlbSha256,
    georeferenceStatus: "calibrated-needs-human-review",
    controlPointManifestSha256: sha256(manifestBytes),
    smokeReportSha256: sha256(reportBytes),
    generationArtifactReceiptSha256: sha256(receiptBytes),
    workflowReportSha256: sha256(workflowBytes),
    verticalDatum: hasVerticalCalibration ? "EPSG:4979-ellipsoidal" : "not-solved",
    ...(hasVerticalCalibration ? {
      verticalStatus: verticalEvidence.status,
      verticalEvidenceSha256: sha256(Buffer.from(canonicalJson(verticalEvidence), "utf8")),
      verticalReferenceFrame: verticalEvidence.referenceFrame,
      verticalCoordinateEpoch: verticalEvidence.coordinateEpoch,
      verticalHeightOffsetM: verticalEvidence.heightOffsetM,
      verticalRmsErrorM: verticalEvidence.controls.rmsErrorM,
      verticalMaxResidualM: verticalEvidence.controls.maxResidualM,
      verticalControlPointCount: verticalEvidence.controls.count,
    } : {}),
    ...(hasIndependentCheckpoints ? {
      checkpointValidationStatus: checkpointEvidence.status,
      checkpointEvidenceSha256: sha256(Buffer.from(canonicalJson(checkpointEvidence), "utf8")),
      checkpointReferenceFrame: checkpointEvidence.referenceFrame,
      checkpointCoordinateEpoch: checkpointEvidence.coordinateEpoch,
      checkpointCount: checkpointEvidence.controls.count,
      checkpointHorizontalRmsErrorM: checkpointEvidence.controls.horizontalRmsErrorM,
      checkpointHorizontalMaxResidualM: checkpointEvidence.controls.horizontalMaxResidualM,
      checkpointVerticalRmsErrorM: checkpointEvidence.controls.verticalRmsErrorM,
      checkpointVerticalMaxResidualM: checkpointEvidence.controls.verticalMaxResidualM,
      checkpoint3dRmsErrorM: checkpointEvidence.controls.spatial3dRmsErrorM,
      checkpoint3dMaxResidualM: checkpointEvidence.controls.spatial3dMaxResidualM,
      ...(observationRecordInventory ? {
        surveyObservationRecordCount: observationRecordInventory.count,
        surveyObservationRecordBytes: observationRecordInventory.totalBytes,
        surveyObservationRecordsSha256: observationRecordInventory.sha256,
        surveyObservationRecords: observationRecordInventory.records,
      } : {}),
    } : {}),
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    files,
  };
}
