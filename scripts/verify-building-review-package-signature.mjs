#!/usr/bin/env node
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  verifyBuildingReviewPackageSignature,
  verifyBuildingReviewPackageSignatureWithTrustedRegistry,
} from "../src/core/building-generation/building-review-package-signature.mjs";

const REGISTRY_ENV = "RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON";

async function regularFile(filePath, label) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(label + " must be a regular file, not a symlink");
  return readFile(filePath);
}

function parseArguments(args) {
  const positional = [];
  let legacyPublicKeyPath = null;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--legacy-public-key") {
      if (legacyPublicKeyPath !== null || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error("--legacy-public-key must be supplied exactly once with a value.");
      }
      legacyPublicKeyPath = path.resolve(args[++index]);
    } else if (value.startsWith("--")) {
      throw new Error("Unknown signature-verification option: " + value);
    } else {
      positional.push(value);
    }
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new Error("Usage: NODE_ENV=production npm run verify:building-review-package-signature -- <review-package-directory> [signature-verification-report.json] [--legacy-public-key <trusted-public-key.pem>]");
  }
  return {
    packageDir: path.resolve(positional[0]),
    reportPath: positional[1] ? path.resolve(positional[1]) : null,
    legacyPublicKeyPath,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: NODE_ENV=production npm run verify:building-review-package-signature -- <review-package-directory> [signature-verification-report.json] [--legacy-public-key <trusted-public-key.pem>]");
    console.log("Schema 2.0.0 signatures use RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON. Schema 1.0.0 signatures require the explicit legacy public-key flag.");
    return;
  }
  const { packageDir, reportPath: requestedReportPath, legacyPublicKeyPath } = parseArguments(args);
  const manifestPath = path.join(packageDir, "package-manifest.json");
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  const [manifestBytes, signatureBytes] = await Promise.all([
    regularFile(manifestPath, "Package manifest"),
    regularFile(signaturePath, "Signature envelope"),
  ]);
  const signatureEnvelope = JSON.parse(signatureBytes.toString("utf8"));
  let result;

  if (signatureEnvelope.schemaVersion === "2.0.0") {
    if (legacyPublicKeyPath) throw new Error("Legacy public-key flag is not accepted for a registry-bound v2 signature.");
    const rawRegistry = process.env[REGISTRY_ENV];
    if (typeof rawRegistry !== "string" || !rawRegistry.trim()) {
      throw new Error("trusted-reviewer-registry-secret-missing");
    }
    if (Buffer.byteLength(rawRegistry, "utf8") > 64 * 1024) {
      throw new Error("trusted-reviewer-registry-secret-exceeds-size-limit");
    }
    result = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
      manifestBytes,
      signatureEnvelope,
      trustedReviewerRegistry: rawRegistry,
    });
  } else if (signatureEnvelope.schemaVersion === "1.0.0") {
    if (!legacyPublicKeyPath) {
      throw new Error("legacy-v1-signature-requires-explicit---legacy-public-key");
    }
    const publicKeyBytes = await regularFile(legacyPublicKeyPath, "Legacy trusted public key");
    result = verifyBuildingReviewPackageSignature({
      manifestBytes,
      signatureEnvelope,
      trustedPublicKeyPem: publicKeyBytes.toString("utf8"),
    });
  } else {
    throw new Error("unsupported-review-package-signature-schema");
  }

  let reportPath = null;
  if (requestedReportPath) {
    reportPath = requestedReportPath;
    const relativeToPackage = path.relative(packageDir, reportPath);
    if (relativeToPackage === "" || (!relativeToPackage.startsWith("..") && !path.isAbsolute(relativeToPackage))) {
      throw new Error("Signature verification report must be outside the package directory.");
    }
    if ([manifestPath, signaturePath, legacyPublicKeyPath].includes(reportPath)) {
      throw new Error("Report path must differ from signature inputs.");
    }
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }

  console.log(JSON.stringify({
    status: result.status,
    valid: result.valid,
    schemaVersion: result.schemaVersion,
    manifestSha256: result.manifestSha256,
    reviewerId: result.reviewerId ?? null,
    keyId: result.keyId ?? null,
    registryId: result.registryId ?? null,
    trustedPublicKeyFingerprintSha256: result.trustedPublicKeyFingerprintSha256 ??
      result.publicKeyFingerprintSha256 ?? null,
    report: reportPath,
    publicationEligible: false,
  }, null, 2));
  if (!result.valid) process.exitCode = 2;
}

main().catch((error) => {
  console.error("Could not verify building review package signature:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
