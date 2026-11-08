#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runEvidenceBackedVerticalSlice } from "../src/core/building-generation/evidence-backed-vertical-slice.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.length !== 1) {
  console.log("Usage: node scripts/run-evidence-backed-vertical-slice.mjs <options.json>");
  process.exit(args.includes("--help") ? 0 : 2);
}

const configPath = path.resolve(process.cwd(), args[0]);
const options = JSON.parse(await readFile(configPath, "utf8"));
if (!options.workspaceRoot) options.workspaceRoot = path.dirname(configPath);
const result = await runEvidenceBackedVerticalSlice(options);
console.log(JSON.stringify({
  status: result.report.status,
  reportPath: result.reportPath,
  candidateGlbAvailable: result.report.acceptance.candidateGlbAvailable,
  texturedGlbAvailable: result.report.acceptance.texturedGlbAvailable,
  blockerCount: result.report.blockers.length,
  acceptanceEligible: result.report.acceptance.acceptanceEligible,
  publicationEligible: result.report.acceptance.publicationEligible,
  mapReady: result.report.acceptance.mapReady,
}, null, 2));
if (result.report.status !== "completed-requires-human-review") process.exitCode = 1;
