#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { publishReviewedFloorPlanModelCandidate } from "../src/core/building-generation/floor-plan-model-review.mjs";

function usage() {
  console.log("Publish one explicitly approved floor-plan candidate to the versioned map catalog.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run publish:floor-plan-candidate -- <workspaceRoot> <buildingId> <candidateId> --review-receipt <receipt.json>");
  console.log("");
  console.log("A prior approved review, trusted Ed25519 receipt, verified source rights, explicit placement, evidence hashes and the GLB/report/geometry hashes are required.");
  console.log("This command is the publication step; review submission never auto-publishes a model.");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length !== 5 || args[3] !== "--review-receipt") {
  usage();
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 2);
}

try {
  const receiptPath = path.resolve(args[4]);
  const receiptInfo = await lstat(receiptPath);
  if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile() || receiptInfo.size < 1 || receiptInfo.size > 8 * 1024) {
    throw new TypeError("--review-receipt must identify a regular JSON file no larger than 8 KiB.");
  }
  const reviewReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const result = await publishReviewedFloorPlanModelCandidate({
    workspaceRoot: path.resolve(args[0]),
    buildingId: args[1],
    candidateId: args[2],
    reviewReceipt,
  });
  console.log(JSON.stringify({
    status: "published",
    candidateId: result.candidateId,
    reviewId: result.reviewId,
    modelId: result.modelId,
    versionId: result.versionId,
    assetUrl: result.assetUrl,
    sha256: result.sha256,
    reviewerAuthentication: result.reviewerAuthentication,
    signedReviewReceiptSha256: result.signedReviewReceiptSha256,
    mapReady: false,
    publicationEligible: false,
  }, null, 2));
} catch (error) {
  console.error("Floor-plan publication refused:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
