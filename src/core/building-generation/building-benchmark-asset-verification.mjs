import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const HASH = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const DEFAULT_MAX_ASSET_BYTES = 8 * 1024 ** 3;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRelative(value) {
  if (!nonEmpty(value) || value.includes("\\") || value.includes("\0") ||
      value.startsWith("/") || /^[a-z]:/i.test(value)) {
    return false;
  }
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function addBlocker(blockers, assetBlockers, assetId, code, detail) {
  const blocker = { assetId: assetId ?? null, code, detail };
  blockers.push(blocker);
  if (assetBlockers) assetBlockers.push(blocker);
}

async function inspectRegularFile(root, localPath) {
  if (!safeRelative(localPath)) {
    const error = new Error("localPath must be a safe root-relative path without traversal or symlinks.");
    error.code = "unsafe-local-path";
    throw error;
  }

  const components = localPath.split("/");
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (cause) {
      const error = new Error("Asset file or path component does not exist.");
      error.code = "file-missing";
      error.cause = cause;
      throw error;
    }
    if (info.isSymbolicLink()) {
      const error = new Error("Symbolic links are not allowed in benchmark asset paths.");
      error.code = "symlink-disallowed";
      throw error;
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      const error = new Error("Every parent component in localPath must be a directory.");
      error.code = "parent-not-directory";
      throw error;
    }
    if (index === components.length - 1 && !info.isFile()) {
      const error = new Error("Benchmark assets must resolve to regular files.");
      error.code = "not-regular-file";
      throw error;
    }
  }

  const absolutePath = path.resolve(root, ...components);
  const actualPath = await realpath(absolutePath);
  if (!insideRoot(root, actualPath)) {
    const error = new Error("Resolved asset path escapes the selected asset root.");
    error.code = "path-escapes-root";
    throw error;
  }
  return { absolutePath, info: await lstat(absolutePath) };
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

/**
 * Verifies declared byte size and SHA-256 against files already present below
 * assetRoot. It does not download assets or authenticate licences, identity,
 * survey registration, geometry or model accuracy.
 */
export async function verifyBuildingBenchmarkAssetBytes(
  manifest,
  { assetRoot, maxAssetBytes = DEFAULT_MAX_ASSET_BYTES } = {},
) {
  const report = {
    schemaVersion: "1.0.0",
    status: "invalid",
    assets: [],
    blockers: [],
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
    limitation: "Local-byte verification only. It does not download assets, authenticate licensing or survey provenance, prove building identity, validate coordinate transforms, reconstruct a candidate or approve a model.",
  };

  if (!object(manifest)) {
    report.blockers.push({
      assetId: null,
      code: "manifest-object-required",
      detail: "Manifest must be a JSON object.",
    });
    return report;
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    report.blockers.push({
      assetId: null,
      code: "assets-required",
      detail: "Manifest must declare at least one asset.",
    });
    return report;
  }
  if (!nonEmpty(assetRoot)) {
    report.blockers.push({
      assetId: null,
      code: "asset-root-required",
      detail: "Provide an explicit local asset root.",
    });
    return report;
  }
  if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1) {
    report.blockers.push({
      assetId: null,
      code: "max-asset-bytes-invalid",
      detail: "maxAssetBytes must be a positive safe integer.",
    });
    return report;
  }

  let root;
  try {
    root = await realpath(path.resolve(assetRoot));
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) {
      throw new Error("Asset root must be a directory.");
    }
  } catch (error) {
    report.blockers.push({
      assetId: null,
      code: "asset-root-unavailable",
      detail: error instanceof Error ? error.message : String(error),
    });
    report.status = "blocked";
    return report;
  }

  const seenIds = new Set();
  for (const [index, asset] of manifest.assets.entries()) {
    const assetBlockers = [];
    const assetId = object(asset) && ID.test(asset.id ?? "") ? asset.id : null;
    const result = {
      index,
      id: assetId,
      localPath: object(asset) && typeof asset.localPath === "string" ? asset.localPath : null,
      status: "blocked",
      expectedByteSize: object(asset) ? asset.byteSize ?? null : null,
      actualByteSize: null,
      expectedSha256: object(asset) && typeof asset.sha256 === "string" ? asset.sha256.toLowerCase() : null,
      actualSha256: null,
      rightsReviewDeclared: Boolean(object(asset) && object(asset.license) && asset.license.reviewStatus === "approved"),
      blockers: assetBlockers,
    };
    report.assets.push(result);

    if (!object(asset) || !assetId) {
      addBlocker(report.blockers, assetBlockers, assetId, "asset-id-invalid",
        "Each asset must be an object with a safe, stable ID.");
      continue;
    }
    if (seenIds.has(assetId)) {
      addBlocker(report.blockers, assetBlockers, assetId, "asset-id-duplicate",
        "Asset IDs must be unique.");
      continue;
    }
    seenIds.add(assetId);

    if (!safeRelative(asset.localPath)) {
      addBlocker(report.blockers, assetBlockers, assetId, "unsafe-local-path",
        "asset.localPath must be a safe path relative to the explicit asset root.");
      continue;
    }
    if (!Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1) {
      addBlocker(report.blockers, assetBlockers, assetId, "declared-byte-size-invalid",
        "asset.byteSize must be a positive safe integer representing the original downloaded bytes.");
      continue;
    }
    if (!HASH.test(asset.sha256 ?? "")) {
      addBlocker(report.blockers, assetBlockers, assetId, "declared-sha256-invalid",
        "asset.sha256 must be a 64-character hexadecimal SHA-256 digest.");
      continue;
    }

    let file;
    try {
      file = await inspectRegularFile(root, asset.localPath);
    } catch (error) {
      const code = error && typeof error.code === "string" ? error.code : "asset-inspection-failed";
      addBlocker(report.blockers, assetBlockers, assetId, code,
        error instanceof Error ? error.message : String(error));
      continue;
    }

    result.actualByteSize = file.info.size;
    if (file.info.size > maxAssetBytes) {
      addBlocker(report.blockers, assetBlockers, assetId, "asset-too-large",
        "File size exceeds configured maxAssetBytes; no hash was computed.");
      continue;
    }

    try {
      result.actualSha256 = await sha256File(file.absolutePath);
    } catch (error) {
      addBlocker(report.blockers, assetBlockers, assetId, "asset-read-failed",
        error instanceof Error ? error.message : String(error));
      continue;
    }

    if (result.actualByteSize !== asset.byteSize) {
      addBlocker(report.blockers, assetBlockers, assetId, "byte-size-mismatch",
        "Actual file byte size does not match manifest.asset.byteSize.");
    }
    if (result.actualSha256.toLowerCase() !== asset.sha256.toLowerCase()) {
      addBlocker(report.blockers, assetBlockers, assetId, "sha256-mismatch",
        "SHA-256 of actual local file bytes does not match manifest.asset.sha256.");
    }
    if (assetBlockers.length === 0) result.status = "verified";
  }

  const structurallyComplete = report.assets.length === manifest.assets.length &&
    report.assets.every((asset) => asset.status === "verified");
  report.status = structurallyComplete && report.blockers.length === 0 ? "verified" : "blocked";
  return report;
}
