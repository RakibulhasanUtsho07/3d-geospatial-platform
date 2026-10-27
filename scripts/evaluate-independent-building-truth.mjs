#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateIndependentBuildingTruth } from "../src/core/building-generation/independent-building-truth-evaluator.mjs";
import { geometryPayloadSha256, validateGeometryExtractionProvenance } from "../src/core/building-generation/geometry-extraction-provenance.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.startsWith("/") || /^[a-z]:/i.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " must be a safe project-relative path.");
  }
  return value;
}
async function safeRead(root, relative, label) {
  const safe = safeRelative(relative, label);
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!resolved.startsWith(root + path.sep)) throw new TypeError(label + " resolves outside the project root.");
  let current = root;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " must not traverse symbolic links.");
    if (current === resolved && !info.isFile()) throw new TypeError(label + " must be a regular file.");
  }
  return { path: resolved, bytes: await readFile(resolved) };
}

async function safeOutputPath(root, relative) {
  const safe = safeRelative(relative, "report output");
  const parts = safe.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError("Report output must not traverse symbolic links or non-directories.");
    }
  }
  const resolved = path.resolve(root, ...parts);
  if (!resolved.startsWith(root + path.sep)) throw new TypeError("Report output resolves outside the project root.");
  return resolved;
}
function addArtifactCheck(report, id, passed, detail, failureStatus = "failed") {
  const check = { id, status: passed ? "passed" : failureStatus, detail };
  report.checks.push(check);
  if (!passed && failureStatus === "warning") report.warnings.push(check);
  if (!passed && failureStatus === "failed") report.failures.push(check);
}
function refreshStatus(report) {
  report.counts = {
    passed: report.checks.filter((item) => item.status === "passed").length,
    warnings: report.checks.filter((item) => item.status === "warning").length,
    failures: report.checks.filter((item) => item.status === "failed").length,
  };
  report.status = report.counts.failures ? "benchmark-failed" :
    report.counts.warnings ? "benchmark-incomplete" : "benchmark-review-required";
}

