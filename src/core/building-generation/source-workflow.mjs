import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeBuildingSpec } from "./building-spec.mjs";
import { toBuildingSpecSource } from "./media-intake.mjs";

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function safeId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(label + " is invalid");
  return value;
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function text(value, label, max = 500, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new TypeError(label + " is required");
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new TypeError(label + " must be a non-empty string of at most " + max + " characters");
  }
  return value.trim();
}
async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
export async function loadVerifiedSource(workspaceRoot, buildingId, sourceId) {
  const root = await realpath(path.resolve(workspaceRoot));
  const bid = safeId(buildingId, "buildingId");
  const sid = safeId(sourceId, "sourceId");
  const mediaPath = path.join(root, ".building-engine", "media", bid);
  const mediaEntry = await lstat(mediaPath);
  if (mediaEntry.isSymbolicLink() || !mediaEntry.isDirectory()) {
    throw new TypeError("building media directory must be a regular, non-symlink directory");
  }
  const mediaRoot = await realpath(mediaPath);
  if (!inside(root, mediaRoot)) throw new TypeError("building media directory resolves outside workspaceRoot");

  const sourceRootPath = path.join(mediaRoot, "sources");
  const assetRootPath = path.join(mediaRoot, "assets");
  for (const [candidate, label] of [[sourceRootPath, "source metadata directory"], [assetRootPath, "asset directory"]]) {
    const entry = await lstat(candidate);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new TypeError(label + " must be a real directory, not a symlink");
  }
  const sourceRoot = await realpath(sourceRootPath);
  const assetRoot = await realpath(assetRootPath);
  if (!inside(mediaRoot, sourceRoot) || !inside(mediaRoot, assetRoot)) {
    throw new TypeError("source/asset directory escapes the building media store");
  }

  const recordPath = path.join(sourceRoot, sid + ".json");
  const recordEntry = await lstat(recordPath);
  if (recordEntry.isSymbolicLink() || !recordEntry.isFile()) throw new TypeError("source metadata must be a regular, non-symlink file");
  const recordReal = await realpath(recordPath);
  if (!inside(sourceRoot, recordReal)) throw new TypeError("source metadata resolves outside source store");
  const record = JSON.parse(await readFile(recordReal, "utf8"));
  if (record.id !== sid || record.buildingId !== bid) throw new TypeError("source metadata identity mismatch");
  if (typeof record.relativePath !== "string" || record.relativePath.includes("\\")) {
    throw new TypeError("source asset relativePath is invalid");
  }

  const assetPath = path.resolve(root, record.relativePath);
  if (!inside(root, assetPath) || !inside(assetRoot, assetPath)) {
    throw new TypeError("source asset path escapes the workspace or building asset store");
  }
  const assetEntry = await lstat(assetPath);
  if (assetEntry.isSymbolicLink() || !assetEntry.isFile()) {
    throw new TypeError("source asset must be a regular, non-symlink file");
  }
  const assetReal = await realpath(assetPath);
  const assetStat = await stat(assetReal);
  if (!inside(assetRoot, assetReal) || assetStat.size <= 0) throw new TypeError("source asset resolves outside the asset store or is empty");
  const sha256 = await sha256File(assetReal);
  if (sha256 !== record.sha256 || sha256 !== record.assetId) throw new TypeError("source asset SHA-256 does not match its ingestion record");
  return { root, buildingId: bid, sourceId: sid, recordPath: recordReal, record, assetPath: assetReal, sha256, bytes: assetStat.size };
}

/** Record an operator's rights attestation; this does not independently verify copyright. */
export async function reviewBuildingSource(options) {
  if (!options || typeof options !== "object") throw new TypeError("options are required");
  if (options.confirmRights !== true) {
    throw new TypeError("confirmRights must be true after verifying that you own the source or have permission to use it");
  }
  const licence = text(options.licence, "licence", 500, true);
  if (["unknown", "n/a", "none"].includes(licence.toLowerCase())) throw new TypeError("a known source licence/permission basis is required");
  const loaded = await loadVerifiedSource(options.workspaceRoot, options.buildingId, options.sourceId);
  const record = { ...loaded.record };
  record.licence = licence;
  record.usageStatus = "approved";
  record.rightsReviewMethod = "explicit-cli-attestation";
  record.rightsReviewedAt = new Date().toISOString();

  for (const key of ["author", "attribution", "title", "capturedAt", "description", "providerId"]) {
    const value = text(options[key], key, key === "description" ? 2000 : 500, false);
    if (value !== undefined) record[key] = value;
  }
  if (options.sourceUrl !== undefined) {
    const raw = text(options.sourceUrl, "sourceUrl", 2048, true);
    let url;
    try { url = new URL(raw); } catch { throw new TypeError("sourceUrl must be an absolute HTTPS URL"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("sourceUrl must be HTTPS without embedded credentials");
    record.url = url.toString();
  }
  if (options.captureLocation !== undefined) {
    const { longitude, latitude, headingDegrees } = options.captureLocation;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -85 || latitude > 85) {
      throw new RangeError("captureLocation must contain valid WGS84 longitude and latitude");
    }
    record.location = { longitude, latitude };
    if (headingDegrees !== undefined) {
      if (!Number.isFinite(headingDegrees) || headingDegrees < 0 || headingDegrees > 360) {
        throw new RangeError("headingDegrees must be between 0 and 360");
      }
      record.location.headingDegrees = headingDegrees;
    }
  }
  const tempPath = loaded.recordPath + "." + randomUUID() + ".tmp";
  await writeFile(tempPath, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    await rename(tempPath, loaded.recordPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return { record, assetSha256: loaded.sha256, recordPath: loaded.recordPath, attestation: "explicit-cli-attestation" };
}

/** Join selected, verified local media records into a validated BuildingSpec. */
export async function prepareBuildingSpecSources(options) {
  if (!options || typeof options !== "object") throw new TypeError("options are required");
  const buildingSpec = options.buildingSpec;
  if (!buildingSpec || typeof buildingSpec !== "object" || Array.isArray(buildingSpec) || typeof buildingSpec.id !== "string") {
    throw new TypeError("buildingSpec with an id is required");
  }
  if (!Array.isArray(options.sourceIds) || options.sourceIds.length < 1 || options.sourceIds.length > 100) {
    throw new RangeError("sourceIds must contain between 1 and 100 IDs");
  }
  const sourceIds = options.sourceIds.map(value => safeId(value, "sourceId"));
  if (new Set(sourceIds).size !== sourceIds.length) throw new TypeError("sourceIds contains duplicates");
  const additions = [];
  for (const sourceId of sourceIds) {
    const loaded = await loadVerifiedSource(options.workspaceRoot, buildingSpec.id, sourceId);
    additions.push(toBuildingSpecSource(loaded.record));
  }
  const byId = new Map();
  for (const source of Array.isArray(buildingSpec.sources) ? buildingSpec.sources : []) {
    if (!source || typeof source !== "object" || typeof source.id !== "string") throw new TypeError("each existing BuildingSpec source needs an id");
    byId.set(source.id, source);
  }
  for (const source of additions) byId.set(source.id, source);
  const normalized = normalizeBuildingSpec({ ...buildingSpec, sources: [...byId.values()] }).spec;
  return {
    buildingSpec: normalized,
    selectedSourceIds: sourceIds,
    sourceStatuses: additions.map(source => ({ id: source.id, licence: source.licence, usageStatus: source.usageStatus, assetId: source.assetId })),
  };
}