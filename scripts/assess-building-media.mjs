#!/usr/bin/env node
import { parseArgs } from "node:util";
import { assessBuildingMediaSources, writeMediaQualityReport } from "../src/core/building-generation/media-quality-preflight.mjs";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    ffmpeg: { type: "string" },
    "timeout-ms": { type: "string", default: "60000" },
    "near-duplicate-threshold": { type: "string", default: "5" },
  },
});
if (positionals.length !== 3 || process.argv.includes("--help")) {
  console.log("Usage: node scripts/assess-building-media.mjs <workspaceRoot> <buildingId> <sourceId1,sourceId2,...> [--ffmpeg <executable>] [--timeout-ms 60000] [--near-duplicate-threshold 5]\nRuns a local, non-destructive image quality preflight (dimensions, sharpness, luminance, perceptual near-duplicates). It does not reconstruct a mesh or prove camera overlap.");
  process.exit(process.argv.includes("--help") ? 0 : 2);
}
const [workspaceRoot, buildingId, idsCsv] = positionals;
const sourceIds = idsCsv.split(",").map(value => value.trim()).filter(Boolean);
const timeoutMs = Number(values["timeout-ms"]);
const nearDuplicateThreshold = Number(values["near-duplicate-threshold"]);
if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 300000) throw new RangeError("--timeout-ms must be 5000–300000");
if (!Number.isInteger(nearDuplicateThreshold) || nearDuplicateThreshold < 0 || nearDuplicateThreshold > 64) throw new RangeError("--near-duplicate-threshold must be 0–64");
const options = { workspaceRoot, buildingId, sourceIds, timeoutMs, nearDuplicateThreshold, ffmpegPath: values.ffmpeg };
const report = await assessBuildingMediaSources(options);
const reportPath = await writeMediaQualityReport(options, report);
console.log(JSON.stringify({
  reportPath,
  buildingId: report.buildingId,
  sourceCount: report.sourceCount,
  uniqueContentCount: report.uniqueContentCount,
  qualityAnalysisComplete: report.qualityAnalysisComplete,
  rightsApproved: report.rightsApproved,
  reconstructionCandidate: report.reconstructionCandidate,
  safeToSubmitToColmap: report.safeToSubmitToColmap,
  nearDuplicatePairs: report.nearDuplicatePairs,
  warnings: report.warnings,
}, null, 2));
