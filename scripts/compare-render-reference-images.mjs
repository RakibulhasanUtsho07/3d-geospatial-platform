#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeRenderImageSimilarity } from "../src/core/building-generation/render-image-similarity-diagnostics.mjs";

function usage() {
  console.error("Usage: node scripts/compare-render-reference-images.mjs <reference.jpg|png> <candidate-render.jpg|png> [report.json]");
  console.error("Metrics are grayscale preview diagnostics only; use images of the same facade and closely matched camera pose.");
  process.exitCode = 2;
}
const [, , referenceArg, candidateArg, reportArg] = process.argv;
if (!referenceArg || !candidateArg || process.argv.includes("--help")) {
  usage();
} else {
  try {
    const report = await analyzeRenderImageSimilarity({
      referenceImagePath: path.resolve(referenceArg),
      candidateImagePath: path.resolve(candidateArg),
    });
    const serialized = JSON.stringify(report, null, 2) + "\n";
    if (reportArg) await writeFile(path.resolve(reportArg), serialized, "utf8");
    else process.stdout.write(serialized);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
