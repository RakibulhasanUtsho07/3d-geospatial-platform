import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyBrf36SourceAssetBytes } from "../src/core/building-generation/brf36-source-byte-verifier.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function withRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf36-source-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function writeAsset(root, localPath, body) {
  const filename = path.join(root, ...localPath.split("/"));
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, body);
  return { id: path.basename(localPath, path.extname(localPath)), role: "image-frame",
    status: "pinned", localPath, byteSize: Buffer.byteLength(body), sha256: sha256(body),
    rightsStatus: "pending-exact-file-scope-review" };
}
function manifest(assets) { return { schemaVersion: "1.0.0", evaluationId: "brf36-test-01", assets }; }
const FLAGS = { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false };

test("verifies exact local bytes while keeping rights and release approval separate", async (t) => {
  const root = await withRoot(t);
  const a = await writeAsset(root, "images/front.jpg", "synthetic image bytes");
  const report = await verifyBrf36SourceAssetBytes(manifest([a]), root);
  assert.equal(report.status, "source-bytes-verified-review-required");
  assert.equal(report.byteStatus, "verified");
  assert.equal(report.verifiedAssetCount, 1);
  assert.equal(report.assets[0].byteStatus, "byte-verified");
  assert.equal(report.rightsStatus, "not-adjudicated-by-byte-verifier");
  assert.deepEqual(report.releaseFlags, FLAGS);
});

test("blocks hash changes after source bytes are mutated", async (t) => {
  const root = await withRoot(t);
  const a = await writeAsset(root, "images/front.jpg", "original");
  await writeFile(path.join(root, a.localPath), "changed bytes");
  const report = await verifyBrf36SourceAssetBytes(manifest([a]), root);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-front-sha256"));
  assert.equal(report.assets[0].byteStatus, "blocked");
});

test("blocks mismatched byte counts before hashing", async (t) => {
  const root = await withRoot(t);
  const a = await writeAsset(root, "images/front.jpg", "original");
  a.byteSize += 1;
  const report = await verifyBrf36SourceAssetBytes(manifest([a]), root);
  assert.ok(report.blockers.includes("asset-front-byte-size"));
  assert.equal(report.assets[0].actualSha256, null);
});

test("blocks missing local source bytes", async (t) => {
  const root = await withRoot(t);
  const a = { id: "citygml-main", role: "citygml-reference", status: "pinned",
    localPath: "private-assets/building.gml", byteSize: 8, sha256: sha256("12345678") };
  const report = await verifyBrf36SourceAssetBytes(manifest([a]), root);
  assert.ok(report.blockers.includes("asset-citygml-main-file"));
  assert.equal(report.assets[0].byteStatus, "blocked");
});

test("blocks a pending asset instead of treating its URL or name as bytes", async (t) => {
  const root = await withRoot(t);
  const report = await verifyBrf36SourceAssetBytes(manifest([{
    id: "uls-crop", role: "uls-crop", status: "pending-acquisition",
    localPath: null, byteSize: null, sha256: null, sourceUri: "https://example.test/uls.laz"
  }]), root);
  assert.ok(report.blockers.includes("asset-uls-crop-acquisition"));
  assert.equal(report.verifiedAssetCount, 0);
  assert.deepEqual(report.releaseFlags, FLAGS);
});

test("rejects path traversal and absolute paths", async (t) => {
  const root = await withRoot(t);
  const a = await writeAsset(root, "images/front.jpg", "original");
  a.localPath = "../outside.jpg";
  const first = await verifyBrf36SourceAssetBytes(manifest([a]), root);
  assert.ok(first.blockers.includes("asset-front-pins"));
  a.localPath = path.join(root, "images/front.jpg");
  const second = await verifyBrf36SourceAssetBytes(manifest([a]), root);
  assert.ok(second.blockers.includes("asset-front-pins"));
});

test("rejects a nested symbolic link", async (t) => {
  const root = await withRoot(t);
  const realPath = path.join(root, "images", "real.jpg");
  const linkPath = path.join(root, "images", "linked.jpg");
  await mkdir(path.dirname(realPath), { recursive: true });
  await writeFile(realPath, "source bytes");
  await symlink(realPath, linkPath);
  const a = { id: "linked", role: "image-frame", status: "pinned", localPath: "images/linked.jpg",
    byteSize: Buffer.byteLength("source bytes"), sha256: sha256("source bytes") };
  const report = await verifyBrf36SourceAssetBytes(manifest([a]), root);
  assert.ok(report.blockers.includes("asset-linked-file"));
});

test("rejects duplicate asset IDs and duplicate local paths", async (t) => {
  const root = await withRoot(t);
  const a = await writeAsset(root, "assets/a.bin", "bytes A");
  const b = { ...a, id: "different-id" };
  const report = await verifyBrf36SourceAssetBytes(manifest([a, b]), root);
  assert.ok(report.blockers.includes("asset-paths-unique"));
  const duplicateId = await verifyBrf36SourceAssetBytes(manifest([a, { ...a, localPath: "assets/a.bin" }]), root);
  assert.ok(duplicateId.blockers.includes("asset-ids-unique"));
});

test("blocks malformed manifests and oversized pin declarations", async (t) => {
  const root = await withRoot(t);
  const invalid = await verifyBrf36SourceAssetBytes({ schemaVersion: "1.0.0", evaluationId: "bad", assets: [] }, root);
  assert.ok(invalid.blockers.includes("manifest-contract"));
  const over = { id: "too-large", role: "uls-crop", status: "pinned", localPath: "large.laz",
    byteSize: 9 * 1024 * 1024 * 1024, sha256: sha256("never") };
  const report = await verifyBrf36SourceAssetBytes(manifest([over]), root);
  assert.ok(report.blockers.includes("asset-too-large-pins"));
  assert.deepEqual(report.releaseFlags, FLAGS);
});
