import assert from "node:assert/strict";
import test from "node:test";
import { assessColmapReconstruction, parseColmapModelAnalysis } from "../src/core/building-generation/colmap-diagnostics.mjs";

const modelAnalysis = [
  "I20261021 10:53:42.368326 model.cc:456] Images: 4",
  "I20261021 10:53:42.369568 model.cc:457] Registered images: 2",
  "I20261021 10:53:42.369576 model.cc:459] Points: 96",
  "I20261021 10:53:42.369581 model.cc:460] Observations: 278",
  "I20261021 10:53:42.369588 model.cc:462] Mean track length: 1.895833",
  "I20261021 10:53:42.369621 model.cc:467] Mean reprojection error: 2.570908px",
].join("\n");

test("parses COLMAP model_analyzer metrics with timestamped logger prefixes", () => {
  assert.deepEqual(parseColmapModelAnalysis(modelAnalysis), {
    totalImages: 4,
    registeredImages: 2,
    sparsePointCount: 96,
    observationCount: 278,
    meanTrackLength: 1.895833,
    meanReprojectionErrorPx: 2.570908,
  });
});

test("flags low registration, sparse-point density, short tracks and reprojection error", () => {
  const result = assessColmapReconstruction({ analysisText: modelAnalysis, sourceCount: 4 });

  assert.equal(result.status, "review-recommended");
  assert.equal(result.sourceImageCount, 4);
  assert.equal(result.registeredImageRatio, 0.5);
  assert.equal(result.metrics.registeredImages, 2);
  assert.equal(result.metrics.sparsePointCount, 96);
  assert.ok(result.warnings.some((warning) => warning.includes("Only 2 of 4 selected images registered")));
  assert.ok(result.warnings.some((warning) => warning.includes("Registered-image ratio")));
  assert.ok(result.warnings.some((warning) => warning.includes("Sparse reconstruction has 96 points")));
  assert.ok(result.warnings.some((warning) => warning.includes("Mean feature-track length")));
  assert.ok(result.warnings.some((warning) => warning.includes("Mean reprojection error")));
  assert.match(result.caveat, /heuristic review hints/);
});

test("returns a passed diagnostic only when available metrics meet configured heuristics", () => {
  const healthy = [
    "I20261021 10:53:42.368326 model.cc:456] Images: 8",
    "I20261021 10:53:42.369568 model.cc:457] Registered images: 8",
    "I20261021 10:53:42.369576 model.cc:459] Points: 2400",
    "I20261021 10:53:42.369581 model.cc:460] Observations: 8400",
    "I20261021 10:53:42.369588 model.cc:462] Mean track length: 3.5",
    "I20261021 10:53:42.369621 model.cc:467] Mean reprojection error: 0.7px",
  ].join("\n");

  const result = assessColmapReconstruction({ analysisText: healthy, sourceCount: 8 });

  assert.equal(result.status, "diagnostics-passed");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.registeredImageRatio, 1);
});

test("does not pretend diagnostics succeeded when COLMAP output cannot be parsed", () => {
  const result = assessColmapReconstruction({
    analysisText: "COLMAP ran, but it did not emit model metrics",
    sourceCount: 3,
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.metrics.registeredImages, null);
  assert.ok(result.warnings.length > 0);
});

test("validates input counts and diagnostic thresholds", () => {
  assert.throws(() => assessColmapReconstruction({ analysisText: "", sourceCount: 2 }), /between 3 and 120/);
  assert.throws(() => assessColmapReconstruction({
    analysisText: modelAnalysis,
    sourceCount: 4,
    thresholds: { minimumRegisteredImageRatio: -0.1 },
  }), /non-negative finite number/);
});
