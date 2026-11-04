#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { collectGenerationWorkerHostInventory } from "../src/core/building-generation/generation-worker-host-inventory.mjs";

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", default: false },
      python: { type: "string" },
      "runner-script": { type: "string" },
      device: { type: "string" },
      "timeout-ms": { type: "string", default: "180000" },
    },
  });
  if (values.help) {
    console.log([
      "Usage: node scripts/collect-generation-worker-host-inventory.mjs [options]",
      "  --python <python>              Python executable in the worker environment",
      "  --runner-script <path>         Installed TripoSR run.py to fingerprint and syntax-compile",
      "  --device cpu|mps|cuda:N        Selected device (defaults to BUILDING_ENGINE_DEVICE or cuda:0)",
      "  --timeout-ms <1000..180000>    Bounded probe/hash timeout (default: 180000)",
      "",
      "Writes a redacted JSON inventory to stdout. Redirect stdout to a private operator-controlled file if needed.",
      "Imports runtime packages, checks local model-cache readiness and compiles run.py in memory.",
      "Does not execute run.py, instantiate rembg sessions, download model weights or run inference.",
      "Python package imports may have package-specific side effects; this is not an OS sandbox or network firewall.",
      "The report excludes hostnames, usernames, absolute paths, environment values, credentials and raw subprocess logs.",
      "A ready inventory is a precondition only; it does not prove real inference or building accuracy.",
    ].join("\n"));
    return 0;
  }
  if (positionals.length) throw new TypeError("Unexpected positional arguments. Run with --help.");
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) {
    throw new TypeError("--timeout-ms must be an integer from 1000 to 180000.");
  }
  const env = {
    ...process.env,
    ...(values.python ? {
      BUILDING_ENGINE_PYTHON_EXECUTABLE: values.python,
      TRIPOSR_PYTHON: values.python,
    } : {}),
    ...(values["runner-script"] ? {
      BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT: values["runner-script"],
    } : {}),
    ...(values.device ? { BUILDING_ENGINE_DEVICE: values.device } : {}),
  };
  const report = await collectGenerationWorkerHostInventory({
    env,
    pythonPath: values.python ?? env.BUILDING_ENGINE_PYTHON_EXECUTABLE ?? env.TRIPOSR_PYTHON ?? "python",
    runnerScript: values["runner-script"] ?? env.BUILDING_ENGINE_TRIPOSR_RUNNER_SCRIPT,
    device: values.device ?? env.BUILDING_ENGINE_DEVICE ?? "cuda:0",
    commandTimeoutMs: timeoutMs,
  });
  console.log(JSON.stringify(report, null, 2));
  return report.status === "ready-for-operator-smoke" ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
