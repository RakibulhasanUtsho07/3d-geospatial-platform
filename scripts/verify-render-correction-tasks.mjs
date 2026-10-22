#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectRenderCorrectionArtifactEvidence } from "../src/core/building-generation/render-correction-artifact-evidence.mjs";
import { verifyRenderCorrectionTasks } from "../src/core/building-generation/render-correction-verification.mjs";

const [, , backlogArg, reviewArg, candidateArg, manifestArg, geometryQaArg, textureQaArg, outputArg] = process.argv;

if (!backlogArg || !reviewArg || !candidateArg || !manifestArg || !geometryQaArg ||
  !textureQaArg || !outputArg || process.argv.length !== 10) {
  console.error("Usage: node scripts/verify-render-correction-tasks.mjs <correction-tasks.json> <new-render-reference-review-report.json> <candidate.glb> <render-review-manifest.json> <geometry-qa-report.json> <texture-qa-report.json> <verification-output.json>");
  process.exit(2);
}

try {
  const backlog = JSON.parse(await readFile(resolve(backlogArg), "utf8"));
  const report = JSON.parse(await readFile(resolve(reviewArg), "utf8"));
  const artifactInspection = await inspectRenderCorrectionArtifactEvidence({
    candidateModelPath: resolve(candidateArg),
    renderManifestPath: resolve(manifestArg),
    geometryQaReportPath: resolve(geometryQaArg),
    textureQaReportPath: resolve(textureQaArg),
    reviewReport: report,
  });
  const verification = verifyRenderCorrectionTasks(backlog, report, artifactInspection.artifactEvidence);
  const outputPath = resolve(outputArg);
  // wx avoids silently replacing a prior verification snapshot.
  await writeFile(outputPath, JSON.stringify(verification, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    output: outputPath,
    buildingId: verification.buildingId,
    taskCount: verification.counts.total,
    verified: verification.counts.verified,
    needsMoreWork: verification.counts.needsMoreWork,
    artifactIntegrity: verification.artifactIntegrity.status,
    publicationEligible: verification.automationPolicy.publicationEligible,
  }, null, 2));
} catch (error) {
  console.error("Could not verify render correction tasks:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
