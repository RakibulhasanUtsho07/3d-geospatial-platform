#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runWireframeQaRepairPasses } from "../src/core/building-generation/wireframe-qa-repair-passes.mjs";

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (const arg of args) {
    if (arg.startsWith("--max-passes=")) options.maxPasses = Number(arg.split("=")[1]);
    else if (arg.startsWith("--max-rms-reprojection-error=")) options.maxRmsReprojectionError = Number(arg.split("=")[1]);
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2 || positional[0] === positional[1]) {
    throw new Error("Usage: node scripts/run-wireframe-qa-repair-passes.mjs <input-wireframe.json> <output-report.json> [--max-passes=3|4] [--max-rms-reprojection-error=3]");
  }
  return { inputPath: path.resolve(positional[0]), outputPath: path.resolve(positional[1]), options };
}

async function main() {
  const { inputPath, outputPath, options } = parseArgs(process.argv.slice(2));
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const report = runWireframeQaRepairPasses(input, options);
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    status: report.status,
    passesExecuted: report.passesExecuted,
    converged: report.converged,
    repairs: report.repairs.length,
    flaggedVertices: report.history.at(-1)?.flaggedVertices.length ?? 0,
    outputPath,
    publicationEligible: report.publicationEligible,
  }, null, 2));
  if (report.status !== "qa-clean") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
