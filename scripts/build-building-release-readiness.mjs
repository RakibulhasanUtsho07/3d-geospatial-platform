#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { inspectRenderCorrectionArtifactEvidence } from "../src/core/building-generation/render-correction-artifact-evidence.mjs";
import { buildBuildingReleaseReadiness } from "../src/core/building-generation/building-release-readiness.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safePngName = (value) => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(value) &&
  !value.includes("..") && !value.includes("/") && !value.includes("\\");

async function main() {
  const [glbArg, renderDirArg, reviewArg, backlogArg, verificationArg, accuracyEvidenceArg, geometryQaArg, textureQaArg, outputArg] =
    process.argv.slice(2);
  if (!glbArg || !renderDirArg || !reviewArg || !backlogArg || !verificationArg ||
    !accuracyEvidenceArg || !geometryQaArg || !textureQaArg || !outputArg || process.argv.length !== 11) {
    throw new Error("Usage: node scripts/build-building-release-readiness.mjs <candidate.glb> <render-directory> <render-reference-review-report.json> <correction-tasks.json> <correction-verification.json> <accuracy-evidence.json> <geometry-qa-report.json> <texture-qa-report.json> <release-readiness-report.json>");
  }

  const glbPath = path.resolve(glbArg);
  const renderDir = path.resolve(renderDirArg);
  const manifestPath = path.join(renderDir, "render-review-manifest.json");
  const reviewPath = path.resolve(reviewArg);
  const backlogPath = path.resolve(backlogArg);
  const verificationPath = path.resolve(verificationArg);
  const accuracyEvidencePath = path.resolve(accuracyEvidenceArg);
  const geometryQaPath = path.resolve(geometryQaArg);
  const textureQaPath = path.resolve(textureQaArg);
  const outputPath = path.resolve(outputArg);

  const [reviewBytes, backlogBytes, verificationBytes, accuracyEvidenceBytes] = await Promise.all([
    readFile(reviewPath),
    readFile(backlogPath),
    readFile(verificationPath),
    readFile(accuracyEvidencePath),
  ]);
  const renderReferenceReview = JSON.parse(reviewBytes.toString("utf8"));
  const correctionTaskBacklog = JSON.parse(backlogBytes.toString("utf8"));
  const correctionVerification = JSON.parse(verificationBytes.toString("utf8"));
  const accuracyEvidence = JSON.parse(accuracyEvidenceBytes.toString("utf8"));
  const inspected = await inspectRenderCorrectionArtifactEvidence({
    candidateModelPath: glbPath,
    renderManifestPath: manifestPath,
    geometryQaReportPath: geometryQaPath,
    textureQaReportPath: textureQaPath,
    reviewReport: renderReferenceReview,
  });
  const {
    candidateModelBytes: glbBytes,
    renderManifestBytes: manifestBytes,
    renderManifest,
    geometryQa,
    textureQa,
    artifactEvidence: correctionArtifactEvidence,
  } = inspected;

  const baseInputPaths = [
    glbPath, manifestPath, reviewPath, backlogPath, verificationPath, accuracyEvidencePath,
    geometryQaPath, textureQaPath,
  ];
  const actualRenderFiles = [];
  const renderFilePaths = [];
  for (const view of Array.isArray(renderManifest?.views) ? renderManifest.views : []) {
    if (!safePngName(view?.filename)) continue;
    const filePath = path.resolve(renderDir, view.filename);
    renderFilePaths.push(filePath);
    try {
      const bytes = await readFile(filePath);
      const dimensions = readImageDimensions(bytes);
      if (!dimensions) continue;
      actualRenderFiles.push({
        filename: view.filename,
        sha256: sha256(bytes),
        width: dimensions.width,
        height: dimensions.height,
        bytes: bytes.length,
      });
    } catch {
      // Missing or unreadable render files remain absent; the readiness gate blocks release.
    }
  }
  if ([...baseInputPaths, ...renderFilePaths].includes(outputPath)) {
    throw new Error("Output path must differ from every input file, including QA reports and rendered PNGs.");
  }

  const candidateGlbSha256 = sha256(glbBytes);
  const renderManifestSha256 = sha256(manifestBytes);
  const readiness = buildBuildingReleaseReadiness({
    buildingId: renderReferenceReview.buildingId,
    candidateGlbSha256,
    renderManifest,
    renderManifestSha256,
    actualRenderFiles,
    geometryQa,
    textureQa,
    renderReferenceReview,
    correctionTaskBacklog,
    correctionVerification,
    correctionArtifactEvidence,
    accuracyEvidence,
  });

  await writeFile(outputPath, JSON.stringify(readiness, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({
    report: outputPath,
    buildingId: readiness.buildingId,
    candidateGlbSha256: readiness.candidateGlbSha256,
    status: readiness.status,
    blockers: readiness.counts.blockers,
    warnings: readiness.counts.warnings,
    requiredRenderViews: readiness.counts.requiredRenderViews,
    qualifyingReviewedViews: readiness.counts.qualifyingReviewedViews,
    actualRenderFilesRead: readiness.counts.actualRenderFilesRead,
    correctionArtifactIntegrity: correctionArtifactEvidence.validated ? "validated" : "invalid",
    accuracyBenchmarkChecks: readiness.counts.accuracyBenchmarkChecks,
    groundControlPoints: readiness.counts.groundControlPoints,
    publicationEligible: readiness.publicationEligible,
  }, null, 2));
  if (readiness.status === "blocked") process.exitCode = 2;
}

main().catch((error) => {
  console.error("Could not build building release readiness report:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
