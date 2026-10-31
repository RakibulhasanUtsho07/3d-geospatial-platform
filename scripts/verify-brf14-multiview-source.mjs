#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_VIEW_COUNT = 32;
const SHA256 = /^[a-f0-9]{64}$/;
const SAMPLE_ID = "brf-14-flat-roof-16-view-subset";
const SOURCE_COMMIT = "19b3ce9cccf3e8fd414ff705f75d0f2105846fc1";
const DATA_REPOSITORY_REVISION = "fde325fbd1d3636ffcf5d48aedc24cdbfc9a630f";
const SOURCE_PREFIX = "https://huggingface.co/datasets/Matt1up/drone-building-scans/resolve/" + DATA_REPOSITORY_REVISION + "/flat-roof/images/";

function fail(message) {
  const error = new Error(message);
  error.name = "IntakeError";
  throw error;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validatePinnedMetadataUrl(value, suffix) {
  if (typeof value !== "string") return false;
  const expected = "https://raw.githubusercontent.com/Matt1Up/drone-building-scans-dataset/" +
    SOURCE_COMMIT + "/" + suffix;
  return value === expected;
}

function validateManifest(manifest) {
  if (!object(manifest)) fail("Manifest must be a JSON object.");
  if (manifest.schemaVersion !== "1.0.0") fail("Unsupported source manifest schemaVersion.");
  if (manifest.sampleId !== SAMPLE_ID) fail("Unexpected benchmark sampleId.");
  if (manifest.evaluationStage !== "multiview-source-byte-intake-only") {
    fail("This verifier only admits multi-view source-byte intake manifests.");
  }

  const dataset = manifest.dataset;
  if (!object(dataset) ||
      dataset.datasetUrl !== "https://huggingface.co/datasets/Matt1up/drone-building-scans" ||
      dataset.sourceRepository !== "https://github.com/Matt1Up/drone-building-scans-dataset" ||
      dataset.sourceRepositoryCommit !== SOURCE_COMMIT ||
      dataset.dataRepositoryRevision !== DATA_REPOSITORY_REVISION ||
      dataset.license !== "CC-BY-4.0" ||
      !validText(dataset.licenseScope) ||
      !validText(dataset.attribution) ||
      !validText(dataset.rightsStatus)) {
    fail("Pinned dataset identity, source-declared licence scope, attribution and rights-status note are required.");
  }

  const upstream = manifest.upstreamFiles;
  if (!object(upstream) ||
      !validatePinnedMetadataUrl(upstream.imageInventoryUrl, "manifest/flat-roof/images.csv") ||
      !validatePinnedMetadataUrl(upstream.checksumListUrl, "manifest/flat-roof/checksums.sha256") ||
      !validatePinnedMetadataUrl(upstream.colmapImagesUrl, "poses/flat-roof/colmap/images.txt") ||
      !validatePinnedMetadataUrl(upstream.colmapCamerasUrl, "poses/flat-roof/colmap/cameras.txt") ||
      upstream.metadataCommit !== SOURCE_COMMIT) {
    fail("Inventory, checksum list and COLMAP pose metadata must be pinned to the reviewed upstream repository commit.");
  }

  const frame = manifest.coordinateFrameMetadata;
  if (!object(frame) || !object(frame.gps) || !object(frame.colmap) ||
      !validText(frame.gps.frame) || !validText(frame.gps.verticalDatum) ||
      !validText(frame.colmap.frameId) || !validText(frame.colmap.units) ||
      !validText(frame.colmap.axisConvention) ||
      frame.colmap.epsg !== null ||
      frame.colmap.registrationToGps !== "not established by this intake") {
    fail("GPS and local COLMAP frames must be declared separately; the manifest must not claim an unverified GPS registration.");
  }

  const views = manifest.views;
  if (!Array.isArray(views) || views.length < 3 || views.length > MAX_VIEW_COUNT) {
    fail("views must contain between 3 and " + MAX_VIEW_COUNT + " selected images.");
  }
  if (manifest.selectionMethod?.expectedViewCount !== views.length ||
      !validText(manifest.selectionMethod?.name) ||
      !validText(manifest.selectionMethod?.description)) {
    fail("Selection method metadata must match the view list.");
  }
  if (!Number.isSafeInteger(manifest.maximumImageBytes) || manifest.maximumImageBytes <= 0 ||
      !Number.isSafeInteger(manifest.maximumTotalBytes) || manifest.maximumTotalBytes <= 0) {
    fail("Positive per-image and total byte limits are required.");
  }

  const seenIds = new Set();
  const seenNames = new Set();
  const seenHashes = new Set();
  let expectedTotalBytes = 0;
  for (const [index, view] of views.entries()) {
    const label = "views[" + index + "]";
    if (!object(view) ||
        typeof view.id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,99}$/.test(view.id) ||
        typeof view.filename !== "string" || !/^[A-Za-z0-9_.-]+$/.test(view.filename) ||
        view.localPath !== view.filename ||
        view.sourceUrl !== SOURCE_PREFIX + view.filename ||
        !Number.isSafeInteger(view.expectedByteSize) || view.expectedByteSize <= 0 ||
        view.expectedByteSize > manifest.maximumImageBytes ||
        typeof view.expectedSha256 !== "string" || !SHA256.test(view.expectedSha256) ||
        view.mediaType !== "image/jpeg" ||
        view.declaredWidth !== 4096 || view.declaredHeight !== 3072 ||
        !validText(view.capturedAt) || !Number.isFinite(Date.parse(view.capturedAt))) {
      fail(label + " has invalid image identity, exact URL, byte declaration or dimensions.");
    }
    if (seenIds.has(view.id) || seenNames.has(view.filename) || seenHashes.has(view.expectedSha256)) {
      fail("View IDs, filenames and expected hashes must all be unique; duplicate detected at " + label + ".");
    }
    seenIds.add(view.id);
    seenNames.add(view.filename);
    seenHashes.add(view.expectedSha256);
    if (!object(view.gps) ||
        !Number.isFinite(view.gps.latitude) || view.gps.latitude < -90 || view.gps.latitude > 90 ||
        !Number.isFinite(view.gps.longitude) || view.gps.longitude < -180 || view.gps.longitude > 180 ||
        !Number.isFinite(view.gps.altitudeM) || view.gps.altitudeM < -1000 || view.gps.altitudeM > 20000 ||
        view.gps.verticalDatum !== "not declared") {
      fail(label + " must preserve source GPS coordinates without inventing a vertical datum.");
    }
    const pose = view.colmapPose;
    if (!object(pose) || !Number.isSafeInteger(pose.imageId) || pose.imageId <= 0 ||
        !Array.isArray(pose.cameraCenterLocalM) || pose.cameraCenterLocalM.length !== 3 ||
        !pose.cameraCenterLocalM.every(Number.isFinite) ||
        !Number.isFinite(pose.centerAzimuthDegrees) || pose.centerAzimuthDegrees < 0 || pose.centerAzimuthDegrees >= 360 ||
        !Number.isFinite(pose.centerElevationDegrees) || pose.centerElevationDegrees < -90 || pose.centerElevationDegrees > 90 ||
        !Number.isFinite(pose.lookAngleToCaptureCenterDegrees) ||
        pose.lookAngleToCaptureCenterDegrees < 0 || pose.lookAngleToCaptureCenterDegrees > 180) {
      fail(label + " has invalid local pose/coverage metadata.");
    }
    expectedTotalBytes += view.expectedByteSize;
  }

  if (!Number.isSafeInteger(manifest.expectedTotalBytes) ||
      manifest.expectedTotalBytes !== expectedTotalBytes ||
      expectedTotalBytes > manifest.maximumTotalBytes) {
    fail("expectedTotalBytes must equal the sum of declared view sizes and remain under maximumTotalBytes.");
  }
  if (manifest.acceptanceEligible !== false || manifest.publicationEligible !== false ||
      manifest.mapReady !== false || manifest.automaticApproval !== false) {
    fail("Source intake must keep all acceptance/publication/map/automatic-approval flags false.");
  }
  return { dataset, views, expectedTotalBytes, frame };
}

