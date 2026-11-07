import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ADAPTER_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const RESULT_MARKER = "D3M26_PROVIDER_RESULT:";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const WORKER_PATH = fileURLToPath(new URL("../../../scripts/trust-registry-governance-provider-process-worker.mjs", import.meta.url));

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be an object.");
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(label + " must contain exactly: " + required.join(", ") + ".");
  }
}

async function assertNoSymlinkComponents(absolutePath) {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  const parts = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error("Provider adapter paths must not contain symbolic links.");
    }
  }
}

async function inspectAdapterModule(modulePath) {
  if (typeof modulePath !== "string" || modulePath.trim() === "" || modulePath.includes("\0")) {
    throw new TypeError("A provider adapter module file path is required.");
  }
  const absolutePath = path.resolve(modulePath);
  await assertNoSymlinkComponents(absolutePath);
  const before = await lstat(absolutePath);
  if (!before.isFile() || before.size < 1 || before.size > MAX_ADAPTER_BYTES) {
    throw new Error("Provider adapter module must be a non-empty regular file within the size limit.");
  }
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Provider adapter module changed while it was being opened.");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || bytes.length !== opened.size) {
      throw new Error("Provider adapter module changed while it was being read.");
    }
  } finally {
    await handle.close();
  }
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new Error("Provider adapter module must use its canonical non-symlink path.");
  }
  return Object.freeze({
    modulePath: canonicalPath,
    moduleSha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function normalizeTimeout(value) {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new TypeError("Provider worker timeout must be an integer from 100 to 120000 milliseconds.");
  }
  return timeoutMs;
}

function normalizeEnvironmentKeys(keys) {
  if (!Array.isArray(keys)) throw new TypeError("allowedEnvironmentKeys must be an array.");
  const normalized = [...new Set(keys)];
  for (const key of normalized) {
    if (typeof key !== "string" || !ENV_KEY.test(key) ||
        ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(key)) {
      throw new TypeError("Provider environment allowlist contains an unsafe variable name.");
    }
  }
  return normalized;
}

function buildWorkerEnvironment(allowedKeys) {
  const environment = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "TZ"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  for (const key of allowedKeys) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return environment;
}

export function createProviderProcessMetrics() {
  return {
    workerProcessesStarted: 0,
    workerInstanceIds: new Set(),
    workerProcessIds: new Set(),
  };
}

function parseWorkerOutput(output) {
  const messages = output.split(/\r?\n/).filter((line) => line.startsWith(RESULT_MARKER));
  if (messages.length !== 1) {
    throw new Error("Provider worker returned an invalid response protocol.");
  }
  let response;
  try {
    response = JSON.parse(messages[0].slice(RESULT_MARKER.length));
  } catch {
    throw new Error("Provider worker returned malformed JSON.");
  }
  if (!response || typeof response !== "object" || Array.isArray(response) ||
      typeof response.ok !== "boolean") {
    throw new Error("Provider worker returned an invalid response envelope.");
  }
  return response;
}

export async function createProcessIsolatedTrustRegistryGovernanceProvider({
  modulePath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowedEnvironmentKeys = [],
  metrics = createProviderProcessMetrics(),
} = {}) {
  const adapter = await inspectAdapterModule(modulePath);
  const timeout = normalizeTimeout(timeoutMs);
  const environmentKeys = normalizeEnvironmentKeys(allowedEnvironmentKeys);
  if (!metrics || typeof metrics !== "object" ||
      !(metrics.workerInstanceIds instanceof Set) ||
      !(metrics.workerProcessIds instanceof Set) ||
      !Number.isSafeInteger(metrics.workerProcessesStarted)) {
    throw new TypeError("Provider process metrics collector is invalid.");
  }
  const environment = buildWorkerEnvironment(environmentKeys);

  async function invoke(operation, args) {
    const request = JSON.stringify({ operation, args });
    if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error("Provider worker request exceeds the size limit.");
    }

    const response = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        WORKER_PATH,
        adapter.modulePath,
        adapter.moduleSha256,
      ], {
        cwd: process.cwd(),
        env: environment,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const outputChunks = [];
      let outputBytes = 0;
      let failure = null;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        failure = new Error("Provider worker timed out after " + timeout + " milliseconds.");
        child.kill("SIGKILL");
      }, timeout);

      child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_RESPONSE_BYTES) {
          failure = new Error("Provider worker response exceeds the size limit.");
          child.kill("SIGKILL");
          return;
        }
        outputChunks.push(Buffer.from(chunk));
      });
      child.on("error", () => finish(new Error("Provider worker could not be started.")));
      child.on("close", (code) => {
        if (failure) {
          finish(failure);
          return;
        }
        let parsed;
        try {
          parsed = parseWorkerOutput(Buffer.concat(outputChunks).toString("utf8"));
        } catch (error) {
          finish(error);
          return;
        }
        if (code !== 0 || parsed.ok !== true) {
          const errorCode = typeof parsed.errorCode === "string" &&
            /^[A-Z0-9_]{1,80}$/.test(parsed.errorCode)
            ? parsed.errorCode
            : "D3M26_PROVIDER_WORKER_FAILED";
          finish(new Error("Provider worker failed (" + errorCode + ")."));
          return;
        }
        if (!Number.isSafeInteger(parsed.workerPid) || parsed.workerPid < 1 ||
            typeof parsed.workerInstanceId !== "string" ||
            !/^[0-9a-f-]{36}$/.test(parsed.workerInstanceId) ||
            !Object.hasOwn(parsed, "result")) {
          finish(new Error("Provider worker response metadata is invalid."));
          return;
        }
        if (metrics.workerInstanceIds.has(parsed.workerInstanceId)) {
          finish(new Error("Provider worker instance identifier was reused."));
          return;
        }
        metrics.workerProcessesStarted += 1;
        metrics.workerInstanceIds.add(parsed.workerInstanceId);
        metrics.workerProcessIds.add(parsed.workerPid);
        finish(null, parsed);
      });

      child.stdin.on("error", () => {});
      child.stdin.end(request);
    });

    return response;
  }

  const description = await invoke("describe", {});
  const providerId = description.result?.providerId;
  if (typeof providerId !== "string" || !SAFE_ID.test(providerId)) {
    throw new Error("Provider adapter returned an invalid provider identifier.");
  }
  const adapterDeclaredSyntheticOnly = description.result.adapterDeclaredSyntheticOnly;
  if (adapterDeclaredSyntheticOnly !== null && typeof adapterDeclaredSyntheticOnly !== "boolean") {
    throw new Error("Provider adapter synthetic-only declaration is invalid.");
  }

  async function call(operation, args) {
    const result = await invoke(operation, args);
    return result.result;
  }

  return Object.freeze({
    providerId,
    adapterModuleSha256: adapter.moduleSha256,
    adapterDeclaredSyntheticOnly,
    async readState(identity) {
      return call("readState", { identity });
    },
    async initializeStateIfAbsent({ identity, state }) {
      return call("initializeStateIfAbsent", { identity, state });
    },
    async compareAndSetState({ identity, expectedVersion, expectedStateSha256, nextState }) {
      return call("compareAndSetState", {
        identity,
        expectedVersion,
        expectedStateSha256,
        nextState,
      });
    },
    get processStats() {
      return Object.freeze({
        workerProcessesStarted: metrics.workerProcessesStarted,
        uniqueWorkerInstances: metrics.workerInstanceIds.size,
        uniqueWorkerProcessIds: metrics.workerProcessIds.size,
      });
    },
  });
}
