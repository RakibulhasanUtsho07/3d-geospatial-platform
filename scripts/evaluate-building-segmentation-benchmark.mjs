#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  buildSegmentationBenchmarkReport, calculateSegmentationMetrics, decodeSegmentationPalette,
  validateSegmentationBenchmarkManifest, SEGMENTATION_PALETTE_ID,
} from "../src/core/building-generation/building-segmentation-benchmark.mjs";

const HASH = /^[a-f0-9]{64}$/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\\\") ||
      value.startsWith("/") || /^[a-z]:/i.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " must be a safe project-relative path.");
  }
  return value;
}
async function safeRead(root, relative, label) {
  const safe = safeRelative(relative, label);
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!resolved.startsWith(root + path.sep)) throw new TypeError(label + " resolves outside the project root.");
  let current = root;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " must not traverse symbolic links.");
    if (current === resolved && !info.isFile()) throw new TypeError(label + " must be a regular file.");
  }
  return { path: resolved, bytes: await readFile(resolved) };
}
async function imageMetadata(bytes, label) {
  const info = await sharp(bytes, { failOn: "error" }).metadata();
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1) {
    throw new TypeError(label + " has unreadable image dimensions.");
  }
  return { width: info.width, height: info.height };
}
async function decodePaletteImage(bytes, label) {
  const decoded = await sharp(bytes, { failOn: "error" }).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 3) throw new TypeError(label + " must decode to RGB for " + SEGMENTATION_PALETTE_ID + ".");
  return { width: decoded.info.width, height: decoded.info.height, labels: decodeSegmentationPalette(decoded.data) };
}
function assetMismatch(asset, actual, dimensions) {
  if (actual.sha256.toLowerCase() !== asset.sha256?.toLowerCase()) return "SHA-256 mismatch";
  if (actual.bytes !== asset.bytes) return "byte-length mismatch";
  if (!dimensions || dimensions.width !== asset.width || dimensions.height !== asset.height) return "image-dimension mismatch";
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.find((arg) => arg.startsWith("--root="));
  const positional = argv.filter((arg) => !arg.startsWith("--root="));
  if (process.argv.includes("--help") || !positional[0] || positional.length > 2) {
    console.log("Usage: node scripts/evaluate-building-segmentation-benchmark.mjs <benchmark-manifest.json> [report.json] [--root=project-root]\nUses reviewed RGB-palette masks and records per-image/per-class metrics. No model is trained or auto-approved.");
    process.exitCode = process.argv.includes("--help") ? 0 : 2;
    return;
  }
  const root = await realpath(path.resolve(rootFlag ? rootFlag.slice("--root=".length) : process.cwd()));
  const manifestFile = await safeRead(root, positional[0], "benchmark manifest");
  const manifestSha256 = sha256(manifestFile.bytes);
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  const structural = validateSegmentationBenchmarkManifest(manifest);
  const evaluatedSamples = [], integrityIssues = [], integrity = [];
  for (const sample of manifest.samples ?? []) {
    let sourceLoaded = null, truthLoaded = null, sourceDigest = null, truthLabels = null;
    try {
      const file = await safeRead(root, sample.source?.path, sample.sampleId + " source image");
      sourceDigest = { sha256: sha256(file.bytes), bytes: file.bytes.length };
      const dimensions = await imageMetadata(file.bytes, sample.sampleId + " source image");
      const mismatch = assetMismatch(sample.source, sourceDigest, dimensions);
      integrity.push({ sampleId: sample.sampleId, kind: "source", path: sample.source?.path,
        status: mismatch ? "failed" : "passed", ...sourceDigest, dimensions, detail: mismatch });
      if (mismatch) throw new Error("Source asset " + mismatch + ".");
      sourceLoaded = { file, dimensions };
    } catch (error) {
      integrity.push({ sampleId: sample.sampleId, kind: "source", path: sample.source?.path, status: "failed",
        detail: error instanceof Error ? error.message : String(error) });
      integrityIssues.push({ level: "error", code: "source-asset-integrity-failed",
        detail: "Source image could not be verified: " + (error instanceof Error ? error.message : String(error)), sampleId: sample.sampleId });
    }
    try {
      const file = await safeRead(root, sample.groundTruthMask?.path, sample.sampleId + " ground-truth mask");
      const actual = { sha256: sha256(file.bytes), bytes: file.bytes.length };
      const dimensions = await imageMetadata(file.bytes, sample.sampleId + " ground-truth mask");
      const mismatch = assetMismatch(sample.groundTruthMask, actual, dimensions);
      integrity.push({ sampleId: sample.sampleId, kind: "ground-truth-mask", path: sample.groundTruthMask?.path,
        status: mismatch ? "failed" : "passed", ...actual, dimensions, detail: mismatch });
      if (mismatch) throw new Error("Ground-truth mask " + mismatch + ".");
      if (!sourceLoaded || dimensions.width !== sourceLoaded.dimensions.width || dimensions.height !== sourceLoaded.dimensions.height) {
        throw new Error("Ground-truth mask dimensions do not match the source image.");
      }
      truthLoaded = { file, dimensions };
      truthLabels = await decodePaletteImage(file.bytes, sample.sampleId + " ground-truth mask");
    } catch (error) {
      integrity.push({ sampleId: sample.sampleId, kind: "ground-truth-mask", path: sample.groundTruthMask?.path,
        status: "failed", detail: error instanceof Error ? error.message : String(error) });
      integrityIssues.push({ level: "error", code: "ground-truth-integrity-failed",
        detail: "Ground-truth mask could not be verified: " + (error instanceof Error ? error.message : String(error)), sampleId: sample.sampleId });
    }
    for (const candidate of sample.predictions ?? []) {
      try {
        if (!sourceLoaded || !truthLoaded || !truthLabels) throw new Error("Source or reviewed ground truth failed integrity verification.");
        if (candidate.inputSha256?.toLowerCase() !== sourceDigest.sha256.toLowerCase()) {
          throw new Error("Candidate input hash does not match the exact source image bytes.");
        }
        const file = await safeRead(root, candidate.mask?.path, sample.sampleId + " prediction mask");
        const actual = { sha256: sha256(file.bytes), bytes: file.bytes.length };
        const dimensions = await imageMetadata(file.bytes, sample.sampleId + " prediction mask");
        const mismatch = assetMismatch(candidate.mask, actual, dimensions);
        integrity.push({ sampleId: sample.sampleId, providerId: candidate.providerId, kind: "prediction-mask",
          path: candidate.mask?.path, status: mismatch ? "failed" : "passed", ...actual, dimensions, detail: mismatch });
        if (mismatch) throw new Error("Prediction mask " + mismatch + ".");
        if (dimensions.width !== sourceLoaded.dimensions.width || dimensions.height !== sourceLoaded.dimensions.height) {
          throw new Error("Prediction mask dimensions do not match the exact source image.");
        }
        const prediction = await decodePaletteImage(file.bytes, sample.sampleId + " prediction mask");
        const metrics = calculateSegmentationMetrics(truthLabels.labels, prediction.labels);
        evaluatedSamples.push({ sampleId: sample.sampleId, providerId: candidate.providerId, status: "evaluated",
          sourceSha256: sourceDigest.sha256, groundTruthSha256: sha256(truthLoaded.file.bytes),
          predictionSha256: actual.sha256, metrics });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        evaluatedSamples.push({ sampleId: sample.sampleId, providerId: candidate.providerId, status: "failed", detail });
        integrityIssues.push({ level: "error", code: "prediction-integrity-or-evaluation-failed", detail, sampleId: sample.sampleId });
      }
    }
  }
  const report = buildSegmentationBenchmarkReport({ manifest, evaluatedSamples });
  report.manifestSha256 = manifestSha256;
  report.assetIntegrity = integrity;
  report.issues.push(...integrityIssues);
  report.counts.errors = report.issues.filter((item) => item.level === "error").length;
  report.counts.warnings = report.issues.filter((item) => item.level === "warning").length;
  if (report.counts.errors) report.status = "benchmark-failed";
  else if (report.counts.warnings || structural.status !== "ready-for-evaluation") report.status = "benchmark-incomplete";
  const reportPath = path.resolve(root, positional[1] ??
    path.join("artifacts", "building-segmentation-benchmark", (manifest.benchmarkId || "unidentified") + "-report.json"));
  if (!reportPath.startsWith(root + path.sep)) throw new TypeError("Report output must resolve inside the project root.");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ reportPath: path.relative(root, reportPath).split(path.sep).join("/"),
    status: report.status, samples: report.counts.samples, evaluatedPairs: report.counts.evaluatedPairs,
    errors: report.counts.errors, warnings: report.counts.warnings, acceptanceEligible: false }, null, 2));
  if (report.status === "benchmark-failed") process.exitCode = 1;
  else if (report.status === "benchmark-incomplete") process.exitCode = 2;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
