import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { loadVerifiedSource } from "./source-workflow.mjs";
import { traceFloorPlanRaster } from "./floor-plan-raster-trace.mjs";

const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_TRACE_JSON_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new TypeError(label + " must be a safe identifier.");
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensurePrivateDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      const entry = await lstat(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Floor-plan trace output path must contain only regular directories.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (createError) {
        if (createError?.code !== "EEXIST") throw createError;
      }
      const entry = await lstat(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("Floor-plan trace output path must contain only regular directories.");
      }
    }
    current = await realpath(next);
    if (!inside(root, current)) throw new TypeError("Floor-plan trace output resolves outside workspaceRoot.");
  }
  return current;
}

async function persistTrace(root, buildingId, traceId, trace) {
  const bytes = Buffer.from(JSON.stringify(trace, null, 2) + "\n", "utf8");
  if (bytes.byteLength > MAX_TRACE_JSON_BYTES) {
    const error = new RangeError("Trace output exceeds the 8 MiB artifact limit; simplify the source or detection options.");
    error.code = "TRACE_OUTPUT_TOO_LARGE";
    throw error;
  }
  const directory = await ensurePrivateDirectory(root, [
    ".building-engine", "floor-plan-traces", buildingId, traceId,
  ]);
  const filePath = path.join(directory, "trace.json");
  const integrityPath = path.join(directory, "trace.integrity.json");
  const integrityBytes = Buffer.from(JSON.stringify({
    schemaVersion: "1.0.0",
    traceId,
    buildingId,
    traceSha256: sha256(bytes),
    sourceSha256: trace.source?.sha256,
  }, null, 2) + "\n", "utf8");
  try {
    await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    await writeFile(integrityPath, integrityBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { relativePath: path.relative(root, filePath).split(path.sep).join("/"), sha256: sha256(bytes), byteSize: bytes.byteLength };
}

/**
 * Analyze a private, already-ingested raster floor plan. PDF bytes are rejected:
 * rasterize the page with a controlled PDF renderer first, then ingest that
 * page image as a source so the trace always has pixel-coordinate evidence.
 */
export async function traceFloorPlanImageSource({ workspaceRoot, buildingId, sourceId, options = {} }) {
  const bid = safeId(buildingId, "buildingId");
  const sid = safeId(sourceId, "sourceId");
  const root = await realpath(path.resolve(workspaceRoot));
  const loaded = await loadVerifiedSource(root, bid, sid);
  if (!IMAGE_MIME_TYPES.has(loaded.record.mimeType)) {
    const error = new TypeError("Floor-plan raster trace supports JPEG, PNG or WebP image sources only; rasterize a PDF page to an image first.");
    error.code = "UNSUPPORTED_SOURCE_MEDIA";
    throw error;
  }
  if (loaded.bytes > 50 * 1024 * 1024) throw new RangeError("source exceeds the 50 MiB decoded image input limit.");
  const maxEdge = options.maxEdge ?? 2048;
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 256 || maxEdge > 4096) {
    throw new RangeError("maxEdge must be an integer between 256 and 4096.");
  }

  const sourceBytes = await readFile(loaded.assetPath);
  if (sha256(sourceBytes) !== loaded.sha256) {
    const error = new Error("Source bytes changed between provenance verification and decoding.");
    error.code = "SOURCE_CHECKSUM_MISMATCH";
    throw error;
  }

  let metadata;
  let decoded;
  try {
    const input = sharp(sourceBytes, { limitInputPixels: MAX_SOURCE_PIXELS, failOn: "error" });
    metadata = await input.metadata();
    if (!metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32 ||
        metadata.width * metadata.height > MAX_SOURCE_PIXELS) {
      throw new RangeError("Image dimensions must be at least 32x32 and no more than 40 million pixels.");
    }
    decoded = await sharp(sourceBytes, { limitInputPixels: MAX_SOURCE_PIXELS, failOn: "error" })
      .rotate()
      .greyscale()
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof RangeError) throw error;
    const invalid = new TypeError("Source could not be decoded as a supported raster image.");
    invalid.code = "INVALID_RASTER_IMAGE";
    throw invalid;
  }
  if (decoded.info.channels !== 1) throw new TypeError("Raster decoder did not produce a one-channel grayscale image.");

  const orientation = metadata.orientation ?? 1;
  const swapsAxes = orientation >= 5 && orientation <= 8;
  const orientedWidth = swapsAxes ? metadata.height : metadata.width;
  const orientedHeight = swapsAxes ? metadata.width : metadata.height;
  const traceId = "trace-" + randomUUID();
  const analysisTrace = traceFloorPlanRaster({
    width: decoded.info.width,
    height: decoded.info.height,
    grayscale: decoded.data,
    sourceSha256: loaded.sha256,
    options,
  });
  const trace = {
    ...analysisTrace,
    traceId,
    buildingId: bid,
    sourceId: sid,
    sourceEvidence: {
      sha256: loaded.sha256,
      mimeType: loaded.record.mimeType,
      byteSize: loaded.bytes,
      usageStatus: loaded.record.usageStatus ?? "unreviewed",
      licence: loaded.record.licence ?? "unknown",
    },
    raster: {
      orientedSourceWidth: orientedWidth,
      orientedSourceHeight: orientedHeight,
      analysisWidth: decoded.info.width,
      analysisHeight: decoded.info.height,
      sourcePixelsPerAnalysisPixelX: orientedWidth / decoded.info.width,
      sourcePixelsPerAnalysisPixelY: orientedHeight / decoded.info.height,
      reductionApplied: decoded.info.width !== orientedWidth || decoded.info.height !== orientedHeight,
    },
    createdAt: new Date().toISOString(),
  };
  const artifact = await persistTrace(root, bid, traceId, trace);
  return {
    traceId,
    buildingId: bid,
    sourceId: sid,
    sourceSha256: loaded.sha256,
    artifact,
    status: trace.status,
    summary: trace.summary,
    traceUrl: "/api/building-generation/floor-plan-traces/" + bid + "/" + traceId,
    mapReady: false,
    publicationEligible: false,
  };
}

