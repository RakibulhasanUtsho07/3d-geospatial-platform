#!/usr/bin/env node
import { parseArgs } from "node:util";
import { prepareSourceBoundReconstructionHandoff } from "../src/core/building-generation/source-bound-reconstruction-handoff.mjs";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
    "visual-bundle": { type: "string" },
    "reconstruction-evidence": { type: "string" },
    "candidate-glb": { type: "string" },
    "qa-report": { type: "string" },
  },
});

function usage() {
  console.log([
    "Prepare an immutable, review-only candidate evidence hand-off.",
    "",
    "Usage:",
    "  npm run prepare:source-bound-reconstruction-handoff -- <workspaceRoot> <buildingId> <sourceJobId>",
    "    --visual-bundle <relative-path>",
    "    --reconstruction-evidence <relative-path>",
    "    --candidate-glb <relative-path>",
    "    --qa-report <relative-path>",
    "",
    "All artifact paths must be regular, non-symlink files relative to workspaceRoot.",
    "The source job must be a completed media-to-model workflow with immutable model-generation and report-finalization artifacts.",
    "The resulting hand-off is review-only; it never dispatches a worker, publishes a model or enables map readiness.",
  ].join("\n"));
}

if (values.help) {
  usage();
  process.exit(0);
}

const required = [
  values["visual-bundle"],
  values["reconstruction-evidence"],
  values["candidate-glb"],
  values["qa-report"],
];
if (positionals.length !== 3 || required.some((value) => typeof value !== "string" || !value.trim())) {
  usage();
  process.exit(2);
}

const [workspaceRoot, buildingId, sourceJobId] = positionals;
try {
  const result = await prepareSourceBoundReconstructionHandoff({
    workspaceRoot,
    buildingId,
    sourceJobId,
    visualBundlePath: values["visual-bundle"],
    reconstructionEvidencePath: values["reconstruction-evidence"],
    candidateGlbPath: values["candidate-glb"],
    qaReportPath: values["qa-report"],
  });
  console.log(JSON.stringify({
    handoffJobId: result.handoffJobId,
    disposition: result.disposition,
    handoffPrepared: result.handoffPrepared,
    reused: result.reused,
    artifactId: result.artifact?.artifactId ?? null,
    artifactSha256: result.artifact?.contentSha256 ?? null,
    dispatchAllowed: result.handoff?.dispatchAllowed ?? false,
    publicationEligible: result.handoff?.policy?.publicationEligible ?? false,
    mapReady: result.handoff?.policy?.mapReady ?? false,
  }, null, 2));
  if (result.disposition === "blocked") process.exitCode = 2;
} catch (error) {
  console.error("Candidate evidence hand-off refused:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
