#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { buildBuildingAccuracyBenchmark } from "../src/core/building-generation/building-accuracy-benchmark.mjs";

function usage() {
  console.error("Usage: node scripts/benchmark-building-accuracy.mjs <candidate.glb> <benchmark.json> [report.json]");
  console.error("benchmark.json must identify independently sourced dimensions and their evidence basis.");
  console.error("Optional groundControl and renderReferenceReviewReportPath add georeference and visual-review evidence.");
  process.exitCode = 2;
}

const [, , modelArg, configArg, reportArg] = process.argv;
if (!modelArg || !configArg) {
  usage();
} else {
  try {
    const modelPath = path.resolve(modelArg);
    const configPath = path.resolve(configArg);
    const [glb, configText] = await Promise.all([readFile(modelPath), readFile(configPath)]);
    const config = JSON.parse(configText.toString("utf8"));
    if (config.schemaVersion !== "1.0.0") {
      throw new TypeError("benchmark.json schemaVersion must be 1.0.0");
    }
    const candidateGlbSha256 = createHash("sha256").update(glb).digest("hex");
    const geometryQa = analyzeGlbQuality(glb);
    let renderReferenceReview;
    if (config.renderReferenceReviewReportPath !== undefined) {
      if (typeof config.renderReferenceReviewReportPath !== "string" || !config.renderReferenceReviewReportPath.trim()) {
        throw new TypeError("renderReferenceReviewReportPath must be a non-empty relative or absolute path");
      }
      const reviewPath = path.resolve(path.dirname(configPath), config.renderReferenceReviewReportPath);
      renderReferenceReview = JSON.parse((await readFile(reviewPath)).toString("utf8"));
    }
    const report = {
      ...buildBuildingAccuracyBenchmark({
        buildingId: config.buildingId,
        candidateGlbSha256,
        geometryQa,
        dimensionReference: config.dimensionReference,
        groundControl: config.groundControl,
        renderReferenceReview,
      }),
      input: {
        modelFile: path.basename(modelPath),
        modelBytes: glb.length,
        benchmarkConfigFile: path.basename(configPath),
        renderReferenceReviewReportFile: config.renderReferenceReviewReportPath
          ? path.basename(config.renderReferenceReviewReportPath) : null,
      },
    };
    const serialized = JSON.stringify(report, null, 2) + "\n";
    if (reportArg) await writeFile(path.resolve(reportArg), serialized, "utf8");
    else process.stdout.write(serialized);
    if (report.status !== "benchmark-passed-review-required") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
