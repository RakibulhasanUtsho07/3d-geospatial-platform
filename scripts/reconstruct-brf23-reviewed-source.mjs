#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runBrf23AuthorizedColmapReconstruction } from "../src/core/building-generation/brf23-reconstruction-executor.mjs";

const usage = "Usage: node scripts/reconstruct-brf23-reviewed-source.mjs <workspaceRoot> <buildingSpec.json> <jobId> <sourceId1,sourceId2,sourceId3> <artifactRoot> <imageRoot> <decision.json> <profile.json> <preflight-report.json> <expected-report-sha256> --confirm-execute-reviewed-preflight\n" +
  "Revalidates hash-pinned BRF-23 inputs before executing the local-only COLMAP worker. Result is review-only and not georeferenced.";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
    "confirm-execute-reviewed-preflight": { type: "boolean", default: false },
    quality: { type: "string", default: "MEDIUM" },
    "timeout-ms": { type: "string", default: "3600000" },
    "python-path": { type: "string" },
    "ffmpeg-path": { type: "string" },
  },
});
if (values.help || (positionals.length === 0 && process.argv.includes("--help"))) {
  console.log(usage);
  process.exit(0);
}
if (positionals.length !== 10) {
  console.error(usage);
  process.exit(2);
}
if (!values["confirm-execute-reviewed-preflight"]) {
  console.error("Blocked: pass --confirm-execute-reviewed-preflight to run the reviewed local reconstruction attempt.");
  process.exit(2);
}
const [workspaceRootArg, buildingSpecPath, jobId, sourceIdsCsv, artifactRootArg, imageRootArg,
  decisionName, profilePathArg, preflightReportName, expectedPreflightReportSha256] = positionals;
const buildingSpec = JSON.parse(await readFile(path.resolve(buildingSpecPath), "utf8"));
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 14400000) {
  throw new RangeError("--timeout-ms must be an integer between 5000 and 14400000.");
}
const quality = values.quality.toUpperCase();
if (!["LOW", "MEDIUM", "HIGH", "EXTREME"].includes(quality)) throw new TypeError("Invalid --quality.");
const result = await runBrf23AuthorizedColmapReconstruction({
  workspaceRoot: path.resolve(workspaceRootArg), buildingSpec, buildingId: buildingSpec.id,
  jobId, sourceIds: sourceIdsCsv.split(",").map(value => value.trim()).filter(Boolean),
  artifactRoot: path.resolve(artifactRootArg), imageRoot: path.resolve(imageRootArg),
  decisionName, profilePath: path.resolve(profilePathArg), preflightReportName,
  expectedPreflightReportSha256, confirmExecution: true, pythonPath: values["python-path"],
  ffmpegPath: values["ffmpeg-path"], quality, timeoutMs,
});
console.log(JSON.stringify({
  jobDirectory: path.relative(path.resolve(workspaceRootArg), result.jobDir).split(path.sep).join("/"),
  reportPath: path.relative(path.resolve(workspaceRootArg), result.reportPath).split(path.sep).join("/"),
  authorizationPath: path.relative(path.resolve(workspaceRootArg), result.authorizationPath).split(path.sep).join("/"),
  status: result.report.status, candidateGlb: result.report.outputs?.glb || null,
  candidateGeometryValidated: false, independentReferenceVerified: false,
  heldOutCheckpointAccuracyVerified: false, acceptanceEligible: false,
  publicationEligible: false, mapReady: false, automaticApproval: false,
}, null, 2));
