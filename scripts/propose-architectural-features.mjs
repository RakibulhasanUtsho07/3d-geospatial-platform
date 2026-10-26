#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { validateBuildingMaskArtifact } from "../src/core/building-generation/building-mask-provider.mjs";
import {
  buildArchitecturalFeatureOverlaySvg, proposeArchitecturalFeatures,
} from "../src/core/building-generation/architectural-feature-proposals.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function readInput(filePath, label) {
  const resolved = path.resolve(filePath);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError(label + " must be a regular file, not a symlink.");
  return { path: resolved, bytes: await readFile(resolved) };
}
async function decodeGreyscale(bytes, label) {
  const decoded = await sharp(bytes, { failOn: "error" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const width = decoded.info.width, height = decoded.info.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || decoded.info.channels !== 1) {
    throw new TypeError(label + " must decode to a single-channel grayscale image.");
  }
  return { width, height, pixels: new Uint8Array(decoded.data) };
}
async function imageDimensions(bytes, label) {
  const meta = await sharp(bytes, { failOn: "error" }).metadata();
  if (!Number.isSafeInteger(meta.width) || !Number.isSafeInteger(meta.height)) {
    throw new TypeError(label + " dimensions are not readable.");
  }
  return { width: meta.width, height: meta.height };
}
async function main() {
  const argv = process.argv.slice(2);
  if (process.argv.includes("--help") || argv.length !== 5) {
    console.log("Usage: node scripts/propose-architectural-features.mjs <source-image> <reviewed-mask.png> <same-resolution-edge-map.png> <source-view-metadata.json> <new-output-dir>\nMetadata must pin source/mask/edge hashes and include a reviewed mask-provider result. Outputs JSON proposals plus transparent SVG and PNG overlays.");
    process.exitCode = process.argv.includes("--help") ? 0 : 2;
    return;
  }
  const [sourceArg, maskArg, edgeArg, metadataArg, outputArg] = argv;
  const [sourceFile, maskFile, edgeFile, metadataFile] = await Promise.all([
    readInput(sourceArg, "source image"), readInput(maskArg, "reviewed mask"),
    readInput(edgeArg, "edge map"), readInput(metadataArg, "view metadata"),
  ]);
  const metadata = JSON.parse(metadataFile.bytes.toString("utf8"));
  if (metadata.schemaVersion !== "1.0.0" || !metadata.source || !metadata.mask ||
      !metadata.provider || !metadata.assessment || !metadata.edgeMap) {
    throw new TypeError("View metadata must contain schemaVersion 1.0.0, source, mask, provider, assessment and edgeMap records.");
  }
  const sourceSha256 = sha256(sourceFile.bytes), maskSha256 = sha256(maskFile.bytes), edgeMapSha256 = sha256(edgeFile.bytes);
  if (sourceSha256.toLowerCase() !== metadata.source.sha256?.toLowerCase()) {
    throw new Error("Source image SHA-256 does not match the reviewed source manifest.");
  }
  if (maskSha256.toLowerCase() !== metadata.mask.sha256?.toLowerCase()) {
    throw new Error("Mask SHA-256 does not match the reviewed mask manifest.");
  }
  if (edgeMapSha256.toLowerCase() !== metadata.edgeMap.sha256?.toLowerCase()) {
    throw new Error("Edge-map SHA-256 does not match the declared edge evidence.");
  }
  const [sourceDimensions, maskDimensions, edgeDimensions, maskPixels, edgePixels] = await Promise.all([
    imageDimensions(sourceFile.bytes, "source image"),
    imageDimensions(maskFile.bytes, "mask"),
    imageDimensions(edgeFile.bytes, "edge map"),
    decodeGreyscale(maskFile.bytes, "mask"),
    decodeGreyscale(edgeFile.bytes, "edge map"),
  ]);
  for (const [label, actual] of [["source", sourceDimensions], ["mask", maskDimensions], ["edgeMap", edgeDimensions]]) {
    const declared = label === "source" ? metadata.source : label === "mask" ? metadata.mask : metadata.edgeMap;
    if (declared.width !== actual.width || declared.height !== actual.height) {
      throw new Error(label + " dimensions do not match declared evidence.");
    }
  }
  if (sourceDimensions.width !== maskDimensions.width || sourceDimensions.height !== maskDimensions.height ||
      sourceDimensions.width !== edgeDimensions.width || sourceDimensions.height !== edgeDimensions.height) {
    throw new Error("Source, reviewed mask and edge-map dimensions must match exactly so pixel coordinates remain source-bound.");
  }
  if (metadata.mask.bytes !== maskFile.bytes.length) throw new Error("Encoded mask byte length does not match the source manifest.");
  if (metadata.edgeMap.bytes !== undefined && metadata.edgeMap.bytes !== edgeFile.bytes.length) {
    throw new Error("Edge-map byte length does not match the declared source evidence.");
  }
  const source = { ...metadata.source, ...sourceDimensions };
  const providerResult = { schemaVersion: metadata.schemaVersion, sourceId: source.id,
    inputSha256: sourceSha256, provider: metadata.provider, mask: metadata.mask, assessment: metadata.assessment };
  const maskValidation = validateBuildingMaskArtifact({ source: { sourceId: source.id, sha256: sourceSha256, ...sourceDimensions },
    result: providerResult, actualMaskSha256: maskSha256, actualMaskBytes: maskFile.bytes.length, decodedMask: maskPixels });
  if (!maskValidation.validForFeatureExtraction) {
    throw new Error("Mask is not ready for feature extraction (" + maskValidation.status + "): " +
      [...maskValidation.errors, ...maskValidation.warnings].map((item) => item.detail).join(" "));
  }
  const outputDir = path.resolve(outputArg);
  await mkdir(outputDir, { recursive: true });
  const generatedAt = metadata.generatedAt ?? new Date().toISOString();
  const report = proposeArchitecturalFeatures({
    buildingId: metadata.buildingId, viewId: metadata.viewId, source,
    mask: { sha256: maskSha256, width: maskDimensions.width, height: maskDimensions.height, pixels: maskPixels.pixels },
    edgeMap: { sha256: edgeMapSha256, width: edgeDimensions.width, height: edgeDimensions.height, pixels: edgePixels.pixels },
    options: metadata.options ?? {}, generatedAt,
  });
  const svg = buildArchitecturalFeatureOverlaySvg(report);
  const overlayPng = await sharp(sourceFile.bytes).composite([{ input: Buffer.from(svg), blend: "over" }]).png().toBuffer();
  const observationsSha256 = sha256(Buffer.from(JSON.stringify(report.observations)));
  report.maskValidation = { status: maskValidation.status, providerId: maskValidation.providerId,
    confidence: maskValidation.confidence, publishable: false };
  report.artifactHashes = { metadataSha256: sha256(metadataFile.bytes), sourceSha256, maskSha256, edgeMapSha256,
    observationsSha256, overlaySvgSha256: sha256(Buffer.from(svg)), overlayPngSha256: sha256(overlayPng) };
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(outputDir, "architectural-feature-proposals.json"), reportBytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(outputDir, "feature-proposals-overlay.svg"), svg, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(outputDir, "feature-proposals-overlay.png"), overlayPng, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, proposals: report.observations.length,
    sourceSha256, maskSha256, edgeMapSha256, overlayPngSha256: report.artifactHashes.overlayPngSha256,
    outputDirectory: outputDir, publishable: false }, null, 2));
  if (report.status === "incomplete") process.exitCode = 2;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