async function inspectFile(root, relativePath, expectedSize, expectedSha256, maximumImageBytes) {
  if (typeof relativePath !== "string" || !/^[A-Za-z0-9_.-]+$/.test(relativePath)) {
    return { status: "blocked", error: "Local image path must be a simple filename." };
  }
  const filePath = path.join(root, relativePath);
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    return { status: "blocked", error: "Downloaded image is missing or unreadable: " +
      (error instanceof Error ? error.message : String(error)) };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return { status: "blocked", error: "Downloaded image must be a regular, non-symlink file." };
  }
  if (info.size > maximumImageBytes) {
    return { status: "blocked", actualByteSize: info.size, error: "Image exceeds the per-image byte limit." };
  }

  const hash = createHash("sha256");
  let actualByteSize = 0;
  try {
    for await (const chunk of createReadStream(filePath)) {
      actualByteSize += chunk.length;
      if (actualByteSize > maximumImageBytes) {
        return { status: "blocked", actualByteSize, error: "Image exceeded the per-image byte limit while hashing." };
      }
      hash.update(chunk);
    }
  } catch (error) {
    return { status: "blocked", actualByteSize, error: "Could not read image bytes: " +
      (error instanceof Error ? error.message : String(error)) };
  }
  const actualSha256 = hash.digest("hex");
  const sizeMatches = actualByteSize === expectedSize && info.size === expectedSize;
  const hashMatches = actualSha256 === expectedSha256;
  return {
    status: sizeMatches && hashMatches ? "passed" : "blocked",
    expectedByteSize: expectedSize,
    actualByteSize,
    filesystemByteSize: info.size,
    expectedSha256,
    actualSha256,
    sizeMatches,
    hashMatches,
    error: !sizeMatches ? "Actual byte size does not match the pinned inventory." :
      !hashMatches ? "Actual SHA-256 does not match the pinned upstream checksum." : null
  };
}

