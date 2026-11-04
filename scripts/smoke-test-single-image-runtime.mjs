#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runSingleImageRuntimeSmoke } from "../src/core/building-generation/single-image-runtime-smoke.mjs";

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", default: false },
      licence: { type: "string" },
      author: { type: "string" },
      attribution: { type: "string" },
      "triposr-licence-review": { type: "string" },
      "rembg-licence-review": { type: "string" },
      "runner-script": { type: "string" },
      python: { type: "string" },
      device: { type: "string", default: "cuda:0" },
      resolution: { type: "string", default: "256" },
      "timeout-ms": { type: "string", default: "1800000" },
      "inventory-timeout-ms": { type: "string", default: "180000" },
      "confirm-source-rights": { type: "boolean", default: false },
      "confirm-operation-scopes": { type: "boolean", default: false },
      "confirm-single-view-inference": { type: "boolean", default: false },
      "confirm-model-licences": { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log([
      "Usage:",
      "  node scripts/smoke-test-single-image-runtime.mjs <workspaceRoot> <buildingSpec.json> <jobId> <sourceId> <workspace-relative-image-path>",
      "    --licence <source-rights-basis>",
      "    --runner-script <TripoSR-repo/run.py>",
      "    --triposr-licence-review <code/checkpoint licence basis>",
      "    --rembg-licence-review <rembg weight licence basis>",
      "    --confirm-source-rights",
      "    --confirm-operation-scopes",
      "    --confirm-single-view-inference",
      "    --confirm-model-licences",
      "    [--python <python>] [--device cuda:0|mps|cpu] [--resolution 256] [--timeout-ms 1800000] [--inventory-timeout-ms 180000]",
      "",
      "Runs one real TripoSR inference through the same media-to-model workflow as the queue worker.",
      "Requires both TripoSR and rembg model caches to be present; no model downloads are performed.",
      "Writes a private hash-bound smoke report under .building-engine/runtime-smokes/.",
      "The result is AI-proposed and requires human review; it is never published to /map.",
    ].join("\n"));
    return;
  }

  if (positionals.length !== 5 || !values.licence || !values["runner-script"] ||
      !values["triposr-licence-review"] || !values["rembg-licence-review"]) {
    throw new TypeError("Five positionals, --licence, --runner-script and both model-licence review statements are required. Run with --help for usage.");
  }

  const [workspaceRoot, specPath, jobId, sourceId, sourceRelativePath] = positionals;
  const buildingSpec = JSON.parse(await readFile(path.resolve(specPath), "utf8"));
  const timeoutMs = Number(values["timeout-ms"]);
  const mcResolution = Number(values.resolution);
  const inventoryTimeoutMs = Number(values["inventory-timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || !Number.isInteger(mcResolution) ||
      !Number.isInteger(inventoryTimeoutMs) || inventoryTimeoutMs < 1000 || inventoryTimeoutMs > 180000) {
    throw new TypeError("--timeout-ms and --resolution must be integers; --inventory-timeout-ms must be an integer from 1000 to 180000.");
  }

  const result = await runSingleImageRuntimeSmoke({
    workspaceRoot: path.resolve(workspaceRoot),
    buildingSpec,
    jobId,
    sourceId,
    sourceRelativePath,
    licence: values.licence,
    author: values.author,
    attribution: values.attribution,
    triposrLicenceReview: values["triposr-licence-review"],
    rembgLicenceReview: values["rembg-licence-review"],
    runnerScript: values["runner-script"],
    pythonPath: values.python,
    device: values.device,
    mcResolution,
    timeoutMs,
    inventoryTimeoutMs,
    confirmSourceRights: values["confirm-source-rights"],
    confirmOperationScopes: values["confirm-operation-scopes"],
    confirmSingleViewInference: values["confirm-single-view-inference"],
    confirmModelLicences: values["confirm-model-licences"],
  });

  console.log(JSON.stringify({
    status: result.report.status,
    jobId: result.report.jobId,
    reportPath: path.relative(path.resolve(workspaceRoot), result.reportPath).split(path.sep).join("/"),
    readiness: result.report.readiness,
    source: result.report.source,
    model: result.report.model,
    inference: result.report.inference,
    output: result.report.output,
    geometryQa: result.report.geometryQa,
    generationArtifactReceipt: result.report.generationArtifactReceipt,
    mapReady: result.report.mapReady,
    publicationEligible: result.report.publicationEligible,
    automaticApproval: result.report.automaticApproval,
  }, null, 2));
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
