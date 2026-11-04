#!/usr/bin/env node
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { signBuildingReviewPackageManifestWithTrustedRegistry } from "../src/core/building-generation/building-review-package-signature.mjs";

const REGISTRY_ENV = "RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON";

async function regularFile(filePath, label) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(label + " must be a regular file, not a symlink");
  const bytes = await readFile(filePath);
  if (bytes.length === 0) throw new Error(label + " must not be empty");
  return bytes;
}

function parseArguments(args) {
  const positional = [];
  let reviewerId = null;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--reviewer-id") {
      if (reviewerId !== null || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error("--reviewer-id must be supplied exactly once with a value.");
      }
      reviewerId = args[++index];
    } else if (value.startsWith("--")) {
      throw new Error("Unknown signing option: " + value);
    } else {
      positional.push(value);
    }
  }
  if (positional.length !== 2 || !reviewerId) {
    throw new Error("Usage: NODE_ENV=production npm run sign:building-review-package -- <review-package-directory> <ed25519-private-key.pem> --reviewer-id <registered-reviewer-id>");
  }
  return { packageDir: path.resolve(positional[0]), privateKeyPath: path.resolve(positional[1]), reviewerId };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: NODE_ENV=production npm run sign:building-review-package -- <review-package-directory> <ed25519-private-key.pem> --reviewer-id <registered-reviewer-id>");
    console.log("Reads the public-key-only registry from RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON; never accepts registry JSON on the command line.");
    return;
  }
  const { packageDir, privateKeyPath, reviewerId } = parseArguments(args);
  if (path.resolve(path.join(packageDir, "package-manifest.sig.json")) === privateKeyPath) {
    throw new Error("Signature path cannot replace the private key path");
  }
  const rawRegistry = process.env[REGISTRY_ENV];
  if (typeof rawRegistry !== "string" || !rawRegistry.trim()) {
    throw new Error("trusted-reviewer-registry-secret-missing");
  }
  if (Buffer.byteLength(rawRegistry, "utf8") > 64 * 1024) {
    throw new Error("trusted-reviewer-registry-secret-exceeds-size-limit");
  }

  const manifestPath = path.join(packageDir, "package-manifest.json");
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  const [manifestBytes, privateKeyBytes] = await Promise.all([
    regularFile(manifestPath, "Package manifest"),
    regularFile(privateKeyPath, "Private key"),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== "1.0.0" ||
      manifest.engine !== "building-review-package-v1" ||
      manifest.readiness?.publicationEligible !== false ||
      manifest.readiness?.finalHumanReviewRequired !== true ||
      manifest.policy?.publicationEligible !== false ||
      manifest.policy?.assetPublished !== false) {
    throw new Error("Only a valid final-human-review package with all publication flags false may be signed.");
  }

  const envelope = signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes,
    privateKeyPem: privateKeyBytes.toString("utf8"),
    reviewerId,
    trustedReviewerRegistry: rawRegistry,
  });
  await writeFile(signaturePath, JSON.stringify(envelope, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({
    signatureFile: signaturePath,
    schemaVersion: envelope.schemaVersion,
    signaturePurpose: envelope.signaturePurpose,
    manifestSha256: envelope.manifestSha256,
    reviewerId: envelope.reviewerId,
    keyId: envelope.keyId,
    registryId: envelope.registryId,
    publicKeyFingerprintSha256: envelope.publicKeyFingerprintSha256,
    signedAt: envelope.signedAt,
    algorithm: envelope.algorithm,
    publicationEligible: false,
  }, null, 2));
}

main().catch((error) => {
  console.error("Could not sign building review package:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
