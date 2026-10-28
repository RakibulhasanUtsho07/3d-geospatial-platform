import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MAX_ASSETS = 64;
const MAX_ASSET_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
const RELEASE_FLAGS = {
  acceptanceEligible: false,
  publicationEligible: false,
  mapReady: false,
  automaticApproval: false,
};

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeId(value) {
  return typeof value === "string" && ID.test(value);
}
function safeRelativePath(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    !value.includes("\\") && !value.startsWith("/") && !/^[a-z]:/i.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
function add(checks, blockers, id, ok, detail) {
  checks.push({ id, status: ok ? "passed" : "blocked", detail });
  if (!ok) blockers.push(id);
}
function blockedResult(manifest, checks, blockers, assets = []) {
  return {
    schemaVersion: "1.0.0",
    evaluationId: object(manifest) && safeId(manifest.evaluationId) ? manifest.evaluationId : "invalid-manifest",
    status: "blocked",
    byteStatus: "incomplete-or-invalid",
    assetCount: assets.length,
    verifiedAssetCount: assets.filter((asset) => asset.byteStatus === "byte-verified").length,
    blockers: [...new Set(blockers)],
    checks,
    assets,
    rightsStatus: "not-adjudicated-by-byte-verifier",
    buildingIdentityStatus: "not-adjudicated-by-byte-verifier",
    coordinateOperationStatus: "not-executed-by-byte-verifier",
    candidateSelected: false,
    accuracyPassed: false,
    releaseFlags: { ...RELEASE_FLAGS },
    policy: "local byte-integrity only; byte verification does not establish rights, identity, CRS, accuracy or release approval",
  };
}
async function resolveSourceFile(root, relativePath) {
  if (!safeRelativePath(relativePath)) {
    throw new Error("Path must be project-relative and must not contain traversal, absolute path syntax or backslashes.");
  }
  const parts = relativePath.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error("Symbolic links are not accepted in source asset paths.");
    const last = index === parts.length - 1;
    if (last && !entry.isFile()) throw new Error("Source asset must resolve to a regular file.");
    if (!last && !entry.isDirectory()) throw new Error("Every parent path component must be a directory.");
  }
  const relative = path.relative(root, current);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Resolved source asset escapes the selected asset root.");
  }
  return { path: current, stat: await lstat(current) };
}
async function hashFileBounded(filePath, maxBytes) {
  const digest = createHash("sha256");
  let count = 0;
  await new Promise((resolve, reject) => {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const stream = createReadStream(filePath, { flags: constants.O_RDONLY | noFollow });
    stream.on("data", (chunk) => {
      count += chunk.length;
      if (count > maxBytes) {
        stream.destroy(new Error("Source file exceeded its byte ceiling while streaming."));
        return;
      }
      digest.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { byteSize: count, sha256: digest.digest("hex") };
}
function metadataCheck(asset, index, checks, blockers) {
  const id = safeId(asset?.id) ? asset.id : "invalid-" + index;
  const valid = object(asset) && safeId(asset.id) &&
    typeof asset.role === "string" && asset.role.trim().length > 0 &&
    ["pinned", "pending-acquisition"].includes(asset.status);
  add(checks, blockers, "asset-" + id + "-metadata", valid,
    valid ? "Stable asset ID, role and recognized acquisition status are present." :
      "Asset requires a safe unique ID, non-empty role, and pinned or pending-acquisition status.");
  return { id, valid };
}

/**
 * Verify selected local source files only. No network requests are made.
 * The verifier's result never enables a model release flag and never interprets
 * a rights/identity field as trusted evidence.
 */
export async function verifyBrf36SourceAssetBytes(manifest, assetRoot, options = {}) {
  const checks = [], blockers = [];
  if (!object(manifest) || manifest.schemaVersion !== "1.0.0" ||
      !safeId(manifest.evaluationId) || !Array.isArray(manifest.assets) ||
      manifest.assets.length === 0 || manifest.assets.length > MAX_ASSETS) {
    add(checks, blockers, "manifest-contract", false,
      "Manifest must use schemaVersion 1.0.0, a safe evaluationId and 1–64 assets.");
    return blockedResult(manifest, checks, blockers);
  }

  let root;
  try {
    root = await realpath(assetRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Asset root must resolve to a real directory.");
    }
  } catch (error) {
    add(checks, blockers, "asset-root", false, error instanceof Error ? error.message : String(error));
    return blockedResult(manifest, checks, blockers, manifest.assets);
  }
  add(checks, blockers, "asset-root", true, "Asset root resolves to a directory.");

  const seenIds = new Set();
  const seenPaths = new Set();
  const results = [];
  let declaredTotal = 0;

  for (const [index, asset] of manifest.assets.entries()) {
    const { id, valid } = metadataCheck(asset, index, checks, blockers);
    const result = {
      id,
      role: object(asset) && typeof asset.role === "string" ? asset.role : "unknown",
      acquisitionStatus: object(asset) ? asset.status : "invalid",
      rightsStatus: object(asset) && typeof asset.rightsStatus === "string" ? asset.rightsStatus : "unknown",
      byteStatus: "blocked",
      localPath: null,
      expectedByteSize: null,
      actualByteSize: null,
      expectedSha256: null,
      actualSha256: null,
    };
    results.push(result);
    if (!valid) continue;

    if (seenIds.has(asset.id)) {
      add(checks, blockers, "asset-ids-unique", false, "Duplicate asset ID: " + asset.id + ".");
      continue;
    }
    seenIds.add(asset.id);

    if (asset.status === "pending-acquisition") {
      add(checks, blockers, "asset-" + id + "-acquisition", false,
        "Asset has not been acquired and byte-pinned; do not infer byte verification from metadata or a URL.");
      continue;
    }

    const pathOk = safeRelativePath(asset.localPath);
    const sizeOk = Number.isSafeInteger(asset.byteSize) && asset.byteSize > 0 &&
      asset.byteSize <= MAX_ASSET_BYTES;
    const hashOk = typeof asset.sha256 === "string" && SHA256.test(asset.sha256);
    add(checks, blockers, "asset-" + id + "-pins", pathOk && sizeOk && hashOk,
      pathOk && sizeOk && hashOk
        ? "Pinned relative path, positive bounded byte size and SHA-256 are declared."
        : "Pinned asset needs a safe localPath, positive byteSize up to 8 GiB and a 64-character SHA-256.");
    if (!(pathOk && sizeOk && hashOk)) continue;

    result.localPath = asset.localPath;
    result.expectedByteSize = asset.byteSize;
    result.expectedSha256 = asset.sha256.toLowerCase();

    if (seenPaths.has(asset.localPath)) {
      add(checks, blockers, "asset-paths-unique", false, "Multiple asset records point at the same local path: " + asset.localPath + ".");
      continue;
    }
    seenPaths.add(asset.localPath);

    declaredTotal += asset.byteSize;
    if (declaredTotal > MAX_TOTAL_BYTES) {
      add(checks, blockers, "total-declared-byte-ceiling", false,
        "Declared source assets exceed the 16 GiB aggregate byte ceiling.");
      continue;
    }

    let resolved;
    try {
      resolved = await resolveSourceFile(root, asset.localPath);
    } catch (error) {
      add(checks, blockers, "asset-" + id + "-file", false,
        error instanceof Error ? error.message : String(error));
      continue;
    }

    result.actualByteSize = resolved.stat.size;
    if (!Number.isSafeInteger(resolved.stat.size) || resolved.stat.size !== asset.byteSize) {
      add(checks, blockers, "asset-" + id + "-byte-size", false,
        "Declared byteSize " + asset.byteSize + " does not match local file size " + resolved.stat.size + ".");
      continue;
    }
    add(checks, blockers, "asset-" + id + "-byte-size", true,
      "Declared and local file byte sizes match.");

    let actual;
    try {
      actual = await hashFileBounded(resolved.path, asset.byteSize);
    } catch (error) {
      add(checks, blockers, "asset-" + id + "-stream", false,
        error instanceof Error ? error.message : String(error));
      continue;
    }
    result.actualByteSize = actual.byteSize;
    result.actualSha256 = actual.sha256;
    const after = await lstat(resolved.path);
    const stable = after.isFile() && !after.isSymbolicLink() &&
      after.dev === resolved.stat.dev && after.ino === resolved.stat.ino &&
      after.size === resolved.stat.size && after.mtimeMs === resolved.stat.mtimeMs;
    add(checks, blockers, "asset-" + id + "-stable-file", stable,
      stable ? "File identity and metadata remained stable during byte hashing." :
        "Source file changed during verification; repeat against an immutable local copy.");
    const hashMatches = actual.byteSize === asset.byteSize &&
      actual.sha256.toLowerCase() === asset.sha256.toLowerCase();
    add(checks, blockers, "asset-" + id + "-sha256", hashMatches,
      hashMatches ? "Actual streamed bytes match the pinned SHA-256." :
        "Actual streamed bytes do not match the pinned byte count and/or SHA-256.");
    if (stable && hashMatches) result.byteStatus = "byte-verified";
  }

  add(checks, blockers, "release-flags-remain-disabled", true,
    "This verifier cannot enable acceptance, publication, map readiness or automatic approval.");
  const uniqueBlockers = [...new Set(blockers)];
  const verifiedCount = results.filter((asset) => asset.byteStatus === "byte-verified").length;
  return {
    ...blockedResult(manifest, [], [], results),
    status: uniqueBlockers.length ? "blocked" : "source-bytes-verified-review-required",
    byteStatus: uniqueBlockers.length ? "incomplete-or-invalid" : "verified",
    assetCount: results.length,
    verifiedAssetCount: verifiedCount,
    blockers: uniqueBlockers,
    checks,
    assets: results,
    rightsStatus: "not-adjudicated-by-byte-verifier",
    buildingIdentityStatus: "not-adjudicated-by-byte-verifier",
    coordinateOperationStatus: "not-executed-by-byte-verifier",
    releaseFlags: { ...RELEASE_FLAGS },
    policy: "actual local byte hashes only; this report is not a rights, identity, CRS, accuracy or release approval",
  };
}
