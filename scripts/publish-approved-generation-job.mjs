#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { publishApprovedGenerationJob } from "../src/core/building-generation/publish-approved-generation-job.mjs";

function usage() {
  console.log("Publish one reviewed generation job into the versioned GLB catalog.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run publish:approved-generation-job -- <workspaceRoot> <jobId> --review-receipt <receipt.json> --longitude <deg> --latitude <deg> --height <metres>");
  console.log("");
  console.log("Optional placement: --heading <deg> --pitch <deg> --roll <deg> --scale <factor> --up-axis X|Y|Z --forward-axis X|Y|Z");
  console.log("Height is interpreted as WGS84 ellipsoid height. The complete transform must match the immutable approved review exactly.");
  console.log("The signed Ed25519 receipt must bind the exact review record, GLB, QA report and placement; trust anchors come from RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON.");
  console.log("Publication is explicit; no job is published automatically.");
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
      "review-receipt": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    usage();
    return;
  }
  if (positionals.length !== 2) throw new TypeError("Expected workspaceRoot and jobId.");
  if (typeof values["review-receipt"] !== "string") {
    throw new TypeError("--review-receipt is required.");
  }
  const receiptPath = path.resolve(values["review-receipt"]);
  const receiptInfo = await lstat(receiptPath);
  if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile() || receiptInfo.size < 1 || receiptInfo.size > 8 * 1024) {
    throw new TypeError("--review-receipt must identify a regular JSON file no larger than 8 KiB.");
  }
  const reviewReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const longitude = numberOption(values.longitude, "--longitude");
  const latitude = numberOption(values.latitude, "--latitude");
  const height = numberOption(values.height, "--height");
  if (longitude === undefined || latitude === undefined || height === undefined) {
    throw new TypeError("--longitude, --latitude and --height are all required.");
  }

  const result = await publishApprovedGenerationJob({
    workspaceRoot: path.resolve(positionals[0]),
    jobId: positionals[1],
    reviewReceipt,
    placement: {
      position: { longitude, latitude, height },
      heightReference: "WGS84-ellipsoid",
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
    placementHeightReference: result.placementHeightReference,
    placementSha256: result.placementSha256,
    signedReviewPayloadSha256: result.signedReviewPayloadSha256,
    signedReviewReceiptSha256: result.signedReviewReceiptSha256,
    reviewerAuthentication: result.reviewerAuthentication,
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
