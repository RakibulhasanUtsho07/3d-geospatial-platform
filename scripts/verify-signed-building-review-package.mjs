#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { verifyBuildingReviewPackage } from "../src/core/building-generation/building-review-package-integrity.mjs";
import {
  verifyBuildingReviewPackageSignature,
  verifyBuildingReviewPackageSignatureWithTrustedRegistry,
} from "../src/core/building-generation/building-review-package-signature.mjs";

const REGISTRY_ENV = "RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularFile(filePath, label) {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(label + " must be a regular file, not a symlink");
  return readFile(filePath);
}

async function listPackageFiles(root, current = root, files = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const details = await lstat(fullPath);
    if (details.isSymbolicLink()) throw new Error("Symbolic links are not allowed inside review packages.");
    if (details.isDirectory()) {
      await listPackageFiles(root, fullPath, files);
      continue;
    }
    if (!details.isFile()) throw new Error("Unsupported filesystem entry inside review package.");
    const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
    if (relativePath === "package-manifest.json" || relativePath === "package-manifest.sig.json") continue;
    const content = await readFile(fullPath);
    const image = /\.(?:png|jpe?g)$/i.test(entry.name) ? readImageDimensions(content) : null;
    files.push({
      relativePath,
      sha256: sha256(content),
      bytes: content.length,
      content,
      isRegularFile: true,
      ...(image ? { width: image.width, height: image.height } : {}),
    });
  }
  return files;
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
      throw new Error("Unknown signed-package verification option: " + value);
    } else {
      positional.push(value);
    }
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new Error("Usage: NODE_ENV=production npm run verify:signed-building-review-package -- <review-package-directory> [verification-report.json] [--legacy-public-key <trusted-public-key.pem>]");
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
    console.log("Usage: NODE_ENV=production npm run verify:signed-building-review-package -- <review-package-directory> [verification-report.json] [--legacy-public-key <trusted-public-key.pem>]");
    console.log("Runs offline artifact integrity and detached-signature verification. Schema 2 signatures use RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON; schema 1 requires the explicit legacy public-key flag.");
    return;
  }
  const { packageDir, reportPath: requestedReportPath, legacyPublicKeyPath } = parseArguments(args);
  const manifestPath = path.join(packageDir, "package-manifest.json");
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  const [manifestBytes, signatureBytes] = await Promise.all([
    regularFile(manifestPath, "Package manifest"),
    regularFile(signaturePath, "Signature envelope"),
  ]);
  const packageManifest = JSON.parse(manifestBytes.toString("utf8"));
  const signatureEnvelope = JSON.parse(signatureBytes.toString("utf8"));
  const actualFiles = await listPackageFiles(packageDir);
  const integrity = verifyBuildingReviewPackage({
    packageManifest,
    actualFiles,
    packageManifestSha256: sha256(manifestBytes),
  });

  let signature;
  if (signatureEnvelope.schemaVersion === "2.0.0") {
    if (legacyPublicKeyPath) throw new Error("Legacy public-key flag is not accepted for a registry-bound v2 signature.");
    const rawRegistry = process.env[REGISTRY_ENV];
    if (typeof rawRegistry !== "string" || !rawRegistry.trim()) {
      throw new Error("trusted-reviewer-registry-secret-missing");
    }
    if (Buffer.byteLength(rawRegistry, "utf8") > 64 * 1024) {
      throw new Error("trusted-reviewer-registry-secret-exceeds-size-limit");
    }
    signature = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
      manifestBytes,
      signatureEnvelope,
      trustedReviewerRegistry: rawRegistry,
    });
  } else if (signatureEnvelope.schemaVersion === "1.0.0") {
    if (!legacyPublicKeyPath) throw new Error("legacy-v1-signature-requires-explicit---legacy-public-key");
    const publicKeyBytes = await regularFile(legacyPublicKeyPath, "Legacy trusted public key");
    signature = verifyBuildingReviewPackageSignature({
      manifestBytes,
      signatureEnvelope,
      trustedPublicKeyPem: publicKeyBytes.toString("utf8"),
    });
  } else {
    throw new Error("unsupported-review-package-signature-schema");
  }

  const valid = integrity.valid === true && signature.valid === true;
  const result = {
    schemaVersion: "1.0.0",
    engine: "signed-building-review-package-verification-v1",
    status: valid ? "verified" : "tampered-or-invalid",
    valid,
    buildingId: packageManifest.buildingId ?? null,
    packageManifestSha256: sha256(manifestBytes),
    packageIntegrity: {
      status: integrity.status,
      valid: integrity.valid,
      errors: integrity.counts.errors,
      warnings: integrity.counts.warnings,
      checks: integrity.checks,
      errorsList: integrity.errors,
    },
    signature: {
      status: signature.status,
      valid: signature.valid,
      schemaVersion: signature.schemaVersion,
      reviewerId: signature.reviewerId ?? null,
      keyId: signature.keyId ?? null,
      registryId: signature.registryId ?? null,
      signedAt: signature.signedAt ?? null,
      checks: signature.checks,
      errors: signature.errors,
    },
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
    note: "A valid package-integrity signature and artifact manifest do not constitute release approval, surveyor authentication or proof of architectural accuracy.",
  };

  let reportPath = null;
  if (requestedReportPath) {
    reportPath = requestedReportPath;
    const relativeToPackage = path.relative(packageDir, reportPath);
    if (relativeToPackage === "" || (!relativeToPackage.startsWith("..") && !path.isAbsolute(relativeToPackage))) {
      throw new Error("Combined verification report must be outside the package directory.");
    }
    if ([manifestPath, signaturePath, legacyPublicKeyPath].includes(reportPath)) {
      throw new Error("Combined verification report path must differ from verification inputs.");
    }
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }

  console.log(JSON.stringify({
    status: result.status,
    valid,
    buildingId: result.buildingId,
    packageIntegrity: integrity.status,
    signature: signature.status,
    reviewerId: result.signature.reviewerId,
    keyId: result.signature.keyId,
    registryId: result.signature.registryId,
    publicationEligible: false,
    mapReady: false,
    report: reportPath,
  }, null, 2));
  if (!valid) process.exitCode = 2;
}

main().catch((error) => {
  console.error("Could not verify signed building review package:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
