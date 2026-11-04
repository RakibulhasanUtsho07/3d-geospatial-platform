#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { publishEvidenceBackedVerticalSlice } from "../src/core/building-generation/publish-evidence-backed-vertical-slice.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.length !== 1) {
  console.log("Usage: node scripts/publish-evidence-backed-vertical-slice.mjs <publication-config.json>");
  console.log("The config must provide workspaceRoot, reportPath, attestationPath, reviewReceiptPath and publicRoot.");
  console.log("Set RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON in the runtime environment; never put keys in the config.");
  process.exit(args.includes("--help") ? 0 : 2);
}

const configPath = path.resolve(process.cwd(), args[0]);
const config = JSON.parse(await readFile(configPath, "utf8"));
const result = await publishEvidenceBackedVerticalSlice({
  ...config,
  workspaceRoot: path.resolve(config.workspaceRoot ?? path.dirname(configPath)),
  publicRoot: path.resolve(config.publicRoot),
});
console.log(JSON.stringify({
  status: "explicitly-published-to-generated-model-catalog",
  modelId: result.modelId,
  versionId: result.versionId,
  assetUrl: result.assetUrl,
  sha256: result.sha256,
  parentReportSha256: result.parentReportSha256,
  sourceSetSha256: result.sourceSetSha256,
  signedReviewPayloadSha256: result.signedReviewPayloadSha256,
  reviewerAuthentication: result.reviewerAuthentication,
  mapReady: false,
  publicationEligible: false,
  note: result.note,
}, null, 2));
