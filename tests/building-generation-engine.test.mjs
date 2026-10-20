import assert from "node:assert/strict";
import test from "node:test";

import { createBuildingGenerationEngine } from "../src/core/building-generation/engine.mjs";

const base = {
  schemaVersion: 1,
  requestId: "engine-test-1",
  building: {
    name: "Engine Test House",
    buildingType: "house",
    designBrief: "Compact house with a flat roof.",
    dimensions: { aboveGroundFloors: 2, floorToFloorHeightMeters: 3.1, totalHeightMeters: 6.2 },
    footprint: { widthMeters: 10, depthMeters: 8 },
    frontAzimuthDegrees: 180,
    facadeColours: ["#e6ded1"],
  },
  references: [],
  quality: "parametric-facade",
  allowExternalProviderProcessing: false,
};

function image(id, view, extra = {}) {
  return {
    id, assetId: "asset-" + id, kind: "image", purpose: "actual-building",
    permission: "authorized", view, providerFileToken: "file_" + id + "1234",
    ...extra,
  };
}

test("analyzes the request and generates a dimension-controlled GLB base", () => {
  const engine = createBuildingGenerationEngine();
  const output = engine.generateProceduralCandidate(base);
  assert.equal(output.contentType, "model/gltf-binary");
  assert.equal(output.extension, ".glb");
  assert.equal(output.glb.toString("ascii", 0, 4), "glTF");
  assert.equal(output.metadata.totalHeightMeters, 6.2);
  assert.equal(output.metadata.footprintWidthMeters, 10);
  assert.equal(output.plan.canGenerateParametricBase, true);
});

test("submits labelled authorized image views through the multiview provider adapter", async () => {
  let received;
  const engine = createBuildingGenerationEngine({
    tripoClient: {
      async submitMultiview(input) { received = input; return { taskId: "task_98765" }; },
      async submitImage() { throw new Error("single image route was not expected"); },
    },
  });
  const result = await engine.submitReferenceCandidate({
    ...base,
    quality: "reference-assisted",
    allowExternalProviderProcessing: true,
    references: [image("front", "front"), image("left", "left")],
  });
  assert.equal(result.strategy, "parametric-plus-ai-multiview");
  assert.equal(result.taskId, "task_98765");
  assert.deepEqual(received.views, { front: "file_front1234", left: "file_left1234" });
});

test("requires explicit permission before calling an external provider", async () => {
  let called = false;
  const engine = createBuildingGenerationEngine({
    tripoClient: { async submitImage() { called = true; return { taskId: "task_12345" }; } },
  });
  await assert.rejects(
    engine.submitReferenceCandidate({
      ...base, quality: "reference-assisted",
      references: [image("front", "front")],
    }),
    (error) => error.code === "external-processing-not-authorized",
  );
  assert.equal(called, false);
});

test("requires uploaded provider tokens instead of exposing private asset handles", async () => {
  const engine = createBuildingGenerationEngine({
    tripoClient: { async submitImage() { throw new Error("should not submit"); } },
  });
  await assert.rejects(
    engine.submitReferenceCandidate({
      ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
      references: [{ ...image("front", "front"), providerFileToken: undefined }],
    }),
    (error) => error.code === "provider-upload-required",
  );
});

test("video generation requires selected, labelled and provenance-linked keyframes", async () => {
  let received;
  const engine = createBuildingGenerationEngine({
    tripoClient: {
      async submitMultiview(input) { received = input; return { taskId: "task_video1" }; },
      async submitImage() { throw new Error("video path should use multiview"); },
    },
  });
  const video = { id: "walkthrough", assetId: "video-asset", kind: "video", purpose: "actual-building", permission: "authorized" };
  const frames = [
    image("frame-front", "front", { derivedFromReferenceId: "walkthrough", timestampSeconds: 1.2 }),
    image("frame-left", "left", { derivedFromReferenceId: "walkthrough", timestampSeconds: 3.7 }),
  ];
  await assert.rejects(
    engine.submitReferenceCandidate({
      ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
      references: [video, ...frames],
    }),
    (error) => error.code === "video-frame-selection-required",
  );
  const result = await engine.submitReferenceCandidate({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
    references: [video, ...frames],
  }, { selectedVideoFrameIds: ["frame-front", "frame-left"] });
  assert.equal(result.strategy, "video-keyframes-then-ai");
  assert.equal(received.views.front, "file_frame-front1234");
  assert.equal(received.views.left, "file_frame-left1234");
});

test("does not route research-only video frames to the provider", async () => {
  const engine = createBuildingGenerationEngine({
    tripoClient: { async submitMultiview() { throw new Error("should not submit"); } },
  });
  const video = { id: "walkthrough", assetId: "video-asset", kind: "video", purpose: "actual-building", permission: "research-only" };
  const frames = [
    image("frame-front", "front", { derivedFromReferenceId: "walkthrough", timestampSeconds: 1.2, permission: "research-only" }),
    image("frame-left", "left", { derivedFromReferenceId: "walkthrough", timestampSeconds: 3.7, permission: "research-only" }),
  ];
  assert.throws(() => engine.analyze({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
    references: [video, ...frames],
  }), TypeError);
});
