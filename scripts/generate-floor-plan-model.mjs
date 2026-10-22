#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { generateFloorPlanGlb } from "../src/core/building-generation/floor-plan-model.mjs";

const USAGE = "Usage: npm run generate:floor-plan-model -- <geometry.json> <output.glb> [original-source-file]";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exitCode = args.length === 0 ? 1 : 0;
    return;
  }
  if (args.length < 2 || args.length > 3) throw new Error(USAGE);
  const inputPath = path.resolve(args[0]);
  const outputPath = path.resolve(args[1]);
  const sourcePath = args[2] ? path.resolve(args[2]) : null;
  if (inputPath === outputPath || (sourcePath && (sourcePath === outputPath || sourcePath === inputPath))) {
    throw new Error("Input geometry, original source and output GLB must use distinct paths.");
  }

  const inputBytes = await readFile(inputPath);
  if (inputBytes.length > 2 * 1024 * 1024) throw new RangeError("Floor-plan geometry JSON must be at most 2 MiB.");
  const floorPlan = JSON.parse(inputBytes.toString("utf8"));
  let verifiedSourceSha256 = null;
  if (sourcePath) {
    const sourceBytes = await readFile(sourcePath);
    if (sourceBytes.length > 100 * 1024 * 1024) {
      throw new RangeError("Original source file must be at most 100 MiB for CLI hash verification.");
    }
    verifiedSourceSha256 = sha256(sourceBytes);
    if (!floorPlan.source?.sha256 || floorPlan.source.sha256.toLowerCase() !== verifiedSourceSha256) {
      throw new Error("Original source SHA-256 does not match floorPlan.source.sha256; refusing to generate.");
    }
  }

  const result = generateFloorPlanGlb(floorPlan);
  if (verifiedSourceSha256) {
    result.report.input.sourceEvidenceVerified = true;
    result.report.input.verifiedSourceSha256 = verifiedSourceSha256;
    result.report.warnings = result.report.warnings.filter(
      (warning) => !warning.startsWith("A source SHA-256 is metadata"),
    );
  }
  const reportPath = outputPath + ".report.json";
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.glb);
  await writeFile(reportPath, JSON.stringify(result.report, null, 2) + "\n");
  console.log(JSON.stringify({
    outputPath,
    reportPath,
    sha256: result.report.output.sha256,
    byteSize: result.report.output.byteSize,
    geometry: result.report.geometry,
    mapReady: false,
    publicationEligible: false,
  }, null, 2));
}

main().catch((error) => {
  console.error("[floor-plan-model]", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
