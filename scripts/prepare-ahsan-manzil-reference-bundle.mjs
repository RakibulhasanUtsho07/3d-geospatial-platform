#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { validateHeritageReferenceRegistry } from "../src/core/building-generation/heritage-reference-registry.mjs";

const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const USER_AGENT = "3d-geospatial-platform-reference-intake/1.0 (licensed research; https://github.com/RakibulhasanUtsho07/3d-geospatial-platform)";

async function downloadSource(source) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(source.downloadUrl, {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, "Accept": "image/jpeg,image/*;q=0.9,*/*;q=0.1" },
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error("HTTP " + response.status + " for " + source.id);
      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") {
        throw new TypeError("Unexpected content type for " + source.id + ": " + (contentType || "missing"));
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 4 || bytes.length > MAX_IMAGE_BYTES) {
        throw new RangeError("Downloaded file size outside allowed range for " + source.id + ": " + bytes.length);
      }
      const dimensions = readImageDimensions(bytes);
      if (!dimensions) throw new TypeError("Downloaded bytes are not a readable JPEG/PNG: " + source.id);
      if (dimensions.width !== source.expectedWidth || dimensions.height !== source.expectedHeight) {
        throw new Error("Dimensions changed for " + source.id + ": expected " +
          source.expectedWidth + "x" + source.expectedHeight + ", got " + dimensions.width + "x" + dimensions.height);
      }
      if (source.expectedBytes !== undefined && bytes.length !== source.expectedBytes) {
        throw new Error("Byte length changed for " + source.id + ": expected " + source.expectedBytes + ", got " + bytes.length);
      }
      const actualSha1 = sha1(bytes);
      const actualSha256 = sha256(bytes);
      if (source.expectedSha1 && actualSha1.toLowerCase() !== source.expectedSha1.toLowerCase()) {
        throw new Error("SHA-1 mismatch for " + source.id + ": expected " + source.expectedSha1 + ", got " + actualSha1);
      }
      if (source.expectedSha256 && actualSha256.toLowerCase() !== source.expectedSha256.toLowerCase()) {
        throw new Error("SHA-256 mismatch for " + source.id + ": expected " + source.expectedSha256 + ", got " + actualSha256);
      }
      return {
        bytes,
        record: {
          id: source.id, fileName: source.fileName, mediaTitle: source.mediaTitle, viewRole: source.viewRole,
          sourcePageUrl: source.sourcePageUrl, requestedDownloadUrl: source.downloadUrl, resolvedDownloadUrl: response.url,
          sourceRevision: source.sourceRevision, attribution: source.attribution, license: source.license, licenseUrl: source.licenseUrl,
          width: dimensions.width, height: dimensions.height, byteLength: bytes.length, sha1: actualSha1, sha256: actualSha256,
          expectedSha1: source.expectedSha1, expectedSha256: source.expectedSha256,
          sha1Pinned: Boolean(source.expectedSha1), sha256Pinned: Boolean(source.expectedSha256),
          integrityStatus: source.expectedSha1 && source.expectedSha256 ? "verified-against-pinned-sha1-and-sha256" : "captured-hash-recorded-awaiting-review",
          evidenceClass: "photographic-reference",
          useLimits: ["not-an-independent-survey-dimension", "not-geodetic-ground-control", "not-proof-of-occluded-or-unseen-surfaces"]
        }
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  const [registryArg, outputArg, ...extra] = process.argv.slice(2);
  if (!registryArg || !outputArg || extra.length) {
    throw new Error("Usage: node scripts/prepare-ahsan-manzil-reference-bundle.mjs <registry.json> <output-directory>");
  }
  const registryPath = path.resolve(registryArg);
  const outputDir = path.resolve(outputArg);
  let registryBytes;
  try { registryBytes = await readFile(registryPath); }
  catch (error) { throw new Error("Cannot read registry " + registryPath + ": " + (error instanceof Error ? error.message : String(error))); }
  const registry = JSON.parse(registryBytes.toString("utf8"));
  const validation = validateHeritageReferenceRegistry(registry);
  if (!validation.valid) throw new Error("Reference registry validation failed: " + validation.errors.join(", "));
  await mkdir(path.dirname(outputDir), { recursive: true });
  try {
    await mkdir(outputDir, { recursive: false });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Output directory already exists; use a fresh evidence directory: " + outputDir);
    throw error;
  }
  const imageDir = path.join(outputDir, "images");
  await mkdir(imageDir, { recursive: false });
  const results = [];
  for (const source of registry.sources) {
    const { bytes, record } = await downloadSource(source);
    await writeFile(path.join(imageDir, source.fileName), bytes, { flag: "wx", mode: 0o644 });
    results.push(record);
  }
  const pendingHashPins = results.filter((item) => !item.sha1Pinned || !item.sha256Pinned).map((item) => item.id);
  const intakeManifest = {
    schemaVersion: "1.0.0", bundleId: registry.registryId, capturedAt: new Date().toISOString(),
    sourceCommit: process.env.GITHUB_SHA ?? null,
    registryPath: path.relative(process.cwd(), registryPath).split(path.sep).join("/"),
    registrySha256: sha256(registryBytes), candidateModel: registry.candidateModel, sourceCount: results.length,
    complete: results.length === registry.sources.length,
    status: pendingHashPins.length ? "review-required" : "captured-hash-pinned",
    pendingHashPins, validation: { valid: validation.valid, errors: validation.errors }, sources: results,
    policy: {
      establishesSurveyedDimensions: false, establishesGeodeticGroundControl: false,
      verifiesOccludedOrUnseenGeometry: false, publicationEligible: false, humanReviewRequired: true
    }
  };
  await writeFile(path.join(outputDir, "reference-intake-manifest.json"), JSON.stringify(intakeManifest, null, 2) + "\n", { flag: "wx" });
  const attributionLines = [
    "# Ahsan Manzil photographic reference bundle", "",
    "Original images are distributed unchanged for visual reference and retain the licenses stated below.",
    "These photographs are not surveyed dimensions, not geodetic ground-control points, and do not prove hidden or occluded geometry.",
    "No endorsement by the photographers or Wikimedia Commons is implied.", "",
    ...results.flatMap((item) => [
      "## " + item.mediaTitle, "",
      "- Local file: `images/" + item.fileName + "`",
      "- Author / attribution: " + item.attribution,
      "- Source revision: " + item.sourceRevision,
      "- Source page: " + item.sourcePageUrl,
      "- License: [" + item.license + "](" + item.licenseUrl + ")",
      "- SHA-1: `" + item.sha1 + "` (" + (item.sha1Pinned ? "matches the registry pin" : "captured on intake; review and pin before treating the source version as immutable") + ")",
      "- SHA-256: `" + item.sha256 + "` (" + (item.sha256Pinned ? "matches the registry pin" : "captured on intake; review and pin before treating the source version as immutable") + ")",
      "- View role: " + item.viewRole, ""
    ]),
    "## Use and limitations", "",
    "Compare only corresponding visible facades and account for perspective, lens distortion, cropping, lighting, and occlusion. Do not infer unseen roof geometry or metric scale from a single photograph. Any adapted or redistributed material must comply with the applicable CC BY-SA terms."
  ].join("\n");
  await writeFile(path.join(outputDir, "ATTRIBUTION.md"), attributionLines + "\n", { flag: "wx" });
  console.log(JSON.stringify({
    bundleDirectory: outputDir, bundleId: intakeManifest.bundleId, status: intakeManifest.status,
    sourceCount: intakeManifest.sourceCount, sha1Pinned: results.filter((item) => item.sha1Pinned).length,
    pendingHashPins, files: results.map(({ id, fileName, byteLength, width, height, sha1, sha256: hash, integrityStatus }) =>
      ({ id, fileName, byteLength, width, height, sha1, sha256: hash, integrityStatus })),
    publicationEligible: false
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
