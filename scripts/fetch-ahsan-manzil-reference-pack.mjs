#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const packUrl = new URL("../data/heritage/ahsan-manzil-reference-pack.json", import.meta.url);
const sourcePack = JSON.parse(await readFile(packUrl, "utf8"));
const outputDir = path.resolve(process.argv[2] ?? "artifacts/ahsan-manzil-reference-pack");
const manifestPath = path.join(outputDir, "reference-pack.manifest.json");
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");

function assertAllowedSource(source) {
  const thumbnailMode = source.downloadMode === "thumbnail";
  const downloadUrl = thumbnailMode ? source.downloadUrl : source.originalFileUrl;
  const parsed = new URL(downloadUrl || "");
  const allowedHost = thumbnailMode ? "thumb.wikimedia.org" : "upload.wikimedia.org";
  if (parsed.protocol !== "https:" || parsed.hostname !== allowedHost || !parsed.pathname.startsWith("/wikipedia/commons/")) {
    throw new Error("Reference URL is outside the allowlisted Wikimedia Commons host: " + source.id);
  }
  if (thumbnailMode && (!parsed.pathname.includes("/thumb/") ||
      !Number.isSafeInteger(source.expectedDownloadDimensions?.width) ||
      !Number.isSafeInteger(source.expectedDownloadDimensions?.height))) {
    throw new Error("Thumbnail sources require a fixed Commons thumb URL and expected dimensions: " + source.id);
  }
  if (!/^[a-z0-9][a-z0-9._-]+$/i.test(source.localFileName || "")) {
    throw new Error("Reference filename is not a safe basename: " + source.id);
  }
  if (!/^[a-f0-9]{40}$/i.test(source.publishedSha1 || "")) {
    throw new Error("Reference source has no valid published original-file SHA-1: " + source.id);
  }
  if (!Number.isSafeInteger(source.expectedByteLength) || source.expectedByteLength < 1024) {
    throw new Error("Reference source has an invalid original-file byte length: " + source.id);
  }
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return {height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5)};
    }
    offset += segmentLength;
  }
  return null;
}

