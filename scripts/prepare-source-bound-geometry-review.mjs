#!/usr/bin/env node
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { prepareSourceBoundGeometryReview } from "../src/core/building-generation/source-bound-authenticated-review.mjs";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
  },
});

function usage() {
  console.log([
    "Prepare a candidate-bound geometry QA report and unsigned review template.",
    "",
    "Usage:",
    "  node scripts/prepare-source-bound-geometry-review.mjs <workspaceRoot> <buildingId> <handoffJobId> <output.json>",
    "",
    "The output contains the exact candidate geometry report, hash-bound decision template and Ed25519 signing instructions.",
    "It does not accept a reviewer decision or access a private key. A signed decision must be submitted to the authenticated review API.",
    "Output is review-only and cannot approve, publish or place a model on the map.",
  ].join("\n"));
}

if (values.help) {
  usage();
  process.exit(0);
}

if (positionals.length !== 4) {
  usage();
  process.exit(2);
}

const [workspaceRootArg, buildingId, handoffJobId, outputArg] = positionals;
const workspaceRoot = await realpath(path.resolve(workspaceRootArg));
if (path.isAbsolute(outputArg) || outputArg.includes("\\") ||
    outputArg.split("/").some((part) => !part || part === "." || part === "..")) {
  throw new TypeError("Output path must be a safe workspace-relative POSIX path.");
}
const outputPath = path.resolve(workspaceRoot, ...outputArg.split("/"));
const relative = path.relative(workspaceRoot, outputPath);
if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
  throw new TypeError("Output path must remain inside workspaceRoot.");
}
const segments = relative.split(path.sep);
let current = workspaceRoot;
for (let index = 0; index < segments.length - 1; index += 1) {
  current = path.join(current, segments[index]);
  try {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError("Output path must not traverse symlinks or non-directory parents.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(current, { mode: 0o700 });
  }
}
const parent = await realpath(path.dirname(outputPath));
if (parent !== workspaceRoot && !parent.startsWith(workspaceRoot + path.sep)) {
  throw new TypeError("Output directory resolves outside workspaceRoot.");
}
try {
  await lstat(outputPath);
  throw new TypeError("Refusing to overwrite an existing geometry-review packet.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const result = await prepareSourceBoundGeometryReview({
  workspaceRoot,
  buildingId,
  handoffJobId,
});
const packet = {
  schemaVersion: "1.0.0",
  recordType: "source-bound-geometry-review-packet",
  generatedFor: {
    buildingId,
    handoffJobId,
    handoffArtifactSha256: result.handoffArtifactSha256,
    candidateGlbSha256: result.candidateSha256,
    candidateByteLength: result.candidateByteLength,
  },
  geometryReport: result.geometryReport,
  geometryReportSha256: result.geometryReportSha256,
  submissionTemplate: result.submissionTemplate,
  signingInstructions: result.signingInstructions,
  limitations: [
    "This packet contains an unsigned review template; it is not a completed human decision.",
    "A signature is verified only against the server-configured trusted reviewer key for reviewerId.",
    "GLB geometry QA does not prove architectural fidelity, building identity, metric scale, survey truth or independent accuracy.",
    "No release, publication, dispatch or map-ready flag is changed.",
  ],
};
await writeFile(outputPath, JSON.stringify(packet, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify({
  outputPath: path.relative(workspaceRoot, outputPath).split(path.sep).join("/"),
  handoffJobId,
  candidateGlbSha256: result.candidateSha256,
  geometryReportSha256: result.geometryReportSha256,
  geometryStatus: result.geometryReport.geometryStatus,
  signatureRequired: true,
  privateKeyHandledByServer: false,
  candidateGeometryValidated: false,
  acceptanceEligible: false,
  publicationEligible: false,
  mapReady: false,
}, null, 2));
