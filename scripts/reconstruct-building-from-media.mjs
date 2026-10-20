#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runColmapReconstruction } from "../src/core/building-generation/colmap-worker.mjs";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true,
  options: {
    "confirm-same-building": { type: "boolean", default: false },
    "confirm-overlap-reviewed": { type: "boolean", default: false },
    "confirm-up-axis-reviewed": { type: "boolean", default: false },
    "model-distance": { type: "string" }, "real-distance-m": { type: "string" },
    quality: { type: "string", default: "MEDIUM" }, "heading-degrees": { type: "string", default: "0" },
    "colmap-path": { type: "string" }, "ffmpeg-path": { type: "string" }, "timeout-ms": { type: "string", default: "3600000" },
  },
});
if (positionals.length !== 5 || process.argv.includes("--help")) {
  console.log("Usage: node scripts/reconstruct-building-from-media.mjs <workspaceRoot> <buildingSpec.json> <jobId> <sourceId1,sourceId2,sourceId3> <sourceUpAxis>\nRequired flags: --confirm-same-building --confirm-overlap-reviewed --confirm-up-axis-reviewed\nOptional scale calibration: --model-distance <model units> --real-distance-m <metres>\nOptional: --quality LOW|MEDIUM|HIGH|EXTREME --heading-degrees <0..360> --colmap-path <executable> --ffmpeg-path <executable> --timeout-ms <ms>\nRequires COLMAP installed separately. Output is a review-only candidate GLB; no automatic /map publishing occurs.");
  process.exit(process.argv.includes("--help") ? 0 : 2);
}
const [workspaceRootArg, specPathArg, jobId, sourceIdsCsv, upAxis] = positionals;
const sourceIds = sourceIdsCsv.split(",").map(value => value.trim()).filter(Boolean);
const numberOption = (value, label) => { if (value === undefined) return undefined; const number = Number(value); if (!Number.isFinite(number)) throw new TypeError(label + " must be numeric"); return number; };
const modelDistanceUnits = numberOption(values["model-distance"], "--model-distance");
const realDistanceM = numberOption(values["real-distance-m"], "--real-distance-m");
const workspaceRoot = path.resolve(workspaceRootArg);
const buildingSpec = JSON.parse(await readFile(path.resolve(specPathArg), "utf8"));
const result = await runColmapReconstruction({
  workspaceRoot, buildingSpec, buildingId: buildingSpec.id, jobId, sourceIds, upAxis,
  upAxisReviewed: values["confirm-up-axis-reviewed"],
  matchConfirmed: values["confirm-same-building"], overlapReviewed: values["confirm-overlap-reviewed"],
  quality: values.quality, colmapPath: values["colmap-path"], ffmpegPath: values["ffmpeg-path"],
  timeoutMs: numberOption(values["timeout-ms"], "--timeout-ms"),
  headingDegrees: numberOption(values["heading-degrees"], "--heading-degrees"),
  scaleCalibration: { ...(modelDistanceUnits !== undefined ? { modelDistanceUnits } : {}), ...(realDistanceM !== undefined ? { realDistanceM } : {}) },
});
console.log(JSON.stringify({
  jobDirectory: path.relative(workspaceRoot, result.jobDir).split(path.sep).join("/"),
  reportPath: path.relative(workspaceRoot, result.reportPath).split(path.sep).join("/"),
  output: result.report.outputs.glb, status: result.report.status, mapReady: result.report.mapReady,
  publicationEligible: result.report.publicationEligible, warnings: result.report.warnings,
}, null, 2));