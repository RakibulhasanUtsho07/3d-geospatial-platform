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
      "runner-script": { type: "string" },
      python: { type: "string" },
      device: { type: "string", default: "cuda:0" },
      resolution: { type: "string", default: "256" },
      "timeout-ms": { type: "string", default: "1800000" },
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
      "    --confirm-source-rights",
      "    --confirm-operation-scopes",
      "    --confirm-single-view-inference",
      "    --confirm-model-licences",
      "    [--python <python>] [--device cuda:0|mps|cpu] [--resolution 256] [--timeout-ms 1800000]",
      "",
      "Runs one real TripoSR inference through the same media-to-model workflow as the queue worker.",
      "Requires both TripoSR and rembg model caches to be present; no model downloads are performed.",
      "Writes a private hash-bound smoke report under .building-engine/runtime-smokes/.",
      "The result is AI-proposed and requires human review; it is never published to /map.",
    ].join("\n"));
    return;
  }

  if (positionals.length !== 5 || !values.licence || !values["runner-script"]) {
    throw new TypeError("Five positionals, --licence and --runner-script are required. Run with --help for usage.");
  }

  const [workspaceRoot, specPath, jobId, sourceId, sourceRelativePath] = positionals;
  const buildingSpec = JSON.parse(await readFile(path.resolve(specPath), "utf8"));
  const timeoutMs = Number(values["timeout-ms"]);
  const mcResolution = Number(values.resolution);
  if (!Number.isInteger(timeoutMs) || !Number.isInteger(mcResolution)) {
    throw new TypeError("--timeout-ms and --resolution must be integers.");
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
    runnerScript: values["runner-script"],
    pythonPath: values.python,
    device: values.device,
    mcResolution,
    timeoutMs,
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
