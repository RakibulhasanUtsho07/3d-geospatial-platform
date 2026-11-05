import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { readImageDimensions } from "./image-quality-preflight.mjs";
import { verifyBuildingReviewPackage } from "./building-review-package-integrity.mjs";
import { trustRegistryGovernanceKeyFingerprint } from "./trust-registry-governance-attestation.mjs";
import {
  advanceTrustRegistryGovernanceState,
  loadOrInitializeTrustRegistryGovernanceState,
} from "./trust-registry-governance-state.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PACKAGE_CONTROL_FILES = new Set(["package-manifest.json", "package-manifest.sig.json"]);

function identity(stat) {
  return [
    stat.dev.toString(),
    stat.ino.toString(),
    stat.size.toString(),
    stat.mtimeNs.toString(),
    stat.ctimeNs.toString(),
    stat.mode.toString(),
  ].join(":");
}

async function statPath(filePath, label) {
  let stat;
  try {
    stat = await lstat(filePath, { bigint: true });
  } catch {
    throw new Error("review-package-" + label + "-missing-or-unreadable");
  }
  if (stat.isSymbolicLink()) throw new Error("review-package-symlink-not-allowed:" + label);
  return stat;
}

async function readStableRegularFile(filePath, label, maxBytes = null) {
  const pathBefore = await statPath(filePath, label);
  if (!pathBefore.isFile()) throw new Error("review-package-entry-must-be-regular-file:" + label);
  if (maxBytes !== null && pathBefore.size > BigInt(maxBytes)) {
    throw new Error("review-package-file-exceeds-size-limit:" + label);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile() || identity(descriptorBefore) !== identity(pathBefore)) {
      throw new Error("review-package-file-identity-changed-before-read:" + label);
    }
    const bytes = await handle.readFile();
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await statPath(filePath, label);
    if (!descriptorAfter.isFile() ||
        identity(descriptorBefore) !== identity(descriptorAfter) ||
        identity(descriptorAfter) !== identity(pathAfter) ||
        BigInt(bytes.length) !== descriptorAfter.size ||
        (maxBytes !== null && descriptorAfter.size > BigInt(maxBytes))) {
      throw new Error("review-package-file-changed-during-read:" + label);
    }
    return { bytes, stat: descriptorAfter };
  } finally {
    await handle?.close();
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
  );
}

async function walkDirectory(root, current, files) {
  const directoryBefore = await statPath(current, "directory");
  if (!directoryBefore.isDirectory()) throw new Error("review-package-entry-is-not-a-directory");
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
    if (!safeRelativePath(relativePath)) throw new Error("review-package-unsafe-relative-path");
    const details = await statPath(fullPath, relativePath);
    if (details.isDirectory()) {
      await walkDirectory(root, fullPath, files);
      const after = await statPath(fullPath, relativePath);
      if (identity(details) !== identity(after)) {
        throw new Error("review-package-directory-changed-during-inventory:" + relativePath);
      }
      continue;
    }
    if (!details.isFile()) throw new Error("review-package-entry-not-regular-file:" + relativePath);
    if (PACKAGE_CONTROL_FILES.has(relativePath)) continue;

    const { bytes } = await readStableRegularFile(fullPath, relativePath);
    const image = /\.(?:png|jpe?g)$/i.test(entry.name) ? readImageDimensions(bytes) : null;
    files.push({
      relativePath,
      sha256: sha256(bytes),
      bytes: bytes.length,
      content: bytes,
      isRegularFile: true,
      ...(image ? { width: image.width, height: image.height } : {}),
    });
  }

  const directoryAfter = await statPath(current, "directory");
  if (identity(directoryBefore) !== identity(directoryAfter)) {
    throw new Error("review-package-directory-changed-during-inventory");
  }
}

/**
 * Takes one filesystem-safe snapshot of the package manifest and every package
 * artifact. File reads are pinned to an open descriptor, reject symlinks, and
 * compare inode/size/mtime/ctime before and after reading.
 */
