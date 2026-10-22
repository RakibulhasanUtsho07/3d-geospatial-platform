import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeRenderImageSimilarity,
  compareGrayscaleImageSamples,
} from "../src/core/building-generation/render-image-similarity-diagnostics.mjs";

function pngHeader(width, height, extra = Buffer.alloc(0)) {
  const buffer = Buffer.alloc(24 + extra.length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  extra.copy(buffer, 24);
  return buffer;
}
function pattern(fn) {
  const pixels = Buffer.alloc(4096);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 64 + x] = fn(x, y);
  return pixels;
}
function mockedSpawn(_executable, args) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  queueMicrotask(() => {
    const inputPath = args[args.indexOf("-i") + 1];
    let pixels;
    if (inputPath.includes("candidate")) pixels = pattern((x, y) => (x * 3 + y * 7 + x * y) % 256);
    else pixels = pattern((x, y) => (x * 3 + y * 7 + x * y) % 256);
    child.stdout.write(pixels);
    setImmediate(() => {
      child.stdout.end();
      child.emit("close", 0, null);
    });
  });
  child.args = args;
  return child;
}

test("identical normalized previews produce zero error and a maximum local SSIM", () => {
  const pixels = pattern((x, y) => (x * 5 + y * 11 + x * y) % 256);
  const result = compareGrayscaleImageSamples(pixels, Buffer.from(pixels), {
    reference: { width: 1600, height: 1200 },
    candidate: { width: 800, height: 600 },
  });
  assert.equal(result.status, "diagnostics-computed");
  assert.equal(result.metrics.meanAbsoluteError, 0);
  assert.equal(result.metrics.rootMeanSquaredError, 0);
  assert.equal(result.metrics.psnrDb, null);
  assert.equal(result.metrics.localSsim8x8, 1);
  assert.equal(result.metrics.differenceHashHammingDistance, 0);
  assert.equal(result.metrics.edgeDensityAbsoluteDifference, 0);
  assert.equal(result.metrics.edgeOrientationHistogramDistance, 0);
  assert.equal(result.metrics.candidateToReferenceSharpnessRatio, 1);
  assert.equal(result.metrics.referenceEdgeOrientationHistogram.length, 8);
  assert.equal(result.metrics.spatialEdgeDistributionDistance, 0);
  assert.equal(result.metrics.activeEdgeCellJaccardDistance, 0);
  assert.equal(result.metrics.referenceSpatialEdgeDistribution.length, 16);
  assert.equal(result.metrics.referenceSpatialActiveCells.length, 16);
  assert.equal(result.metrics.spatialCellDiagnostics.length, 16);
  assert.equal(result.metrics.spatialCellMaeMedianGap, 0);
  assert.equal(result.metrics.localEdgeDensityDifferenceMaximum, 0);
  assert.equal(result.metrics.spatialCellDiagnostics[0].referenceEdgePixelCount,
    result.metrics.spatialCellDiagnostics[0].candidateEdgePixelCount);
  assert.deepEqual(result.metrics.highestEdgeDifferenceCells, [
    { cellX: 0, cellY: 0 }, { cellX: 1, cellY: 0 },
    { cellX: 2, cellY: 0 }, { cellX: 3, cellY: 0 },
  ]);
  assert.deepEqual(result.metrics.highestDifferenceCells, [
    { cellX: 0, cellY: 0 }, { cellX: 1, cellY: 0 },
    { cellX: 2, cellY: 0 }, { cellX: 3, cellY: 0 },
  ]);
  assert.equal(result.comparability.aspectRatioWithinScreeningThreshold, true);
  assert.equal(result.policy.automaticMatch, false);
  assert.equal(result.policy.publicationEligible, false);
});

