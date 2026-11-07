#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  assessTrustRegistryProviderQualification,
  normalizeTrustRegistryProviderQualificationManifest,
  verifyTrustRegistryProviderQualificationArtifacts,
} from "../src/core/building-generation/trust-registry-governance-provider-qualification.mjs";

const MAX_MANIFEST_BYTES = 1024 * 1024;

async function readRegularFile(inputPath, maxBytes, label) {
  const absolute = path.resolve(inputPath);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
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

function usage() {
  console.log("Usage: node scripts/verify-trust-registry-governance-provider-anchor-witness.mjs <manifest.json> [--artifact-root DIR]");
  console.log("Verifies the exact D3M-29 challenge and independent-anchor witness referenced by a D3M-25 schema 1.3.0 manifest.");
  console.log("The public-only registry is supplied through D3M29_INDEPENDENT_ANCHOR_KEYS_JSON; its governance key is pinned separately by D3M29_INDEPENDENT_ANCHOR_GOVERNANCE_KEY_FINGERPRINT_SHA256. No private key is read.");
}

function parseArgs(args) {
  const result = { manifestPath: null, artifactRoot: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifact-root") {
      if (seen.has(arg)) throw new TypeError("--artifact-root may be supplied only once.");
      seen.add(arg);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError("Missing value for --artifact-root.");
      result.artifactRoot = value;
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

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return usage();
  const options = parseArgs(args);
  if (!options.manifestPath) {
    usage();
    process.exitCode = 2;
    return;
  }
  const manifestBytes = await readRegularFile(options.manifestPath, MAX_MANIFEST_BYTES, "Manifest");
  const manifest = normalizeTrustRegistryProviderQualificationManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
  );
  if (manifest.schemaVersion !== "1.3.0") {
    throw new Error("D3M-29 verification requires a D3M-25 schema 1.3.0 manifest.");
  }
  const artifactRoot = path.resolve(options.artifactRoot ?? path.dirname(path.resolve(options.manifestPath)));
  const verification = await verifyTrustRegistryProviderQualificationArtifacts(manifest, artifactRoot, {
    independentAnchorKeyRegistry: process.env.D3M29_INDEPENDENT_ANCHOR_KEYS_JSON,
    independentAnchorGovernanceKeyFingerprintSha256: process.env.D3M29_INDEPENDENT_ANCHOR_GOVERNANCE_KEY_FINGERPRINT_SHA256,
  });
  const assessment = assessTrustRegistryProviderQualification(manifest, {
    artifactVerification: verification,
  });
  const output = {
    status: manifest.independentAnchorWitness.status === "verified" &&
      verification.failures.length === 0 &&
      verification.verifiedArtifactIds.includes(manifest.independentAnchorWitness.witnessArtifactId)
        ? "anchor-witness-verified"
        : "blocked",
    blockers: verification.failures.map((item) => item.code),
    qualificationStatus: assessment.status,
    productionQualificationEligible: false,
    releaseFlags: assessment.releaseFlags,
  };
  console.log(JSON.stringify(output, null, 2));
  if (output.status !== "anchor-witness-verified") process.exitCode = 2;
}

main().catch((error) => {
  console.error("D3M-29 witness verification blocked: " +
    (error instanceof Error ? error.message : "unexpected error"));
  process.exitCode = 2;
});
