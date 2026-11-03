import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  flagCanvasRedPixelOutliers,
  measureCanvasRedPixelSignal,
} from "../src/core/map-engine/canvas-red-pixel-diagnostics.mjs";

async function png(width, height, color) {
  return sharp({
    create: { width, height, channels: 3, background: color },
  }).png().toBuffer();
}

test("map canvas red-pixel signal finds a saturated red patch without rejecting neutral pixels", async () => {
  const image = await png(100, 100, "#a0a0a0");
  const redPatch = await sharp(image)
    .composite([{ input: await png(20, 20, "#ff2020"), left: 30, top: 30 }])
    .png()
    .toBuffer();
  const measured = await measureCanvasRedPixelSignal(redPatch);

  assert.equal(measured.width, 100);
  assert.equal(measured.height, 100);
  assert.ok(measured.redPixelRatio > 0.02);
  assert.ok(measured.redPixelRatio < 0.06);
});

test("red-pixel diagnostic comparison flags an isolated large red signal", () => {
  const results = flagCanvasRedPixelOutliers([
    { redPixelRatio: 0.0016 },
    { redPixelRatio: 0.0017 },
    { redPixelRatio: 0.0015 },
    { redPixelRatio: 0.0143 },
    { redPixelRatio: 0.0016 },
    { redPixelRatio: 0.0018 },
  ]);
  assert.deepEqual(results.map((item) => item.flagged), [false, false, false, true, false, false]);
  assert.equal(results[3].reason, "red-pixel-signal-outlier-review-required");
});

test("invalid pixel signals and thresholds fail closed", () => {
  assert.deepEqual(
    flagCanvasRedPixelOutliers([{ redPixelRatio: Number.NaN }, {}]).map((item) => item.flagged),
    [false, false],
  );
  assert.throws(
    () => flagCanvasRedPixelOutliers([], { minimumRatio: 1.1 }),
    /minimumRatio/,
  );
  assert.throws(
    () => flagCanvasRedPixelOutliers([], { peerMultiplier: 0.5 }),
    /peerMultiplier/,
  );
});