test("changed pixels reduce structural similarity and produce diagnostic warnings", () => {
  const reference = pattern((x, y) => (x * 3 + y * 7 + x * y) % 256);
  const candidate = Buffer.from(reference);
  candidate.fill(245, 0, 1500);
  const result = compareGrayscaleImageSamples(reference, candidate, {
    reference: { width: 1000, height: 1000 },
    candidate: { width: 1000, height: 1000 },
  }, { minimumLocalSsim: 0.99, maximumMeanAbsoluteError: 1 });
  assert.ok(result.metrics.meanAbsoluteError > 1);
  assert.ok(result.metrics.rootMeanSquaredError > 1);
  assert.ok(result.metrics.psnrDb > 0);
  assert.ok(result.metrics.localSsim8x8 < 0.99);
  assert.ok(result.warnings.includes("low-grayscale-ssim-screening-hint"));
  assert.ok(result.warnings.includes("high-grayscale-pixel-error-screening-hint"));
  assert.equal(result.policy.architecturalAccuracyCertified, false);
});

test("localizes a concentrated pixel mismatch to its 4x4 cell", () => {
  const reference = Buffer.alloc(4096, 30);
  const candidate = Buffer.from(reference);
  for (let y = 16; y < 32; y++) {
    for (let x = 32; x < 48; x++) candidate[y * 64 + x] = 220;
  }
  const result = compareGrayscaleImageSamples(reference, candidate, {
    reference: { width: 1600, height: 1200 },
    candidate: { width: 800, height: 600 },
  });
  assert.equal(result.metrics.spatialCellDiagnostics.length, 16);
  assert.deepEqual(result.metrics.highestDifferenceCells[0], { cellX: 2, cellY: 1 });
  assert.equal(result.metrics.spatialCellDiagnostics[6].meanAbsoluteError, 190);
  assert.equal(result.metrics.spatialCellMaeMedian, 0);
  assert.equal(result.metrics.spatialCellMaeMedianGap, 190);
  assert.ok(result.warnings.includes("localized-image-difference-screening-hint"));
  assert.equal(result.policy.automaticMatch, false);
  assert.equal(result.policy.publicationEligible, false);
});

test("detects spatial edge-layout differences that aspect ratio alone cannot reveal", () => {
  const leftFramed = pattern((x) => x < 32 ? (Math.floor(x / 4) % 2 ? 230 : 25) : 128);
  const rightFramed = pattern((x) => x >= 32 ? (Math.floor(x / 4) % 2 ? 230 : 25) : 128);
  const result = compareGrayscaleImageSamples(leftFramed, rightFramed, {
    reference: { width: 1600, height: 1200 },
    candidate: { width: 800, height: 600 },
  }, { maximumSpatialEdgeDistributionDistance: 0.2, maximumActiveEdgeCellJaccardDistance: 0.2 });
  assert.equal(result.comparability.aspectRatioWithinScreeningThreshold, true);
  assert.ok(result.metrics.spatialEdgeDistributionDistance > 0.2);
  assert.ok(result.metrics.activeEdgeCellJaccardDistance > 0.2);
  assert.ok(result.warnings.includes("spatial-edge-layout-difference-screening-hint"));
  assert.ok(result.warnings.includes("spatial-edge-coverage-difference-screening-hint"));
  assert.equal(result.policy.automaticMatch, false);
});

test("low-edge previews are flagged as weak comparison evidence", () => {
  const flat = Buffer.alloc(4096, 128);
  const result = compareGrayscaleImageSamples(flat, Buffer.from(flat), {
    reference: { width: 1600, height: 1200 },
    candidate: { width: 800, height: 600 },
  });
  assert.equal(result.metrics.spatialEdgeDistributionDistance, 0);
  assert.equal(result.metrics.referenceSpatialActiveEdgeCellCount, 0);
  assert.ok(result.warnings.includes("low-edge-content-comparability-screening-hint"));
  assert.equal(result.policy.publicationEligible, false);
});

