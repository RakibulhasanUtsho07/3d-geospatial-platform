#!/usr/bin/env node
import path from "node:path";
import { publishReviewedBuildingModel } from "../src/core/building-generation/published-model-catalog.mjs";

function usage() {
  console.log("Publish a human-reviewed GLB to the versioned public model catalog.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run publish:building-model -- <workspaceRoot> <candidate.glb> <review-attestation.json>");
  console.log("");
  console.log("The candidate and review evidence must be files inside workspaceRoot.");
  console.log("Every required review check must be explicitly true; candidate and evidence hashes are verified.");
  console.log("This command records an operator attestation; it does not independently verify architecture, rights, scale or georeferencing.");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.length !== 3) {
  usage();
  process.exit(args.includes("--help") ? 0 : 2);
}

try {
  const result = await publishReviewedBuildingModel({
    workspaceRoot: path.resolve(args[0]),
    candidatePath: args[1],
    attestationPath: args[2],
  });
  console.log(JSON.stringify({
    status: "published",
    modelId: result.modelId,
    versionId: result.versionId,
    assetUrl: result.assetUrl,
    sha256: result.sha256,
    manifest: path.relative(path.resolve(args[0]), result.manifestPath),
  }, null, 2));
} catch (error) {
  console.error("Model publication refused:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
