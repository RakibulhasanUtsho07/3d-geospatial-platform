import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function pngHeader(width, height, tail = "") {
  const buffer = Buffer.alloc(24 + Buffer.byteLength(tail));
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  Buffer.from(tail).copy(buffer, 24);
  return buffer;
}
async function createCliFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-review-diagnostic-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const renderDir = path.join(root, "renders");
  const reviewDir = path.join(root, "review");
  await mkdir(renderDir, { recursive: true });
  await mkdir(path.join(reviewDir, "references"), { recursive: true });
  await mkdir(path.join(reviewDir, "diagnostics"), { recursive: true });

  const renderBytes = pngHeader(512, 512, "render-bytes");
  const referenceBytes = pngHeader(1600, 1200, "reference-bytes");
  const renderPath = path.join(renderDir, "front.png");
  const referencePath = path.join(reviewDir, "references", "front.png");
  await writeFile(renderPath, renderBytes);
  await writeFile(referencePath, referenceBytes);

  const renderManifest = {
    schemaVersion: "1.0.0",
    engine: "building-render-review-manifest-v1",
    status: "render-set-ready-for-human-review",
    valid: true,
    publicationEligible: false,
    modelSha256: "a".repeat(64),
    views: [{ id: "front", filename: "front.png", sha256: sha256(renderBytes), width: 512, height: 512, renderComplete: true }],
  };
  await writeFile(path.join(renderDir, "render-review-manifest.json"), JSON.stringify(renderManifest, null, 2) + "\n");
  const diagnostic = {
    schemaVersion: "1.0.0",
    engine: "render-image-similarity-diagnostics-v1",
    status: "diagnostics-computed",
    interpretation: "review-recommended",
    pair: {
      reference: { filename: "front.png", bytes: referenceBytes.length, sha256: sha256(referenceBytes), width: 1600, height: 1200 },
      candidateRender: { filename: "front.png", bytes: renderBytes.length, sha256: sha256(renderBytes), width: 512, height: 512 },
    },
    comparability: {
      aspectRatioDifferencePercent: 33.333,
      aspectRatioWithinScreeningThreshold: false,
      sameFacadeConfirmedByTool: false,
      cameraPoseAlignmentVerifiedByTool: false,
    },
    metrics: {
      meanAbsoluteError: 3,
      rootMeanSquaredError: 5,
      psnrDb: 34.151,
      localSsim8x8: 0.95,
      differenceHashHammingDistance: 4,
    },
    warnings: ["aspect-ratio-difference-exceeds-screening-threshold"],
    policy: { automaticMatch: false, architecturalAccuracyCertified: false, publicationEligible: false, mapReady: false },
  };
  await writeFile(path.join(reviewDir, "diagnostics", "front.json"), JSON.stringify(diagnostic, null, 2) + "\n");
  const reviewInput = {
    schemaVersion: "1.0.0",
    buildingId: "cli-test-building",
    referenceImages: [{
      id: "front-reference",
      path: "references/front.png",
      sha256: sha256(referenceBytes),
      width: 1600,
      height: 1200,
      sourceDescription: "Test reference",
      rightsStatus: "verified",
      facadeLabel: "front",
      captureHeadingDegrees: 180,
      captureHeadingBasis: "measured",
    }],
    comparisons: [{
      viewId: "front",
      referenceImageId: "front-reference",
      comparisonBasis: "same-facade-known",
      outcome: "match",
      reviewer: "reviewer-test",
      reviewedAt: "2026-10-21T10:00:00Z",
      notes: "The test reports an existing human decision.",
      similarityDiagnosticsPath: "diagnostics/front.json",
    }],
  };
  const reviewInputPath = path.join(reviewDir, "review-input.json");
  await writeFile(reviewInputPath, JSON.stringify(reviewInput, null, 2) + "\n");
  return { root, renderDir, reviewDir, reviewInputPath, referenceBytes, renderBytes };
}
function runCli(args) {
  const scriptPath = path.resolve("scripts/review-render-references.mjs");
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8", timeout: 15000 });
}

test("review CLI attaches optional diagnostics bound to exact local render and reference files", async (t) => {
  const fixture = await createCliFixture(t);
  const outputPath = path.join(fixture.reviewDir, "review-report.json");
  const result = runCli([fixture.renderDir, fixture.reviewInputPath, outputPath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(report.valid, true);
  assert.equal(report.reviewStatus, "reviewer-reported-matches");
  assert.equal(report.similarityDiagnosticsSummary.count, 1);
  assert.equal(report.comparisons[0].similarityDiagnostics.metrics.localSsim8x8, 0.95);
  assert.equal(report.comparisons[0].similarityDiagnostics.warnings[0], "aspect-ratio-difference-exceeds-screening-threshold");
  assert.equal(report.comparisons[0].outcome, "match");
  assert.equal(report.publicationEligible, false);
});

test("review CLI rejects a diagnostics path escaping the review-input directory", async (t) => {
  const fixture = await createCliFixture(t);
  const input = JSON.parse(await readFile(fixture.reviewInputPath, "utf8"));
  input.comparisons[0].similarityDiagnosticsPath = "../outside.json";
  await writeFile(fixture.reviewInputPath, JSON.stringify(input, null, 2) + "\n");
  const result = runCli([fixture.renderDir, fixture.reviewInputPath, path.join(fixture.reviewDir, "blocked-report.json")]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /escapes the review-input directory/);
});

test("review CLI refuses symlinked diagnostics reports", async (t) => {
  const fixture = await createCliFixture(t);
  const target = path.join(fixture.reviewDir, "diagnostics", "front.json");
  const alias = path.join(fixture.reviewDir, "diagnostics", "alias.json");
  await symlink(target, alias);
  const input = JSON.parse(await readFile(fixture.reviewInputPath, "utf8"));
  input.comparisons[0].similarityDiagnosticsPath = "diagnostics/alias.json";
  await writeFile(fixture.reviewInputPath, JSON.stringify(input, null, 2) + "\n");
  const result = runCli([fixture.renderDir, fixture.reviewInputPath, path.join(fixture.reviewDir, "blocked-report.json")]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a regular file and not a symlink/);
});
