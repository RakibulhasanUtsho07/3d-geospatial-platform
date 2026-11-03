#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyBrf36SourceAssetBytes } from "../src/core/building-generation/brf36-source-byte-verifier.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/verify-brf36-source-assets.mjs <manifest.json> [--asset-root DIR] [--report FILE]\nStreams local source files to verify exact declared byte sizes and SHA-256. It makes no network calls, does not verify rights/identity/CRS and never enables release flags.");
  process.exit(0);
}
let manifestArg = null, rootArg = process.cwd(), reportArg = null;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--asset-root" || arg === "--report") {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      console.error(arg + " requires a path.");
      process.exit(2);
    }
    if (arg === "--asset-root") rootArg = value;
    else reportArg = value;
    i += 1;
  } else if (arg.startsWith("--")) {
    console.error("Unknown option: " + arg);
    process.exit(2);
  } else if (manifestArg === null) manifestArg = arg;
  else {
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
  const report = await verifyBrf36SourceAssetBytes(manifest, path.resolve(rootArg));
  if (reportArg) {
    const reportPath = path.resolve(reportArg);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "source-bytes-verified-review-required") process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
