import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateBuildingCaptureManifestFile } from "../scripts/validate-building-capture-manifest.mjs";

const reviewedAt = "2026-10-24T10:00:00.000Z";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
function png(width = 1024, height = 768, tail = 0) {
  const bytes = Buffer.alloc(40, tail);
  PNG_SIGNATURE.copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; bytes[25] = 2; bytes[26] = 0; bytes[27] = 0; bytes[28] = 0;
  return bytes;
}
function makeFfmpegMock({ sameFrontView = false } = {}) {
  return (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const sourcePath = args[args.indexOf("-i") + 1] || "";
    const base = path.basename(sourcePath);
    let seed = sameFrontView && base.includes("-front.") ? 123456 : Array.from(base).reduce((sum, char) => sum + char.charCodeAt(0), 1);
    const pixels = Buffer.alloc(4096);
    for (let i = 0; i < pixels.length; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[i] = seed >>> 24;
    }
    queueMicrotask(() => {
      child.stdout.write(pixels);
      setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("close", 0, null); });
    });
    return child;
  };
}
const mockFfmpegSpawn = makeFfmpegMock();
const mockFrontDuplicateFfmpegSpawn = makeFfmpegMock({ sameFrontView: true });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "building-capture-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "evidence"));
  const sources = [];
  const rows = [
    ["capture-front", "capture", "photo", "front"],
    ["capture-back", "capture", "photo", "back"],
    ["capture-left", "capture", "photo", "left"],
    ["capture-right", "capture", "photo", "right"],
    ["reference-front", "reference", "photo", "front"],
    ["reference-back", "reference", "photo", "back"],
    ["reference-left", "reference", "photo", "left"],
    ["reference-right", "reference", "photo", "right"],
    ["survey-record", "measurement-evidence", "document", "other"],
  ];
  for (const [index, [id, purpose, kind, side]] of rows.entries()) {
    const filename = id + ".png";
    const bytes = png(1024, 768, index + 1);
    await writeFile(path.join(root, "evidence", filename), bytes);
    sources.push({ id, purpose, kind, side, path: "evidence/" + filename, sha256: sha256(bytes), bytes: bytes.length,
      sourceId: "record-" + id,
      rights: { status: "verified", evidenceId: "rights-" + id, reviewedBy: "reviewer-a", reviewedAt },
      camera: { status: purpose === "capture" ? "verified" : "unknown", headingDegrees: 90 },
      occlusion: { status: purpose === "capture" ? "partial" : "unknown", notes: "Reviewed visibility." } });
  }
  const manifest = {
    schemaVersion: "1.0.0", manifestId: "validator-pilot-a", buildingId: "validator-building-a", createdAt: reviewedAt,
    buildingIdentity: { status: "verified", sourceId: "official-register",
      evidenceDescription: "Identity cross-checked against a documented record.",
      verifiedBy: "reviewer-a", verifiedAt: reviewedAt },
    sources,
    measurements: ["x", "y", "z"].map((axis, index) => ({ id: "dimension-" + axis, axis, valueM: [20, 12, 30][index],
      uncertaintyM: 0.05, basis: "surveyed", status: "verified", sourceId: "survey-record",
      evidenceId: "survey-book", verifiedBy: "surveyor-a", verifiedAt: reviewedAt })),
    controlPoints: [
      { id: "gcp-1", longitude: 90.4000, latitude: 23.7000 },
      { id: "gcp-2", longitude: 90.4010, latitude: 23.7000 },
      { id: "gcp-3", longitude: 90.4000, latitude: 23.7010 },
    ].map((point) => ({ ...point, status: "verified", sourceId: "survey-record", evidenceId: "survey-book",
      verifiedBy: "surveyor-a", verifiedAt: reviewedAt })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(path.join(root, "capture-manifest.json"), manifestBytes);
  return { root, manifest, expectedManifestSha256: sha256(manifestBytes) };
}

test("validates source files and requires a pinned manifest hash for ready status", async (t) => {
  const data = await fixture(t);
  const bootstrap = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root, spawnImpl: mockFfmpegSpawn });
  assert.equal(bootstrap.status, "incomplete");
  assert.equal(bootstrap.input.expectedSha256Pinned, false);
  assert.ok(bootstrap.checks.some((check) => check.id === "capture-manifest-hash-pin" && check.status === "warning"));

  const pinned = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root,
    expectedSha256: data.expectedManifestSha256, spawnImpl: mockFfmpegSpawn });
  assert.equal(pinned.status, "ready-for-review");
  assert.equal(pinned.readyForModelReview, true);
  assert.equal(pinned.input.expectedSha256Pinned, true);
  assert.ok(pinned.fileIntegrity.every((item) => item.status === "passed"));
});

