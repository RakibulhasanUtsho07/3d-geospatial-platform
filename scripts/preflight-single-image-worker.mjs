#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runSingleImageWorkerPreflight } from "../src/core/building-generation/single-image-worker-preflight.mjs";

export async function main(args = process.argv.slice(2), env = process.env) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", default: false },
      python: { type: "string" },
      "runner-script": { type: "string" },
      device: { type: "string" },
      "timeout-ms": { type: "string", default: "10000" },
      json: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log([
      "Usage: node scripts/preflight-single-image-worker.mjs [options]",
      "  --python <python>              Python executable for the worker environment",
      "  --runner-script <path>         Installed TripoSR run.py path",
      "  --device cpu|mps|cuda:N        Device to verify (defaults to BUILDING_ENGINE_DEVICE or cuda:0)",
      "  --timeout-ms <1000..30000>     Bounded probe timeout (default: 10000)",
      "  --json                         Emit machine-readable JSON",
      "",
      "Read-only: checks installed runtime/device and local TripoSR/rembg caches; syntax-compiles run.py in memory.",
      "Does not execute run.py or its --help handler, download weights, create a model, run inference or publish to the map.",
    ].join("\n"));
    return 0;
  }
  if (positionals.length) throw new TypeError("Unexpected positional arguments. Run with --help.");
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    throw new TypeError("--timeout-ms must be an integer from 1000 to 30000.");
  }
  const probeEnv = {
    ...env,
    ...(values.python ? {
      BUILDING_ENGINE_PYTHON_EXECUTABLE: values.python,
      TRIPOSR_PYTHON: values.python,
    } : {}),
    ...(values["runner-script"] ? {
      BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: values["runner-script"],
    } : {}),
    ...(values.device ? { BUILDING_ENGINE_DEVICE: values.device } : {}),
  };
  const report = await runSingleImageWorkerPreflight({
    env: probeEnv,
    commandTimeoutMs: timeoutMs,
  });
  const output = values.json ? JSON.stringify(report, null, 2) : [
    "Single-image worker preflight: " + report.status.toUpperCase(),
    "TripoSR weights: " + report.model.tripoModelWeights,
    "rembg weights: " + report.model.backgroundRemovalWeights,
    ...(report.model.backgroundRemovalModel ? ["rembg model: " + report.model.backgroundRemovalModel] : []),
    ...report.blockers.map((item) => "BLOCKER: " + item),
    ...report.caveats.map((item) => "NOTE: " + item),
    "Release flags: mapReady=false, publicationEligible=false, automaticApproval=false",
  ].join("\n");
  console.log(output);
  return report.status === "ready" ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Single-image worker preflight failed; inspect local worker configuration without sharing secrets.");
    process.exitCode = 2;
  });
}
