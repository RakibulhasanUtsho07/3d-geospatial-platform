#!/usr/bin/env node
import path from "node:path";

import { publishReviewedFloorPlanModelCandidate } from "../src/core/building-generation/floor-plan-model-review.mjs";

function usage() {
  console.log("Publish one explicitly approved floor-plan candidate to the versioned map catalog.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run publish:floor-plan-candidate -- <workspaceRoot> <buildingId> <candidateId>");
  console.log("");
  console.log("A prior approved review, verified source rights, explicit placement, evidence hashes and the GLB/report/geometry hashes are required.");
  console.log("This command is the publication step; review submission never auto-publishes a model.");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length !== 3) {
  usage();
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 2);
}

try {
  const result = await publishReviewedFloorPlanModelCandidate({
    workspaceRoot: path.resolve(args[0]),
    buildingId: args[1],
    candidateId: args[2],
  });
  console.log(JSON.stringify({
    status: "published",
    candidateId: result.candidateId,
    reviewId: result.reviewId,
    modelId: result.modelId,
    versionId: result.versionId,
    assetUrl: result.assetUrl,
    sha256: result.sha256,
    mapReady: false,
    publicationEligible: false,
  }, null, 2));
} catch (error) {
  console.error("Floor-plan publication refused:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
