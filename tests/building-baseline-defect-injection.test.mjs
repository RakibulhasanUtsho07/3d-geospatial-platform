import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { validateReferenceDimensions } from "../src/core/building-generation/reference-dimension-validation.mjs";
import {
  buildControlledBuildingGlb,
  injectDegenerateTriangleDefect,
  injectDimensionScaleDefect,
} from "./fixtures/building-baseline-glb.mjs";

const baseline = JSON.parse(await readFile(
  new URL("../benchmarks/building-reconstruction/brf-04-controlled-baseline-v1.json", import.meta.url),
  "utf8",
));
const cleanGlb = buildControlledBuildingGlb(baseline.expectedDimensionsM);

function dimensionReport(glb) {
  const qa = analyzeGlbQuality(glb);
  const [x, y, z] = qa.bounds.dimensions;
  return validateReferenceDimensions({
    measuredModelDimensions: { x, y, z },
    referenceDimensionsM: baseline.expectedDimensionsM,
    metresPerModelUnit: baseline.metresPerModelUnit,
    tolerancePercent: baseline.dimensionTolerancePercent,
  });
}

function controlledBaselinePasses(glb) {
  const qa = analyzeGlbQuality(glb);
  const dimensions = dimensionReport(glb);
  return qa.valid === baseline.geometryExpectations.validGlb &&
    qa.counts.meshCount === baseline.geometryExpectations.meshCount &&
    qa.counts.triangleCount === baseline.geometryExpectations.triangleCount &&
    qa.counts.degenerateTriangleCount === baseline.geometryExpectations.degenerateTriangleCount &&
    dimensions.status === "dimension-check-passed-review-required";
}

test("controlled baseline matches its declared synthetic dimensions and geometry counts", () => {
  assert.equal(baseline.provenance.type, "synthetic-known-geometry");
  const qa = analyzeGlbQuality(cleanGlb);
  assert.equal(qa.valid, true);
  assert.equal(qa.counts.meshCount, baseline.geometryExpectations.meshCount);
  assert.equal(qa.counts.triangleCount, baseline.geometryExpectations.triangleCount);
  assert.equal(qa.counts.degenerateTriangleCount, 0);
  assert.deepEqual(
    { x: qa.bounds.dimensions[0], y: qa.bounds.dimensions[1], z: qa.bounds.dimensions[2] },
    baseline.expectedDimensionsM,
  );
  assert.equal(dimensionReport(cleanGlb).status, "dimension-check-passed-review-required");
  assert.equal(controlledBaselinePasses(cleanGlb), true);
  assert.equal(baseline.policy.mapReady, false);
  assert.equal(baseline.policy.publicationEligible, false);
});

test("baseline fixture generation is byte-repeatable for the same input", () => {
  const first = buildControlledBuildingGlb(baseline.expectedDimensionsM);
  const second = buildControlledBuildingGlb(baseline.expectedDimensionsM);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(hash(first), hash(second));
});

test("deliberately scaled Y-axis defect fails the expected-dimension tolerance gate", () => {
  const defect = baseline.defectCases.find((item) => item.id === "scale-y-plus-20-percent");
  const glb = injectDimensionScaleDefect(cleanGlb, defect.injection);
  const qa = analyzeGlbQuality(glb);
  const report = dimensionReport(glb);
  assert.equal(qa.valid, true, "dimension defects can remain structurally valid GLBs");
  assert.deepEqual(
    { x: qa.bounds.dimensions[0], y: qa.bounds.dimensions[1], z: qa.bounds.dimensions[2] },
    defect.expectedDimensionsM,
  );
  assert.equal(report.status, defect.expectedOutcome);
  assert.equal(report.maxRelativeErrorPercent, defect.expectedMaxRelativeErrorPercent);
  assert.equal(controlledBaselinePasses(glb), false);
});

test("deliberately degenerate triangle remains detectable even when the GLB parser accepts the asset", () => {
  const defect = baseline.defectCases.find((item) => item.id === "degenerate-triangle");
  const glb = injectDegenerateTriangleDefect(cleanGlb, defect.injection);
  const qa = analyzeGlbQuality(glb);
  assert.equal(qa.valid, true, "structural validity must not be confused with geometry quality");
  assert.ok(qa.counts.degenerateTriangleCount >= defect.expectedMinimumDegenerateTriangleCount);
  assert.ok(qa.warnings.includes(defect.expectedWarning));
  assert.equal(controlledBaselinePasses(glb), false);
});

test("controlled baseline explicitly disclaims real-building truth and publication approval", () => {
  assert.ok(baseline.provenance.notAuthoritativeFor.includes("architectural similarity"));
  assert.equal(baseline.policy.mapReady, false);
  assert.equal(baseline.policy.publicationEligible, false);
  assert.equal(baseline.policy.automaticApproval, false);
});
