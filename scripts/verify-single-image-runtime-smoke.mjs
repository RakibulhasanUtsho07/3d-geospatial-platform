#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { verifySingleImageRuntimeSmoke } from "../src/core/building-generation/verify-single-image-runtime-smoke.mjs";

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { help: { type: "boolean", default: false } },
  });
  if (values.help) {
    console.log("Usage: node scripts/verify-single-image-runtime-smoke.mjs <workspaceRoot> <jobId>");
    console.log("Re-hashes the source, workflow report, immutable artifact receipt and private GLB; independently checks geometry QA and false release flags.");
    console.log("This verifies evidence integrity; it does not verify reconstruction accuracy or source/model licences.");
    return;
  }
  if (positionals.length !== 2) {
    throw new TypeError("workspaceRoot and jobId are required. Run with --help for usage.");
  }
  const [workspaceRoot, jobId] = positionals;
  const result = await verifySingleImageRuntimeSmoke({
    workspaceRoot: path.resolve(workspaceRoot),
    jobId,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
