#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyBuildingBenchmarkAssetBytes } from "../src/core/building-generation/building-benchmark-asset-verification.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--help")) {
  console.log("Usage: node scripts/verify-building-benchmark-asset-bytes.mjs <manifest.json> --root <asset-root>\nVerifies each declared localPath against the actual file byte size and streamed SHA-256. It does not download files, validate licence truth, prove building identity or survey alignment, run reconstruction or approve a model.");
  process.exitCode = 0;
} else {
  let manifestPath = null;
  let assetRoot = null;
  let invalidArgs = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root") {
      if (assetRoot !== null || !args[index + 1] || args[index + 1].startsWith("--")) {
        invalidArgs = true;
        break;
      }
      assetRoot = args[index + 1];
      index += 1;
    } else if (args[index].startsWith("--") || manifestPath !== null) {
      invalidArgs = true;
      break;
    } else {
      manifestPath = args[index];
    }
  }

  if (invalidArgs || !manifestPath || !assetRoot) {
    console.error("Usage: node scripts/verify-building-benchmark-asset-bytes.mjs <manifest.json> --root <asset-root>");
    process.exitCode = 2;
  } else {
    try {
      const absoluteManifestPath = path.resolve(manifestPath);
      const manifest = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
      const report = await verifyBuildingBenchmarkAssetBytes(manifest, { assetRoot });
      console.log(JSON.stringify({
        manifestPath: absoluteManifestPath,
        ...report,
      }, null, 2));
      if (report.status !== "verified") process.exitCode = 2;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
