#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyBuildingReviewPackageSignature } from "../src/core/building-generation/building-review-package-signature.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularFile(filePath, label) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(label + " must be a regular file, not a symlink");
  return readFile(filePath);
}

async function main() {
  const [packageDirArg, trustedPublicKeyArg, reportArg] = process.argv.slice(2);
  if (!packageDirArg || !trustedPublicKeyArg || process.argv.length > 5) {
    throw new Error("Usage: node scripts/verify-building-review-package-signature.mjs <review-package-directory> <trusted-ed25519-public-key.pem> [signature-verification-report.json]");
  }
  const packageDir = path.resolve(packageDirArg);
  const manifestPath = path.join(packageDir, "package-manifest.json");
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  const publicKeyPath = path.resolve(trustedPublicKeyArg);
  const [manifestBytes, signatureBytes, publicKeyBytes] = await Promise.all([
    regularFile(manifestPath, "Package manifest"),
    regularFile(signaturePath, "Signature envelope"),
    regularFile(publicKeyPath, "Trusted public key"),
  ]);
  const signatureEnvelope = JSON.parse(signatureBytes.toString("utf8"));
  const result = verifyBuildingReviewPackageSignature({
    manifestBytes,
    signatureEnvelope,
    trustedPublicKeyPem: publicKeyBytes.toString("utf8"),
  });

  let reportPath = null;
  if (reportArg) {
    reportPath = path.resolve(reportArg);
    const relativeToPackage = path.relative(packageDir, reportPath);
    if (relativeToPackage === "" || (!relativeToPackage.startsWith("..") && !path.isAbsolute(relativeToPackage))) {
      throw new Error("Signature verification report must be outside the package directory.");
    }
    if ([manifestPath, signaturePath, publicKeyPath].includes(reportPath)) throw new Error("Report path must differ from signature inputs.");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }

  console.log(JSON.stringify({
    status: result.status,
    valid: result.valid,
    manifestSha256: result.manifestSha256,
    trustedPublicKeyFingerprintSha256: result.trustedPublicKeyFingerprintSha256,
    report: reportPath,
    publicationEligible: false,
  }, null, 2));
  if (!result.valid) process.exitCode = 2;
}

main().catch((error) => {
  console.error("Could not verify building review package signature:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
