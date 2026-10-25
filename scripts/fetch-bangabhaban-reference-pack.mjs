#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDir = path.resolve(process.argv[2] || "artifacts/bangabhaban-reference-pack");
const sources = [
  {
    id: "licensed-aerial-2006",
    filename: "bangabhaban-aerial-2006.jpg",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/4b/Bangabhaban.jpg",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Bangabhaban.jpg",
    author: "Naira Al Husain",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "Naira Al Husain, Bangabhaban.jpg, licensed under CC BY-SA 4.0; source: Wikimedia Commons.",
    viewRole: "elevated aerial; compound orientation and broad roof/building massing only",
    limitations: ["Perspective is uncalibrated.", "Do not infer measured dimensions or texture UVs from this image."]
  },
  {
    id: "licensed-exterior-2017",
    filename: "bangabhaban-exterior-2017.jpg",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/ed/Bangabhaban_%2833310655331%29.jpg",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Bangabhaban_(33310655331).jpg",
    author: "ASaber91",
    license: "CC BY 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
    attribution: "ASaber91, Bangabhaban (33310655331).jpg, licensed under CC BY 2.0; source: Wikimedia Commons.",
    expectedByteLength: 2420452,
    expectedSha1: "08c42b61fb435cf2bd9ac8e90f8261e8edc03b4a",
    viewRole: "elevated oblique exterior; central dome, facade rhythm, loggia and wing silhouette",
    limitations: ["Trees and distance obscure parts of the lower facade.", "Camera calibration is unknown."]
  },
  {
    id: "licensed-aerial-2017",
    filename: "bangabhaban-aerial-2017.jpg",
    url: "https://upload.wikimedia.org/wikipedia/commons/8/81/Bangabhaban%2C_Dhaka_April_%2833244270994%29.jpg",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Bangabhaban,_Dhaka_April_(33244270994).jpg",
    author: "ASaber91",
    license: "CC BY 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
    attribution: "ASaber91, Bangabhaban, Dhaka April (33244270994).jpg, licensed under CC BY 2.0; source: Wikimedia Commons.",
    viewRole: "elevated aerial/cityscape; roof blocks and visible building arrangement only",
    limitations: ["Perspective and surrounding buildings hide lower edges.", "Camera calibration is unknown."]
  }
];
const sha = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const records = [];
await mkdir(outputDir, { recursive: true });
for (const source of sources) {
  const response = await fetch(source.url, {
    redirect: "follow",
    headers: { "user-agent": "3d-geospatial-platform-bangabhaban-reference-audit/1.0" },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(source.id + " download failed with HTTP " + response.status);
  const finalUrl = response.url;
  if (new URL(finalUrl).hostname !== "upload.wikimedia.org") throw new Error(source.id + " redirected to an unexpected host");
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!contentType.includes("image/jpeg") || bytes.length < 10000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error(source.id + " is not a valid JPEG payload");
  }
  if (source.expectedByteLength && bytes.length !== source.expectedByteLength) {
    throw new Error(source.id + " byte length differs from recorded Commons metadata");
  }
  const sha1 = sha(bytes, "sha1"), sha256 = sha(bytes);
  if (source.expectedSha1 && sha1 !== source.expectedSha1) throw new Error(source.id + " published SHA-1 mismatch");
  const imagePath = path.join(outputDir, source.filename);
  let existing = null;
  try { existing = await readFile(imagePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing && sha(existing) !== sha256) throw new Error(source.id + " existing image differs from fresh source bytes");
  if (!existing) await writeFile(imagePath, bytes, { flag: "wx" });
  const { expectedByteLength, expectedSha1, ...metadata } = source;
  records.push({
    ...metadata,
    downloadedUrl: finalUrl,
    imagePath: source.filename,
    byteLength: bytes.length,
    sha1,
    sha256,
    verified: true,
    publishedChecksumCompared: Boolean(source.expectedSha1),
    hashMethod: "SHA-256 computed from exact downloaded JPEG bytes",
    cameraCalibration: "unknown",
    attributionRequired: true,
    modificationDisclosureRequired: true,
    modificationDisclosure: "Source image bytes unchanged; used only as a qualitative visual reference."
  });
}
const manifest = {
  schemaVersion: "1.0.0",
  building: "Bangabhaban",
  verified: records.length === 3,
  sourceCount: records.length,
  licensePolicy: "Retain per-file attribution and license links; disclose changes; respect CC BY-SA 4.0 share-alike terms for adaptations of that source.",
  usePolicy: "Reference bytes support qualitative exterior and roof review only; they do not provide survey dimensions or calibrated photogrammetry.",
  sources: records
};
await writeFile(path.join(outputDir, "reference-pack.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({
  verified: manifest.verified,
  sourceCount: records.length,
  sources: records.map(s => ({ id: s.id, byteLength: s.byteLength, sha256: s.sha256, license: s.license, publishedChecksumCompared: s.publishedChecksumCompared }))
}, null, 2));
