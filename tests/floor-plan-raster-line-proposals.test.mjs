import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import test from "node:test";

import { proposeFloorPlanRasterLines } from "../src/core/building-generation/floor-plan-raster-line-proposals.mjs";

async function makePlanImage(width = 800, height = 600) {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
    '<rect width="100%" height="100%" fill="#ffffff"/>' +
    '<g fill="none" stroke="#111111" stroke-width="4" stroke-linecap="square">' +
    '<path d="M 100 100 H 700 V 500 H 100 Z"/>' +
    '<path d="M 400 100 V 500"/>' +
    '</g></svg>',
    "utf8",
  );
  return sharp(svg).png().toBuffer();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("proposes long horizontal and vertical line segments from a raster plan without inventing rooms or metres", async () => {
  const imageBytes = await makePlanImage();
  const report = await proposeFloorPlanRasterLines({
    imageBytes,
    sourceSha256: sha256(imageBytes),
    sourceMimeType: "image/png",
    options: { minLineLengthPx: 40 },
  });
  assert.equal(report.schemaVersion, "1.0.0");
  assert.equal(report.engine, "floor-plan-raster-line-proposals-v1");
  assert.equal(report.status, "review-required-not-scaled");
  assert.equal(report.source.sha256, sha256(imageBytes));
  assert.equal(report.raster.originalWidth, 800);
  assert.equal(report.raster.originalHeight, 600);
  assert.equal(report.calibration.status, "not-calibrated");
  assert.equal(report.calibration.metresPerPixel, null);
  assert.ok(report.summary.horizontalCandidates >= 2);
  assert.ok(report.summary.verticalCandidates >= 3);
  assert.ok(report.candidates.every((candidate) => candidate.semanticClass === "ambiguous-line-candidate"));
  assert.ok(report.candidates.every((candidate) => candidate.confidenceScore > 0 && candidate.confidenceScore < 1));
  assert.ok(report.candidates.every((candidate) =>
    Number.isFinite(candidate.start.x) && Number.isFinite(candidate.start.y) &&
    Number.isFinite(candidate.end.x) && Number.isFinite(candidate.end.y) &&
    candidate.lengthPx > 0
  ));
  assert.equal("rooms" in report, false);
  assert.equal(report.mapReady, false);
  assert.equal(report.publicationEligible, false);
  assert.ok(report.warnings.some((warning) => warning.includes("not inferred")));
});

test("normalization is bounded and records the original image dimensions and processed pixel scale", async () => {
  const imageBytes = await makePlanImage(1800, 1200);
  const report = await proposeFloorPlanRasterLines({
    imageBytes,
    sourceSha256: sha256(imageBytes),
    sourceMimeType: "image/png",
    options: { maxDimension: 512, minLineLengthPx: 24, maxCandidates: 4 },
  });
  assert.equal(report.raster.originalWidth, 1800);
  assert.equal(report.raster.originalHeight, 1200);
  assert.equal(report.raster.width, 512);
  assert.ok(report.raster.height < 512);
  assert.ok(report.summary.candidateCount <= 4);
  assert.equal(report.summary.truncated, true);
  assert.ok(report.warnings.some((warning) => warning.includes("capped")));
  assert.equal(report.calibration.units, "pixel");
});

test("is deterministic for the same bytes and options", async () => {
  const imageBytes = await makePlanImage();
  const args = {
    imageBytes,
    sourceSha256: sha256(imageBytes),
    sourceMimeType: "image/png",
    options: { minLineLengthPx: 40 },
  };
  assert.deepEqual(await proposeFloorPlanRasterLines(args), await proposeFloorPlanRasterLines(args));
});

test("rejects invalid checksums, unsupported PDF input and invalid limits", async () => {
  const imageBytes = await makePlanImage();
  await assert.rejects(
    proposeFloorPlanRasterLines({
      imageBytes,
      sourceSha256: "0".repeat(64),
      sourceMimeType: "image/png",
    }),
    (error) => error.code === "SOURCE_CHECKSUM_MISMATCH",
  );
  await assert.rejects(
    proposeFloorPlanRasterLines({
      imageBytes: Buffer.from("%PDF-1.7"),
      sourceSha256: sha256(Buffer.from("%PDF-1.7")),
      sourceMimeType: "application/pdf",
    }),
    /support JPEG, PNG and WebP only/,
  );
  await assert.rejects(
    proposeFloorPlanRasterLines({
      imageBytes,
      sourceSha256: sha256(imageBytes),
      sourceMimeType: "image/png",
      options: { maxDimension: 10000 },
    }),
    /maxDimension must be an integer/,
  );
  await assert.rejects(
    proposeFloorPlanRasterLines({
      imageBytes: Buffer.from("not an image"),
      sourceSha256: sha256(Buffer.from("not an image")),
      sourceMimeType: "image/png",
    }),
    /Could not decode the uploaded raster floor-plan image/,
  );
});
