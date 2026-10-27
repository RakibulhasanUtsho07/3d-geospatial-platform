#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const HASH = /^[a-f0-9]{64}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;
const safeRelative = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.startsWith("/") || /^[a-z]:/i.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " must be a safe project-relative path.");
  }
  return value;
};
async function safeRead(root, relative, label) {
  const rel = safeRelative(relative, label);
  const resolved = path.resolve(root, ...rel.split("/"));
  if (!resolved.startsWith(root + path.sep)) throw new TypeError(label + " escapes project root.");
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " may not traverse symlinks.");
    if (current === resolved && !info.isFile()) throw new TypeError(label + " must be a regular file.");
  }
  return { relative: rel, path: resolved, bytes: await readFile(resolved) };
}
function xmlSafe(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}
function formatBytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
}
async function decodeMetadata(bytes, label) {
  const image = await sharp(bytes, { failOn: "error" }).rotate().metadata();
  if (!positiveInt(image.width) || !positiveInt(image.height) || image.width * image.height > 20_000_000) {
    throw new RangeError(label + " has invalid dimensions or is too large for this review packet.");
  }
  return {
    width: image.width, height: image.height, format: image.format ?? null,
    orientation: image.orientation ?? null,
    decodedWidth: image.orientation && image.orientation >= 5 && image.orientation <= 8 ? image.height : image.width,
    decodedHeight: image.orientation && image.orientation >= 5 && image.orientation <= 8 ? image.width : image.height,
  };
}
async function makeTile(asset, width = 800, height = 600) {
  const headerHeight = 90;
  const footerHeight = 48;
  const sidePadding = 16;
  const metadata = [
    asset.viewRole ?? "unclassified view",
    asset.downloadMode === "thumbnail" ? "Wikimedia derivative • original metadata kept separately" : "original file",
    (asset.downloadedDimensions?.width ?? asset.dimensionsPixels?.width ?? "?") + " × " +
      (asset.downloadedDimensions?.height ?? asset.dimensionsPixels?.height ?? "?") + " px",
    (asset.computedSha256 ?? asset.sha256).slice(0, 16),
  ].join("  •  ");
  const titleSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + headerHeight +
    '"><rect width="100%" height="100%" fill="#f4f6f8"/><text x="16" y="32" font-size="21" font-family="Arial,sans-serif" font-weight="700" fill="#1b2733">' +
    xmlSafe(asset.title) + '</text><text x="16" y="63" font-size="13" font-family="Arial,sans-serif" fill="#4d5b68">' +
    xmlSafe(metadata) + '</text></svg>',
  );
  const footSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + footerHeight +
    '"><rect width="100%" height="100%" fill="#f8fafc"/><text x="16" y="27" font-size="13" font-family="Arial,sans-serif" fill="#334155">' +
    xmlSafe(asset.creator + " • " + asset.license) + '</text></svg>',
  );
  const imageAreaWidth = width - sidePadding * 2;
  const imageAreaHeight = height - headerHeight - footerHeight - sidePadding * 2;
  const photo = await sharp(asset.bytes, { failOn: "error" }).rotate()
    .resize({ width: imageAreaWidth, height: imageAreaHeight, fit: "contain", background: "#e6ebef" })
    .png().toBuffer();
  const photoMeta = await sharp(photo).metadata();
  const photoLeft = Math.floor((width - photoMeta.width) / 2);
  const photoTop = headerHeight + sidePadding + Math.floor((imageAreaHeight - photoMeta.height) / 2);
  return sharp({ create: { width, height, channels: 3, background: "#e6ebef" } })
    .composite([
      { input: titleSvg, top: 0, left: 0 },
      { input: photo, top: photoTop, left: photoLeft },
      { input: footSvg, top: height - footerHeight, left: 0 },
    ])
    .png().toBuffer();
}
async function writeNewFile(filePath, bytes) {
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length < 1 || args.length > 2) {
    console.log([
      "Usage: node scripts/prepare-building-visual-review-packet.mjs <verified-reference-manifest.json> [output-directory]",
      "The output directory must not already contain review-packet.json or contact-sheet.png.",
      "Copies only hash-verified source bytes, writes provenance-bound pending annotation templates, and creates a contact sheet.",
      "This tool does not create/approve masks, mark any feature reviewed, or assert architectural accuracy.",
    ].join("\n"));
    process.exitCode = args.includes("--help") ? 0 : 2;
    return;
  }

  const root = await realpath(process.cwd());
  const manifestFile = await safeRead(root, args[0], "Reference manifest");
  const referenceManifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  if (referenceManifest.schemaVersion !== "1.0.0" || referenceManifest.verified !== true ||
      !SAFE_ID.test(referenceManifest.id ?? "") || !Array.isArray(referenceManifest.sources) ||
      referenceManifest.sources.length < 3) {
    throw new TypeError("Reference manifest must be version 1.0.0, verified, and contain at least three sources.");
  }
  const outputRelative = args[1] ?? "artifacts/ahsan-manzil-review-packet";
  safeRelative(outputRelative, "Output directory");
  const outputPath = path.resolve(root, ...outputRelative.split("/"));
  if (!outputPath.startsWith(root + path.sep)) throw new TypeError("Output directory escapes project root.");
  await mkdir(outputPath, { recursive: true });
  const realOutput = await realpath(outputPath);
  if (!realOutput.startsWith(root + path.sep)) throw new TypeError("Output directory resolves outside project root.");

  const packetPath = path.join(realOutput, "review-packet.json");
  const contactPath = path.join(realOutput, "contact-sheet.png");
  for (const existing of [packetPath, contactPath]) {
    try { await lstat(existing); throw new Error("Refusing to overwrite existing review artifact: " + existing); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  const annotationDir = path.join(realOutput, "annotation-templates");
  const imageDir = path.join(realOutput, "images");
  await mkdir(annotationDir, { recursive: true });
  await mkdir(imageDir, { recursive: true });
  const processed = [];
  const tiles = [];
  const seen = new Set();

  for (const item of referenceManifest.sources) {
    if (!item || item.verified !== true || item.downloaded !== true ||
        !SAFE_ID.test(item.id ?? "") || seen.has(item.id) ||
        typeof item.imagePath !== "string" ||
        typeof item.computedSha256 !== "string" || !HASH.test(item.computedSha256) ||
        !positiveInt(item.byteLength)) {
      throw new TypeError("Every source must have a unique ID, downloaded bytes and valid computed SHA-256.");
    }
    seen.add(item.id);
    const imageFile = await safeRead(path.dirname(manifestFile.path), item.imagePath, "Reference image " + item.id);
    // The verified manifest's image paths are basenames, so read under its own directory.
    if (path.basename(item.imagePath) !== item.imagePath || imageFile.bytes.length !== item.byteLength ||
        sha256(imageFile.bytes) !== item.computedSha256.toLowerCase()) {
      throw new TypeError("Reference image bytes do not match verified manifest: " + item.id);
    }
    const metadata = await decodeMetadata(imageFile.bytes, item.id);
    if (item.downloadMode === "thumbnail" &&
        (metadata.decodedWidth !== item.expectedDownloadDimensions?.width ||
         metadata.decodedHeight !== item.expectedDownloadDimensions?.height)) {
      throw new TypeError("Downloaded thumbnail dimensions do not match the pinned derivative contract: " + item.id);
    }
    if (item.downloadMode !== "thumbnail" &&
        (metadata.decodedWidth !== item.dimensionsPixels?.width ||
         metadata.decodedHeight !== item.dimensionsPixels?.height)) {
      throw new TypeError("Original image dimensions do not match the source metadata: " + item.id);
    }

    const imageName = item.imagePath;
    const outputImagePath = path.join(imageDir, imageName);
    await writeNewFile(outputImagePath, imageFile.bytes);
    const record = {
      id: item.id,
      title: item.title,
      viewRole: item.viewRole ?? "unspecified",
      sourcePageUrl: item.sourceUrl ?? item.url ?? null,
      downloadedUrl: item.downloadedUrl ?? null,
      imagePath: "images/" + imageName,
      mimeType: metadata.format === "jpeg" ? "image/jpeg" : "image/" + metadata.format,
      bytes: imageFile.bytes.length,
      sha256: sha256(imageFile.bytes),
      downloadedDimensions: { width: metadata.decodedWidth, height: metadata.decodedHeight },
      originalFileMetadata: {
        dimensions: item.dimensionsPixels ?? null,
        publishedSha1: item.publishedSha1 ?? null,
        expectedByteLength: item.expectedByteLength ?? null,
        downloadMode: item.downloadMode ?? "original",
        expectedDownloadDimensions: item.expectedDownloadDimensions ?? null,
      },
      creator: item.creator ?? null,
      license: item.license ?? null,
      licenseUrl: item.licenseUrl ?? null,
      attributionRequired: item.attributionRequired === true,
      modificationDisclosureRequired: item.modificationDisclosureRequired === true,
      attributionText: item.attribution ?? null,
      metadataQuality: "downloaded-and-hash-verified",
      independentRightsReview: "required",
      imageIdentityVerified: true,
      geometryUse: item.viewAssessment?.geometryUse ?? item.supports ?? [],
      knownOcclusions: item.viewAssessment?.occlusions ?? [],
      cameraCalibrationStatus: item.viewAssessment?.cameraCalibration ?? "unknown",
      limitations: item.viewAssessment?.notSufficientFor ?? item.notUsableFor ?? [],
    };
    const annotationTemplate = {
      schemaVersion: "1.0.0",
      packetEngine: "building-visual-review-template-v1",
      buildingId: referenceManifest.building?.name ?? referenceManifest.id,
      viewId: item.id,
      createdAt: new Date().toISOString(),
      coordinateConvention: "source-image-pixel-origin-top-left",
      source: {
        id: item.id,
        path: record.imagePath,
        sha256: record.sha256,
        width: metadata.decodedWidth,
        height: metadata.decodedHeight,
        mimeType: record.mimeType,
      },
      rightsReview: {
        status: "pending-independent-review",
        sourceMetadataLicense: record.license,
        sourceLicenseUrl: record.licenseUrl,
        attributionText: record.attributionText,
        reviewerId: null,
        reviewedAt: null,
        notes: "",
      },
      masks: {
        status: "pending-annotation",
        buildingMask: null,
        occluderMasks: [],
        reviewerId: null,
        reviewedAt: null,
      },
      observations: [],
      categories: [
        "silhouette-bounds", "roofline-segment", "outer-corner", "floor-band", "window-candidate",
        "door-candidate", "balcony-candidate", "facade-region", "arch-candidate", "column-candidate",
        "dome-candidate", "cornice-candidate", "pediment-candidate", "staircase-candidate",
        "parapet-candidate", "ornament-candidate",
      ],
      visibilityStates: ["visible", "partially-occluded", "occluded", "not-visible", "not-detected"],
      acceptance: {
        reviewedByIndependentHuman: false,
        groundTruth: false,
        acceptanceEligible: false,
        publicationEligible: false,
        notes: "Template only. No masks or features are annotated/reviewed by this generator.",
      },
    };
    const templatePath = path.join(annotationDir, item.id + ".annotation-template.json");
    await writeNewFile(templatePath, Buffer.from(JSON.stringify(annotationTemplate, null, 2) + "\n"));
    const tile = await makeTile({
      ...item, bytes: imageFile.bytes, computedSha256: record.sha256,
      downloadedDimensions: { width: metadata.decodedWidth, height: metadata.decodedHeight },
    });
    tiles.push(tile);
    processed.push(record);
  }

  const columns = 2;
  const tileWidth = 800, tileHeight = 600;
  const rows = Math.ceil(tiles.length / columns);
  const composites = tiles.map((tile, index) => ({
    input: tile,
    left: (index % columns) * tileWidth,
    top: Math.floor(index / columns) * tileHeight,
  }));
  const contactSheet = await sharp({
    create: { width: columns * tileWidth, height: rows * tileHeight, channels: 3, background: "#e6ebef" },
  }).composite(composites).png().toBuffer();
  await writeNewFile(contactPath, contactSheet);

  const packet = {
    schemaVersion: "1.0.0",
    engine: "building-visual-review-packet-v1",
    building: referenceManifest.building ?? { id: referenceManifest.id },
    sourceManifest: {
      path: path.relative(root, manifestFile.path).split(path.sep).join("/"),
      sha256: sha256(manifestFile.bytes),
      verified: true,
    },
    createdAt: new Date().toISOString(),
    sourceCount: processed.length,
    sourceImages: processed,
    contactSheet: {
      path: "contact-sheet.png",
      sha256: sha256(contactSheet),
      bytes: contactSheet.length,
      width: columns * tileWidth,
      height: rows * tileHeight,
    },
    annotationTemplates: processed.map((item) => ({
      sourceId: item.id,
      path: "annotation-templates/" + item.id + ".annotation-template.json",
      status: "pending-annotation-and-independent-review",
    })),
    policy: {
      sourcesVerifiedByBytes: true,
      independentlyReviewedMasksAvailable: false,
      heldOutEvaluationAvailable: false,
      surveyedDimensionControlAvailable: false,
      groundTruth: false,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
    },
    blockingGaps: [
      "A downloaded/hash-pinned source pack is not an independent licence/legal review.",
      "Human reviewers must annotate and sign off building/occluder masks on the exact source pixels.",
      "A second reviewer must review architectural feature annotations and document occlusion/visibility states.",
      "At least one held-out building/view group with reviewed labels is required; views of one capture group must not leak between tuning and evaluation.",
      "Independent surveyed dimensions and a credible calibrated source-camera model are still required for metric 3D accuracy claims.",
    ],
  };

  await writeNewFile(packetPath, Buffer.from(JSON.stringify(packet, null, 2) + "\n"));
  const checksums = [
    "contact-sheet.png " + packet.contactSheet.sha256,
    "review-packet.json " + sha256(Buffer.from(JSON.stringify(packet, null, 2) + "\n")),
    ...processed.map((item) => item.imagePath + " " + item.sha256),
  ].join("\n") + "\n";
  await writeNewFile(path.join(realOutput, "SHA256SUMS.txt"), Buffer.from(checksums));
  console.log(JSON.stringify({
    outputDirectory: path.relative(root, realOutput).split(path.sep).join("/"),
    status: "review-packet-ready-awaiting-human-annotation",
    sourceCount: processed.length,
    contactSheetSha256: packet.contactSheet.sha256,
    evidencePolicy: packet.policy,
    blockingGaps: packet.blockingGaps.length,
  }, null, 2));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
