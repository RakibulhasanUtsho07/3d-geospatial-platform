#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { generateBuildingAsset } from "../src/core/building-generation/generation-pipeline.mjs";

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "confirm-paid-provider-generation": { type: "boolean", default: false },
    model: { type: "string", default: "v3.1-20260211" },
    "geometry-quality": { type: "string", default: "detailed" },
    "texture-quality": { type: "string", default: "detailed" },
    "poll-interval-ms": { type: "string", default: "5000" },
    "max-poll-attempts": { type: "string", default: "120" },
  },
});
const { values, positionals } = parsed;
if (process.argv.includes("--help")) {
  console.log(
    "Usage: TRIPO_API_KEY=<server secret> npm run generate:building-from-brief -- <workspaceRoot> <buildingSpec.json> <jobId> --confirm-paid-provider-generation [--model v3.1-20260211] [--geometry-quality standard|detailed] [--texture-quality standard|detailed|extreme]\n" +
    "This sends a text prompt to Tripo V3. The resulting GLB is AI-proposed, review-only, unscaled and not georeferenced. The provider may consume account credits.",
  );
  process.exit(0);
}
if (positionals.length !== 3) {
  console.error("Expected <workspaceRoot> <buildingSpec.json> <jobId>. Run with --help for usage.");
  process.exit(2);
}
if (values["confirm-paid-provider-generation"] !== true) {
  console.error("Refusing to call the paid provider without --confirm-paid-provider-generation.");
  process.exit(2);
}
if (!process.env.TRIPO_API_KEY) {
  console.error("TRIPO_API_KEY must be configured in the server environment; do not pass it as a command-line argument.");
  process.exit(2);
}
const [workspaceRoot, specPath, jobId] = positionals;
const buildingSpec = JSON.parse(await readFile(specPath, "utf8"));
const pollIntervalMs = Number(values["poll-interval-ms"]);
const maxPollAttempts = Number(values["max-poll-attempts"]);
const result = await generateBuildingAsset(buildingSpec, {
  strategy: "tripo-text",
  tripo: {
    workspaceRoot,
    jobId,
    allowPaidProviderGeneration: true,
    model: values.model,
    geometryQuality: values["geometry-quality"],
    textureQuality: values["texture-quality"],
    pollIntervalMs,
    maxPollAttempts,
  },
});
console.log(JSON.stringify({
  mode: result.mode,
  status: result.report.status,
  modelPath: result.modelPath,
  reportPath: result.reportPath,
  mapReady: result.report.mapReady,
  publicationEligible: result.report.publicationEligible,
  automaticApproval: result.report.automaticApproval,
}, null, 2));