test("brightness-only shifts do not become local edge-structure warnings", () => {
  const reference = pattern((x, y) => (Math.floor(x / 2) % 2 ? 180 : 40) + y);
  const candidate = pattern((x, y) => (Math.floor(x / 2) % 2 ? 200 : 60) + y);
  const result = compareGrayscaleImageSamples(reference, candidate, {
    reference: { width: 1600, height: 1200 },
    candidate: { width: 800, height: 600 },
  });
  assert.ok(result.metrics.meanAbsoluteError > 0);
  assert.equal(result.metrics.localEdgeDensityDifferenceMaximum, 0);
  assert.equal(result.metrics.spatialCellDiagnostics.length, 16);
  assert.ok(!result.warnings.includes("localized-edge-structure-difference-screening-hint"));
});

test("localizes edge-structure changes to the affected 4x4 cell", () => {
  const reference = pattern((x) => Math.floor(x / 2) % 2 ? 240 : 12);
  const candidate = Buffer.from(reference);
  for (let y = 16; y < 32; y++) {
    for (let x = 32; x < 48; x++) candidate[y * 64 + x] = 128;
  }
  const result = compareGrayscaleImageSamples(reference, candidate, {
    reference: { width: 1600, height: 1200 },
    candidate: { width: 800, height: 600 },
  }, { maximumLocalEdgeDensityDifference: 0.1 });
  assert.equal(result.metrics.spatialCellDiagnostics.length, 16);
  assert.equal(result.metrics.highestEdgeDifferenceCells[0].cellX, 2);
  assert.equal(result.metrics.highestEdgeDifferenceCells[0].cellY, 1);
  assert.ok(result.metrics.localEdgeDensityDifferenceMaximum > 0.1);
  assert.ok(result.warnings.includes("localized-edge-structure-difference-screening-hint"));
  assert.equal(result.policy.automaticMatch, false);
  assert.equal(result.policy.publicationEligible, false);
});

test("detects a lower-sharpness candidate against a structured reference", () => {
  const reference = pattern((x) => Math.floor(x / 8) % 2 ? 230 : 24);
  const blurredCandidate = Buffer.alloc(4096, 128);
  const result = compareGrayscaleImageSamples(reference, blurredCandidate, {
    reference: { width: 1280, height: 720 },
    candidate: { width: 1280, height: 720 },
  }, { minimumReferenceLaplacianVariance: 1, minimumSharpnessRatio: 0.5 });
  assert.ok(result.metrics.referenceLaplacianVariance > result.metrics.candidateLaplacianVariance);
  assert.equal(result.metrics.candidateToReferenceSharpnessRatio, 0);
  assert.ok(result.warnings.includes("candidate-lower-sharpness-screening-hint"));
  assert.ok(result.warnings.includes("edge-density-difference-screening-hint"));
  assert.equal(result.policy.publicationEligible, false);
});

test("flags different edge-orientation structure without claiming compass heading", () => {
  const verticalFacadeBands = pattern((x) => Math.floor(x / 8) % 2 ? 255 : 12);
  const horizontalFacadeBands = pattern((_x, y) => Math.floor(y / 8) % 2 ? 255 : 12);
  const result = compareGrayscaleImageSamples(verticalFacadeBands, horizontalFacadeBands, {
    reference: { width: 1024, height: 1024 },
    candidate: { width: 1024, height: 1024 },
  }, { maximumEdgeOrientationHistogramDistance: 0.2 });
  assert.ok(result.metrics.edgeOrientationHistogramDistance > 0.2);
  assert.ok(result.warnings.includes("edge-orientation-structure-difference-screening-hint"));
  assert.equal(result.comparability.sameFacadeConfirmedByTool, false);
  assert.equal(result.comparability.cameraPoseAlignmentVerifiedByTool, false);
});

