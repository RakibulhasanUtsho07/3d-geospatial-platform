#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessTextureBakeReadiness } from "../src/core/building-generation/texture-bake-readiness.mjs";

async function main() {
  const [inputArg, outputArg, ...flags] = process.argv.slice(2);
  if (!inputArg || !outputArg || path.resolve(inputArg) === path.resolve(outputArg)) {
    throw new Error("Usage: node scripts/assess-texture-bake-readiness.mjs <texture-candidate.json> <bake-readiness.json> [--atlas-width=2048] [--atlas-height=2048]");
  }
  const options = {};
  for (const flag of flags) {
    const match = flag.match(/^--(atlas-width|atlas-height)=(\d+)$/);
    if (!match) throw new Error(`Unknown option: ${flag}`);
    options[match[1] === "atlas-width" ? "atlasWidth" : "atlasHeight"] = Number(match[2]);
  }
  const candidate = JSON.parse(await readFile(path.resolve(inputArg), "utf8"));
  const report = assessTextureBakeReadiness(candidate, options);
  await writeFile(path.resolve(outputArg), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    status: report.status,
    faces: report.faceCount,
    eligibleFaces: report.eligibleFaceIndices.length,
    faceIssues: report.faceIssues.length,
    overlapCandidates: report.overlapCandidates.length,
    publicationEligible: report.publicationEligible,
  }, null, 2));
  if (report.status !== "bake-inputs-ready-for-external-baker") process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