/** Check actual local bytes for a bounded, manifest-pinned multi-view source sample. */
export async function verifyBrf14MultiviewSource(manifest, assetRoot) {
  const validated = validateManifest(manifest);
  const requestedRoot = path.resolve(assetRoot);
  const requestedRootInfo = await lstat(requestedRoot);
  if (requestedRootInfo.isSymbolicLink() || !requestedRootInfo.isDirectory()) {
    fail("Asset root must be a real directory and must not be a symlink.");
  }
  const root = await realpath(requestedRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) {
    fail("Resolved asset root must be a directory.");
  }

  const views = [];
  let actualTotalBytes = 0;
  const actualHashes = new Set();
  for (const view of validated.views) {
    const result = await inspectFile(root, view.localPath, view.expectedByteSize,
      view.expectedSha256, manifest.maximumImageBytes);
    if (Number.isSafeInteger(result.actualByteSize) && result.actualByteSize >= 0) {
      actualTotalBytes += result.actualByteSize;
    }
    if (result.actualSha256) {
      if (actualHashes.has(result.actualSha256)) {
        result.status = "blocked";
        result.error = "Two selected view files have byte-identical content.";
      }
      actualHashes.add(result.actualSha256);
    }
    views.push({
      id: view.id,
      filename: view.filename,
      sourceUrl: view.sourceUrl,
      sourceCapturedAt: view.capturedAt,
      declaredGps: view.gps,
      sourceColmapPose: view.colmapPose,
      ...result
    });
  }
  const blockers = views.filter((view) => view.status !== "passed").map((view) => view.id);
  if (actualTotalBytes > manifest.maximumTotalBytes) blockers.push("total-byte-limit");
  const passed = blockers.length === 0;
  return {
    schemaVersion: "1.0.0",
    sampleId: manifest.sampleId,
    status: passed ? "views-byte-verified" : "blocked",
    checkedAt: new Date().toISOString(),
    dataset: {
      title: validated.dataset.title,
      datasetUrl: validated.dataset.datasetUrl,
      sourceRepository: validated.dataset.sourceRepository,
      sourceRepositoryCommit: validated.dataset.sourceRepositoryCommit,
      dataRepositoryRevision: validated.dataset.dataRepositoryRevision,
      declaredLicense: validated.dataset.license,
      licenseScope: validated.dataset.licenseScope,
      attribution: validated.dataset.attribution,
      rightsStatus: validated.dataset.rightsStatus
    },
    coordinateFrameMetadata: validated.frame,
    selectedViewCount: views.length,
    declaredTotalBytes: validated.expectedTotalBytes,
    actualTotalBytes,
    views,
    blockers,
    candidateGlbGenerated: false,
    independentReferenceVerified: false,
    knownLimitations: manifest.knownLimitations,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false
  };
}

function parseArgs(args) {
  const parsed = { manifestPath: null, assetRoot: null, reportPath: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      return parsed;
    }
    if (["--manifest", "--asset-root", "--report"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) fail("Missing path after " + arg + ".");
      const key = arg === "--manifest" ? "manifestPath" : arg === "--asset-root" ? "assetRoot" : "reportPath";
      if (parsed[key] !== null) fail("Duplicate argument: " + arg + ".");
      parsed[key] = value;
      index += 1;
    } else {
      fail("Unknown argument: " + arg + ".");
    }
  }
  if (!parsed.manifestPath || !parsed.assetRoot || !parsed.reportPath) {
    fail("Required: --manifest <json> --asset-root <download-dir> --report <json>.");
  }
  return parsed;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log("Usage: node scripts/verify-brf14-multiview-source.mjs --manifest <source.json> --asset-root <download-dir> --report <report.json>\nVerifies the declared bytes and pose metadata for a bounded multi-view building-image sample. It does not generate a GLB or validate independent survey accuracy.");
    return;
  }
  try {
    const manifest = JSON.parse(await readFile(path.resolve(args.manifestPath), "utf8"));
    const report = await verifyBrf14MultiviewSource(manifest, path.resolve(args.assetRoot));
    const reportPath = path.resolve(args.reportPath);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({
      reportPath,
      status: report.status,
      selectedViewCount: report.selectedViewCount,
      verifiedViewCount: report.views.filter((view) => view.status === "passed").length,
      blockers: report.blockers,
      candidateGlbGenerated: false,
      independentReferenceVerified: false,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false
    }, null, 2));
    if (report.status !== "views-byte-verified") process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.name === "IntakeError" ? 2 : 1;
  }
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) await main();
