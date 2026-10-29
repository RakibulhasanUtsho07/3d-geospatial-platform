#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { calibrateFloorPlanRasterVectors } from "../src/core/building-generation/floor-plan-raster-vector-calibration.mjs";

const USAGE = "Usage: npm run calibrate:floor-plan-raster-vectors -- <proposal-report.json> <review.json> <original-raster-image> <output-geometry.json> <output-audit.json>";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularFile(filePath, label, maxBytes) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(label + " must be a regular non-symlink file.");
  if (info.size < 1 || info.size > maxBytes) throw new RangeError(label + " exceeds the allowed file size.");
  return readFile(filePath);
}

async function assertOutputAbsent(filePath, label) {
  try {
    await lstat(filePath);
    throw new Error(label + " already exists; choose a new output path rather than overwriting evidence.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function writePrivateNewFile(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    process.exitCode = args.length === 0 ? 1 : 0;
    return;
  }
  if (args.length !== 5) throw new Error(USAGE);
  const [proposalPath, reviewPath, sourcePath, geometryPath, auditPath] = args.map((item) => path.resolve(item));
  if (new Set([proposalPath, reviewPath, sourcePath, geometryPath, auditPath]).size !== 5) {
    throw new Error("Proposal, review, source and output paths must all be distinct.");
  }

  const [proposalBytes, reviewBytes, sourceBytes] = await Promise.all([
    readRegularFile(proposalPath, "Proposal report", 10 * 1024 * 1024),
    readRegularFile(reviewPath, "Review JSON", 5 * 1024 * 1024),
    readRegularFile(sourcePath, "Original raster source", 20 * 1024 * 1024),
  ]);
  let proposalReport;
  let review;
  try {
    proposalReport = JSON.parse(proposalBytes.toString("utf8"));
    review = JSON.parse(reviewBytes.toString("utf8"));
  } catch {
    throw new TypeError("Proposal report and review input must be valid UTF-8 JSON.");
  }
  await Promise.all([
    assertOutputAbsent(geometryPath, "Geometry output"),
    assertOutputAbsent(auditPath, "Audit output"),
  ]);

  const result = calibrateFloorPlanRasterVectors({ proposalReport, review, sourceBytes });
  const geometryBytes = Buffer.from(JSON.stringify(result.floorPlan, null, 2) + "\n", "utf8");
  const auditBytes = Buffer.from(JSON.stringify(result.audit, null, 2) + "\n", "utf8");
  let wroteGeometry = false;
  try {
    await writePrivateNewFile(geometryPath, geometryBytes);
    wroteGeometry = true;
    await writePrivateNewFile(auditPath, auditBytes);
  } catch (error) {
    if (wroteGeometry) await rm(geometryPath, { force: true });
    await rm(auditPath, { force: true });
    throw error;
  }
  process.stdout.write(JSON.stringify({
    status: result.status,
    geometryPath,
    geometryFileSha256: sha256(geometryBytes),
    floorPlanCanonicalSha256: result.audit.vector.floorPlanSha256,
    auditPath,
    auditFileSha256: sha256(auditBytes),
    reviewCanonicalSha256: result.audit.review.canonicalSha256,
    sourceSha256: result.audit.source.sha256,
    metresPerPixel: result.audit.calibration.metresPerPixel,
    roomCount: result.audit.vector.roomCount,
    wallCount: result.audit.vector.wallCount,
    openingCount: result.audit.vector.openingCount,
    allRoomBoundariesCovered: result.audit.vector.allRoomBoundariesCovered,
    generatedPreviewGlbSha256: result.audit.vector.generatedPreviewGlbSha256,
    releaseFlags: result.audit.releaseFlags,
    note: "Only private JSON vector draft and audit were written; no GLB or map asset was published.",
  }, null, 2) + "\n");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write("[floor-plan-raster-vector-calibration] " +
      (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
