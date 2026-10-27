#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 100 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

function fail(message) {
  const error = new Error(message);
  error.name = "IntakeError";
  throw error;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Manifest must be a JSON object.");
  }
  const asset = manifest.asset;
  const dataset = manifest.dataset;
  if (manifest.schemaVersion !== "1.0.0") fail("Unsupported source manifest schemaVersion.");
  if (typeof manifest.sampleId !== "string" || !/^[a-z0-9][a-z0-9._-]{1,99}$/.test(manifest.sampleId)) {
    fail("sampleId must be a safe stable identifier.");
  }
  if (!dataset || dataset.license !== "CC-BY-4.0" ||
      typeof dataset.attribution !== "string" || !dataset.attribution.trim() ||
      typeof dataset.licenseScope !== "string" || !dataset.licenseScope.trim()) {
    fail("Dataset licence declaration, attribution and licence scope must be explicit.");
  }
  if (manifest.evaluationStage !== "source-byte-intake-only") {
    fail("Only source-byte-intake-only manifests are accepted by this gate.");
  }
  if (!asset || asset.role !== "candidate-image" ||
      typeof asset.filename !== "string" || !/^[A-Za-z0-9_.-]+$/.test(asset.filename) ||
      !Number.isSafeInteger(asset.expectedByteSize) || asset.expectedByteSize <= 0 ||
      asset.expectedByteSize > MAX_BYTES || !HASH.test(asset.expectedSha256 ?? "") ||
      asset.mediaType !== "image/jpeg" ||
      !Number.isSafeInteger(asset.width) || asset.width <= 0 ||
      !Number.isSafeInteger(asset.height) || asset.height <= 0) {
    fail("Asset identity, byte size, SHA-256, JPEG media type and dimensions are required.");
  }
  let url;
  try {
    url = new URL(asset.sourceUrl);
  } catch {
    fail("Asset sourceUrl is not a valid URL.");
  }
  const expectedPath = "/datasets/Matt1up/drone-building-scans/resolve/main/flat-roof/images/" + asset.filename;
  if (url.protocol !== "https:" || url.hostname !== "huggingface.co" ||
      url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== expectedPath) {
    fail("Asset sourceUrl must be the pinned Hugging Face dataset path for the declared flat-roof image; no alternate host or query string is allowed.");
  }
  if (asset.expectedSha256.toLowerCase() !== asset.expectedSha256) {
    fail("expectedSha256 must be lowercase hexadecimal.");
  }
  return { asset, dataset };
}

async function hashFile(filePath, expectedSize) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    fail("Cannot stat downloaded image: " + (error instanceof Error ? error.message : String(error)));
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("Downloaded image must be a regular, non-symlink file.");
  if (stat.size > MAX_BYTES) fail("Downloaded image exceeds the 100 MiB safety limit.");
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    byteSize += chunk.length;
    if (byteSize > MAX_BYTES) fail("Downloaded image exceeds the 100 MiB safety limit while reading.");
    hash.update(chunk);
  }
  return { byteSize, sha256: hash.digest("hex"), filesystemByteSize: stat.size, expectedSize };
}

export async function verifyBrf13DroneImageSource(manifest, filePath) {
  const { asset, dataset } = validateManifest(manifest);
  const actual = await hashFile(filePath, asset.expectedByteSize);
  const checks = [
    {
      id: "local-image-byte-size",
      status: actual.byteSize === asset.expectedByteSize && actual.filesystemByteSize === asset.expectedByteSize ? "passed" : "blocked",
      expected: asset.expectedByteSize,
      actual: actual.byteSize,
      detail: "Exact downloaded file byte count compared with the upstream image manifest."
    },
    {
      id: "local-image-sha256",
      status: actual.sha256 === asset.expectedSha256 ? "passed" : "blocked",
      expected: asset.expectedSha256,
      actual: actual.sha256,
      detail: "SHA-256 was computed from the actual downloaded image bytes."
    }
  ];
  const blockers = checks.filter((check) => check.status !== "passed").map((check) => check.id);
  return {
    schemaVersion: "1.0.0",
    sampleId: manifest.sampleId,
    status: blockers.length === 0 ? "bytes-verified" : "blocked",
    checkedAt: new Date().toISOString(),
    dataset: {
      title: dataset.title,
      version: dataset.version,
      url: dataset.datasetUrl,
      sourceRepository: dataset.sourceRepository,
      sourceRepositoryCommit: dataset.sourceRepositoryCommit,
      declaredLicense: dataset.license,
      licenseScope: dataset.licenseScope,
      attribution: dataset.attribution,
      rightsStatus: dataset.rightsStatus
    },
    asset: {
      role: asset.role,
      buildingId: asset.buildingId,
      filename: asset.filename,
      sourceUrl: asset.sourceUrl,
      expectedByteSize: asset.expectedByteSize,
      actualByteSize: actual.byteSize,
      expectedSha256: asset.expectedSha256,
      actualSha256: actual.sha256,
      mediaType: asset.mediaType,
      declaredWidth: asset.width,
      declaredHeight: asset.height,
      upstreamManifestUrl: asset.upstreamManifestUrl,
      upstreamChecksumUrl: asset.upstreamChecksumUrl
    },
    checks,
    blockers,
    evaluationLimitations: manifest.knownLimitations,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false
  };
}

function parseArgs(args) {
  const result = { manifestPath: null, filePath: null, reportPath: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--help" || value === "-h") {
      result.help = true;
      return result;
    }
    if (value === "--manifest" || value === "--file" || value === "--report") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) fail("Missing value after " + value + ".");
      const key = value === "--manifest" ? "manifestPath" : value === "--file" ? "filePath" : "reportPath";
      if (result[key] !== null) fail("Duplicate argument: " + value);
      result[key] = next;
      index += 1;
    } else {
      fail("Unknown argument: " + value);
    }
  }
  if (!result.manifestPath || !result.filePath || !result.reportPath) {
    fail("Required arguments: --manifest <json> --file <downloaded-image> --report <output-json>.");
  }
  return result;
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
    console.log("Usage: node scripts/verify-brf13-drone-image-source.mjs --manifest <source.json> --file <downloaded-image.jpg> --report <report.json>\nVerifies a small, allowlisted source image against its declared byte size and SHA-256. This is not model accuracy or independent survey validation.");
    return;
  }
  try {
    const manifest = JSON.parse(await readFile(path.resolve(args.manifestPath), "utf8"));
    const report = await verifyBrf13DroneImageSource(manifest, path.resolve(args.filePath));
    const reportPath = path.resolve(args.reportPath);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "bytes-verified") process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.name === "IntakeError" ? 2 : 1;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