test("rejects a stale source file hash and a mismatched manifest pin", async (t) => {
  const data = await fixture(t);
  await writeFile(path.join(data.root, "evidence", "capture-front.png"), "changed source bytes");
  const assetMismatch = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root,
    expectedSha256: data.expectedManifestSha256, spawnImpl: mockFfmpegSpawn });
  assert.equal(assetMismatch.status, "failed");
  assert.ok(assetMismatch.fileIntegrity.some((item) => item.sourceId === "capture-front" && item.status === "failed"));

  const wrongPin = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root,
    expectedSha256: "f".repeat(64), spawnImpl: mockFfmpegSpawn });
  assert.equal(wrongPin.status, "failed");
  assert.ok(wrongPin.checks.some((check) => check.id === "capture-manifest-hash-pin" && check.status === "failed"));
});

test("refuses path traversal and symlinked source files", async (t) => {
  const data = await fixture(t);
  await assert.rejects(validateBuildingCaptureManifestFile({ manifestPath: "../outside.json", rootDir: data.root }),
    /inside the project root|project-relative path/);
  const manifestPath = path.join(data.root, "capture-manifest.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  const frontPath = path.join(data.root, "evidence", "capture-front.png");
  await unlink(frontPath);
  await symlink("capture-back.bin", frontPath);
  const symlinkResult = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json",
    rootDir: data.root, expectedSha256: data.expectedManifestSha256, spawnImpl: mockFfmpegSpawn });
  assert.equal(symlinkResult.status, "failed");
  assert.match(symlinkResult.fileIntegrity.find((item) => item.sourceId === "capture-front").detail, /symlink/);

  raw.sources[0].path = "../outside.jpg";
  await writeFile(manifestPath, JSON.stringify(raw));
  await assert.rejects(validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root }),
    /safe project-relative path/);
});

test("image-quality preflight blocks low-resolution capture sets from ready status", async (t) => {
  const data = await fixture(t);
  const image = png(320, 240, 7);
  await writeFile(path.join(data.root, "evidence", "capture-front.png"), image);
  const source = data.manifest.sources.find((item) => item.id === "capture-front");
  source.sha256 = sha256(image);
  source.bytes = image.length;
  const manifestBytes = Buffer.from(JSON.stringify(data.manifest, null, 2) + "\n");
  await writeFile(path.join(data.root, "capture-manifest.json"), manifestBytes);
  const report = await validateBuildingCaptureManifestFile({
    manifestPath: "capture-manifest.json", rootDir: data.root,
    expectedSha256: sha256(manifestBytes), spawnImpl: mockFfmpegSpawn,
  });
  assert.equal(report.status, "incomplete");
  assert.equal(report.readyForModelReview, false);
  assert.ok(report.inputQuality.results.find((item) => item.sourceId === "capture-front").warnings.includes("low-resolution"));
  assert.ok(report.checks.some((check) => check.id === "capture-image-quality-preflight" && check.status === "warning"));
});

test("image-quality preflight flags perceptually near-duplicate views without deleting sources", async (t) => {
  const data = await fixture(t);
  const report = await validateBuildingCaptureManifestFile({
    manifestPath: "capture-manifest.json", rootDir: data.root,
    expectedSha256: data.expectedManifestSha256, spawnImpl: mockFrontDuplicateFfmpegSpawn,
  });
  assert.equal(report.status, "incomplete");
  assert.ok(report.inputQuality.nearDuplicatePairCount > 0);
  assert.ok(report.inputQuality.results.find((item) => item.sourceId === "capture-front").warnings.includes("near-duplicate-view"));
  assert.equal(report.counts.captures, 4);
});

test("image-quality preflight fails when declared camera image dimensions contradict file dimensions", async (t) => {
  const data = await fixture(t);
  data.manifest.sources.find((item) => item.id === "capture-front").camera.imageWidth = 640;
  data.manifest.sources.find((item) => item.id === "capture-front").camera.imageHeight = 480;
  const manifestBytes = Buffer.from(JSON.stringify(data.manifest, null, 2) + "\n");
  await writeFile(path.join(data.root, "capture-manifest.json"), manifestBytes);
  const report = await validateBuildingCaptureManifestFile({
    manifestPath: "capture-manifest.json", rootDir: data.root,
    expectedSha256: sha256(manifestBytes), spawnImpl: mockFfmpegSpawn,
  });
  assert.equal(report.status, "failed");
  assert.ok(report.inputQuality.results.find((item) => item.sourceId === "capture-front").warnings.includes("declared-camera-image-dimensions-mismatch"));
});
