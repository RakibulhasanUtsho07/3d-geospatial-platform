#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";
import { buildBuildingReleaseReadiness } from "../src/core/building-generation/building-release-readiness.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");


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
  const inputPaths = [glbPath, manifestPath, reviewPath, backlogPath, verificationPath];
  if (new Set([...inputPaths, outputPath]).size !== inputPaths.length + 1) {
    throw new Error("Output path must differ from every input path.");
  }

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
  const candidateGlbSha256 = sha256(glbBytes);
  const renderManifestSha256 = sha256(manifestBytes);

  // Re-run both structural audits from these exact candidate bytes, avoiding reuse
  // of a stale standalone geometry/texture QA report from a previous model revision.
  const geometryQa = analyzeGlbQuality(glbBytes);
  const textureQa = reviewGlbTextureBindings(glbBytes);
  const readiness = buildBuildingReleaseReadiness({
    buildingId: renderReferenceReview.buildingId,
    candidateGlbSha256,
    renderManifest,
    renderManifestSha256,
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
    publicationEligible: readiness.publicationEligible,
  }, null, 2));
  if (readiness.status === "blocked") process.exitCode = 2;
}

main().catch((error) => {
  console.error("Could not build building release readiness report:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
