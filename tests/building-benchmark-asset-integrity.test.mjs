import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyBuildingBenchmarkAssetBytes } from "../src/core/building-generation/building-benchmark-asset-integrity.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function withRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf11-asset-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeAsset(root, relativePath, content) {
  const fullPath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  return { localPath: relativePath, byteSize: Buffer.byteLength(content), sha256: sha256(content) };
}

async function manifestFor(root, options = {}) {
  const image = "front-image-bytes-v1";
  const reference = options.sharedReference ? "candidate-glb-bytes-v1" : "independent-reference-model-bytes";
  const surface = "independent-laser-surface-bytes";
  const control = "survey-control-point-bytes";
  const candidate = options.sharedReference ? reference : "candidate-glb-bytes-v1";
  const assets = [
    { id: "image-front", role: "candidate-image", ...(await writeAsset(root, "images/front.jpg", image)) },
    { id: "reference-model", role: "reference-model", ...(await writeAsset(root, "reference/model.gml", reference)) },
    { id: "independent-surface", role: "independent-surface", ...(await writeAsset(root, "reference/surface.laz", surface)) },
    { id: "control-survey", role: "independent-control", ...(await writeAsset(root, "reference/controls.csv", control)) },
  ];
  const candidateFile = await writeAsset(root, "candidate/candidate.glb", candidate);
  return {
    schemaVersion: "1.0.0",
    evaluationId: "brf11-byte-integrity-test-01",
    assets,
    candidate: {
      glbPath: candidateFile.localPath,
      glbByteSize: candidateFile.byteSize,
      glbSha256: candidateFile.sha256,
      sourceAssetIds: ["image-front"],
    },
    reference: {
      sourceAssetIds: ["reference-model", "independent-surface"],
    },
  };
}

test("verifies local asset and candidate GLB bytes against exact size and SHA-256", async (t) => {
  const root = await withRoot(t);
  const manifest = await manifestFor(root);
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, root);
  assert.equal(report.status, "verified");
  assert.equal(report.counts.assets, 4);
  assert.equal(report.counts.verifiedAssets, 4);
  assert.equal(report.candidate.verified, true);
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.mapReady, false);
  assert.equal(report.automaticApproval, false);
});

test("blocks content whose bytes no longer match the declared SHA-256", async (t) => {
  const root = await withRoot(t);
  const manifest = await manifestFor(root);
  await writeFile(path.join(root, "images/front.jpg"), "mutated-source-image");
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, root);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-image-front-sha256"));
});

test("blocks declared byte-size mismatch", async (t) => {
  const root = await withRoot(t);
  const manifest = await manifestFor(root);
  manifest.assets[0].byteSize += 1;
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, root);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-image-front-byte-size"));
});

test("blocks path traversal outside the selected asset root", async (t) => {
  const root = await withRoot(t);
  const manifest = await manifestFor(root);
  manifest.assets[0].localPath = "../outside.jpg";
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, root);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-image-front"));
});

test("blocks nested symbolic links instead of following a path outside the root", async (t) => {
  const root = await withRoot(t);
  const manifest = await manifestFor(root);
  const original = path.join(root, "images/front.jpg");
  const target = path.join(root, "images/front-real.jpg");
  await writeFile(target, "front-image-bytes-v1");
  await rm(original);
  await symlink(target, original);
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, root);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-image-front-file"));
});

test("blocks candidate bytes identical to a verified independent reference asset", async (t) => {
  const root = await withRoot(t);
  const manifest = await manifestFor(root, { sharedReference: true });
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, root);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("candidate-reference-content-disjoint"));
  assert.equal(report.candidate.verified, true);
});

test("blocks when candidate GLB file is missing", async (t) => {
  const root = await withRoot(t);
  const manifest = await manifestFor(root);
  await rm(path.join(root, "candidate/candidate.glb"));
  const report = await verifyBuildingBenchmarkAssetBytes(manifest, root);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("candidate-glb-file"));
});
