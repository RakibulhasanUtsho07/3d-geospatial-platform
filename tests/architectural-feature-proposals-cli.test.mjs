import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const width = 20, height = 20;
const reviewedAt = "2026-10-26T10:00:00Z";
async function png(pixels, channels) {
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}
function makeMaskPixels() {
  const pixels = new Uint8Array(width * height);
  for (let y=2; y<=17; y+=1) for (let x=3; x<=16; x+=1) pixels[y*width+x]=255;
  return pixels;
}
function makeEdgePixels() {
  const pixels = new Uint8Array(width * height);
  for (let x=3; x<=16; x+=1) pixels[10*width+x]=255;
  for (const [x1,y1,x2,y2] of [[6,5,8,7],[11,5,13,7],[7,12,10,17]]) {
    for (let x=x1;x<=x2;x+=1) { pixels[y1*width+x]=255; pixels[y2*width+x]=255; }
    for (let y=y1;y<=y2;y+=1) { pixels[y*width+x1]=255; pixels[y*width+x2]=255; }
  }
  return pixels;
}
async function setup(t, assessmentStatus = "reviewed") {
  const root = await mkdtemp(path.join(os.tmpdir(), "architectural-feature-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePixels = new Uint8Array(width * height * 3).fill(185);
  const sourceBytes = await png(sourcePixels, 3);
  const maskBytes = await png(makeMaskPixels(), 1);
  const edgeBytes = await png(makeEdgePixels(), 1);
  await writeFile(path.join(root, "source.png"), sourceBytes);
  await writeFile(path.join(root, "mask.png"), maskBytes);
  await writeFile(path.join(root, "edges.png"), edgeBytes);
  const metadata = {
    schemaVersion: "1.0.0", buildingId: "building-a", viewId: "front", generatedAt: reviewedAt,
    source: { id: "capture-front", sha256: digest(sourceBytes), width, height },
    provider: { id: "manual-reviewed-mask", kind: "human-reviewed-mask", version: "1.0.0", configurationSha256: "a".repeat(64) },
    mask: { sha256: digest(maskBytes), bytes: maskBytes.length, width, height,
      encoding: "binary-8bit-white-foreground-v1", coordinateConvention: "pixel-origin-top-left",
      backgroundValue: 0, foregroundValue: 255 },
    assessment: { status: assessmentStatus, confidence: 1, humanReviewed: assessmentStatus === "reviewed",
      reviewerId: assessmentStatus === "reviewed" ? "reviewer-a" : undefined,
      reviewedAt: assessmentStatus === "reviewed" ? reviewedAt : undefined },
    edgeMap: { sha256: digest(edgeBytes), bytes: edgeBytes.length, width, height },
    options: { edgeThreshold: 160, horizontalBandDensityThreshold: 0.58 },
  };
  await writeFile(path.join(root, "metadata.json"), JSON.stringify(metadata, null, 2));
  return { root, metadata };
}
function run(root, output = "review-output") {
  const script = new URL("../scripts/propose-architectural-features.mjs", import.meta.url).pathname;
  return spawnSync(process.execPath, [script, "source.png", "mask.png", "edges.png", "metadata.json", output],
    { cwd: root, encoding: "utf8" });
}

test("requires reviewed hash-pinned mask and creates source overlay plus feature evidence", async (t) => {
  const { root } = await setup(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const output = path.join(root, "review-output");
  const report = JSON.parse(await readFile(path.join(output, "architectural-feature-proposals.json"), "utf8"));
  const overlay = await readFile(path.join(output, "feature-proposals-overlay.png"));
  const svg = await readFile(path.join(output, "feature-proposals-overlay.svg"), "utf8");
  assert.equal(report.status, "proposal-review-required");
  assert.equal(report.publishable, false);
  assert.equal(report.maskValidation.status, "ready-for-feature-extraction");
  assert.ok(report.observations.some((item) => item.category === "roofline-segment"));
  assert.ok(report.artifactHashes.overlayPngSha256 === digest(overlay));
  assert.ok(report.artifactHashes.overlaySvgSha256 === digest(Buffer.from(svg)));
  assert.ok((await stat(path.join(output, "feature-proposals-overlay.png"))).size > 0);
});

test("blocks an unreviewed mask instead of quietly generating architectural features", async (t) => {
  const { root } = await setup(t, "proposed");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Mask is not ready for feature extraction/);
});
