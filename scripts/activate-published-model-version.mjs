#!/usr/bin/env node
import path from "node:path";
import { activatePublishedModelVersion } from "../src/core/building-generation/published-model-catalog.mjs";

function usage() {
  console.log("Activate a previously published GLB version (including rollback).");
  console.log("");
  console.log("Usage:");
  console.log("  npm run activate:building-model-version -- <workspaceRoot> <modelId> <versionId>");
  console.log("");
  console.log("The target asset checksum is re-verified before the catalog pointer is changed.");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.length !== 3) {
  usage();
  process.exit(args.includes("--help") ? 0 : 2);
}

try {
  const result = await activatePublishedModelVersion({
    workspaceRoot: path.resolve(args[0]),
    modelId: args[1],
    versionId: args[2],
  });
  console.log(JSON.stringify({ status: "activated", ...result }, null, 2));
} catch (error) {
  console.error("Model version activation refused:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
