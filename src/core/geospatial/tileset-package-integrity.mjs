import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { validateTilesetManifest } from "./tileset-manifest-validation.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%") ||
    value.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) return false;

  const segments = value.split("/");
  return segments.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." &&
    /^[a-zA-Z0-9._-]+$/.test(segment)
  );
}

async function readPackageFile(root, relativePath, maximumBytes) {
  if (!safeRelativePath(relativePath)) {
    throw new Error(`Unsafe package-relative path: ${String(relativePath)}`);
  }

  let current = root;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in a tiles package: ${relativePath}`);
    }
    const isFinal = index === segments.length - 1;
    if (!isFinal && !info.isDirectory()) {
      throw new Error(`Package path parent is not a directory: ${relativePath}`);
    }
    if (isFinal && !info.isFile()) {
      throw new Error(`Package asset is not a regular file: ${relativePath}`);
    }
    if (isFinal && info.size > maximumBytes) {
      throw new Error(`Package asset exceeds the configured size limit: ${relativePath}`);
    }
  }

  return readFile(current);
}

function collectContentEntries(tileset) {
  const entries = [];
  const stack = [tileset.root];
  while (stack.length) {
    const tile = stack.pop();
    if (!isRecord(tile)) continue;
    if (isRecord(tile.content)) {
      entries.push({ uri: tile.content.uri ?? tile.content.url, tileExtras: tile.extras ?? null });
    }
    if (Array.isArray(tile.contents)) {
      for (const item of tile.contents) {
        if (isRecord(item)) entries.push({ uri: item.uri ?? item.url, tileExtras: item.extras ?? tile.extras ?? null });
      }
    }
    if (Array.isArray(tile.children)) stack.push(...tile.children);
  }
  return entries;
}

function jsonFromBytes(bytes, name, errors) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    errors.push(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Verify a self-contained 3D Tiles package without loading or rendering it.
 * This proves file/manifest integrity only; it does not prove source rights,
 * building accuracy, Cesium rendering, or publication eligibility.
 */
export async function verifyTilesetPackage({
  directory,
  expectedSourceSha256 = null,
  maxTotalBytes = 512 * 1024 * 1024,
  maxSingleFileBytes = 256 * 1024 * 1024,
} = {}) {
  const errors = [];
  if (typeof directory !== "string" || directory.trim() === "") {
    return { valid: false, errors: ["A package directory is required."], tileCount: 0, contentCount: 0, bytesVerified: 0 };
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 ||
      !Number.isSafeInteger(maxSingleFileBytes) || maxSingleFileBytes < 1) {
    return { valid: false, errors: ["Package size limits must be positive safe integers."], tileCount: 0, contentCount: 0, bytesVerified: 0 };
  }

  const root = path.resolve(directory);
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error("Package root must be a real directory, not a symbolic link.");
    }
  } catch (error) {
    return {
      valid: false,
      errors: [`Cannot read package root: ${error instanceof Error ? error.message : String(error)}`],
      tileCount: 0,
      contentCount: 0,
      bytesVerified: 0,
    };
  }

  let tilesetBytes;
  let manifestBytes;
  try {
    [tilesetBytes, manifestBytes] = await Promise.all([
      readPackageFile(root, "tileset.json", maxSingleFileBytes),
      readPackageFile(root, "build-manifest.json", maxSingleFileBytes),
    ]);
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      tileCount: 0,
      contentCount: 0,
      bytesVerified: 0,
    };
  }

  const tileset = jsonFromBytes(tilesetBytes, "tileset.json", errors);
  const build = jsonFromBytes(manifestBytes, "build-manifest.json", errors);
  if (!isRecord(tileset) || !isRecord(build)) {
    return { valid: false, errors, tileCount: 0, contentCount: 0, bytesVerified: 0 };
  }

  const manifestValidation = validateTilesetManifest(tileset);
  errors.push(...manifestValidation.errors);

  if (build.schemaVersion !== 1) errors.push("build-manifest.json schemaVersion must be 1.");
  if (build.packageType !== "dhaka-multibuilding-3d-tiles-pilot") {
    errors.push('build-manifest.json packageType must be "dhaka-multibuilding-3d-tiles-pilot".');
  }
  if (!isRecord(build.source) || !SHA256_PATTERN.test(build.source.sha256 ?? "")) {
    errors.push("build-manifest.json must record the source dataset SHA-256.");
  } else if (expectedSourceSha256 && build.source.sha256 !== expectedSourceSha256) {
    errors.push("Package source SHA-256 does not match the expected source SHA-256.");
  }

  const assetExtras = isRecord(tileset.asset) && isRecord(tileset.asset.extras) ? tileset.asset.extras : null;
  if (isRecord(build.source) && SHA256_PATTERN.test(build.source.sha256 ?? "") &&
      assetExtras?.sourceSha256 !== build.source.sha256) {
    errors.push("tileset asset source SHA-256 does not match build-manifest.json source SHA-256.");
  }
  if (isRecord(build.configuration) && assetExtras &&
      build.configuration.syntheticHeightMeters !== assetExtras.syntheticHeightMeters) {
    errors.push("tileset synthetic height does not match the build configuration.");
  }
  if (isRecord(build.releaseFlags) &&
      ["acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"].some((key) => build.releaseFlags[key] !== false)) {
    errors.push("All release flags must remain explicitly false for this experimental package.");
  }
  if (isRecord(build.validation) &&
      build.validation.contentCount !== undefined &&
      build.validation.contentCount !== contentEntries.length) {
    errors.push("build-manifest validation contentCount does not match the tileset.");
  }

  const contentEntries = collectContentEntries(tileset);
  const contentUris = contentEntries.map((entry) => entry.uri);
  if (contentUris.length === 0) errors.push("The tileset contains no tile content.");
  if (contentUris.some((uri) => typeof uri !== "string" || !safeRelativePath(uri))) {
    errors.push("The tileset contains an unsafe content URI.");
  }
  const uniqueUris = new Set(contentUris);
  if (uniqueUris.size !== contentUris.length) errors.push("The tileset references the same content URI more than once.");

  const tiles = Array.isArray(build.tiles) ? build.tiles : [];
  if (!Array.isArray(build.tiles)) errors.push("build-manifest.json tiles must be an array.");
  if (tiles.length !== contentUris.length) errors.push("build-manifest tile count does not match tileset content count.");
  const tileUris = tiles.map((tile) => isRecord(tile) ? tile.contentUri : null);
  if (tileUris.some((uri) => typeof uri !== "string") || new Set(tileUris).size !== tileUris.length) {
    errors.push("build-manifest tile contentUri values must be unique strings.");
  }
  if (contentUris.some((uri) => !tileUris.includes(uri))) errors.push("A tileset content URI is absent from build-manifest.json tiles.");
  if (tileUris.some((uri) => !contentUris.includes(uri))) errors.push("build-manifest.json lists a tile that the tileset does not reference.");

  const tileByUri = new Map(tiles.filter(isRecord).map((tile) => [tile.contentUri, tile]));
  for (const entry of contentEntries) {
    const tile = tileByUri.get(entry.uri);
    if (!tile) continue;
    if (!SHA256_PATTERN.test(tile.featureSha256 ?? "")) {
      errors.push(`Tile ${entry.uri} has no valid source-feature SHA-256.`);
    }
    if (!SHA256_PATTERN.test(tile.contentSha256 ?? "")) {
      errors.push(`Tile ${entry.uri} has no valid content SHA-256.`);
    }
    if (isRecord(entry.tileExtras) &&
        (entry.tileExtras.sourceFeatureId !== tile.featureId ||
         entry.tileExtras.sourceFeatureSha256 !== tile.featureSha256)) {
      errors.push(`Tile source identity/hash extras do not match build-manifest.json for ${entry.uri}.`);
    }
  }

  if (!isRecord(build.files)) {
    errors.push("build-manifest.json files must be an object.");
  } else {
    const requiredPaths = new Set(["tileset.json", ...contentUris.filter((uri) => typeof uri === "string")]);
    for (const relativePath of requiredPaths) {
      if (!Object.prototype.hasOwnProperty.call(build.files, relativePath)) {
        errors.push(`build-manifest.json has no hash record for ${relativePath}.`);
      }
    }
    for (const relativePath of Object.keys(build.files)) {
      if (!safeRelativePath(relativePath)) {
        errors.push(`build-manifest.json contains unsafe file path ${relativePath}.`);
      }
    }
    for (const tile of tiles) {
      if (!isRecord(tile) || typeof tile.contentUri !== "string") continue;
      const fileRecord = build.files[tile.contentUri];
      if (!isRecord(fileRecord)) continue;
      if (tile.contentSha256 !== fileRecord.sha256) {
        errors.push(`Tile content SHA-256 does not match the package file record for ${tile.contentUri}.`);
      }
      if (tile.bytes !== fileRecord.bytes) {
        errors.push(`Tile byte count does not match the package file record for ${tile.contentUri}.`);
      }
    }

    let bytesVerified = 0;
    for (const [relativePath, expected] of Object.entries(build.files)) {
      if (!safeRelativePath(relativePath)) continue;
      if (!isRecord(expected) || !SHA256_PATTERN.test(expected.sha256 ?? "") ||
          !Number.isSafeInteger(expected.bytes) || expected.bytes < 1) {
        errors.push(`Invalid file integrity record for ${relativePath}.`);
        continue;
      }
      try {
        const bytes = relativePath === "tileset.json"
          ? tilesetBytes
          : await readPackageFile(root, relativePath, maxSingleFileBytes);
        bytesVerified += bytes.length;
        if (bytes.length !== expected.bytes) errors.push(`Byte-length mismatch for ${relativePath}.`);
        if (sha256(bytes) !== expected.sha256) errors.push(`SHA-256 mismatch for ${relativePath}.`);
      } catch (error) {
        errors.push(`Cannot verify ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (bytesVerified > maxTotalBytes) errors.push(`Package exceeds the total size limit (${maxTotalBytes} bytes).`);
    const actualFilePaths = Object.keys(build.files);
    if (actualFilePaths.length !== requiredPaths.size) {
      errors.push("build-manifest.json files contains unexpected or missing asset entries.");
    }
    return {
      valid: errors.length === 0,
      errors,
      tileCount: manifestValidation.tileCount,
      contentCount: contentUris.length,
      bytesVerified,
      sourceSha256: isRecord(build.source) ? build.source.sha256 ?? null : null,
      manifestVersion: manifestValidation.version,
    };
  }

  return {
    valid: false,
    errors,
    tileCount: manifestValidation.tileCount,
    contentCount: contentUris.length,
    bytesVerified: 0,
  };
}
