import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { traceFloorPlanRaster } from "../src/core/building-generation/floor-plan-raster-trace.mjs";

function drawLine(data, width, height, x1, y1, x2, y2, thickness = 5) {
  const radius = Math.floor(thickness / 2);
  if (y1 === y2) {
    for (let y = Math.max(0, y1 - radius); y <= Math.min(height - 1, y1 + radius); y += 1) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1) data[y * width + x] = 20;
    }
  } else if (x1 === x2) {
    for (let x = Math.max(0, x1 - radius); x <= Math.min(width - 1, x1 + radius); x += 1) {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += 1) data[y * width + x] = 20;
    }
  } else {
    throw new TypeError("fixture helper only draws orthogonal lines");
  }
}

function fixtureRaster() {
  const width = 320, height = 240;
  const pixels = Buffer.alloc(width * height, 245);
  for (const x of [30, 160, 290]) drawLine(pixels, width, height, x, 30, x, 210, 5);
  for (const y of [30, 120, 210]) drawLine(pixels, width, height, 30, y, 290, y, 5);
  return { width, height, pixels };
}

const SOURCE_HASH = createHash("sha256").update("floor plan scan fixture").digest("hex");
const OPTIONS = { threshold: 180, minLineLengthPx: 50, minRoomSidePx: 40, lineMergeTolerancePx: 4 };

test("finds long orthogonal wall hypotheses and closed rectangular room cells", () => {
  const raster = fixtureRaster();
  const result = traceFloorPlanRaster({
    width: raster.width,
    height: raster.height,
    grayscale: raster.pixels,
    sourceSha256: SOURCE_HASH,
    options: OPTIONS,
  });

  assert.equal(result.engine, "orthogonal-floor-plan-raster-trace-v1");
  assert.equal(result.status, "needs-human-trace-review");
  assert.equal(result.source.width, 320);
  assert.equal(result.source.height, 240);
  assert.equal(result.coordinateSystem, "oriented-raster-pixels");
  assert.equal(result.scale.metresPerPixel, null);
  assert.equal(result.summary.horizontalWallCandidates, 3);
  assert.equal(result.summary.verticalWallCandidates, 3);
  assert.equal(result.summary.roomCandidates, 4);
  assert.deepEqual(result.candidates.rooms[0].polygonPx, [[30, 32], [160, 32], [160, 120], [30, 120]]);
  assert.equal(result.candidates.rooms.every((room) => room.reviewStatus === "unreviewed"), true);
  assert.equal(result.candidates.horizontalWalls.every((line) => line.reviewStatus === "unreviewed"), true);
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
  assert.match(result.limitations.join(" "), /Coordinates are pixels, not metres/);
});

test("does not propose rooms where one side is visibly open", () => {
  const raster = fixtureRaster();
  for (let y = 206; y <= 214; y += 1) {
    for (let x = 155; x <= 165; x += 1) raster.pixels[y * raster.width + x] = 245;
  }
  const result = traceFloorPlanRaster({
    width: raster.width,
    height: raster.height,
    grayscale: raster.pixels,
    sourceSha256: SOURCE_HASH,
    options: OPTIONS,
  });
  assert.ok(result.candidates.rooms.length < 4);
});

test("rejects invalid raster dimensions, pixel buffers, checksum and detector options", () => {
  const raster = fixtureRaster();
  assert.throws(() => traceFloorPlanRaster({
    width: 16, height: 16, grayscale: Buffer.alloc(256), sourceSha256: SOURCE_HASH,
  }), /width must be an integer/);
  assert.throws(() => traceFloorPlanRaster({
    width: raster.width, height: raster.height, grayscale: Buffer.alloc(3), sourceSha256: SOURCE_HASH,
  }), /exactly width \* height/);
  assert.throws(() => traceFloorPlanRaster({
    width: raster.width, height: raster.height, grayscale: raster.pixels, sourceSha256: "nope",
  }), /SHA-256 hash/);
  assert.throws(() => traceFloorPlanRaster({
    width: raster.width, height: raster.height, grayscale: raster.pixels,
    sourceSha256: SOURCE_HASH, options: { threshold: 300 },
  }), /threshold must be an integer/);
});