export async function readBuildingReviewPackageDirectory(directoryArg) {
  if (typeof directoryArg !== "string" || !directoryArg.trim()) {
    throw new TypeError("Review-package directory path is required.");
  }
  const packageDir = path.resolve(directoryArg);
  const rootBefore = await statPath(packageDir, "root-directory");
  if (!rootBefore.isDirectory()) throw new Error("review-package-root-must-be-a-directory");

  const manifestPath = path.join(packageDir, "package-manifest.json");
  const manifestSnapshot = await readStableRegularFile(manifestPath, "package-manifest.json");
  const packageManifestBytes = manifestSnapshot.bytes;
  let packageManifest;
  try {
    packageManifest = JSON.parse(packageManifestBytes.toString("utf8"));
  } catch {
    throw new Error("review-package-manifest-json-invalid");
  }

  const actualFiles = [];
  await walkDirectory(packageDir, packageDir, actualFiles);
  actualFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  // The manifest is a package control file and is intentionally excluded from
  // actualFiles. Re-read it after walking all artifacts so a concurrent
  // replacement cannot leave the inventory bound to stale manifest bytes.
  const finalManifestSnapshot = await readStableRegularFile(manifestPath, "package-manifest.json");
  if (!manifestSnapshot.bytes.equals(finalManifestSnapshot.bytes) ||
      identity(manifestSnapshot.stat) !== identity(finalManifestSnapshot.stat)) {
    throw new Error("review-package-manifest-changed-during-inventory");
  }

  const rootAfter = await statPath(packageDir, "root-directory");
  if (identity(rootBefore) !== identity(rootAfter)) {
    throw new Error("review-package-root-changed-during-inventory");
  }

  const packageManifestSha256 = sha256(packageManifestBytes);
  const snapshot = {
    packageDir,
    packageManifest,
    packageManifestBytes,
    packageManifestSha256,
    actualFiles,
  };
  snapshot.snapshotToken = sha256(Buffer.from(JSON.stringify({
    packageManifestSha256,
    files: actualFiles.map((file) => [file.relativePath, file.sha256, file.bytes]),
  })));
  return snapshot;
}

/**
 * Recomputes all package integrity checks from the current filesystem snapshot.
 */
export async function verifyBuildingReviewPackageDirectory(directoryArg, {
  trustedSurveyorRegistry = process.env.SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON ?? null,
  trustedDeviceRegistry = process.env.SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON ?? null,
  trustedEnrollmentAuthorityRegistry = process.env.SURVEY_DEVICE_ENROLLMENT_TRUSTED_AUTHORITIES_JSON ?? null,
  trustRegistryGovernanceAttestation = process.env.SURVEY_TRUST_REGISTRY_GOVERNANCE_ATTESTATION_JSON ?? null,
  trustRegistryGovernancePublicKeyPem = process.env.SURVEY_TRUST_REGISTRY_GOVERNANCE_PUBLIC_KEY_PEM ?? null,
  minimumTrustRegistrySequence = process.env.SURVEY_TRUST_REGISTRY_MINIMUM_SEQUENCE ?? null,
  trustRegistryGovernanceStateFilePath = process.env.SURVEY_TRUST_REGISTRY_GOVERNANCE_STATE_FILE || null,
  trustRegistryGovernanceNow = undefined,
} = {}) {
  const snapshot = await readBuildingReviewPackageDirectory(directoryArg);
  const governance = snapshot.packageManifest?.singleImageEvidence?.schemaVersion === "1.8.0"
    ? snapshot.packageManifest.singleImageEvidence.trustRegistryGovernance
    : null;
  let governanceState = null;
  let effectiveMinimumSequence = minimumTrustRegistrySequence;

  if (governance && trustRegistryGovernanceStateFilePath) {
    if (typeof trustRegistryGovernancePublicKeyPem !== "string" || !trustRegistryGovernancePublicKeyPem) {
      throw new Error("Persisted governance state requires the independently pinned governance public key.");
    }
    const pinnedFingerprint = trustRegistryGovernanceKeyFingerprint(trustRegistryGovernancePublicKeyPem);
    if (governance.governanceKeyFingerprintSha256 !== pinnedFingerprint) {
      throw new Error("Package governance key fingerprint does not match the independently pinned public key.");
    }
    const loaded = await loadOrInitializeTrustRegistryGovernanceState({
      stateFilePath: trustRegistryGovernanceStateFilePath,
      registrySetId: governance.registrySetId,
      governanceKeyFingerprintSha256: pinnedFingerprint,
      bootstrapMinimumSequence: minimumTrustRegistrySequence,
      now: trustRegistryGovernanceNow,
    });
    governanceState = loaded.state;
    const configuredFloor = minimumTrustRegistrySequence === null ||
      minimumTrustRegistrySequence === undefined || minimumTrustRegistrySequence === ""
      ? governanceState.minimumAcceptedSequence
      : Number(minimumTrustRegistrySequence);
    effectiveMinimumSequence = Number.isSafeInteger(configuredFloor)
      ? Math.max(configuredFloor, governanceState.minimumAcceptedSequence)
      : minimumTrustRegistrySequence;
  }

  const integrity = verifyBuildingReviewPackage({
    packageManifest: snapshot.packageManifest,
    actualFiles: snapshot.actualFiles,
    packageManifestSha256: snapshot.packageManifestSha256,
    trustedSurveyorRegistry,
    trustedDeviceRegistry,
    trustedEnrollmentAuthorityRegistry,
    trustRegistryGovernanceAttestation,
    trustRegistryGovernancePublicKeyPem,
    minimumTrustRegistrySequence: effectiveMinimumSequence,
    trustRegistryGovernanceNow,
  });

  if (integrity.valid && governance && governanceState && trustRegistryGovernanceStateFilePath) {
    try {
      const advanced = await advanceTrustRegistryGovernanceState({
        stateFilePath: trustRegistryGovernanceStateFilePath,
        registrySetId: governance.registrySetId,
        governanceKeyFingerprintSha256: governance.governanceKeyFingerprintSha256,
        expectedRevision: governanceState.revision,
        acceptedSequence: governance.sequence,
        acceptedAttestationSha256: governance.attestationSha256,
        acceptedSnapshotSha256: governance.snapshotSha256,
        now: trustRegistryGovernanceNow,
      });
      governanceState = advanced.state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      integrity.errors.push({
        id: "trust-registry-governance-state-advance-failed",
        message,
      });
      integrity.checks.push({
        id: "trust-registry-governance-state-advance",
        status: "failed",
        message,
      });
      integrity.counts.errors += 1;
      integrity.valid = false;
      integrity.status = "tampered-or-invalid";
    }
  }

  return {
    ...snapshot,
    integrity,
    ...(governanceState ? {
      governanceState: {
        schemaVersion: governanceState.schemaVersion,
        registrySetId: governanceState.registrySetId,
        governanceKeyFingerprintSha256: governanceState.governanceKeyFingerprintSha256,
        minimumAcceptedSequence: governanceState.minimumAcceptedSequence,
        revision: governanceState.revision,
        stateSha256: governanceState.stateSha256,
      },
    } : {}),
  };
}