async function readIfExists(filename) {
  try {
    return await readFile(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  if (sourcePack.id !== "ahsan-manzil-dhaka-reference-pack" || sourcePack.sources?.length < 3) {
    throw new Error("Ahsan Manzil reference source manifest is incomplete.");
  }
  const imageSources = sourcePack.sources.filter((source) => source.kind === "image");
  if (imageSources.length < 3) throw new Error("At least three source images are required.");
  const downloads = [];
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  async function fetchWithRetry(source, maxAttempts = 8) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response;
      try {
        response = await fetch(source.originalFileUrl, {
          redirect: "follow",
          headers: { "user-agent": "3d-geospatial-platform-ahsan-manzil-reference-audit/1.0" },
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        if (attempt === maxAttempts) {
          throw new Error(source.id + " download request failed after " + maxAttempts + " attempts: " + (error instanceof Error ? error.message : String(error)));
        }
        const waitMs = Math.min(3000 * (2 ** (attempt - 1)), 30000);
        console.warn(source.id + " request error; retrying in " + waitMs + "ms (attempt " + (attempt + 1) + "/" + maxAttempts + ").");
        await delay(waitMs);
        continue;
      }
      if (response.ok) return response;
      const status = response.status;
      const retryAfterHeader = response.headers.get("retry-after");
      await response.body?.cancel().catch(() => {});
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(source.id + " download failed with HTTP " + status + " after " + attempt + " attempt(s)");
      }
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryAfterDate = retryAfterHeader ? Date.parse(retryAfterHeader) - Date.now() : Number.NaN;
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : Number.isFinite(retryAfterDate) && retryAfterDate > 0
          ? retryAfterDate
          : Math.min(3000 * (2 ** (attempt - 1)), 120000);
      const waitMs = Math.min(Math.max(retryAfterMs, 1000), 120000);
      console.warn(source.id + " received HTTP " + status + "; retrying in " + waitMs + "ms (attempt " + (attempt + 1) + "/" + maxAttempts + ").");
      await delay(waitMs);
    }
    throw new Error(source.id + " download exhausted all retries");
  }

  for (const source of imageSources) {
    assertAllowedSource(source);
    const downloadUrl = source.downloadMode === "thumbnail" ? source.downloadUrl : source.originalFileUrl;
    const response = await fetchWithRetry({...source, originalFileUrl: downloadUrl});
    const final = new URL(response.url);
    const thumbnailMode = source.downloadMode === "thumbnail";
    const allowedHost = thumbnailMode ? "thumb.wikimedia.org" : "upload.wikimedia.org";
    if (final.protocol !== "https:" || final.hostname !== allowedHost || !final.pathname.startsWith("/wikipedia/commons/")) {
      throw new Error(source.id + " redirected outside the allowlisted Wikimedia Commons host: " + final.href);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actualSha1 = sha("sha1", bytes);
    const actualSha256 = sha("sha256", bytes);
    if (thumbnailMode) {
      const dimensions = jpegDimensions(bytes);
      const expected = source.expectedDownloadDimensions;
      if (response.headers.get("content-type")?.toLowerCase().split(";")[0] !== "image/jpeg" ||
          !dimensions || dimensions.width !== expected.width || dimensions.height !== expected.height ||
          bytes.byteLength < 20000 || bytes.byteLength > 5000000) {
        throw new Error(source.id + " thumbnail failed JPEG/dimension/size validation: " + JSON.stringify({contentType: response.headers.get("content-type"), dimensions, byteLength: bytes.byteLength}));
      }
    } else {
      if (bytes.byteLength !== source.expectedByteLength) {
        throw new Error(source.id + " byte length mismatch: expected " + source.expectedByteLength + ", got " + bytes.byteLength);
      }
      if (actualSha1 !== source.publishedSha1) {
        throw new Error(source.id + " published SHA-1 mismatch: expected " + source.publishedSha1 + ", got " + actualSha1);
      }
    }
    downloads.push({
      source,
      bytes,
      manifestSource: {
        ...source,
        sourceUrl: source.url,
        downloadMode: source.downloadMode || "original",
        downloadedUrl: response.url,
        byteLength: bytes.byteLength,
        computedSha1: actualSha1,
        computedSha256: actualSha256,
        sha256: actualSha256,
        verified: true,
        downloaded: true,
        verificationMethod: thumbnailMode
          ? "Fixed Commons thumbnail URL; HTTP image/jpeg response, JPEG signature, decoded frame dimensions and bounded file size checked. SHA-256 is computed from this downloaded thumbnail; published SHA-1/size fields describe the linked original file, not this derivative."
          : "Original bytes match the published file byte length and SHA-1; SHA-256 computed locally.",
        imagePath: source.localFileName,
        modificationDisclosure: thumbnailMode ? "Wikimedia Commons-generated 1280×853 derivative of the original; no additional modifications applied." : "Original source bytes; no modifications applied.",
        attribution: source.creator + ', "' + source.title + '", licensed under ' + source.license + "; source: " + source.url,
      },
    });
    await delay(1500);
  }
  const manifest = {
    schemaVersion: "1.0.0",
    id: sourcePack.id,
    building: sourcePack.building,
    verified: true,
    verificationMethod: "Each original file is downloaded from the fixed upload.wikimedia.org host and checked against the published byte length and SHA-1; SHA-256 is computed locally.",
    licensePolicy: sourcePack.licensePolicy,
    geometryPolicy: sourcePack.geometryPolicy,
    sources: downloads.map((entry) => entry.manifestSource),
    acceptanceGates: sourcePack.acceptanceGates,
  };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  await mkdir(outputDir, { recursive: true });
  for (const item of downloads) {
    const filePath = path.join(outputDir, item.source.localFileName);
    const existing = await readIfExists(filePath);
    if (existing) {
      const existingSha256 = sha("sha256", existing);
      if (existing.byteLength !== item.bytes.byteLength || existingSha256 !== item.manifestSource.sha256) {
        throw new Error("Existing reference file differs from its verified source; refusing to overwrite: " + item.source.localFileName);
      }
    }
  }
  const existingManifest = await readIfExists(manifestPath);
  if (existingManifest && existingManifest.toString("utf8") !== manifestText) {
    throw new Error("Existing reference manifest differs from the newly verified manifest; refusing to overwrite it.");
  }
  for (const item of downloads) {
    const filePath = path.join(outputDir, item.source.localFileName);
    if (!(await readIfExists(filePath))) await writeFile(filePath, item.bytes, { flag: "wx" });
  }
  if (!existingManifest) await writeFile(manifestPath, manifestText, { flag: "wx" });
  console.log(JSON.stringify({
    verified: true,
    outputDir,
    manifestPath,
    sources: downloads.map((item) => ({
      id: item.source.id,
      imagePath: item.source.localFileName,
      byteLength: item.bytes.byteLength,
      sha256: item.manifestSource.sha256,
      license: item.source.license,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ verified: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
