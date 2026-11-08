#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { verifySurveyDeviceEnrollmentEvidence } from "../src/core/building-generation/survey-device-enrollment-evidence.mjs";

const MAX_DEVICE_REGISTRY = 64 * 1024;
const MAX_AUTHORITY_REGISTRY = 64 * 1024;
const MAX_EVIDENCE = 32 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function parseArguments(args) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (value.startsWith("--")) {
      if (!["--device-id", "--now"].includes(value) || options.has(value) ||
          !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error("Unknown, duplicate or incomplete option: " + value);
      }
      options.set(value, args[index + 1]);
      index += 1;
    } else {
      positional.push(value);
    }
  }
  const deviceId = options.get("--device-id");
  if (positional.length !== 3 || !deviceId || !SAFE_ID.test(deviceId)) {
    throw new Error("Usage: npm run verify:survey-device-enrollment-evidence -- <trusted-devices.json> <trusted-enrollment-authorities.json> <enrollment-evidence.json> --device-id <id> [--now <canonical-utc>]");
  }
  return {
    help: false,
    deviceRegistryPath: path.resolve(positional[0]),
    authorityRegistryPath: path.resolve(positional[1]),
    evidencePath: path.resolve(positional[2]),
    deviceId,
    now: options.get("--now"),
  };
}

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(":");
}

async function readStableFile(filePath, label, maxBytes) {
  const absolute = path.resolve(filePath);
  const resolvedBefore = await realpath(absolute);
  const before = await lstat(absolute);
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > maxBytes) {
    throw new Error(label + " must be a non-empty regular file within its size limit and must not be a symlink.");
  }
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || fileIdentity(initial) !== fileIdentity(before)) {
      throw new Error(label + " file identity changed before read.");
    }
    const bytes = await handle.readFile();
    const final = await handle.stat();
    const pathAfter = await lstat(absolute);
    const resolvedAfter = await realpath(absolute);
    if (fileIdentity(initial) !== fileIdentity(final) || fileIdentity(final) !== fileIdentity(pathAfter) ||
        pathAfter.isSymbolicLink() || resolvedBefore !== resolvedAfter || bytes.length !== final.size ||
        bytes.length < 1 || bytes.length > maxBytes) {
      throw new Error(label + " changed while being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Verify a signed D3M-17 survey-device enrollment statement offline.\n\n" +
      "Usage: npm run verify:survey-device-enrollment-evidence -- <trusted-devices.json> <trusted-enrollment-authorities.json> <enrollment-evidence.json> --device-id <id> [--now <canonical-utc>]\n\n" +
      "All registries contain public keys only. The enrollment authority registry is an operator-provisioned trust anchor.\n");
    return 0;
  }
  const [trustedDeviceRegistry, trustedEnrollmentAuthorityRegistry, evidenceBytes] = await Promise.all([
    readStableFile(options.deviceRegistryPath, "Trusted device registry", MAX_DEVICE_REGISTRY),
    readStableFile(options.authorityRegistryPath, "Trusted enrollment-authority registry", MAX_AUTHORITY_REGISTRY),
    readStableFile(options.evidencePath, "Device enrollment evidence", MAX_EVIDENCE),
  ]);
  const result = verifySurveyDeviceEnrollmentEvidence({
    evidenceBytes,
    trustedDeviceRegistry,
    trustedEnrollmentAuthorityRegistry,
    deviceId: options.deviceId,
    now: options.now,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.valid ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write("Device enrollment evidence verification failed: " +
    (error instanceof Error ? error.message : "unknown error") + "\n");
  process.exitCode = 2;
});
