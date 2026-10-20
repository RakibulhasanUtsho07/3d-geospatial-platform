import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBuildingGenerationRequest, planBuildingGeneration } from "../src/core/building-generation/input-policy.mjs";

const base = {
  schemaVersion: 1,
  requestId: "building-job-1",
  building: {
    name: "Sample Apartment",
    buildingType: "apartment",
    dimensions: { aboveGroundFloors: 5, floorToFloorHeightMeters: 3.1 },
    footprint: { widthMeters: 18, depthMeters: 12 },
    designBrief: "Five-storey apartment with modern Bangladeshi facade.",
  },
  references: [],
  quality: "parametric-facade",
  allowExternalProviderProcessing: false,
};

function image(id, view, permission = "authorized") {
  return { id, assetId: "asset-" + id, kind: "image", purpose: "actual-building", permission, view };
}

test("normalizes inputs and keeps metric dimensions explicit", () => {
  const request = normalizeBuildingGenerationRequest(base);
  assert.equal(request.building.dimensions.aboveGroundFloors, 5);
  assert.equal(request.building.footprint.widthMeters, 18);
  assert.equal(request.quality, "parametric-facade");
  assert.equal(planBuildingGeneration(request).strategy, "parametric-only");
});

test("routes rights-cleared front and side images to multiview AI plus a parametric base", () => {
  const plan = planBuildingGeneration({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
    references: [image("front", "front"), image("left", "left")],
  });
  assert.equal(plan.strategy, "parametric-plus-ai-multiview");
  assert.equal(plan.canGenerateParametricBase, true);
  assert.equal(plan.canGenerateParametricBase, true);
  assert.ok(!plan.stages.includes("generate-parametric-base"), "the AI candidate route must not claim the separate procedural candidate has been generated");
  assert.ok(plan.stages.includes("submit-ai-generation"));
  assert.ok(plan.stages.includes("validate-glb"));
  assert.ok(plan.stages.includes("admin-review"));
});

test("single-view AI plan labels hidden sides as inferred", () => {
  const plan = planBuildingGeneration({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
    references: [image("front", "front")],
  });
  assert.equal(plan.strategy, "parametric-plus-ai-image-multiview");
  assert.ok(plan.stages.includes("submit-image-to-multiview"));
  assert.ok(plan.stages.includes("submit-multiview-to-model"));
  assert.ok(plan.qualityNotes.some((note) => note.toLowerCase().includes("hidden surfaces")));
});

test("video inputs must pass through keyframe selection before AI generation", () => {
  const plan = planBuildingGeneration({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
    references: [{ id: "walkthrough", assetId: "video-1", kind: "video", purpose: "actual-building", permission: "authorized" }],
  });
  assert.equal(plan.strategy, "video-keyframes-then-ai");
  assert.ok(plan.stages.includes("extract-video-keyframes"));
  assert.ok(plan.stages.includes("select-and-label-frames"));
  assert.ok(plan.qualityNotes.some((note) => note.toLowerCase().includes("photogrammetry")));
});

test("does not route unapproved material to an external provider", () => {
  const plan = planBuildingGeneration({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: false,
    references: [image("front", "front", "unknown")],
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.externalProviderRequired, true);
  assert.ok(plan.warnings.length > 0);
});

test("multi-view reconstruction blocks under-specified images or missing metric scale", () => {
  const tooFew = planBuildingGeneration({
    ...base, quality: "multi-view-reconstruction", allowExternalProviderProcessing: true,
    references: [image("front", "front"), image("left", "left")],
  });
  assert.equal(tooFew.blocked, true);
  assert.equal(tooFew.strategy, "parametric-only");
  assert.ok(tooFew.missingInputs.some((item) => item.toLowerCase().includes("overlapping image set")));
  const noScale = planBuildingGeneration({
    ...base,
    building: { buildingType: "heritage", dimensions: {}, designBrief: "Facade reconstruction", footprint: undefined },
    quality: "multi-view-reconstruction", allowExternalProviderProcessing: true,
    references: [image("front", "front"), image("left", "left"), image("back", "back")],
  });
  assert.equal(noScale.blocked, true);
});

test("allows a local-metre footprint outline without rectangle dimensions", () => {
  const request = normalizeBuildingGenerationRequest({
    ...base,
    building: { ...base.building, footprint: { polygonXYMeters: [[0, 0], [10, 0], [12, 8], [0, 8]] } },
  });
  assert.equal(planBuildingGeneration(request).canGenerateParametricBase, true);
});

test("rejects unsafe or ambiguous geometry and reference IDs", () => {
  assert.throws(() => normalizeBuildingGenerationRequest({
    ...base, building: { ...base.building, footprint: { widthMeters: 10 } },
  }), TypeError);
  assert.throws(() => normalizeBuildingGenerationRequest({
    ...base, building: { ...base.building, dimensions: { totalHeightMeters: Infinity } },
  }), RangeError);
  assert.throws(() => normalizeBuildingGenerationRequest({
    ...base, references: [image("../unsafe", "front")],
  }), TypeError);
  assert.throws(() => normalizeBuildingGenerationRequest({
    ...base, references: [image("same", "front"), image("same", "left")],
  }), TypeError);
});

test("requires an explicit external processing decision", () => {
  assert.throws(() => normalizeBuildingGenerationRequest({
    ...base, allowExternalProviderProcessing: undefined,
  }), TypeError);
});

test("asks for view labels when several source photos are not labelled", () => {
  const plan = planBuildingGeneration({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
    references: [image("photo-a", "unknown"), image("photo-b", "unknown")],
  });
  assert.equal(plan.strategy, "needs-more-inputs");
  assert.equal(plan.blocked, true);
  assert.ok(plan.missingInputs.some((item) => item.toLowerCase().includes("labelled as at least two distinct views")));
});
