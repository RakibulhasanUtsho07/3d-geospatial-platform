#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewTextureProjection } from "../src/core/building-generation/texture-projection-review.mjs";

async function main() {
  const [inputArg, outputArg, ...flags] = process.argv.slice(2);
  if (!inputArg || !outputArg || path.resolve(inputArg) === path.resolve(outputArg)) {
    throw new Error("Usage: node scripts/review-texture-projection.mjs <texture-candidate.json> <texture-review.json> [--max-reprojection-error-px=2]");
  }
  const options = {};
  for (const flag of flags) {
    if (flag.startsWith("--max-reprojection-error-px=")) options.maxReprojectionErrorPx = Number(flag.split("=")[1]);
    else throw new Error(`Unknown option: ${flag}`);
  }
  const candidate = JSON.parse(await readFile(path.resolve(inputArg), "utf8"));
  const report = reviewTextureProjection(candidate, options);
  await writeFile(path.resolve(outputArg), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    status: report.status,
    faces: report.faceCount,
    evidenceEligibleFaces: report.evidenceEligibleFaceIndices.length,
    rejectedFaces: report.rejectedFaces.length,
    blockers: report.blockers,
    publicationEligible: report.publicationEligible,
  }, null, 2));
  if (report.status !== "evidence-validation-passed") process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
