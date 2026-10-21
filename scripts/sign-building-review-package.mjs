#!/usr/bin/env node
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { signBuildingReviewPackageManifest } from "../src/core/building-generation/building-review-package-signature.mjs";

async function regularFile(filePath, label) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(label + " must be a regular file, not a symlink");
  const bytes = await readFile(filePath);
  if (bytes.length === 0) throw new Error(label + " must not be empty");
  return bytes;
}

async function main() {
  const [packageDirArg, privateKeyArg] = process.argv.slice(2);
  if (!packageDirArg || !privateKeyArg || process.argv.length !== 4) {
    throw new Error("Usage: node scripts/sign-building-review-package.mjs <review-package-directory> <ed25519-private-key.pem>");
  }
  const packageDir = path.resolve(packageDirArg);
  const manifestPath = path.join(packageDir, "package-manifest.json");
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  const privateKeyPath = path.resolve(privateKeyArg);
  if (path.resolve(signaturePath) === privateKeyPath) throw new Error("Signature path cannot replace the private key path");

  const [manifestBytes, privateKeyBytes] = await Promise.all([
    regularFile(manifestPath, "Package manifest"),
    regularFile(privateKeyPath, "Private key"),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.publicationEligible !== false || manifest.policy?.publicationEligible !== false ||
    manifest.readiness?.finalHumanReviewRequired !== true) {
    throw new Error("Only a review-only package manifest may be signed.");
  }
  const envelope = signBuildingReviewPackageManifest({
    manifestBytes,
    privateKeyPem: privateKeyBytes.toString("utf8"),
  });
  await writeFile(signaturePath, JSON.stringify(envelope, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({
    signatureFile: signaturePath,
    manifestSha256: envelope.manifestSha256,
    publicKeyFingerprintSha256: envelope.publicKeyFingerprintSha256,
    algorithm: envelope.algorithm,
    publicationEligible: false,
  }, null, 2));
}

main().catch((error) => {
  console.error("Could not sign building review package:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