export async function loadFloorPlanRasterTrace({ workspaceRoot, buildingId, traceId }) {
  const bid = safeId(buildingId, "buildingId");
  const tid = safeId(traceId, "traceId");
  const root = await realpath(path.resolve(workspaceRoot));
  let current = root;
  for (const segment of [".building-engine", "floor-plan-traces", bid, tid]) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new TypeError("Floor-plan trace path must contain only regular directories.");
    }
    const actual = await realpath(current);
    if (!inside(root, actual)) throw new TypeError("Floor-plan trace path resolves outside workspaceRoot.");
    current = actual;
  }
  const filePath = path.join(current, "trace.json");
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new TypeError("Trace artifact must be a regular, non-symlink file.");
  if (entry.size <= 0 || entry.size > MAX_TRACE_JSON_BYTES) throw new RangeError("Trace artifact size is invalid.");
  const integrityPath = path.join(current, "trace.integrity.json");
  const integrityEntry = await lstat(integrityPath);
  if (integrityEntry.isSymbolicLink() || !integrityEntry.isFile() ||
      integrityEntry.size <= 0 || integrityEntry.size > 16 * 1024) {
    throw new TypeError("Trace integrity record must be a small regular, non-symlink file.");
  }
  const bytes = await readFile(await realpath(filePath));
  const integrity = JSON.parse((await readFile(await realpath(integrityPath))).toString("utf8"));
  if (!integrity || integrity.schemaVersion !== "1.0.0" ||
      integrity.traceId !== tid || integrity.buildingId !== bid ||
      integrity.traceSha256 !== sha256(bytes)) {
    const error = new Error("Stored floor-plan trace failed its SHA-256 integrity check.");
    error.code = "TRACE_CHECKSUM_MISMATCH";
    throw error;
  }
  const trace = JSON.parse(bytes.toString("utf8"));
  if (!trace || trace.traceId !== tid || trace.buildingId !== bid ||
      trace.status !== "needs-human-trace-review" ||
      trace.source?.sha256 !== trace.sourceEvidence?.sha256 ||
      integrity.sourceSha256 !== trace.sourceEvidence?.sha256 ||
      trace.mapReady !== false || trace.publicationEligible !== false) {
    throw new TypeError("Stored floor-plan trace identity or review status is invalid.");
  }
  const currentSource = await loadVerifiedSource(root, bid, trace.sourceId);
  if (currentSource.sha256 !== trace.sourceEvidence.sha256) {
    const error = new Error("Original floor-plan image changed after trace creation.");
    error.code = "SOURCE_CHECKSUM_MISMATCH";
    throw error;
  }
  return trace;
}
