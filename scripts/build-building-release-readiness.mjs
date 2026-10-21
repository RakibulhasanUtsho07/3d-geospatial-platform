#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";
import { buildBuildingReleaseReadiness } from "../src/core/building-generation/building-release-readiness.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safePngName = (value) => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(value) &&
  !value.includes("..") && !value.includes("/") && !value.includes("\\");

async function main() {
  const [glbArg, renderDirArg, reviewArg, backlogArg, verificationArg, outputArg] = process.argv.slice(2);
  if (!glbArg || !renderDirArg || !reviewArg || !backlogArg || !verificationArg || !outputArg ||
    process.argv.length !== 8) {
    throw new Error("Usage: node scripts/build-building-release-readiness.mjs <candidate.glb> <render-directory> <render-reference-review-report.json> <correction-tasks.json> <correction-verification.json> <release-readiness-report.json>");
  }

  const glbPath = path.resolve(glbArg);
  const renderDir = path.resolve(renderDirArg);
  const manifestPath = path.join(renderDir, "render-review-manifest.json");
  const reviewPath = path.resolve(reviewArg);
  const backlogPath = path.resolve(backlogArg);
  const verificationPath = path.resolve(verificationArg);
  const outputPath = path.resolve(outputArg);

  const [glbBytes, manifestBytes, reviewBytes, backlogBytes, verificationBytes] = await Promise.all([
    readFile(glbPath),
    readFile(manifestPath),
    readFile(reviewPath),
    readFile(backlogPath),
    readFile(verificationPath),
  ]);
  const renderManifest = JSON.parse(manifestBytes.toString("utf8"));
  const renderReferenceReview = JSON.parse(reviewBytes.toString("utf8"));
  const correctionTaskBacklog = JSON.parse(backlogBytes.toString("utf8"));
  const correctionVerification = JSON.parse(verificationBytes.toString("utf8"));

  const baseInputPaths = [glbPath, manifestPath, reviewPath, backlogPath, verificationPath];
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
      // Missing or unreadable render files remain absent in the evidence list;
      // the readiness gate records a blocker instead of trusting the manifest.
    }
  }
  if ([...baseInputPaths, ...renderFilePaths].includes(outputPath)) {
    throw new Error("Output path must differ from every input file, including rendered PNGs.");
  }

  const candidateGlbSha256 = sha256(glbBytes);
  const renderManifestSha256 = sha256(manifestBytes);

  // Re-run both structural audits from the exact candidate bytes, rather than
  // trusting separate QA reports that may have been created from another GLB.
  const geometryQa = analyzeGlbQuality(glbBytes);
  const textureQa = reviewGlbTextureBindings(glbBytes);
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
    publicationEligible: readiness.publicationEligible,
  }, null, 2));
  if (readiness.status === "blocked") process.exitCode = 2;
}

main().catch((error) => {
  console.error("Could not build building release readiness report:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
