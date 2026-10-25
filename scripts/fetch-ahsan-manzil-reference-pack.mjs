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
  const parsed = new URL(source.originalFileUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "upload.wikimedia.org" || !parsed.pathname.startsWith("/wikipedia/commons/")) {
    throw new Error("Reference URL is outside the allowed Wikimedia Commons original-file host: " + source.id);
  }
  if (!/^[a-z0-9][a-z0-9._-]+$/i.test(source.localFileName || "")) {
    throw new Error("Reference filename is not a safe basename: " + source.id);
  }
  if (!/^[a-f0-9]{40}$/i.test(source.publishedSha1 || "")) {
    throw new Error("Reference source has no valid published SHA-1: " + source.id);
  }
  if (!Number.isSafeInteger(source.expectedByteLength) || source.expectedByteLength < 1024) {
    throw new Error("Reference source has an invalid expected byte length: " + source.id);
  }
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
  for (const source of imageSources) {
    assertAllowedSource(source);
    const response = await fetch(source.originalFileUrl, {
      redirect: "follow",
      headers: { "user-agent": "3d-geospatial-platform-ahsan-manzil-reference-audit/1.0" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(source.id + " download failed with HTTP " + response.status);
    const final = new URL(response.url);
    if (final.protocol !== "https:" || final.hostname !== "upload.wikimedia.org" || !final.pathname.startsWith("/wikipedia/commons/")) {
      throw new Error(source.id + " redirected outside the allowed Wikimedia Commons original-file host: " + final.href);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actualSha1 = sha("sha1", bytes);
    const actualSha256 = sha("sha256", bytes);
    if (bytes.byteLength !== source.expectedByteLength) {
      throw new Error(source.id + " byte length mismatch: expected " + source.expectedByteLength + ", got " + bytes.byteLength);
    }
    if (actualSha1 !== source.publishedSha1) {
      throw new Error(source.id + " published SHA-1 mismatch: expected " + source.publishedSha1 + ", got " + actualSha1);
    }
    downloads.push({
      source,
      bytes,
      manifestSource: {
        ...source,
        sourceUrl: source.url,
        downloadedUrl: response.url,
        byteLength: bytes.byteLength,
        computedSha256: actualSha256,
        sha256: actualSha256,
        verified: true,
        downloaded: true,
        imagePath: source.localFileName,
        modificationDisclosure: "Original source bytes; no modifications applied.",
        attribution: source.creator + ', "' + source.title + '", licensed under ' + source.license + "; source: " + source.url,
      },
    });
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
