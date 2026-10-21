#!/usr/bin/env node
import { runArchitecturalGeometryWorkflow } from "../src/core/building-generation/architectural-geometry-workflow.mjs";

function parseArgs(argv) {
  if (argv.includes("--help")) {
    console.log("Usage: node scripts/run-architectural-geometry-workflow.mjs <workspace-root> <building-id> <job-id> <input.json> --confirm-camera-calibration-reviewed --confirm-correspondences-reviewed --confirm-face-definitions-reviewed --confirm-texture-evidence-reviewed [--max-rms-reprojection-error=3] [--max-repair-passes=3] [--max-boundary-edges=0] [--min-triangle-area=0.00000001] [--max-texture-reprojection-error-px=2]");
    console.log("Input JSON requires cameras, manually verified multi-view features, edges, explicit triangular faces and textureCandidate evidence. Input/reference image paths must be relative to workspace-root. Outputs are review candidates, never map-ready.");
    process.exit(0);
  }
  const positional = [];
  const options = {};
  const flags = new Map([
    ["--confirm-camera-calibration-reviewed", "confirmCameraCalibrationReviewed"],
    ["--confirm-correspondences-reviewed", "confirmCorrespondencesReviewed"],
    ["--confirm-face-definitions-reviewed", "confirmFaceDefinitionsReviewed"],
    ["--confirm-texture-evidence-reviewed", "confirmTextureEvidenceReviewed"],
  ]);
  const numeric = new Map([
    ["--max-rms-reprojection-error", "maxRmsReprojectionError"],
    ["--max-repair-passes", "maxRepairPasses"],
    ["--max-boundary-edges", "maxBoundaryEdges"],
    ["--min-triangle-area", "minTriangleArea"],
    ["--max-texture-reprojection-error-px", "maxTextureReprojectionErrorPx"],
  ]);
  for (const arg of argv) {
    if (flags.has(arg)) options[flags.get(arg)] = true;
    else {
      const match = arg.match(/^([^=]+)=(.+)$/);
      if (match && numeric.has(match[1])) {
        const value = Number(match[2]);
        if (!Number.isFinite(value)) throw new TypeError(match[1] + " must be a finite number");
        options[numeric.get(match[1])] = value;
      } else if (arg.startsWith("--")) throw new TypeError("unknown option: " + arg);
      else positional.push(arg);
    }
  }
  if (positional.length !== 4 || argv.includes("--help")) {
    console.log("Usage: node scripts/run-architectural-geometry-workflow.mjs <workspace-root> <building-id> <job-id> <input.json> --confirm-camera-calibration-reviewed --confirm-correspondences-reviewed --confirm-face-definitions-reviewed --confirm-texture-evidence-reviewed [--max-rms-reprojection-error=3] [--max-repair-passes=3] [--max-boundary-edges=0] [--min-triangle-area=0.00000001] [--max-texture-reprojection-error-px=2]");
    console.log("Input JSON requires cameras, manually verified multi-view features, edges, explicit triangular faces and textureCandidate evidence. Input/reference image paths must be relative to workspace-root. Outputs are review candidates, never map-ready.");
    process.exit(argv.includes("--help") ? 0 : 2);
  }
  return {
    options: {
      workspaceRoot: positional[0],
      buildingId: positional[1],
      jobId: positional[2],
      inputPath: positional[3],
      ...options,
    },
  };
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const result = await runArchitecturalGeometryWorkflow(options);
  console.log(JSON.stringify({
    status: result.report.status,
    jobStatus: result.state.status,
    blockerCount: result.report.blockers.length,
    blockers: result.report.blockers,
    reportPath: result.reportPath,
    statePath: result.statePath,
    mapReady: result.report.mapReady,
    publicationEligible: result.report.publicationEligible,
  }, null, 2));
  if (result.report.blockers.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
