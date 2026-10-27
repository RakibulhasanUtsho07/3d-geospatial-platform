import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeRelativePath(value) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[a-z]:/i.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function addCheck(checks, id, passed, detail) {
  checks.push({
    id,
    status: passed ? "passed" : "blocked",
    detail,
  });
}

/**
 * Resolve a path under the explicitly selected asset root. Nested symlinks
 * are rejected so a manifest cannot escape the root by traversing a link.
 */
async function resolveRegularFile(rootRealPath, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error("Path must be a safe relative path without '..', '.', absolute paths or backslashes.");
  }

  const parts = relativePath.split("/");
  let current = rootRealPath;

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const entry = await lstat(current);

    if (entry.isSymbolicLink()) {
      throw new Error("Symbolic links are not accepted in asset paths.");
    }

    const isLast = index === parts.length - 1;
    if (isLast && !entry.isFile()) {
      throw new Error("Asset path must resolve to a regular file.");
    }
    if (!isLast && !entry.isDirectory()) {
      throw new Error("Every parent component of an asset path must be a directory.");
    }
  }

  const relativeToRoot = path.relative(rootRealPath, current);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(".." + path.sep) || path.isAbsolute(relativeToRoot)) {
    throw new Error("Resolved asset path escapes the asset root.");
  }

  return { path: current, stat: await lstat(current) };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function verifyDeclaredFile({
  rootRealPath,
  relativePath,
  expectedByteSize,
  expectedSha256,
  label,
  checks,
}) {
  if (!isSafeRelativePath(relativePath)) {
    addCheck(checks, label, false,
      "A safe project-relative localPath/glbPath is required; absolute paths, traversal and backslashes are rejected.");
    return null;
  }
  if (!Number.isSafeInteger(expectedByteSize) || expectedByteSize <= 0) {
    addCheck(checks, label + "-declared-byte-size", false,
      "Declared byte size must be a positive safe integer.");
    return null;
  }
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
    addCheck(checks, label + "-declared-sha256", false,
      "Declared SHA-256 must be exactly 64 hexadecimal characters.");
    return null;
  }

  try {
    const resolved = await resolveRegularFile(rootRealPath, relativePath);
    const actualByteSize = resolved.stat.size;
    if (actualByteSize !== expectedByteSize) {
      addCheck(checks, label + "-byte-size", false,
        "Declared byte size " + expectedByteSize + " does not match actual byte size " + actualByteSize + ".");
      return { actualByteSize, sha256: null, path: resolved.path, valid: false };
    }

    const actualSha256 = await sha256File(resolved.path);
    const hashMatches = actualSha256.toLowerCase() === expectedSha256.toLowerCase();
    addCheck(checks, label + "-sha256", hashMatches,
      hashMatches
        ? "SHA-256 matches the exact local file bytes."
        : "Declared SHA-256 does not match the exact local file bytes.");

    if (hashMatches) {
      addCheck(checks, label + "-byte-size", true, "Declared and actual byte sizes match.");
    }
    return {
      actualByteSize,
      sha256: actualSha256,
      path: resolved.path,
      valid: hashMatches,
    };
  } catch (error) {
    addCheck(checks, label + "-file", false,
      error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Verify the locally available bytes named by a BRF-10 intake manifest.
 *
 * This verifies local paths, byte sizes and SHA-256 values only. It does not
 * download assets, validate licence truth, confirm building identity, verify
 * survey provenance/coordinate registration, or approve model accuracy.
 */
export async function verifyBuildingBenchmarkAssetBytes(manifest, assetRoot) {
  const checks = [];
  const blocked = (id, detail) => addCheck(checks, id, false, detail);

  if (!isObject(manifest)) {
    return {
      status: "invalid",
      counts: { assets: 0, verifiedAssets: 0, blockers: 1 },
      checks: [{ id: "manifest-object", status: "blocked", detail: "Manifest must be a JSON object." }],
      blockers: ["manifest-object"],
      candidate: { verified: false },
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    };
  }

  let rootRealPath;
  try {
    rootRealPath = await realpath(assetRoot);
    const rootStat = await lstat(rootRealPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Asset root must be a real directory.");
    }
  } catch (error) {
    blocked("asset-root", error instanceof Error ? error.message : String(error));
    return {
      status: "blocked",
      counts: { assets: Array.isArray(manifest.assets) ? manifest.assets.length : 0, verifiedAssets: 0, blockers: 1 },
      checks,
      blockers: ["asset-root"],
      candidate: { verified: false },
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    };
  }

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  addCheck(checks, "asset-list", assets.length > 0,
    assets.length > 0 ? "Source assets are declared." : "Manifest must declare at least one asset.");

  const assetsById = new Map();
  const assetResults = new Map();
  const duplicateIds = new Set();
  for (const [index, asset] of assets.entries()) {
    if (!isObject(asset) || typeof asset.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(asset.id)) {
      blocked("asset-" + index + "-identity", "Each asset must be an object with a safe stable id.");
      continue;
    }
    if (assetsById.has(asset.id)) {
      duplicateIds.add(asset.id);
      blocked("asset-ids-unique", "Duplicate asset ID: " + asset.id + ".");
      continue;
    }
    assetsById.set(asset.id, asset);
    assetResults.set(asset.id, await verifyDeclaredFile({
      rootRealPath,
      relativePath: asset.localPath,
      expectedByteSize: asset.byteSize,
      expectedSha256: asset.sha256,
      label: "asset-" + asset.id,
      checks,
    }));
  }
  if (duplicateIds.size === 0) {
    addCheck(checks, "asset-ids-unique", true, "Asset IDs are unique.");
  }

  const candidate = isObject(manifest.candidate) ? manifest.candidate : null;
  let candidateResult = null;
  if (!candidate) {
    blocked("candidate-object", "Manifest must declare a candidate object.");
  } else {
    candidateResult = await verifyDeclaredFile({
      rootRealPath,
      relativePath: candidate.glbPath,
      expectedByteSize: candidate.glbByteSize,
      expectedSha256: candidate.glbSha256,
      label: "candidate-glb",
      checks,
    });

    const sourceIds = Array.isArray(candidate.sourceAssetIds) ? candidate.sourceAssetIds : [];
    const sourceAssets = sourceIds.map((id) => assetsById.get(id)).filter(Boolean);
    const sourcesValid = sourceIds.length > 0 &&
      sourceIds.length === sourceAssets.length &&
      new Set(sourceIds).size === sourceIds.length &&
      sourceAssets.every((asset) => asset.role === "candidate-image");
    addCheck(checks, "candidate-source-assets", sourcesValid,
      sourcesValid
        ? "Candidate inputs reference unique, declared candidate-image assets."
        : "candidate.sourceAssetIds must reference one or more unique declared candidate-image assets.");
  }

  const reference = isObject(manifest.reference) ? manifest.reference : null;
  const referenceIds = reference && Array.isArray(reference.sourceAssetIds) ? reference.sourceAssetIds : [];
  const referenceAssets = referenceIds.map((id) => assetsById.get(id)).filter(Boolean);
  const referenceResults = referenceIds.map((id) => assetResults.get(id)).filter(Boolean);
  const referenceIntegrityValid = referenceIds.length > 0 &&
    referenceIds.length === referenceAssets.length &&
    referenceIds.length === referenceResults.length &&
    referenceAssets.every((asset) => asset.role === "reference-model" || asset.role === "independent-surface") &&
    referenceResults.every((result) => result?.valid === true);
  addCheck(checks, "reference-bytes-verified", referenceIntegrityValid,
    referenceIntegrityValid
      ? "At least one declared reference asset is present and its exact bytes match the manifest."
      : "Reference must name one or more declared reference-model/independent-surface assets whose local bytes, byte sizes and hashes all verify.");

  const candidateReferenceDisjoint = candidateResult?.valid === true &&
    referenceResults.length > 0 &&
    referenceResults.every((result) => result?.valid === true && result.sha256 !== candidateResult.sha256);
  addCheck(checks, "candidate-reference-content-disjoint", candidateReferenceDisjoint,
    candidateReferenceDisjoint
      ? "Candidate GLB bytes differ from every verified reference asset."
      : "Candidate bytes are unverified, a reference asset is unverified, or candidate bytes duplicate reference geometry/source bytes.");

  const blockers = checks.filter((check) => check.status === "blocked").map((check) => check.id);
  const verifiedAssets = [...assetResults.values()].filter((result) => result?.valid === true).length;
  return {
    status: blockers.length === 0 ? "verified" : "blocked",
    assetRoot: rootRealPath,
    counts: {
      assets: assets.length,
      verifiedAssets,
      checks: checks.length,
      blockers: blockers.length,
    },
    checks,
    blockers,
    candidate: {
      verified: candidateResult?.valid === true,
      sha256: candidateResult?.valid === true ? candidateResult.sha256 : null,
      byteSize: candidateResult?.valid === true ? candidateResult.actualByteSize : null,
    },
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
    limitation: "Local byte-integrity verification only. It does not download files, prove licence authority, confirm building identity, validate CRS/vertical datum/frame registration, prove survey independence, or evaluate reconstruction accuracy.",
  };
}
