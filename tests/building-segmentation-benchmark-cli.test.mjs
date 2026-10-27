import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import { SEGMENTATION_PALETTE_ID } from "../src/core/building-generation/building-segmentation-benchmark.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reviewedAt = "2026-10-26T10:00:00Z";
const palettePixels = Buffer.from([
  0,0,0, 255,255,255, 255,255,255,
  0,0,0, 0,255,0, 255,0,0,
]);
async function png(pixels, channels = 3) {
  return sharp(pixels, { raw: { width: 3, height: 2, channels } }).png().toBuffer();
}
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "segmentation-benchmark-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "evidence"));
  const samples = [];
  for (const [sampleId, split, seed] of [["dev-01","development",10],["heldout-01","held-out-evaluation",20]]) {
    const sourceBytes = await png(Buffer.from(Array.from({length:18}, (_,i) => (i + seed) % 255)));
    const labelBytes = await png(palettePixels);
    const files = [
      ["evidence/" + sampleId + "-source.png", sourceBytes],
      ["evidence/" + sampleId + "-truth.png", labelBytes],
      ["evidence/" + sampleId + "-prediction.png", labelBytes],
    ];
    for (const [rel, bytes] of files) await writeFile(path.join(root, rel), bytes);
    const sourceMetadata = await sharp(sourceBytes).metadata();
    const labelMetadata = await sharp(labelBytes).metadata();
    samples.push({
      sampleId, buildingGroupId: "building-" + sampleId,
      captureGroupId: "group-" + sampleId, split,
      source: { path: files[0][0], sha256: hash(sourceBytes), bytes: sourceBytes.length,
        width: sourceMetadata.width, height: sourceMetadata.height, sourceId: "source-" + sampleId,
        rights: { status: "verified", evidenceId: "rights-" + sampleId, reviewedBy: "reviewer-a", reviewedAt } },
      groundTruthMask: { path: files[1][0], sha256: hash(labelBytes), bytes: labelBytes.length,
        width: labelMetadata.width, height: labelMetadata.height, encoding: SEGMENTATION_PALETTE_ID,
        review: { status: "reviewed", annotationId: "annotation-" + sampleId, reviewerId: "reviewer-a", reviewedAt } },
      predictions: [{ providerId: "test-local-provider", modelVersion: "fixture-1", configSha256: "a".repeat(64),
        inputSha256: hash(sourceBytes), mask: { path: files[2][0], sha256: hash(labelBytes), bytes: labelBytes.length,
          width: labelMetadata.width, height: labelMetadata.height, encoding: SEGMENTATION_PALETTE_ID } }],
    });
  }
  const manifest = { schemaVersion: "1.0.0", benchmarkId: "cli-pilot", createdAt: reviewedAt,
    paletteId: SEGMENTATION_PALETTE_ID, samples };
  await writeFile(path.join(root, "benchmark.json"), JSON.stringify(manifest, null, 2));
  return { root, manifest };
}
function run(root, output) {
  return spawnSync(process.execPath, [
    new URL("../scripts/evaluate-building-segmentation-benchmark.mjs", import.meta.url).pathname,
    "benchmark.json", output, "--root=" + root,
  ], { cwd: root, encoding: "utf8" });
}

test("evaluates actual labelled PNG assets and keeps the result review-required", async (t) => {
  const { root } = await setup(t);
  const execution = run(root, "report.json");
  assert.equal(execution.status, 0, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
  assert.equal(report.status, "benchmark-review-required");
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.counts.evaluatedPairs, 2);
  assert.equal(report.assetIntegrity.every((item) => item.status === "passed"), true);
  assert.equal(report.candidateSummaries[0].heldOutImageCount, 1);
  assert.equal(report.candidateSummaries[0].heldOutMeanMacroForegroundIoU, 1);
});

test("rejects changed source bytes instead of reporting a segmentation score", async (t) => {
  const { root, manifest } = await setup(t);
  await writeFile(path.join(root, manifest.samples[1].source.path), "replaced image bytes");
  const execution = run(root, "report-failed.json");
  assert.equal(execution.status, 1);
  const report = JSON.parse(await readFile(path.join(root, "report-failed.json"), "utf8"));
  assert.equal(report.status, "benchmark-failed");
  assert.ok(report.issues.some((item) => item.code === "source-asset-integrity-failed"));
});
