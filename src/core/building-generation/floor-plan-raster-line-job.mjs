import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { loadVerifiedSource } from "./source-workflow.mjs";
import { proposeFloorPlanRasterLines } from "./floor-plan-raster-line-proposals.mjs";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier.");
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensurePrivateDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new TypeError("Refusing unsafe floor-plan line proposal storage.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (createError) {
        if (createError?.code !== "EEXIST") throw createError;
      }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new TypeError("Proposal storage path must be a real directory.");
      }
    }
    current = await realpath(current);
    if (!inside(root, current)) throw new TypeError("Proposal storage path escapes workspaceRoot.");
  }
  return current;
}

async function readRegularFile(directory, name, maxBytes) {
  const filePath = path.join(directory, name);
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new TypeError("Proposal artifact must be a regular, non-symlink file.");
  }
  if (info.size < 1 || info.size > maxBytes) {
    throw new RangeError("Proposal artifact is empty or exceeds its size limit.");
  }
  const actual = await realpath(filePath);
  if (!inside(directory, actual)) throw new TypeError("Proposal artifact resolves outside its private directory.");
  return readFile(actual);
}

async function writeAtomic(directory, name, bytes) {
  const target = path.join(directory, name);
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Analyze a previously ingested raster source and store an immutable private proposal report. */
export async function createFloorPlanRasterLineProposal({
  workspaceRoot,
  buildingId,
  sourceId,
  options = {},
  now = new Date(),
}) {
  const bid = safeId(buildingId, "buildingId");
  const sid = safeId(sourceId, "sourceId");
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("now must be a valid timestamp.");
  const root = await realpath(path.resolve(workspaceRoot));
  const source = await loadVerifiedSource(root, bid, sid);
  if (!["image", "floor-plan"].includes(source.record.kind)) {
    throw new TypeError("Source must be an ingested image or floor-plan raster.");
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(source.record.mimeType)) {
    const error = new TypeError("Raster line proposals support JPEG, PNG and WebP only. Rasterize PDF pages separately first.");
    error.code = "UNSUPPORTED_RASTER_SOURCE";
    throw error;
  }

  const imageBytes = await readFile(source.assetPath);
  const actualSourceSha256 = sha256(imageBytes);
  if (actualSourceSha256 !== source.sha256 || actualSourceSha256 !== source.record.sha256) {
    const error = new Error("Uploaded raster source changed after source intake.");
    error.code = "SOURCE_CHECKSUM_MISMATCH";
    throw error;
  }

  const analysis = await proposeFloorPlanRasterLines({
    imageBytes,
    sourceSha256: actualSourceSha256,
    sourceMimeType: source.record.mimeType,
    options,
  });
  const proposalId = "line-proposals-" + randomUUID();
  const createdAt = timestamp.toISOString();
  const report = {
    schemaVersion: "1.0.0",
    proposalId,
    buildingId: bid,
    sourceId: sid,
    createdAt,
    sourceContext: {
      usageStatus: source.record.usageStatus ?? "unreviewed",
      licence: source.record.licence ?? "unknown",
      rightsApproved: source.record.usageStatus === "approved" &&
        Boolean(source.record.licence) &&
        !["unknown", "n/a", "none"].includes(String(source.record.licence).trim().toLowerCase()),
    },
    analysis,
    status: "review-required-not-scaled",
    mapReady: false,
    publicationEligible: false,
  };
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + "\n", "utf8");
  const reportSha256 = sha256(reportBytes);
  const directory = await ensurePrivateDirectory(
    root,
    [".building-engine", "floor-plan-line-proposals", bid, proposalId],
  );
  const manifest = {
    schemaVersion: "1.0.0",
    proposalId,
    buildingId: bid,
    sourceId: sid,
    sourceSha256: actualSourceSha256,
    reportSha256,
    createdAt,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  try {
    await writeAtomic(directory, "report.json", reportBytes);
    await writeAtomic(directory, "manifest.json", manifestBytes);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    proposalId,
    buildingId: bid,
    sourceId: sid,
    reportSha256,
    candidateCount: analysis.summary.candidateCount,
    status: report.status,
    report,
    mapReady: false,
    publicationEligible: false,
  };
}

/** Retrieve the stored trace proposal only if its manifest, report and source hashes still agree. */
export async function loadFloorPlanRasterLineProposal({ workspaceRoot, buildingId, proposalId }) {
  const bid = safeId(buildingId, "buildingId");
  const pid = safeId(proposalId, "proposalId");
  const root = await realpath(path.resolve(workspaceRoot));
  const directory = await (async () => {
    let current = root;
    for (const segment of [".building-engine", "floor-plan-line-proposals", bid, pid]) {
      const next = path.join(current, segment);
      const info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new TypeError("Proposal storage path must contain only real directories.");
      }
      current = await realpath(next);
      if (!inside(root, current)) throw new TypeError("Proposal storage path escapes workspaceRoot.");
    }
    return current;
  })();

  const manifestBytes = await readRegularFile(directory, "manifest.json", 64 * 1024);
  const reportBytes = await readRegularFile(directory, "report.json", 4 * 1024 * 1024);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const report = JSON.parse(reportBytes.toString("utf8"));
  const reportSha256 = sha256(reportBytes);
  if (!manifest || manifest.schemaVersion !== "1.0.0" ||
      manifest.proposalId !== pid || manifest.buildingId !== bid ||
      !SHA256.test(manifest.sourceSha256 ?? "") ||
      !SHA256.test(manifest.reportSha256 ?? "") ||
      manifest.reportSha256 !== reportSha256 ||
      report?.proposalId !== pid || report.buildingId !== bid ||
      report.analysis?.source?.sha256 !== manifest.sourceSha256 ||
      report.analysis?.mapReady !== false || report.analysis?.publicationEligible !== false ||
      report.mapReady !== false || report.publicationEligible !== false) {
    throw new TypeError("Stored raster line proposal manifest or report failed integrity checks.");
  }
  const source = await loadVerifiedSource(root, bid, manifest.sourceId);
  if (source.sha256 !== manifest.sourceSha256 || source.sha256 !== report.analysis.source.sha256) {
    const error = new Error("Original raster source no longer matches the saved proposal.");
    error.code = "SOURCE_CHECKSUM_MISMATCH";
    throw error;
  }
  return {
    proposalId: pid,
    buildingId: bid,
    sourceId: manifest.sourceId,
    reportSha256,
    candidateCount: report.analysis.summary.candidateCount,
    status: report.status,
    report,
    mapReady: false,
    publicationEligible: false,
  };
}