async function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.find((arg) => arg.startsWith("--root="));
  const positional = argv.filter((arg) => !arg.startsWith("--root="));
  if (process.argv.includes("--help") || !positional[0] || positional.length > 2) {
    console.log("Usage: node scripts/evaluate-independent-building-truth.mjs <evaluation-manifest.json> [report.json] [--root=project-root]\nChecks candidate GLB, independent truth source, extractor source/configuration bytes, and deterministic geometry-payload provenance before computing footprint, dimension, checkpoint and optional mesh-distance metrics. This does not approve a model.");
    process.exitCode = process.argv.includes("--help") ? 0 : 2;
    return;
  }

  const root = await realpath(path.resolve(rootFlag ? rootFlag.slice("--root=".length) : process.cwd()));
  const manifestFile = await safeRead(root, positional[0], "evaluation manifest");
  const manifestSha256 = sha256(manifestFile.bytes);
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  const report = evaluateIndependentBuildingTruth(manifest);
  report.evaluationManifestSha256 = manifestSha256;
  const artifactIntegrity = [];

  const candidateAsset = await safeRead(root, manifest.candidate?.glbPath, "candidate GLB");
  const actualCandidateSha256 = sha256(candidateAsset.bytes);
  const candidateHashMatches = SHA256.test(manifest.candidate?.glbSha256 ?? "") &&
    actualCandidateSha256.toLowerCase() === manifest.candidate.glbSha256.toLowerCase();
  artifactIntegrity.push({ kind: "candidate-glb", path: manifest.candidate.glbPath,
    expectedSha256: manifest.candidate.glbSha256 ?? null, actualSha256: actualCandidateSha256,
    status: candidateHashMatches ? "passed" : "failed" });
  addArtifactCheck(report, "candidate-glb-byte-integrity", candidateHashMatches,
    candidateHashMatches ? "Candidate GLB bytes match the declared SHA-256." :
      "Candidate GLB bytes do not match the declared SHA-256; metrics must not be trusted for this artifact.");

  const referenceAsset = await safeRead(root, manifest.reference?.sourcePath, "independent reference source");
  const actualReferenceSha256 = sha256(referenceAsset.bytes);
  const referenceHashMatches = SHA256.test(manifest.reference?.sourceSha256 ?? "") &&
    actualReferenceSha256.toLowerCase() === manifest.reference.sourceSha256.toLowerCase();
  artifactIntegrity.push({ kind: "independent-reference-source", path: manifest.reference.sourcePath,
    expectedSha256: manifest.reference.sourceSha256 ?? null, actualSha256: actualReferenceSha256,
    status: referenceHashMatches ? "passed" : "failed" });
  addArtifactCheck(report, "reference-source-byte-integrity", referenceHashMatches,
    referenceHashMatches ? "Independent reference-source bytes match the declared SHA-256." :
      "Reference-source bytes do not match the declared SHA-256; independent truth provenance is stale.");

  const extractionReports = {};
  for (const role of ["candidate", "reference"]) {
    const item = role === "candidate" ? manifest.candidate : manifest.reference;
    const sourceHash = role === "candidate" ? actualCandidateSha256 : actualReferenceSha256;
    let payloadSha256 = null;
    try {
      payloadSha256 = geometryPayloadSha256(item);
    } catch (error) {
      addArtifactCheck(report, role + "-geometry-payload-hash", false,
        error instanceof Error ? error.message : String(error));
    }
    const assessment = validateGeometryExtractionProvenance({
      provenance: item.geometryExtractionProvenance,
      sourceSha256: sourceHash,
      geometrySha256: payloadSha256,
      coordinateFrameId: item.coordinateFrameId,
      units: item.units,
      label: role,
    });
    for (const check of assessment.checks) {
      addArtifactCheck(report, check.id, check.status === "passed", check.detail,
        check.status === "warning" ? "warning" : "failed");
    }
    const provenance = assessment.provenance;
    const fileResults = [];
    if (provenance && provenance.extractor) {
      for (const [kind, relativePath, expectedHash] of [
        ["extractor-artifact", provenance.extractor.artifactPath, provenance.extractor.artifactSha256],
        ["extractor-configuration", provenance.extractor.configurationPath, provenance.extractor.configurationSha256],
      ]) {
        try {
          const asset = await safeRead(root, relativePath, role + " " + kind);
          const actualHash = sha256(asset.bytes);
          const matches = SHA256.test(expectedHash ?? "") && actualHash.toLowerCase() === expectedHash.toLowerCase();
          const record = { kind, path: relativePath, expectedSha256: expectedHash ?? null,
            actualSha256: actualHash, status: matches ? "passed" : "failed" };
          fileResults.push(record);
          artifactIntegrity.push(record);
          addArtifactCheck(report, role + "-" + kind + "-byte-integrity", matches,
            matches ? role + " " + kind + " bytes match the pinned SHA-256." :
              role + " " + kind + " bytes do not match the declared extraction provenance.");
        } catch (error) {
          const record = { kind, path: relativePath ?? null, expectedSha256: expectedHash ?? null,
            actualSha256: null, status: "failed", error: error instanceof Error ? error.message : String(error) };
          fileResults.push(record);
          artifactIntegrity.push(record);
          addArtifactCheck(report, role + "-" + kind + "-byte-integrity", false,
            record.error);
        }
      }
    }
    const extractorFilesMatch = fileResults.length === 2 &&
      fileResults.every((file) => file.status === "passed");
    const finalExtractionStatus = assessment.status === "failed" || fileResults.some((file) => file.status === "failed")
      ? "failed"
      : assessment.status === "incomplete" || !extractorFilesMatch ? "incomplete" : "passed";
    extractionReports[role] = {
      status: finalExtractionStatus,
      geometryPayloadSha256: payloadSha256,
      provenance: provenance ?? null,
      extractorFiles: fileResults,
    };
  }
  report.geometryExtractionProvenance = extractionReports;
  report.assetIntegrity = artifactIntegrity;
  refreshStatus(report);
  const reportRelative = positional[1] ??
    path.join("artifacts", "independent-building-truth", manifest.evaluationId + "-report.json").split(path.sep).join("/");
  const reportPath = await safeOutputPath(root, reportRelative);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    reportPath: path.relative(root, reportPath).split(path.sep).join("/"),
    status: report.status, checks: report.counts.passed, warnings: report.counts.warnings,
    failures: report.counts.failures, acceptanceEligible: false, publicationEligible: false, mapReady: false,
  }, null, 2));
  if (report.status === "benchmark-failed") process.exitCode = 1;
  else if (report.status === "benchmark-incomplete") process.exitCode = 2;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