export function sameBuildingReviewPackageSnapshot(left, right) {
  return Boolean(left && right && left.snapshotToken === right.snapshotToken);
}

export function sameBuildingReviewPackageControlFile(left, right) {
  return Boolean(left && right &&
    Buffer.isBuffer(left.bytes) && Buffer.isBuffer(right.bytes) &&
    left.bytes.equals(right.bytes) &&
    left.stat && right.stat &&
    identity(left.stat) === identity(right.stat));
}


/**
 * Reads a root-level detached signature control file with the same descriptor-
 * pinned no-follow and identity checks as package artifacts.
 */
export async function readBuildingReviewPackageControlFile(directoryArg, filename) {
  if (typeof directoryArg !== "string" || !directoryArg.trim()) {
    throw new TypeError("Review-package directory path is required.");
  }
  if (filename !== "package-manifest.sig.json") {
    throw new TypeError("Only the detached signature control file may be read here.");
  }
  const packageDir = path.resolve(directoryArg);
  const rootBefore = await statPath(packageDir, "root-directory");
  if (!rootBefore.isDirectory()) throw new Error("review-package-root-must-be-a-directory");
  const result = await readStableRegularFile(path.join(packageDir, filename), filename, 64 * 1024);
  if (result.bytes.length === 0) throw new Error("review-package-signature-envelope-empty");
  const rootAfter = await statPath(packageDir, "root-directory");
  if (identity(rootBefore) !== identity(rootAfter)) {
    throw new Error("review-package-root-changed-during-control-file-read");
  }
  return result;
}


/**
 * Observe the package and signature again after cryptographic verification.
 * Readers are injected so race-window behavior can be tested deterministically.
 */
export async function assertStableBuildingReviewPackageVerificationWindow({
  initialPackageSnapshot,
  initialSignatureSnapshot,
  readPackageSnapshot,
  readSignatureSnapshot,
}) {
  if (!initialPackageSnapshot || !initialSignatureSnapshot ||
      typeof readPackageSnapshot !== "function" ||
      typeof readSignatureSnapshot !== "function") {
    throw new TypeError("Initial package/signature snapshots and read callbacks are required.");
  }
  const finalPackageSnapshot = await readPackageSnapshot();
  const finalSignatureSnapshot = await readSignatureSnapshot();
  const confirmationPackageSnapshot = await readPackageSnapshot();
  const confirmationSignatureSnapshot = await readSignatureSnapshot();

  if (!sameBuildingReviewPackageSnapshot(initialPackageSnapshot, finalPackageSnapshot) ||
      !sameBuildingReviewPackageSnapshot(finalPackageSnapshot, confirmationPackageSnapshot)) {
    throw new Error("review-package-changed-during-signature-verification");
  }
  if (!sameBuildingReviewPackageControlFile(initialSignatureSnapshot, finalSignatureSnapshot) ||
      !sameBuildingReviewPackageControlFile(finalSignatureSnapshot, confirmationSignatureSnapshot)) {
    throw new Error("review-package-signature-envelope-changed-during-verification");
  }
  return {
    packageSnapshot: initialPackageSnapshot,
    signatureSnapshot: initialSignatureSnapshot,
  };
}


/**
 * Reads an explicitly supplied legacy verification public key without
 * following a final-component symlink and with descriptor/path identity checks.
 * Private keys are never accepted by this verifier-side helper.
 */
export async function readStableBuildingReviewPackageLegacyPublicKey(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("Legacy trusted public-key file path is required.");
  }
  return readStableRegularFile(path.resolve(filePath), "legacy-public-key", 16 * 1024);
}
