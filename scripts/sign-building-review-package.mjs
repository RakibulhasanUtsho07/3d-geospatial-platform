#!/usr/bin/env node
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { signBuildingReviewPackageManifestWithTrustedRegistry } from "../src/core/building-generation/building-review-package-signature.mjs";
import {
  sameBuildingReviewPackageSnapshot,
  verifyBuildingReviewPackageDirectory,
} from "../src/core/building-generation/building-review-package-directory.mjs";

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

function assertIntegrityPreflight(snapshot, phase) {
  const report = snapshot.integrity;
  if (!report.valid) {
    const failedChecks = report.errors.slice(0, 16).map((item) => item.id);
    throw new Error(
      "review-package-integrity-preflight-failed:" + phase +
      ":errors=" + report.counts.errors +
      ":failedChecks=" + failedChecks.join(","),
    );
  }
}

function statIdentity(stat) {
  return [stat.dev.toString(), stat.ino.toString(), stat.size.toString(),
    stat.mtimeNs.toString(), stat.ctimeNs.toString()].join(":");
}

async function removeOnlyOurSignature(signaturePath, createdSignatureStat) {
  if (!createdSignatureStat) return false;
  try {
    const current = await lstat(signaturePath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() ||
        statIdentity(current) !== statIdentity(createdSignatureStat)) return false;
    await unlink(signaturePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: NODE_ENV=production npm run sign:building-review-package -- <review-package-directory> <ed25519-private-key.pem> --reviewer-id <registered-reviewer-id>");
    console.log("Requires an integrity-verified package before signing and re-verifies the directory after writing the detached signature.");
    console.log("Reads the public-key-only registry from RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON; never accepts registry JSON on the command line.");
    return;
  }
  const { packageDir, privateKeyPath, reviewerId } = parseArguments(args);
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  if (path.resolve(signaturePath) === privateKeyPath) {
    throw new Error("Signature path cannot replace the private key path");
  }

  const initialSnapshot = await verifyBuildingReviewPackageDirectory(packageDir);
  assertIntegrityPreflight(initialSnapshot, "before-signing");
  const manifest = initialSnapshot.packageManifest;
  if (manifest.schemaVersion !== "1.0.0" ||
      manifest.engine !== "building-review-package-v1" ||
      manifest.readiness?.publicationEligible !== false ||
      manifest.readiness?.finalHumanReviewRequired !== true ||
      manifest.policy?.publicationEligible !== false ||
      manifest.policy?.assetPublished !== false) {
    throw new Error("Only a valid final-human-review package with all publication flags false may be signed.");
  }

  const rawRegistry = process.env[REGISTRY_ENV];
  if (typeof rawRegistry !== "string" || !rawRegistry.trim()) {
    throw new Error("trusted-reviewer-registry-secret-missing");
  }
  if (Buffer.byteLength(rawRegistry, "utf8") > 64 * 1024) {
    throw new Error("trusted-reviewer-registry-secret-exceeds-size-limit");
  }
  const privateKeyBytes = await regularFile(privateKeyPath, "Private key");
  const envelope = signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes: initialSnapshot.packageManifestBytes,
    privateKeyPem: privateKeyBytes.toString("utf8"),
    reviewerId,
    trustedReviewerRegistry: rawRegistry,
  });

  const signatureBytes = Buffer.from(JSON.stringify(envelope, null, 2) + "\n", "utf8");
  await writeFile(signaturePath, signatureBytes, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const createdSignatureStat = await lstat(signaturePath, { bigint: true });

  try {
    const finalSnapshot = await verifyBuildingReviewPackageDirectory(packageDir);
    assertIntegrityPreflight(finalSnapshot, "after-signing");
    if (!sameBuildingReviewPackageSnapshot(initialSnapshot, finalSnapshot)) {
      throw new Error("review-package-changed-during-signing-window");
    }
    const persistedSignature = await regularFile(signaturePath, "Signature envelope");
    if (!persistedSignature.equals(signatureBytes)) {
      throw new Error("review-package-signature-file-changed-after-write");
    }
  } catch (error) {
    await removeOnlyOurSignature(signaturePath, createdSignatureStat);
    throw error;
  }

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
    packageIntegrity: initialSnapshot.integrity.status,
    packageIntegrityWarnings: initialSnapshot.integrity.counts.warnings,
    packageIntegrityChecks: initialSnapshot.integrity.counts.checks,
    packageSnapshotStable: true,
    publicationEligible: false,
  }, null, 2));
}

main().catch((error) => {
  console.error("Could not sign building review package:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
