#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyBuildingBenchmarkAssetBytes } from "../src/core/building-generation/building-benchmark-asset-integrity.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/verify-building-benchmark-assets.mjs <manifest.json> [--asset-root <directory>]\nVerifies actual local file byte sizes and SHA-256 values for declared benchmark assets and the candidate GLB. Every asset needs localPath relative to --asset-root and byteSize/sha256 declarations. This does not download assets, validate rights, or approve accuracy.");
  process.exit(0);
}

let manifestArg = null;
let assetRootArg = null;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--asset-root") {
    if (!args[index + 1] || args[index + 1].startsWith("--")) {
      console.error("--asset-root requires a directory path.");
      process.exit(2);
    }
    assetRootArg = args[index + 1];
    index += 1;
  } else if (arg.startsWith("--")) {
    console.error("Unknown option: " + arg);
    process.exit(2);
  } else if (manifestArg === null) {
    manifestArg = arg;
  } else {
    console.error("Expected one manifest path.");
    process.exit(2);
  }
}

if (!manifestArg) {
  console.error("A manifest path is required. Use --help for usage.");
  process.exit(2);
}

try {
  const manifestPath = path.resolve(manifestArg);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const assetRoot = path.resolve(assetRootArg ?? path.dirname(manifestPath));
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, assetRoot);
  console.log(JSON.stringify({
    manifestPath,
    ...report,
  }, null, 2));
  if (report.status !== "verified") process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
