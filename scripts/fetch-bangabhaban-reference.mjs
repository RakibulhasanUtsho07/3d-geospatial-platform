#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const source = {
  id: "licensed-exterior-2017",
  url: "https://upload.wikimedia.org/wikipedia/commons/e/ed/Bangabhaban_%2833310655331%29.jpg",
  title: "Bangabhaban (33310655331).jpg",
  author: "ASaber91",
  license: "CC BY 2.0",
  licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
  expectedByteLength: 2420452,
  expectedSha1: "08c42b61fb435cf2bd9ac8e90f8261e8edc03b4a",
};

const outputDir = path.resolve(process.argv[2] ?? "artifacts/bangabhaban-reference");
const imagePath = path.join(outputDir, "bangabhaban-exterior-2017.jpg");
const manifestPath = path.join(outputDir, "bangabhaban-exterior-2017.manifest.json");

try {
  const response = await fetch(source.url, {
    redirect: "follow",
    headers: { "user-agent": "3d-geospatial-platform-reference-audit/1.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("Download failed with HTTP " + response.status);
  const finalUrl = response.url;
  if (new URL(finalUrl).hostname !== "upload.wikimedia.org") {
    throw new Error("Unexpected final download host: " + new URL(finalUrl).hostname);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== source.expectedByteLength) {
    throw new Error("Byte length mismatch: expected " + source.expectedByteLength + ", got " + bytes.byteLength);
  }
  if (sha1 !== source.expectedSha1) {
    throw new Error("Published SHA-1 mismatch: expected " + source.expectedSha1 + ", got " + sha1);
  }
  await mkdir(outputDir, { recursive: true });
  // Idempotent reruns: reuse an existing verified image, but fail closed if it differs.
  let existingBytes = null;
  try {
    existingBytes = await readFile(imagePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existingBytes) {
    const existingSha256 = createHash("sha256").update(existingBytes).digest("hex");
    if (existingBytes.byteLength !== bytes.byteLength || existingSha256 !== sha256) {
      throw new Error("Existing reference file differs from the verified source; refusing to overwrite it.");
    }
  } else {
    await writeFile(imagePath, bytes, { flag: "wx" });
  }
  const manifest = {
    schemaVersion: "1.0.0",
    sourceId: source.id,
    title: source.title,
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Bangabhaban_(33310655331).jpg",
    downloadedUrl: finalUrl,
    author: source.author,
    license: source.license,
    licenseUrl: source.licenseUrl,
    attribution: "ASaber91, “Bangabhaban (33310655331).jpg”, licensed under CC BY 2.0; source: Wikimedia Commons.",
    modificationDisclosure: "Downloaded source file; no modifications applied.",
    byteLength: bytes.byteLength,
    publishedSha1: sha1,
    computedSha256: sha256,
    verified: true,
    imagePath: path.basename(imagePath),
    geometryUse: "single-view visual comparison and broad massing cues only",
    warnings: [
      "One oblique image does not establish survey-grade dimensions.",
      "Do not claim multi-view photogrammetry or architectural fidelity from this file alone.",
    ],
  };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  let existingManifest = null;
  try {
    existingManifest = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existingManifest !== null && existingManifest !== manifestText) {
    throw new Error("Existing reference manifest differs from the newly verified manifest; refusing to overwrite it.");
  }
  if (existingManifest === null) {
    await writeFile(manifestPath, manifestText, { flag: "wx" });
  }
  console.log(JSON.stringify({ imagePath, manifestPath, byteLength: bytes.byteLength, sha1, sha256, verified: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ verified: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
