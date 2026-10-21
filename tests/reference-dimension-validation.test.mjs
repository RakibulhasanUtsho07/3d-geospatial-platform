import assert from "node:assert/strict";
import test from "node:test";
import { validateReferenceDimensions } from "../src/core/building-generation/reference-dimension-validation.mjs";

const measured = { x: 20, y: 10, z: 30 };
const reference = { x: 40, y: 20, z: 60 };

test("passes dimensions when calibrated scale and reference dimensions agree", () => {
  const result = validateReferenceDimensions({
    measuredModelDimensions: measured,
    referenceDimensionsM: reference,
    metresPerModelUnit: 2,
    tolerancePercent: 1,
  });
  assert.equal(result.status, "dimension-check-passed-review-required");
  assert.equal(result.maxRelativeErrorPercent, 0);
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
  assert.ok(result.axes.every((axis) => axis.withinTolerance));
});

test("reports per-axis error and fails when measured dimensions exceed tolerance", () => {
  const result = validateReferenceDimensions({
    measuredModelDimensions: measured,
    referenceDimensionsM: { x: 40, y: 20, z: 80 },
    metresPerModelUnit: 2,
    tolerancePercent: 5,
  });
  assert.equal(result.status, "dimension-mismatch-review-required");
  assert.equal(result.axes.find((axis) => axis.referenceAxis === "z").relativeErrorPercent, 25);
  assert.equal(result.axes.find((axis) => axis.referenceAxis === "z").withinTolerance, false);
  assert.equal(result.maxRelativeErrorPercent, 25);
});

test("supports explicit axis mapping instead of silently assuming model orientation", () => {
  const result = validateReferenceDimensions({
    measuredModelDimensions: { x: 10, y: 30, z: 20 },
    referenceDimensionsM: { x: 20, y: 40, z: 60 },
    metresPerModelUnit: 2,
    axisMapping: { x: "z", y: "x", z: "y" },
    tolerancePercent: 0.1,
  });
  assert.deepEqual(result.axes.map((axis) => axis.referenceAxis), ["z", "x", "y"]);
  assert.equal(result.status, "dimension-check-passed-review-required");
});

test("rejects guessed/missing scale, invalid dimensions and non-bijective axis mapping", () => {
  assert.throws(() => validateReferenceDimensions({ measuredModelDimensions: measured, referenceDimensionsM: reference }), /metresPerModelUnit/);
  assert.throws(() => validateReferenceDimensions({ measuredModelDimensions: { ...measured, x: 0 }, referenceDimensionsM: reference, metresPerModelUnit: 1 }), /greater than zero/);
  assert.throws(() => validateReferenceDimensions({ measuredModelDimensions: measured, referenceDimensionsM: reference, metresPerModelUnit: 1, axisMapping: { x: "x", y: "x", z: "z" } }), /unique reference axis/);
  assert.throws(() => validateReferenceDimensions({ measuredModelDimensions: measured, referenceDimensionsM: reference, metresPerModelUnit: 1, tolerancePercent: 0 }), /between 0.1 and 100/);
});
