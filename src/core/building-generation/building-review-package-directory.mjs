import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { readImageDimensions } from "./image-quality-preflight.mjs";
import { verifyBuildingReviewPackage } from "./building-review-package-integrity.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PACKAGE_CONTROL_FILES = new Set(["package-manifest.json", "package-manifest.sig.json"]);

function identity(stat) {
  return [
    stat.dev.toString(),
    stat.ino.toString(),
    stat.size.toString(),
    stat.mtimeNs.toString(),
    stat.ctimeNs.toString(),
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

async function readStableRegularFile(filePath, label) {
  const pathBefore = await statPath(filePath, label);
  if (!pathBefore.isFile()) throw new Error("review-package-entry-must-be-regular-file:" + label);

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
        BigInt(bytes.length) !== descriptorAfter.size) {
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
  const { bytes: packageManifestBytes } = await readStableRegularFile(manifestPath, "package-manifest.json");
  let packageManifest;
  try {
    packageManifest = JSON.parse(packageManifestBytes.toString("utf8"));
  } catch {
    throw new Error("review-package-manifest-json-invalid");
  }

  const actualFiles = [];
  await walkDirectory(packageDir, packageDir, actualFiles);
  actualFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

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
export async function verifyBuildingReviewPackageDirectory(directoryArg) {
  const snapshot = await readBuildingReviewPackageDirectory(directoryArg);
  const integrity = verifyBuildingReviewPackage({
    packageManifest: snapshot.packageManifest,
    actualFiles: snapshot.actualFiles,
    packageManifestSha256: snapshot.packageManifestSha256,
  });
  return { ...snapshot, integrity };
}

export function sameBuildingReviewPackageSnapshot(left, right) {
  return Boolean(left && right && left.snapshotToken === right.snapshotToken);
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
  const root = await statPath(packageDir, "root-directory");
  if (!root.isDirectory()) throw new Error("review-package-root-must-be-a-directory");
  return readStableRegularFile(path.join(packageDir, filename), filename);
}
