#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyTilesetPackage } from "../src/core/geospatial/tileset-package-integrity.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

function parseArgs(argv) {
  const args = { directory: null, expectedSourceSha256: null, maxTotalBytes: 512 * 1024 * 1024 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--package") args.directory = path.resolve(value);
    else if (flag === "--source-sha256") args.expectedSourceSha256 = value;
    else if (flag === "--max-total-bytes") args.maxTotalBytes = Number(value);
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  if (!args.directory) args.directory = path.join(projectRoot, "data/overture/dhaka-3d-tiles-multibuilding-pilot");
  if (args.expectedSourceSha256 && !/^[a-f0-9]{64}$/i.test(args.expectedSourceSha256)) {
    throw new Error("--source-sha256 must be a 64-character hexadecimal SHA-256.");
  }
  if (!Number.isSafeInteger(args.maxTotalBytes) || args.maxTotalBytes < 1) {
    throw new Error("--max-total-bytes must be a positive safe integer.");
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await verifyTilesetPackage({
      directory: args.directory,
      expectedSourceSha256: args.expectedSourceSha256,
      maxTotalBytes: args.maxTotalBytes,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.valid) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
