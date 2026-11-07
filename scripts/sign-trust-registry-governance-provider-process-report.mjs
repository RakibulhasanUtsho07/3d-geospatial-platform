#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { signTrustRegistryGovernanceProviderProcessReport } from "../src/core/building-generation/trust-registry-governance-provider-process-report-signature.mjs";

const REGISTRY_ENV = "RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON";
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 16 * 1024;

function parseArguments(args) {
  const positional = [];
  let reviewerId = null;
  let signaturePath = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--reviewer-id" || value === "--signature") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(value + " requires a value");
      if (value === "--reviewer-id") {
        if (reviewerId !== null) throw new Error("--reviewer-id may be supplied only once");
        reviewerId = next;
      } else {
        if (signaturePath !== null) throw new Error("--signature may be supplied only once");
        signaturePath = next;
      }
      index += 1;
    } else if (value.startsWith("--")) {
      throw new Error("unknown signing option");
    } else {
      positional.push(value);
    }
  }
  if (positional.length !== 2 || !reviewerId) {
    throw new Error("Usage: node scripts/sign-trust-registry-governance-provider-process-report.mjs <report.json> <private-key.pem> --reviewer-id <registered-id> [--signature <output.json>]");
  }
  return {
    reportPath: path.resolve(positional[0]),
    privateKeyPath: path.resolve(positional[1]),
    signaturePath: path.resolve(signaturePath ?? (positional[0] + ".sig.json")),
    reviewerId,
  };
}

async function readRegularFile(filePath, label, maxBytes) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(label + " must be a regular non-symlink file");
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw new Error(label + " has an invalid size or type");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertSafeOutputPath(filePath) {
  const parent = path.dirname(filePath);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("signature output directory must be a regular directory");
  const resolved = await realpath(parent);
  if (resolved !== parent) throw new Error("signature output directory must not traverse a symlink");
  try {
    await lstat(filePath);
    throw new Error("signature output already exists; signing never overwrites an attestation");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/sign-trust-registry-governance-provider-process-report.mjs <report.json> <private-key.pem> --reviewer-id <registered-id> [--signature <output.json>]");
    console.log("Uses only the public-key registry in RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON. Private keys are read from a protected file and are never emitted.");
    return;
  }
  const options = parseArguments(args);
  if (path.basename(options.reportPath) !== "provider-process-conformance.json") {
    throw new Error("process report filename must be provider-process-conformance.json");
  }
  const registry = process.env[REGISTRY_ENV];
  if (typeof registry !== "string" || !registry.trim()) throw new Error("trusted-reviewer-registry-secret-missing");
  if (Buffer.byteLength(registry, "utf8") > 64 * 1024) throw new Error("trusted-reviewer-registry-secret-exceeds-size-limit");
  const [reportBytes, privateKeyBytes] = await Promise.all([
    readRegularFile(options.reportPath, "process report", MAX_REPORT_BYTES),
    readRegularFile(options.privateKeyPath, "private key", MAX_KEY_BYTES),
  ]);
  if (options.reportPath === options.privateKeyPath || options.signaturePath === options.privateKeyPath ||
      options.signaturePath === options.reportPath) {
    throw new Error("report, signature and private-key paths must be distinct");
  }
  await assertSafeOutputPath(options.signaturePath);
  const envelope = signTrustRegistryGovernanceProviderProcessReport({
    reportBytes,
    privateKeyPem: privateKeyBytes.toString("utf8"),
    reviewerId: options.reviewerId,
    trustedReviewerRegistry: registry,
  });
  await writeFile(options.signaturePath, JSON.stringify(envelope, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({
    status: "signature-created",
    signaturePath: path.relative(process.cwd(), options.signaturePath),
    processReportSha256: envelope.processReportSha256,
    signer: envelope.reviewerId,
    keyId: envelope.keyId,
    registryId: envelope.registryId,
    productionQualificationEligible: envelope.productionQualificationEligible,
  }, null, 2));
}

main().catch((error) => {
  console.error("D3M-28 process-report signing failed: " +
    (error instanceof Error ? error.message : "unexpected error"));
  process.exitCode = 1;
});
