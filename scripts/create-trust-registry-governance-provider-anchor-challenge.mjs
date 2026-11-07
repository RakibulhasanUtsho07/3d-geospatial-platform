#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  createTrustRegistryGovernanceProviderAnchorChallenge,
} from "../src/core/building-generation/trust-registry-governance-provider-anchor-witness.mjs";
import {
  normalizeTrustRegistryProviderQualificationManifest,
  verifyTrustRegistryProviderQualificationArtifacts,
} from "../src/core/building-generation/trust-registry-governance-provider-qualification.mjs";

const MAX_MANIFEST_BYTES = 1024 * 1024;

async function readRegularFile(inputPath, maxBytes, label) {
  const absolute = path.resolve(inputPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " path must not contain symlinks.");
  }
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) {
      throw new TypeError(label + " must be a non-empty regular file within its size limit.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseArgs(args) {
  const result = { manifestPath: null, outputPath: null, artifactRoot: null, ttlSeconds: 300 };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output" || arg === "--ttl-seconds" || arg === "--artifact-root") {
      if (seen.has(arg)) throw new TypeError(arg + " may be supplied only once.");
      seen.add(arg);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError("Missing value for " + arg + ".");
      if (arg === "--output") result.outputPath = value;
      else if (arg === "--artifact-root") result.artifactRoot = value;
      else result.ttlSeconds = Number(value);
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new TypeError("Unknown option: " + arg);
    } else if (!result.manifestPath) {
      result.manifestPath = arg;
    } else {
      throw new TypeError("Only one manifest path may be supplied.");
    }
  }
  return result;
}

async function assertSafeDirectory(directoryPath) {
  const absolute = path.resolve(directoryPath);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError("Challenge output directory path must contain only real directories, not symlinks.");
    }
  }
}

function resolveOutputPath(value) {
  if (!value || path.isAbsolute(value) || value.includes("\\") ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("--output must be a safe relative path.");
  }
  const absolute = path.resolve(value);
  const root = path.resolve(process.cwd());
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new TypeError("--output must remain inside the working directory.");
  }
  return absolute;
}

function usage() {
  console.log("Usage: node scripts/create-trust-registry-governance-provider-anchor-challenge.mjs <manifest.json> --output <challenge.json> [--artifact-root DIR] [--ttl-seconds 300]");
  console.log("Creates a fresh 256-bit D3M-29 challenge for a provisioned, non-synthetic provider. Does not contact the provider or sign a witness.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return usage();
  const options = parseArgs(args);
  if (!options.manifestPath || !options.outputPath) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1 || options.ttlSeconds > 600) {
    throw new RangeError("--ttl-seconds must be between 1 and 600.");
  }
  const manifestBytes = await readRegularFile(options.manifestPath, MAX_MANIFEST_BYTES, "Manifest");
  const manifest = normalizeTrustRegistryProviderQualificationManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
  );
  if (manifest.schemaVersion !== "1.3.0" ||
      manifest.independentAnchorWitness.status !== "not-run") {
    throw new Error("D3M-29 challenge creation requires a schema 1.3.0 manifest with independentAnchorWitness.status=not-run.");
  }
  if (manifest.provider.status !== "provisioned" || manifest.provider.syntheticOnly ||
      manifest.providerIntegration.status !== "passed" || manifest.providerIntegration.syntheticOnly ||
      manifest.providerIntegration.fullRunConclusion !== "success" ||
      manifest.providerIntegration.headSha !== manifest.source.commitSha) {
    throw new Error("D3M-29 challenge creation requires a provisioned, non-synthetic provider and a passed real-provider integration run.");
  }
  const artifactRoot = path.resolve(options.artifactRoot ?? path.dirname(path.resolve(options.manifestPath)));
  const reportVerification = await verifyTrustRegistryProviderQualificationArtifacts(
    manifest,
    artifactRoot,
  );
  const requiredReportArtifacts = [
    manifest.providerIntegration.processReportArtifactId,
    manifest.providerIntegration.processReportSignatureArtifactId,
  ];
  if (reportVerification.failures.length > 0 ||
      requiredReportArtifacts.some((id) => !reportVerification.verifiedArtifactIds.includes(id))) {
    throw new Error("D3M-29 challenge creation requires byte-verified D3M-26 report semantics and D3M-28 trusted signature.");
  }
  const generated = createTrustRegistryGovernanceProviderAnchorChallenge({
    sourceCommitSha: manifest.source.commitSha,
    providerId: manifest.provider.providerId,
    adapterModuleSha256: manifest.provider.adapterModuleSha256,
    syntheticOnly: manifest.provider.syntheticOnly,
    instanceFingerprintSha256: manifest.provider.instanceFingerprintSha256,
    namespaceFingerprintSha256: manifest.provider.namespaceFingerprintSha256,
    ttlSeconds: options.ttlSeconds,
  });
  const outputPath = resolveOutputPath(options.outputPath);
  const parent = path.dirname(outputPath);
  await assertSafeDirectory(parent);
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(generated.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  console.log(JSON.stringify({
    status: "challenge-created",
    challengeId: generated.challenge.challengeId,
    challengeSha256: generated.challengeSha256,
    expiresAtUtc: generated.challenge.expiresAtUtc,
    output: path.relative(process.cwd(), outputPath),
    syntheticOnly: generated.challenge.syntheticOnly,
    processReportAndSignatureVerified: true,
    productionQualificationEligible: false,
  }, null, 2));
}

main().catch((error) => {
  console.error("D3M-29 challenge creation blocked: " +
    (error instanceof Error ? error.message : "unexpected error"));
  process.exitCode = 2;
});
