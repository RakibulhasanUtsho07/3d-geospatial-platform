#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildBuildingVisualEvidencePackage } from "../src/core/building-generation/building-visual-evidence-package.mjs";

const HASH = /^[a-f0-9]{64}$/i;
const MAX_PIXELS = 8_000_000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;

function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
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
  const bytes = await readFile(resolved);
  return { path: resolved, relative: safe, bytes, sha256: sha256(bytes), size: bytes.length };
}

async function imageMetadata(bytes, label) {
  const info = await sharp(bytes, { failOn: "error" }).metadata();
  if (!positiveInt(info.width) || !positiveInt(info.height) || info.width * info.height > MAX_PIXELS) {
    throw new RangeError(label + " has invalid dimensions or exceeds the " + MAX_PIXELS + "-pixel processing limit.");
  }
  const mimeByFormat = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
  return { width: info.width, height: info.height, mimeType: mimeByFormat[info.format] ?? null };
}

async function decodeMaskAsset(root, asset, label, expectedWidth, expectedHeight) {
  if (!asset || typeof asset !== "object" || typeof asset.path !== "string") {
    throw new TypeError(label + " needs a project-relative encoded image path.");
  }
  const encoded = await safeRead(root, asset.path, label);
  if (asset.sha256 && (!HASH.test(asset.sha256) || asset.sha256.toLowerCase() !== encoded.sha256)) {
    throw new TypeError(label + " encoded bytes do not match the declared SHA-256.");
  }
  const decoded = await sharp(encoded.bytes, { failOn: "error" })
    .greyscale().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== expectedWidth || decoded.info.height !== expectedHeight ||
      decoded.info.width * decoded.info.height > MAX_PIXELS) {
    throw new RangeError(label + " decoded pixel dimensions do not match the required source dimensions.");
  }
  const pixels = new Uint8Array(decoded.data);
  for (let index = 0; index < pixels.length; index += 1) {
    if (pixels[index] !== 0 && pixels[index] !== 255) {
      throw new TypeError(label + " is not a binary 0/255 mask at pixel " + index + ".");
    }
  }
  return {
    path: encoded.relative, encodedBytes: encoded.bytes, sha256: encoded.sha256,
    width: decoded.info.width, height: decoded.info.height, pixels,
  };
}

async function readRenderStatistics(bytes, label) {
  const decoded = await sharp(bytes, { failOn: "error" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  if (!positiveInt(width) || !positiveInt(height) || width * height > MAX_PIXELS || channels !== 4) {
    throw new RangeError(label + " cannot be safely decoded into a bounded RGBA plane.");
  }
  const stride = Math.max(1, Math.ceil((width * height) / 100_000));
  const luminances = [];
  let transparent = 0, samples = 0;
  for (let pixel = 0; pixel < width * height; pixel += stride) {
    const index = pixel * 4;
    const alpha = decoded.data[index + 3];
    if (alpha === 0) transparent += 1;
    luminances.push(0.2126 * decoded.data[index] + 0.7152 * decoded.data[index + 1] + 0.0722 * decoded.data[index + 2]);
    samples += 1;
  }
  const average = luminances.reduce((sum, value) => sum + value, 0) / luminances.length;
  const variance = luminances.reduce((sum, value) => sum + ((value - average) ** 2), 0) / luminances.length;
  return {
    width, height,
    pixelStatistics: {
      sampledPixels: samples,
      luminanceMean: Number((average / 255).toFixed(6)),
      luminanceStandardDeviation: Number((Math.sqrt(variance) / 255).toFixed(6)),
      transparentRatio: Number((transparent / samples).toFixed(6)),
    },
  };
}

async function loadOptional(root, asset, label) {
  if (!asset) return null;
  const loaded = await safeRead(root, asset.path, label);
  if (asset.sha256 && (!HASH.test(asset.sha256) || asset.sha256.toLowerCase() !== loaded.sha256)) {
    throw new TypeError(label + " SHA-256 does not match the encoded bytes.");
  }
  return loaded;
}

async function ensureOutputDirectory(root, relative) {
  const safe = safeRelative(relative, "Output directory");
  let current = root;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new TypeError("Output directory must not traverse symlinks or non-directory paths.");
      }
    }
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(root + path.sep)) throw new TypeError("Output directory resolves outside the project root.");
  return resolved;
}

