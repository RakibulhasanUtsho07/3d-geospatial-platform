import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyBuildingBenchmarkAssetBytes } from "../src/core/building-generation/building-benchmark-asset-verification.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t, files = { "front.jpg": "allowed sample image", "reference.gml": "<CityModel/>" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf10-byte-verifier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = [];
  for (const [filename, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    await writeFile(path.join(root, filename), bytes);
    assets.push({
      id: filename.replace(/[^a-z0-9.-]/gi, "-"),
      filename,
      localPath: filename,
      sourceUrl: "https://dataset.example.invalid/" + filename,
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
      license: { reviewStatus: "approved" },
    });
  }
  return { root, manifest: { schemaVersion: "1.0.0", assets } };
}

function hasCode(report, code) {
  return report.blockers.some((blocker) => blocker.code === code);
}

test("verifies real local file sizes and streamed SHA-256 without granting model acceptance", async (t) => {
  const { root, manifest } = await fixture(t);
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, { assetRoot: root });
  assert.equal(report.status, "verified");
  assert.equal(report.assets.length, 2);
  assert.ok(report.assets.every((asset) => asset.status === "verified"));
  assert.ok(report.assets.every((asset) => asset.actualSha256 === asset.expectedSha256));
  assert.ok(report.assets.every((asset) => asset.actualByteSize === asset.expectedByteSize));
  assert.ok(report.assets.every((asset) => asset.rightsReviewDeclared));
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.mapReady, false);
  assert.equal(report.automaticApproval, false);
  assert.match(report.limitation, /does not download assets/i);
});

test("blocks a declared hash or byte size that differs from actual file bytes", async (t) => {
  const { root, manifest } = await fixture(t, { "front.jpg": "actual bytes" });
  manifest.assets[0].sha256 = "0".repeat(64);
  manifest.assets[0].byteSize += 1;
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, { assetRoot: root });
  assert.equal(report.status, "blocked");
  assert.ok(hasCode(report, "byte-size-mismatch"));
  assert.ok(hasCode(report, "sha256-mismatch"));
  assert.equal(report.assets[0].status, "blocked");
});

test("blocks missing local files and does not trust a metadata-only filename", async (t) => {
  const { root, manifest } = await fixture(t, { "front.jpg": "existing" });
  manifest.assets.push({
    id: "missing-asset",
    filename: "missing.jpg",
    localPath: "missing.jpg",
    byteSize: 12,
    sha256: "b".repeat(64),
  });
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, { assetRoot: root });
  assert.equal(report.status, "blocked");
  assert.ok(hasCode(report, "file-missing"));
  assert.equal(report.assets.at(-1).status, "blocked");
});

test("rejects path traversal and symlink-based asset escape", async (t) => {
  const { root, manifest } = await fixture(t, { "front.jpg": "inside" });
  const outside = path.join(path.dirname(root), "outside-" + path.basename(root) + ".jpg");
  await writeFile(outside, "outside");
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(root, "outside-link.jpg"));

  manifest.assets = [
    { ...manifest.assets[0], id: "traversal", localPath: "../" + path.basename(outside) },
    { ...manifest.assets[0], id: "symlink", localPath: "outside-link.jpg" },
  ];
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, { assetRoot: root });
  assert.equal(report.status, "blocked");
  assert.ok(hasCode(report, "unsafe-local-path"));
  assert.ok(hasCode(report, "symlink-disallowed"));
});

test("blocks malformed, duplicate and empty asset declarations", async (t) => {
  const { root, manifest } = await fixture(t, { "front.jpg": "inside" });
  const duplicate = { ...manifest, assets: [manifest.assets[0], { ...manifest.assets[0] }] };
  const duplicateReport = await verifyBuildingBenchmarkAssetBytes(duplicate, { assetRoot: root });
  assert.equal(duplicateReport.status, "blocked");
  assert.ok(hasCode(duplicateReport, "asset-id-duplicate"));

  const emptyReport = await verifyBuildingBenchmarkAssetBytes({ assets: [] }, { assetRoot: root });
  assert.equal(emptyReport.status, "invalid");
  assert.ok(hasCode(emptyReport, "assets-required"));

  const invalidHash = { ...manifest, assets: [{ ...manifest.assets[0], sha256: "not-a-hash" }] };
  const invalidHashReport = await verifyBuildingBenchmarkAssetBytes(invalidHash, { assetRoot: root });
  assert.equal(invalidHashReport.status, "blocked");
  assert.ok(hasCode(invalidHashReport, "declared-sha256-invalid"));
});

test("refuses files above the configured per-asset processing limit", async (t) => {
  const { root, manifest } = await fixture(t, { "front.jpg": "a little file" });
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, { assetRoot: root, maxAssetBytes: 1 });
  assert.equal(report.status, "blocked");
  assert.ok(hasCode(report, "asset-too-large"));
  assert.equal(report.assets[0].actualSha256, null);
});
