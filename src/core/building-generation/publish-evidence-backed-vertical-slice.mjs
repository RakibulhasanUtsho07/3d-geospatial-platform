import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { publishReviewedBuildingModel } from "./published-model-catalog.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

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

/**
 * Publish only the exact textured geometry candidate produced by a completed
 * D3M-ENGINE-03 parent report. The existing catalog publisher independently
 * validates the GLB, candidate hash, human review evidence hash, six required
 * attestations and the WGS84 placement contract.
 *
 * This is an explicit operator action. It does not verify the civil identity
 * or cryptographic trust of the reviewer and does not turn release flags true.
 */
export async function publishEvidenceBackedVerticalSlice({
  workspaceRoot,
  reportPath,
  attestationPath,
  publicRoot,
  publishedAt,
}) {
  if (!workspaceRoot || !reportPath || !attestationPath || !publicRoot) {
    throw new TypeError("workspaceRoot, reportPath, attestationPath and publicRoot are required");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  const reportFile = await readRegularFile(root, reportPath, "vertical-slice report", 16 * 1024 * 1024);
  const attestationFile = await readRegularFile(root, attestationPath, "publication attestation", 2 * 1024 * 1024);

  let report;
  let attestation;
  try {
    report = JSON.parse(reportFile.bytes.toString("utf8"));
    attestation = JSON.parse(attestationFile.bytes.toString("utf8"));
  } catch (error) {
    throw new TypeError("vertical-slice report and attestation must be valid JSON: " + error.message);
  }

  if (!report || typeof report !== "object" || Array.isArray(report) ||
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
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation) ||
      attestation.candidateSha256 !== candidate.sha256) {
    throw new Error("publication attestation must bind the exact D3M-ENGINE-03 textured GLB hash");
  }
  if (!attestation.model || attestation.model.id !== report.buildingId) {
    throw new Error("publication attestation model.id must exactly match the parent buildingId");
  }

  const published = await publishReviewedBuildingModel({
    workspaceRoot: root,
    candidatePath: candidate.relativePath,
    attestationPath: attestationFile.relativePath,
    publicRoot,
    ...(publishedAt ? { publishedAt } : {}),
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
    mapReady: false,
    publicationEligible: false,
    note: "Explicit human attestation published the exact candidate to the static catalog. This does not authenticate reviewer identity or prove independent survey accuracy; parent release flags remain false.",
  };
}
