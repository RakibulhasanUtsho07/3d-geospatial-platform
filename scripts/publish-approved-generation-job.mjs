#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { publishApprovedGenerationJob } from "../src/core/building-generation/publish-approved-generation-job.mjs";

function usage() {
  console.log("Publish one reviewed generation job into the versioned GLB catalog.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run publish:approved-generation-job -- <workspaceRoot> <jobId> --longitude <deg> --latitude <deg> --height <metres>");
  console.log("");
  console.log("Optional placement: --heading <deg> --pitch <deg> --roll <deg> --scale <factor> --up-axis X|Y|Z --forward-axis X|Y|Z");
  console.log("The job must have an immutable approved review whose GLB/report hashes still match. Publication is explicit; no job is published automatically.");
}
function numberOption(value, name) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(name + " must be a finite number.");
  return parsed;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      longitude: { type: "string" },
      latitude: { type: "string" },
      height: { type: "string" },
      heading: { type: "string", default: "0" },
      pitch: { type: "string", default: "0" },
      roll: { type: "string", default: "0" },
      scale: { type: "string", default: "1" },
      "up-axis": { type: "string", default: "Y" },
      "forward-axis": { type: "string", default: "Z" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    usage();
    return;
  }
  if (positionals.length !== 2) throw new TypeError("Expected workspaceRoot and jobId.");
  const longitude = numberOption(values.longitude, "--longitude");
  const latitude = numberOption(values.latitude, "--latitude");
  const height = numberOption(values.height, "--height");
  if (longitude === undefined || latitude === undefined || height === undefined) {
    throw new TypeError("--longitude, --latitude and --height are all required.");
  }

  const result = await publishApprovedGenerationJob({
    workspaceRoot: path.resolve(positionals[0]),
    jobId: positionals[1],
    placement: {
      position: { longitude, latitude, height },
      headingDegrees: numberOption(values.heading, "--heading"),
      pitchDegrees: numberOption(values.pitch, "--pitch"),
      rollDegrees: numberOption(values.roll, "--roll"),
      scale: numberOption(values.scale, "--scale"),
      upAxis: values["up-axis"],
      forwardAxis: values["forward-axis"],
    },
  });
  console.log(JSON.stringify({
    status: "published-reviewed-version",
    modelId: result.modelId,
    versionId: result.versionId,
    assetUrl: result.assetUrl,
    modelSha256: result.modelSha256,
    reportSha256: result.reportSha256,
    reviewId: result.reviewId,
    placement: result.placement,
    mapReady: false,
    publicationEligible: false,
    note: result.note,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Approved-job publication refused:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