test("flags aspect-ratio incompatibility instead of silently treating it as a match", () => {
  const pixels = Buffer.alloc(4096, 128);
  const result = compareGrayscaleImageSamples(pixels, Buffer.from(pixels), {
    reference: { width: 1600, height: 900 },
    candidate: { width: 600, height: 1200 },
  });
  assert.equal(result.comparability.aspectRatioWithinScreeningThreshold, false);
  assert.ok(result.warnings.includes("aspect-ratio-difference-exceeds-screening-threshold"));
});

test("rejects invalid preview buffers, dimensions and thresholds", () => {
  const pixels = Buffer.alloc(4096, 128);
  const dimensions = { reference: { width: 640, height: 480 }, candidate: { width: 640, height: 480 } };
  assert.throws(() => compareGrayscaleImageSamples(Buffer.alloc(12), pixels, dimensions), /4096 grayscale bytes/);
  assert.throws(() => compareGrayscaleImageSamples(pixels, pixels, { reference: { width: 0, height: 1 }, candidate: dimensions.candidate }), /positive integer/);
  assert.throws(() => compareGrayscaleImageSamples(pixels, pixels, dimensions, { minimumLocalSsim: 2 }), /between -1 and 1/);
  assert.throws(() => compareGrayscaleImageSamples(pixels, pixels, dimensions, { maximumEdgeDensityDifference: 2 }), /between 0 and 1/);
  assert.throws(() => compareGrayscaleImageSamples(pixels, pixels, dimensions, { minimumSharpnessRatio: -1 }), /between 0 and 1/);
  assert.throws(() => compareGrayscaleImageSamples(pixels, pixels, dimensions, { maximumSpatialEdgeDistributionDistance: 2 }), /between 0 and 1/);
  assert.throws(() => compareGrayscaleImageSamples(pixels, pixels, dimensions, { maximumActiveEdgeCellJaccardDistance: -1 }), /between 0 and 1/);
  assert.throws(() => compareGrayscaleImageSamples(pixels, pixels, dimensions, { maximumSpatialCellMaeMedianGap: 256 }), /between 0 and 255/);
  assert.throws(() => compareGrayscaleImageSamples(pixels, pixels, dimensions, { maximumLocalEdgeDensityDifference: 2 }), /between 0 and 1/);
});

test("decodes bounded grayscale previews, hashes both files and records safe FFmpeg args", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-image-similarity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const referencePath = path.join(root, "reference.png");
  const candidatePath = path.join(root, "candidate.png");
  await writeFile(referencePath, pngHeader(1280, 720, Buffer.from("reference")));
  await writeFile(candidatePath, pngHeader(1280, 720, Buffer.from("candidate")));
  const result = await analyzeRenderImageSimilarity({ referenceImagePath: referencePath, candidateImagePath: candidatePath, spawnImpl: mockedSpawn });
  assert.equal(result.pair.reference.width, 1280);
  assert.equal(result.pair.candidateRender.height, 720);
  assert.match(result.pair.reference.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.pair.candidateRender.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.pair.reference.sha256 !== result.pair.candidateRender.sha256);
  assert.equal(result.metrics.localSsim8x8, 1);
  assert.equal(result.metrics.edgeOrientationHistogramDistance, 0);
  assert.equal(result.policy.mapReady, false);
  assert.equal(result.policy.publicationEligible, false);
});

test("rejects unsupported images and symlink paths before decoding", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-image-similarity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = path.join(root, "fake.bin");
  await writeFile(fake, Buffer.from("not an image"));
  await assert.rejects(analyzeRenderImageSimilarity({ referenceImagePath: fake, candidateImagePath: fake, spawnImpl: mockedSpawn }), /readable JPEG\/PNG/);
  const valid = path.join(root, "valid.png");
  await writeFile(valid, pngHeader(640, 480));
  const alias = path.join(root, "alias.png");
  await symlink(valid, alias);
  await assert.rejects(analyzeRenderImageSimilarity({ referenceImagePath: alias, candidateImagePath: valid, spawnImpl: mockedSpawn }), /must not be a symlink/);
});
