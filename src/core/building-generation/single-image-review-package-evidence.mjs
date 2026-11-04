import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { verifySingleImageRuntimeSmoke } from "./verify-single-image-runtime-smoke.mjs";

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
  const handle = await open(actual, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new RangeError(label + " is empty or exceeds its size limit.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(actual);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
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
  if (report.schemaVersion !== "1.5.0" || report.kind !== "single-image-runtime-smoke" ||
      report.status !== "passed" || report.jobId !== jobId || report.buildingId !== buildingId ||
      report.output?.sha256 !== candidateGlbSha256 ||
      before.model?.sha256 !== candidateGlbSha256 ||
      before.generationArtifactReceiptStatus !== "verified" ||
      before.georeferenceEvidenceStatus !== "calibrated-needs-human-review" ||
      report.georeferenceEvidence?.status !== "calibrated-needs-human-review" ||
      report.georeferenceEvidence?.modelSha256 !== candidateGlbSha256 ||
      report.georeferenceEvidence?.manifest === null ||
      report.georeferenceEvidence?.registration?.vertical?.status !== "not-solved" ||
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

  if (receipt.schemaVersion !== "1.1.0" || receipt.payload?.georeference === undefined ||
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
      JSON.stringify(workflowReport.georeference) !== JSON.stringify(report.georeferenceEvidence.registration) ||
      JSON.stringify(receipt.payload.georeference) !== JSON.stringify(report.georeferenceEvidence)) {
    throw new Error("Single-image smoke, generation receipt, workflow report and control-point manifest are not cross-bound.");
  }

  const after = await verifySingleImageRuntimeSmoke({ workspaceRoot: root, jobId });
  const reportBytesAfter = await readStableWorkspaceFile(root, reportPath, "Single-image smoke report", MAX_REPORT_BYTES);
  const receiptBytesAfter = await readStableWorkspaceFile(root, receiptPath, "Generation artifact receipt", MAX_RECEIPT_BYTES);
  const workflowBytesAfter = await readStableWorkspaceFile(root, workflowPath, "Generation workflow report", MAX_WORKFLOW_BYTES);
  const manifestBytesAfter = await readStableWorkspaceFile(root, manifestPath, "Control-point manifest", MAX_MANIFEST_BYTES);
  if (after.model?.sha256 !== candidateGlbSha256 ||
      sha256(reportBytesAfter) !== sha256(reportBytes) ||
      sha256(receiptBytesAfter) !== sha256(receiptBytes) ||
      sha256(workflowBytesAfter) !== sha256(workflowBytes) ||
      sha256(manifestBytesAfter) !== sha256(manifestBytes)) {
    throw new Error("Single-image smoke evidence changed during review-package preparation.");
  }

  const files = [
    addFile("single-image-smoke-report", "reports/single-image-runtime-smoke.json", reportBytes),
    addFile("single-image-generation-artifact-receipt", "reports/single-image-generation-artifact-receipt.json", receiptBytes),
    addFile("single-image-workflow-report", "reports/single-image-workflow-report.json", workflowBytes),
    addFile("single-image-control-point-manifest", "evidence/single-image-control-points.json", manifestBytes),
  ];
  return {
    schemaVersion: "1.0.0",
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
    verticalDatum: "not-solved",
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
    files,
  };
}