async function buildInput(root, bundle) {
  if (!bundle || bundle.schemaVersion !== "1.0.0" ||
      typeof bundle.buildingId !== "string" || typeof bundle.viewId !== "string") {
    throw new TypeError("Bundle must use schemaVersion 1.0.0 and declare buildingId/viewId.");
  }
  if (!bundle.source || !bundle.model || !bundle.buildingMask) {
    throw new TypeError("Bundle requires source, model and buildingMask records.");
  }
  const sourceFile = await safeRead(root, bundle.source.path, "Source image");
  const sourceImage = await imageMetadata(sourceFile.bytes, "Source image");
  if (bundle.source.sha256?.toLowerCase() !== sourceFile.sha256 ||
      bundle.source.width !== sourceImage.width || bundle.source.height !== sourceImage.height ||
      (bundle.source.mimeType && bundle.source.mimeType !== sourceImage.mimeType)) {
    throw new TypeError("Source identity, MIME type or dimensions do not match decoded source bytes.");
  }
  const source = {
    ...bundle.source, width: sourceImage.width, height: sourceImage.height,
    decodedWidth: sourceImage.width, decodedHeight: sourceImage.height,
    mimeType: sourceImage.mimeType,
  };
  const rightsAsset = typeof source.rights?.evidencePath === "string"
    ? { path: source.rights.evidencePath, sha256: source.rights.evidenceSha256 }
    : null;
  const rightsFile = rightsAsset ? await loadOptional(root, rightsAsset, "Source-rights evidence") : null;
  if (rightsAsset && rightsFile) {
    source.rights = { ...source.rights, evidenceBytes: rightsFile.bytes, evidenceSha256: rightsFile.sha256 };
  }

  const modelFile = await safeRead(root, bundle.model.path, "Candidate GLB");
  if (bundle.model.sha256 && bundle.model.sha256.toLowerCase() !== modelFile.sha256) {
    throw new TypeError("Candidate GLB SHA-256 does not match the exact file bytes.");
  }

  const buildingMask = await decodeMaskAsset(root, bundle.buildingMask, "Building mask", source.width, source.height);
  const occluderMasks = [];
  for (const [index, item] of (bundle.occluderMasks ?? []).entries()) {
    const decoded = await decodeMaskAsset(root, item, "Occluder mask " + index, source.width, source.height);
    occluderMasks.push({ ...item, encodedBytes: decoded.encodedBytes,
      decodedMask: { width: decoded.width, height: decoded.height, pixels: decoded.pixels } });
  }
  const edgeAsset = await loadOptional(root, bundle.edgeMap, "Edge map");
  let edgeMap = null;
  if (bundle.edgeMap) {
    const decoded = await sharp(edgeAsset.bytes, { failOn: "error" })
      .greyscale().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== source.width || decoded.info.height !== source.height) {
      throw new RangeError("Edge map must match the exact source-image dimensions.");
    }
    edgeMap = { ...bundle.edgeMap, encodedBytes: edgeAsset.bytes, sha256: edgeAsset.sha256,
      sourceImageSha256: sourceFile.sha256, width: source.width, height: source.height,
      pixels: new Uint8Array(decoded.data) };
  }

  const cameraManifest = await safeRead(root, bundle.camera?.manifestPath, "Camera manifest");
  const calibration = await safeRead(root, bundle.camera?.calibrationEvidencePath, "Camera calibration evidence");
  const alignment = await safeRead(root, bundle.camera?.frameAlignmentEvidencePath, "Model-frame alignment evidence");
  const camera = { manifestBytes: cameraManifest.bytes, calibrationEvidenceBytes: calibration.bytes,
    frameAlignmentEvidenceBytes: alignment.bytes };

  let sourceCameraRender = null;
  if (bundle.sourceCameraRender) {
    const renderFile = await safeRead(root, bundle.sourceCameraRender.path, "Source-camera render");
    const renderStats = await readRenderStatistics(renderFile.bytes, "Source-camera render");
    if (renderStats.width !== source.width || renderStats.height !== source.height) {
      throw new RangeError("Source-camera render dimensions must match the exact source image.");
    }
    sourceCameraRender = { ...bundle.sourceCameraRender, bytes: renderFile.bytes, width: renderStats.width,
      height: renderStats.height, pixelStatistics: renderStats.pixelStatistics };
    if (bundle.sourceCameraRender.silhouetteMask) {
      const silhouette = await decodeMaskAsset(root, bundle.sourceCameraRender.silhouetteMask,
        "Candidate render silhouette", source.width, source.height);
      sourceCameraRender.silhouetteMask = {
        ...bundle.sourceCameraRender.silhouetteMask,
        sha256: silhouette.sha256, encodedBytes: silhouette.encodedBytes,
        sourceImageSha256: sourceFile.sha256, sourceCameraRenderSha256: renderFile.sha256,
        extractionVersion: bundle.sourceCameraRender.silhouetteMask.extractionVersion,
        width: silhouette.width, height: silhouette.height, pixels: silhouette.pixels,
      };
    }
  }

  let referenceSilhouette = null;
  if (bundle.referenceSilhouette) {
    const silhouette = await decodeMaskAsset(root, bundle.referenceSilhouette,
      "Reviewed reference silhouette", source.width, source.height);
    referenceSilhouette = {
      ...bundle.referenceSilhouette, sha256: silhouette.sha256, encodedBytes: silhouette.encodedBytes,
      sourceImageSha256: sourceFile.sha256, width: silhouette.width, height: silhouette.height, pixels: silhouette.pixels,
    };
  }

  let realBuildingBenchmark = null;
  if (bundle.realBuildingBenchmark) {
    const manifestFile = await safeRead(root, bundle.realBuildingBenchmark.manifestPath, "Segmentation benchmark manifest");
    const reportFile = await safeRead(root, bundle.realBuildingBenchmark.reportPath, "Segmentation benchmark report");
    realBuildingBenchmark = {
      ...bundle.realBuildingBenchmark, manifestBytes: manifestFile.bytes, reportBytes: reportFile.bytes,
      manifestSha256: manifestFile.sha256, reportSha256: reportFile.sha256,
      report: JSON.parse(reportFile.bytes.toString("utf8")),
    };
  }

  return {
    ...bundle, source, sourceBytes: sourceFile.bytes,
    model: { glbBytes: modelFile.bytes, sha256: modelFile.sha256 },
    buildingMask: { ...bundle.buildingMask, encodedBytes: buildingMask.encodedBytes,
      decodedMask: { width: buildingMask.width, height: buildingMask.height, pixels: buildingMask.pixels } },
    occluderMasks, edgeMap, camera, sourceCameraRender, referenceSilhouette, realBuildingBenchmark,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const rootFlag = args.find((arg) => arg.startsWith("--root="));
  const positional = args.filter((arg) => !arg.startsWith("--root="));
  if (process.argv.includes("--help") || !positional[0] || positional.length > 2) {
    console.log([
      "Usage: node scripts/build-building-visual-evidence-package.mjs <bundle.json> [output-directory] [--root=project-root]",
      "Input is a schemaVersion 1.0.0 project-relative JSON bundle. See docs/research/BRF-05-07-IMPLEMENTATION-AND-EVIDENCE-REPORT.md.",
      "Writes evidence-report.json and one SVG mask overlay per reviewed role without overwriting existing artifacts.",
      "Exit 0 means review-required evidence was assembled; exit 2 means incomplete/not-comparable; exit 1 means failure.",
    ].join("\n"));
    process.exitCode = process.argv.includes("--help") ? 0 : 2;
    return;
  }
  const root = await realpath(path.resolve(rootFlag ? rootFlag.slice("--root=".length) : process.cwd()));
  const bundleFile = await safeRead(root, positional[0], "Evidence bundle");
  const bundle = JSON.parse(bundleFile.bytes.toString("utf8"));
  const input = await buildInput(root, bundle);
  const result = buildBuildingVisualEvidencePackage(input);
  const defaultName = String(bundle.buildingId).replace(/[^a-z0-9._-]/gi, "-") + "-" +
    String(bundle.viewId).replace(/[^a-z0-9._-]/gi, "-");
  const outRelative = positional[1] ?? ("artifacts/building-visual-evidence/" + defaultName);
  const outputDirectory = await ensureOutputDirectory(root, outRelative);
  await writeFile(path.join(outputDirectory, "evidence-report.json"),
    JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  for (const [role, svg] of Object.entries(result.artifacts.maskOverlays)) {
    await writeFile(path.join(outputDirectory, "mask-overlay-" + role + ".svg"), svg, { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({
    outputDirectory: path.relative(root, outputDirectory).split(path.sep).join("/"),
    status: result.status,
    evidenceGraphSha256: result.evidenceGraphSha256,
    stages: Object.fromEntries(Object.entries(result.stages).map(([key, value]) => [key, value.status ?? value.status])),
    errorCount: result.errors.length,
    warningCount: result.warnings.length,
    acceptanceEligible: result.acceptanceEligible,
    publicationEligible: result.publicationEligible,
    mapReady: result.mapReady,
  }, null, 2));
  if (result.status === "failed") process.exitCode = 1;
  else if (result.status !== "review-required") process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
