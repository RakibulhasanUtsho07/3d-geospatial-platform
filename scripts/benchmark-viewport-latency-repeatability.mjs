import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { buildRepeatabilityReport } from "./viewport-latency-repeatability.mjs";

const sampleCount = Number(process.env.P2_15_SAMPLE_COUNT ?? 4);
const firstPort = Number(process.env.P2_15_FIRST_PORT ?? 3100);
const outputPath = resolve(process.cwd(), process.env.P2_15_REPORT_PATH ?? "p2-15-evidence/viewport-latency-repeatability.json");
const sampleDirectory = resolve(process.cwd(), process.env.P2_15_SAMPLE_DIRECTORY ?? "p2-15-evidence/fresh-process-samples");
const nextBin = resolve(process.cwd(), "node_modules/next/dist/bin/next");
const readyTimeoutMs = Number(process.env.P2_15_READY_TIMEOUT_MS ?? 60000);

assert.ok(Number.isInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 7,
  "P2_15_SAMPLE_COUNT must be an integer between 3 and 7");
assert.ok(Number.isInteger(firstPort) && firstPort >= 1024 && firstPort + sampleCount < 65536,
  "P2_15_FIRST_PORT must be a valid base TCP port");
assert.ok(Number.isInteger(readyTimeoutMs) && readyTimeoutMs >= 10000 && readyTimeoutMs <= 120000,
  "P2_15_READY_TIMEOUT_MS must be between 10000 and 120000");

function spawnCapture(command, args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current, chunk) => (current + chunk.toString()).slice(-24000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(
        command + " exited with code " + code + " (" + signal + ").\n" + (stderr || stdout).slice(-10000),
      ));
    });
  });
}

async function startNext(port) {
  const child = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let spawnError = null;
  let closedResult = null;
  let resolveClosed;
  const closed = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
  const append = (chunk) => { logs = (logs + chunk.toString()).slice(-12000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("error", (error) => { spawnError = error; });
  child.once("close", (code, signal) => {
    closedResult = { code, signal };
    resolveClosed(closedResult);
  });

  const endpoint = "http://127.0.0.1:" + port + "/api/geospatial/overture-buildings/viewport";
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error("Could not launch fresh Next.js process: " + String(spawnError));
    if (closedResult) throw new Error("Next.js process exited before readiness (" + JSON.stringify(closedResult) + ").\n" + logs);
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(2500) });
      await response.arrayBuffer();
      if (response.status === 400) {
        ready = true;
        break;
      }
    } catch {
      // Wait for next start to finish booting; invalid-bound probes must not warm the tile index.
    }
    await delay(250);
  }
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error("Next.js did not become ready within " + readyTimeoutMs + " ms on port " + port + ".\n" + logs);
  }
  return {
    child,
    closed,
    stop: async () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      await Promise.race([closed, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([closed, delay(1000)]);
      }
    },
  };
}

await mkdir(sampleDirectory, { recursive: true });
const sampleReports = [];
const startedAt = new Date().toISOString();
for (let index = 0; index < sampleCount; index += 1) {
  const port = firstPort + index;
  const samplePath = resolve(sampleDirectory, "sample-" + String(index + 1).padStart(2, "0") + ".json");
  const server = await startNext(port);
  try {
    const result = await spawnCapture(process.execPath, ["scripts/benchmark-viewport-cold-warm.mjs"], {
      ...process.env,
      GEOSPATIAL_API_BASE_URL: "http://127.0.0.1:" + port,
      P2_11_REPORT_PATH: samplePath,
    });
    const report = JSON.parse(await readFile(samplePath, "utf8"));
    assert.equal(report.cold.indexReadBytes > 0, true, "sample " + (index + 1) + " must capture a true cold index read");
    sampleReports.push(report);
    console.log("[P2.15 fresh-process sample " + (index + 1) + "] " + result.stdout.trim().split("\n").at(-1));
  } finally {
    await server.stop();
  }
}

const report = buildRepeatabilityReport(sampleReports, {
  startedAt,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
});
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log("[P2.15 fresh-process viewport latency repeatability]", JSON.stringify(report));
