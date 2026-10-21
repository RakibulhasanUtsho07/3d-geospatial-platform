import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_BYTES = { image: 20 * 1024 * 1024, video: 500 * 1024 * 1024, "floor-plan": 50 * 1024 * 1024, "video-frame": 20 * 1024 * 1024, auto: 500 * 1024 * 1024 };
const MIME = {
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]),
  "floor-plan": new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
  "video-frame": new Set(["image/jpeg"]),
};
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv", "application/pdf": ".pdf" };
const KIND = { "image/jpeg": "image", "image/png": "image", "image/webp": "image", "video/mp4": "video", "video/quicktime": "video", "video/webm": "video", "video/x-matroska": "video", "application/pdf": "floor-plan" };
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function validateId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(label + " must be a stable identifier (letters, digits, dot, underscore or hyphen)");
  return value;
}
function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
async function ensureRealDirInside(root, directory) {
  if (!isInside(root, directory)) throw new TypeError("workspace path escapes workspaceRoot");
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  if (!isInside(root, actual)) throw new TypeError("workspace contains a directory symlink outside workspaceRoot");
  return actual;
}
function inspectHeader(header) {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (header.length >= 5 && header.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  if (header.length >= 12 && header.toString("ascii", 4, 8) === "ftyp") return header.toString("ascii", 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  if (header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return "video/webm";
  return null;
}
async function readHeader(filePath) {
  const chunks = [];
  for await (const chunk of createReadStream(filePath, { start: 0, end: 31 })) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function optionalText(value, label, max = 500) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new TypeError(label + " must be a string up to " + max + " characters");
  return value.trim();
}
function buildMetadata(options, detectedMime, hash, byteSize, relativePath) {
  const record = {
    schemaVersion: "1.0.0", id: options.sourceId, buildingId: options.buildingId,
    kind: options.kind === "video-frame" ? "video-frame" : (options.kind === "floor-plan" ? "floor-plan" : (detectedMime === "application/pdf" ? "floor-plan" : (detectedMime.startsWith("image/") ? "image" : "video"))),
    mimeType: detectedMime, byteSize, sha256: hash, assetId: hash, relativePath,
    retrievedAt: new Date().toISOString(),
    usageStatus: optionalText(options.usageStatus, "usageStatus", 40) ?? "unreviewed",
    licence: optionalText(options.licence, "licence", 500) ?? "unknown",
  };
  for (const key of ["title", "author", "attribution", "capturedAt", "description", "providerId", "parentSourceId"]) {
    const value = optionalText(options[key], key, key === "description" ? 2000 : 500);
    if (value !== undefined) record[key] = value;
  }
  if (options.sourceUrl !== undefined) {
    let url;
    try { url = new URL(options.sourceUrl); } catch { throw new TypeError("sourceUrl must be an absolute HTTPS URL"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("sourceUrl must be HTTPS without embedded credentials");
    record.url = url.toString();
  }
  if (options.captureLocation !== undefined) {
    const { longitude, latitude, headingDegrees } = options.captureLocation;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -85 || latitude > 85) throw new RangeError("captureLocation must contain valid WGS84 coordinates");
    record.location = { longitude, latitude };
    if (headingDegrees !== undefined) {
      if (!Number.isFinite(headingDegrees) || headingDegrees < 0 || headingDegrees > 360) throw new RangeError("headingDegrees must be between 0 and 360");
      record.location.headingDegrees = headingDegrees;
    }
  }
  return record;
}

/** Ingest a local file; never fetches a remote URL. Unknown licence/reuse status is kept explicit. */
export async function ingestMediaFile(options) {
  if (!options || typeof options !== "object") throw new TypeError("options are required");
  const buildingId = validateId(options.buildingId, "buildingId"), sourceId = validateId(options.sourceId, "sourceId");
  const kind = options.kind ?? "auto";
  if (!(kind in MAX_BYTES)) throw new TypeError("unsupported media kind '" + kind + "'");
  const workspaceRoot = await realpath(path.resolve(options.workspaceRoot));
  const supplied = path.resolve(workspaceRoot, options.sourcePath);
  if (!isInside(workspaceRoot, supplied)) throw new TypeError("sourcePath must be inside workspaceRoot");
  const sourceStat = await lstat(supplied);
  if (sourceStat.isSymbolicLink()) throw new TypeError("media source may not be a symbolic link");
  if (!sourceStat.isFile()) throw new TypeError("media source must be a regular file");
  const absoluteSource = await realpath(supplied);
  if (!isInside(workspaceRoot, absoluteSource)) throw new TypeError("media source resolves outside workspaceRoot");
  const before = await stat(absoluteSource);
  if (before.size <= 0) throw new RangeError("media file is empty");
  const detectedMime = inspectHeader(await readHeader(absoluteSource));
  if (!detectedMime || !KIND[detectedMime]) throw new TypeError("unsupported file signature; only JPEG, PNG, WebP, MP4/MOV, WebM/MKV and PDF are accepted");
  const detectedKind = kind === "auto" ? KIND[detectedMime] : kind;
  if (!MIME[detectedKind]?.has(detectedMime)) throw new TypeError("file signature " + detectedMime + " does not match media kind '" + kind + "'");
  if (before.size > MAX_BYTES[detectedKind]) throw new RangeError(detectedKind + " exceeds " + MAX_BYTES[detectedKind] + "-byte size limit");

  const buildingDir = await ensureRealDirInside(workspaceRoot, path.join(workspaceRoot, ".building-engine", "media", buildingId));
  const assetsDir = await ensureRealDirInside(workspaceRoot, path.join(buildingDir, "assets"));
  const sourceDir = await ensureRealDirInside(workspaceRoot, path.join(buildingDir, "sources"));
  const recordPath = path.join(sourceDir, sourceId + ".json");
  try { await access(recordPath); throw new Error("source id '" + sourceId + "' already exists for building '" + buildingId + "'"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }

  const tempPath = path.join(assetsDir, ".tmp-" + randomUUID());
  const hash = createHash("sha256");
  let total = 0, header = Buffer.alloc(0);
  const digest = new Transform({ transform(chunk, _encoding, callback) {
    total += chunk.length;
    if (total > MAX_BYTES[detectedKind]) return callback(new RangeError(detectedKind + " exceeds its byte limit while reading"));
    if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
    hash.update(chunk); callback(null, chunk);
  }});
  try {
    await pipeline(createReadStream(absoluteSource), digest, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
    if (inspectHeader(header) !== detectedMime) throw new TypeError("media file signature changed during intake");
    const sha256 = hash.digest("hex");
    const relativeAssetPath = path.relative(workspaceRoot, path.join(assetsDir, sha256 + EXT[detectedMime])).split(path.sep).join("/");
    const absoluteAssetPath = path.join(workspaceRoot, ...relativeAssetPath.split("/"));
    try { await access(absoluteAssetPath); await rm(tempPath, { force: true }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; await rename(tempPath, absoluteAssetPath); }
    const record = buildMetadata({ ...options, buildingId, sourceId, kind: detectedKind }, detectedMime, sha256, total, relativeAssetPath);
    const tempRecord = recordPath + "." + randomUUID() + ".tmp";
    await writeFile(tempRecord, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    try { await rename(tempRecord, recordPath); } catch (error) { await rm(tempRecord, { force: true }); throw error; }
    return { record, absoluteAssetPath, recordPath };
  } catch (error) { await rm(tempPath, { force: true }).catch(() => {}); throw error; }
}

/** Map an intake record to the source fields understood by BuildingSpec. */
export function toBuildingSpecSource(record) {
  if (!record || typeof record !== "object" || typeof record.id !== "string" || typeof record.assetId !== "string") throw new TypeError("valid ingested media record required");
  return {
    id: record.id, kind: record.kind, title: record.title ?? record.id, assetId: record.assetId,
    usageStatus: record.usageStatus ?? "unreviewed", licence: record.licence ?? "unknown",
    ...(record.url ? { url: record.url } : {}), ...(record.author ? { author: record.author } : {}),
    ...(record.attribution ? { attribution: record.attribution } : {}), ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
    ...(record.location ? { location: record.location } : {}),
    ...(record.parentSourceId ? { description: "Derived from video source " + record.parentSourceId + (record.description ? "; " + record.description : "") } : record.description ? { description: record.description } : {}),
  };
}