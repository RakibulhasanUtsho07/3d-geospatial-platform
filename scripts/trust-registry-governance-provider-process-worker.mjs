import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RESULT_MARKER = "D3M26_PROVIDER_RESULT:";
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 900 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ERROR_CODES = new Set([
  "D3M26_REQUEST_TOO_LARGE", "D3M26_INVALID_REQUEST_JSON", "D3M26_INVALID_REQUEST_ENVELOPE",
  "D3M26_INVALID_OPERATION", "D3M26_INVALID_OPERATION_ARGUMENTS", "D3M26_INVALID_DESCRIBE_ARGUMENTS",
  "D3M26_INVALID_READ_ARGUMENTS", "D3M26_INVALID_INITIALIZE_ARGUMENTS", "D3M26_INVALID_INITIAL_STATE",
  "D3M26_INVALID_CAS_ARGUMENTS", "D3M26_INVALID_IDENTITY", "D3M26_INVALID_PROVIDER_IDENTITY",
  "D3M26_ADAPTER_SYMLINK_REJECTED", "D3M26_INVALID_ADAPTER_REFERENCE", "D3M26_INVALID_ADAPTER_FILE",
  "D3M26_ADAPTER_CHANGED_DURING_OPEN", "D3M26_ADAPTER_CHANGED_DURING_READ",
  "D3M26_ADAPTER_NON_CANONICAL_PATH", "D3M26_ADAPTER_HASH_MISMATCH",
  "D3M26_ADAPTER_CREATE_PROVIDER_REQUIRED", "D3M26_ADAPTER_SYNTHETIC_DECLARATION_INVALID",
  "D3M26_INVALID_PROVIDER_ADAPTER", "D3M26_PROVIDER_METHOD_MISSING",
  "D3M26_WORKER_RESPONSE_TOO_LARGE",
]);

function fail(code) {
  const error = new Error("Provider worker operation failed.");
  error.code = code;
  throw error;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("D3M26_INVALID_" + label);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail("D3M26_INVALID_" + label);
  }
}

async function assertNoSymlinkComponents(absolutePath) {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const part of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) fail("D3M26_ADAPTER_SYMLINK_REJECTED");
  }
}

async function loadAdapter(modulePath, expectedHash) {
  if (typeof modulePath !== "string" || !path.isAbsolute(modulePath) ||
      typeof expectedHash !== "string" || !SHA256.test(expectedHash)) {
    fail("D3M26_INVALID_ADAPTER_REFERENCE");
  }
  await assertNoSymlinkComponents(modulePath);
  const before = await lstat(modulePath);
  if (!before.isFile() || before.size < 1 || before.size > MAX_MODULE_BYTES) {
    fail("D3M26_INVALID_ADAPTER_FILE");
  }
  const handle = await open(modulePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("D3M26_ADAPTER_CHANGED_DURING_OPEN");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || bytes.length !== opened.size) {
      fail("D3M26_ADAPTER_CHANGED_DURING_READ");
    }
  } finally {
    await handle.close();
  }
  if (await realpath(modulePath) !== modulePath) fail("D3M26_ADAPTER_NON_CANONICAL_PATH");
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) fail("D3M26_ADAPTER_HASH_MISMATCH");
  return import(pathToFileURL(modulePath).href);
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) fail("D3M26_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("D3M26_INVALID_REQUEST_JSON");
  }
  exactKeys(request, ["operation", "args"], "REQUEST_ENVELOPE");
  if (!["describe", "readState", "initializeStateIfAbsent", "compareAndSetState"].includes(request.operation)) {
    fail("D3M26_INVALID_OPERATION");
  }
  if (!request.args || typeof request.args !== "object" || Array.isArray(request.args)) {
    fail("D3M26_INVALID_OPERATION_ARGUMENTS");
  }
  return request;
}

function validateIdentity(identity) {
  exactKeys(identity, ["registrySetId", "governanceKeyFingerprintSha256"], "IDENTITY");
  if (typeof identity.registrySetId !== "string" || !SAFE_ID.test(identity.registrySetId) ||
      typeof identity.governanceKeyFingerprintSha256 !== "string" ||
      !SHA256.test(identity.governanceKeyFingerprintSha256)) {
    fail("D3M26_INVALID_PROVIDER_IDENTITY");
  }
}

function validateOperationArguments(operation, args) {
  if (operation === "describe") {
    exactKeys(args, [], "DESCRIBE_ARGUMENTS");
    return;
  }
  if (operation === "readState") {
    exactKeys(args, ["identity"], "READ_ARGUMENTS");
    validateIdentity(args.identity);
    return;
  }
  if (operation === "initializeStateIfAbsent") {
    exactKeys(args, ["identity", "state"], "INITIALIZE_ARGUMENTS");
    validateIdentity(args.identity);
    if (!args.state || typeof args.state !== "object" || Array.isArray(args.state)) {
      fail("D3M26_INVALID_INITIAL_STATE");
    }
    return;
  }
  exactKeys(args, ["identity", "expectedVersion", "expectedStateSha256", "nextState"], "CAS_ARGUMENTS");
  validateIdentity(args.identity);
  if (typeof args.expectedVersion !== "string" ||
      !/^[A-Za-z0-9._~:-]{1,256}$/.test(args.expectedVersion) ||
      typeof args.expectedStateSha256 !== "string" ||
      !SHA256.test(args.expectedStateSha256) ||
      !args.nextState || typeof args.nextState !== "object" || Array.isArray(args.nextState)) {
    fail("D3M26_INVALID_CAS_ARGUMENTS");
  }
}

function validateProvider(provider) {
  if (!provider || typeof provider !== "object" ||
      typeof provider.providerId !== "string" || !SAFE_ID.test(provider.providerId)) {
    fail("D3M26_INVALID_PROVIDER_ADAPTER");
  }
  for (const method of ["readState", "initializeStateIfAbsent", "compareAndSetState"]) {
    if (typeof provider[method] !== "function") fail("D3M26_PROVIDER_METHOD_MISSING");
  }
}

async function execute() {
  const modulePath = process.argv[2];
  const expectedHash = process.argv[3];
  const request = await readRequest();
  validateOperationArguments(request.operation, request.args);
  const adapterModule = await loadAdapter(modulePath, expectedHash);
  if (typeof adapterModule.createProvider !== "function") {
    fail("D3M26_ADAPTER_CREATE_PROVIDER_REQUIRED");
  }
  if (adapterModule.syntheticOnly !== undefined && typeof adapterModule.syntheticOnly !== "boolean") {
    fail("D3M26_ADAPTER_SYNTHETIC_DECLARATION_INVALID");
  }
  const provider = await adapterModule.createProvider();
  validateProvider(provider);

  let result;
  if (request.operation === "describe") {
    result = {
      providerId: provider.providerId,
      adapterDeclaredSyntheticOnly: typeof adapterModule.syntheticOnly === "boolean"
        ? adapterModule.syntheticOnly
        : null,
    };
  } else {
    result = await provider[request.operation](request.args);
  }
  const response = {
    ok: true,
    workerPid: process.pid,
    workerInstanceId: randomUUID(),
    result,
  };
  const serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
    fail("D3M26_WORKER_RESPONSE_TOO_LARGE");
  }
  process.stdout.write(RESULT_MARKER + serialized + "\n");
}

try {
  await execute();
} catch (error) {
  const code = SAFE_ERROR_CODES.has(error?.code)
    ? error.code
    : "D3M26_PROVIDER_OPERATION_FAILED";
  process.stdout.write(RESULT_MARKER + JSON.stringify({ ok: false, errorCode: code }) + "\n");
  process.exitCode = 1;
}
