import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildRenderReferenceBatchPlan } from "../src/core/building-generation/render-reference-batch-plan.mjs";

function fixture() {
  const renderDirectory = path.resolve("/tmp/building-renders");
  const reviewInputPath = path.resolve("/tmp/building-review/review-input.json");
  return {
    renderDirectory,
    reviewInputPath,
    renderManifest: {
      schemaVersion: "1.0.0",
      engine: "building-render-review-manifest-v1",
      views: [
        { id: "front", filename: "front.png" },
        { id: "side", filename: "side.png" },
      ],
    },
    reviewInput: {
      schemaVersion: "1.0.0",
      buildingId: "batch-plan-test",
      referenceImages: [
        { id: "ref-front", path: "references/front.jpg" },
        { id: "ref-side", path: "references/side.png" },
      ],
      comparisons: [
        { viewId: "front", referenceImageId: "ref-front", outcome: "pending" },
        { viewId: "side", referenceImageId: "ref-side", outcome: "pending" },
      ],
    },
  };
}

test("plans each declared render/reference pair in input order with bounded, safe report names", () => {
  const input = fixture();
  const plan = buildRenderReferenceBatchPlan(input);
  assert.equal(plan.pairs.length, 2);
  assert.equal(plan.pairs[0].viewId, "front");
  assert.equal(plan.pairs[0].referenceImageId, "ref-front");
  assert.equal(plan.pairs[0].renderPath, path.join(input.renderDirectory, "front.png"));
  assert.equal(plan.pairs[0].referencePath, path.resolve(path.dirname(input.reviewInputPath), "references/front.jpg"));
  assert.equal(plan.pairs[0].diagnosticFilename, "pair-001.json");
  assert.equal(plan.pairs[0].diagnosticRelativePath, "generated-render-diagnostics/pair-001.json");
  assert.equal(plan.pairs[1].diagnosticFilename, "pair-002.json");
  assert.equal(plan.reviewInputWithDiagnosticsPath,
    path.join(path.dirname(input.reviewInputPath), "review-input.with-similarity-diagnostics.json"));
});

test("rejects duplicate view/reference pairs instead of generating ambiguous evidence", () => {
  const input = fixture();
  input.reviewInput.comparisons.push({ viewId: "front", referenceImageId: "ref-front", outcome: "pending" });
  assert.throws(() => buildRenderReferenceBatchPlan(input), /duplicate render\/reference comparison/);
});

test("rejects unknown render views and reference identifiers", () => {
  const unknownView = fixture();
  unknownView.reviewInput.comparisons[0].viewId = "roof";
  assert.throws(() => buildRenderReferenceBatchPlan(unknownView), /unknown render view/);

  const unknownReference = fixture();
  unknownReference.reviewInput.comparisons[0].referenceImageId = "unknown-ref";
  assert.throws(() => buildRenderReferenceBatchPlan(unknownReference), /unknown reference image/);
});

test("rejects paths escaping the review-input directory and absolute reference paths", () => {
  const outside = fixture();
  outside.reviewInput.referenceImages[0].path = "../../private/front.jpg";
  assert.throws(() => buildRenderReferenceBatchPlan(outside), /must resolve to a child/);

  const absolute = fixture();
  absolute.reviewInput.referenceImages[0].path = path.resolve("/tmp/outside.jpg");
  assert.throws(() => buildRenderReferenceBatchPlan(absolute), /relative file path/);
});

test("rejects unsafe diagnostics directory names and excessive batch sizes", () => {
  const unsafeDirectory = fixture();
  assert.throws(() =>
    buildRenderReferenceBatchPlan({ ...unsafeDirectory, diagnosticsDirectoryName: "../output" }),
  /safe, single relative directory name/);

  const tooMany = fixture();
  assert.throws(() =>
    buildRenderReferenceBatchPlan({ ...tooMany, maxComparisons: 1 }),
  /between 1 and 1 entries/);
});
