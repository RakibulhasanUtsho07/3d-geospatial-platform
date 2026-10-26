import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateBuildingCaptureManifestFile } from "../scripts/validate-building-capture-manifest.mjs";

const reviewedAt = "2026-10-24T10:00:00.000Z";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
    const filename = id + ".bin";
    const bytes = Buffer.from("fixture bytes for " + id);
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
  const bootstrap = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root });
  assert.equal(bootstrap.status, "incomplete");
  assert.equal(bootstrap.input.expectedSha256Pinned, false);
  assert.ok(bootstrap.checks.some((check) => check.id === "capture-manifest-hash-pin" && check.status === "warning"));

  const pinned = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root,
    expectedSha256: data.expectedManifestSha256 });
  assert.equal(pinned.status, "ready-for-review");
  assert.equal(pinned.readyForModelReview, true);
  assert.equal(pinned.input.expectedSha256Pinned, true);
  assert.ok(pinned.fileIntegrity.every((item) => item.status === "passed"));
});

test("rejects a stale source file hash and a mismatched manifest pin", async (t) => {
  const data = await fixture(t);
  await writeFile(path.join(data.root, "evidence", "capture-front.bin"), "changed source bytes");
  const assetMismatch = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root,
    expectedSha256: data.expectedManifestSha256 });
  assert.equal(assetMismatch.status, "failed");
  assert.ok(assetMismatch.fileIntegrity.some((item) => item.sourceId === "capture-front" && item.status === "failed"));

  const wrongPin = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root,
    expectedSha256: "f".repeat(64) });
  assert.equal(wrongPin.status, "failed");
  assert.ok(wrongPin.checks.some((check) => check.id === "capture-manifest-hash-pin" && check.status === "failed"));
});

test("refuses path traversal and symlinked source files", async (t) => {
  const data = await fixture(t);
  await assert.rejects(validateBuildingCaptureManifestFile({ manifestPath: "../outside.json", rootDir: data.root }),
    /inside the project root|project-relative path/);
  const manifestPath = path.join(data.root, "capture-manifest.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  const frontPath = path.join(data.root, "evidence", "capture-front.bin");
  await unlink(frontPath);
  await symlink("capture-back.bin", frontPath);
  const symlinkResult = await validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json",
    rootDir: data.root, expectedSha256: data.expectedManifestSha256 });
  assert.equal(symlinkResult.status, "failed");
  assert.match(symlinkResult.fileIntegrity.find((item) => item.sourceId === "capture-front").detail, /symlink/);

  raw.sources[0].path = "../outside.jpg";
  await writeFile(manifestPath, JSON.stringify(raw));
  await assert.rejects(validateBuildingCaptureManifestFile({ manifestPath: "capture-manifest.json", rootDir: data.root }),
    /safe project-relative path/);
});
