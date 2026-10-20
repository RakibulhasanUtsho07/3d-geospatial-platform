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

test("uploads protected image assets to the provider without exposing internal asset IDs", async () => {
  let uploadedBytes;
  let submittedInput;
  const engine = createBuildingGenerationEngine({
    loadAsset: async (assetId) => {
      assert.equal(assetId, "asset-front");
      return { bytes: new Uint8Array([255, 216, 255, 217]), filename: "front.jpg", contentType: "image/jpeg" };
    },
    tripoClient: {
      async uploadImage(options) { uploadedBytes = options.bytes; return { fileToken: "file_uploaded123" }; },
      async submitImage(options) { submittedInput = options.input; return { taskId: "task_uploaded1" }; },
    },
  });
  const result = await engine.submitReferenceCandidate({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
    references: [{ ...image("front", "front"), providerFileToken: undefined }],
  });
  assert.deepEqual([...uploadedBytes], [255, 216, 255, 217]);
  assert.equal(submittedInput, "file_uploaded123");
  assert.deepEqual(result.uploadedReferences, [{ referenceId: "front", providerFileToken: "file_uploaded123" }]);
});

test("extracts video frames into provenance-linked, Admin-reviewable image references", async () => {
  const { mkdtemp, mkdir, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "building-engine-test-"));
  const workDirectory = join(root, "work");
  await mkdir(workDirectory);
  let removed = false;
  let extractedOptions;
  let stored = 0;
  const video = { id: "walkthrough", assetId: "video-asset", kind: "video", purpose: "actual-building", permission: "authorized", licence: "admin-upload" };
  const engine = createBuildingGenerationEngine({
    resolveVideoAssetPath: async (assetId) => { assert.equal(assetId, "video-asset"); return join(root, "private-source.mp4"); },
    createVideoWorkDirectory: async () => workDirectory,
    removeVideoWorkDirectory: async (directory) => { removed = true; assert.equal(directory, workDirectory); await rm(directory, { recursive: true, force: true }); },
    extractVideo: async (options) => {
      extractedOptions = options;
      return {
        inputPath: options.inputPath, outputDirectory: options.outputDirectory, durationSeconds: 8, samplingFps: 0.5,
        frames: [
          { index: 0, filename: "frame_0000.jpg", path: join(options.outputDirectory, "frame_0000.jpg"), timestampSeconds: 1.25, timestampConfidence: "ffmpeg-presentation-timestamp", sourceVideoPath: options.inputPath },
          { index: 1, filename: "frame_0001.jpg", path: join(options.outputDirectory, "frame_0001.jpg"), timestampSeconds: 3.5, timestampConfidence: "ffmpeg-presentation-timestamp", sourceVideoPath: options.inputPath },
        ],
        notes: ["Admin must inspect the frames."],
      };
    },
    storeFrameAsset: async ({ path: framePath, sourceVideoAssetId, timestampSeconds }) => {
      assert.ok(framePath.endsWith(".jpg"));
      assert.equal(sourceVideoAssetId, "video-asset");
      stored += 1;
      return { assetId: "saved-frame-" + Math.round(timestampSeconds * 100) };
    },
  });
  const prepared = await engine.prepareVideoFrames({
    ...base, references: [video],
  }, { videoReferenceId: "walkthrough", extractionOptions: { fps: 0.25, maxFrames: 8 } });
  assert.equal(extractedOptions.inputPath, join(root, "private-source.mp4"));
  assert.ok(extractedOptions.outputDirectory.startsWith(workDirectory));
  assert.equal(extractedOptions.fps, 0.25);
  assert.equal(stored, 2);
  assert.equal(prepared.reviewRequired, true);
  assert.equal(prepared.frameReferences[0].kind, "image");
  assert.equal(prepared.frameReferences[0].view, "unknown");
  assert.equal(prepared.frameReferences[0].derivedFromReferenceId, "walkthrough");
  assert.equal(prepared.frameReferences[1].timestampSeconds, 3.5);
  assert.equal(prepared.request.references.length, 3);
  assert.equal(removed, true);
  await assert.rejects(stat(workDirectory), { code: "ENOENT" });
  await rm(root, { recursive: true, force: true });
});

test("does not extract a video reference without explicit processing authorization", async () => {
  let resolverCalled = false;
  const engine = createBuildingGenerationEngine({
    resolveVideoAssetPath: async () => { resolverCalled = true; return "/private/video.mp4"; },
    storeFrameAsset: async () => ({ assetId: "frame-1" }),
    extractVideo: async () => { throw new Error("should not start extraction"); },
  });
  await assert.rejects(engine.prepareVideoFrames({
    ...base,
    references: [{ id: "video1", assetId: "video1-asset", kind: "video", purpose: "actual-building", permission: "research-only" }],
  }, { videoReferenceId: "video1" }), (error) => error.code === "video-processing-not-authorized");
  assert.equal(resolverCalled, false);
});

test("polls a successful AI task, validates its GLB, and stores an Admin-review candidate", async () => {
  const { generateParametricBuildingGlb } = await import("../src/core/building-generation/procedural-builder.mjs");
  const glb = generateParametricBuildingGlb(base).glb;
  let polls = 0;
  let saved = null;
  let downloads = 0;
  const engine = createBuildingGenerationEngine({
    tripoClient: {
      async submitImage({ input }) { assert.equal(input, "file_front1234"); return { taskId: "task_engine123" }; },
      async getTask(taskId) {
        polls += 1;
        assert.equal(taskId, "task_engine123");
        if (polls === 1) return { taskId, status: "running", progress: 42 };
        return { taskId, status: "success", progress: 100, modelUrl: "https://cdn.tripo3d.ai/output/building.glb" };
      },
    },
    fetchImpl: async (url, options) => {
      downloads += 1;
      assert.equal(url, "https://cdn.tripo3d.ai/output/building.glb");
      assert.equal(options.redirect, "manual");
      return new Response(glb, { status: 200 });
    },
    storeGeneratedCandidate: async (input) => { saved = input; return { assetId: "draft-building-v1" }; },
    sleepImpl: async () => {},
  });
  const result = await engine.generateAndStoreReferenceCandidate({
    ...base,
    quality: "reference-assisted",
    allowExternalProviderProcessing: true,
    references: [image("front", "front")],
  }, { pollOptions: { pollIntervalMs: 100, maxAttempts: 4 } });
  assert.equal(polls, 2);
  assert.equal(downloads, 1);
  assert.equal(result.status, "needs-admin-review");
  assert.equal(result.assetId, "draft-building-v1");
  assert.equal(result.taskId, "task_engine123");
  assert.equal(result.strategy, "parametric-plus-ai-image");
  assert.equal(result.validation.valid, true);
  assert.equal(result.validation.contentType, "model/gltf-binary");
  assert.ok(result.warnings.some((warning) => warning.toLowerCase().includes("review")));
  assert.equal(saved.taskId, "task_engine123");
  assert.equal(saved.contentType, "model/gltf-binary");
  assert.equal(saved.metadata.provenance, "external-ai-candidate");
  assert.equal(saved.bytes.toString("ascii", 0, 4), "glTF");
});

test("failed provider tasks never download or store a model", async () => {
  let downloads = 0;
  let stores = 0;
  const engine = createBuildingGenerationEngine({
    tripoClient: {
      async submitImage() { return { taskId: "task_failed123" }; },
      async getTask(taskId) { return { taskId, status: "failed", message: "model generation failed" }; },
    },
    fetchImpl: async () => { downloads += 1; return new Response("bad"); },
    storeGeneratedCandidate: async () => { stores += 1; return { assetId: "should-not-exist" }; },
    sleepImpl: async () => {},
  });
  await assert.rejects(engine.generateAndStoreReferenceCandidate({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
    references: [image("front", "front")],
  }), (error) => error.code === "provider-task-failed");
  assert.equal(downloads, 0);
  assert.equal(stores, 0);
});

test("provider output outside the trusted CDN is rejected before download", async () => {
  let downloads = 0;
  let stores = 0;
  const engine = createBuildingGenerationEngine({
    tripoClient: {
      async submitImage() { return { taskId: "task_badurl123" }; },
      async getTask(taskId) { return { taskId, status: "success", modelUrl: "https://cdn.tripo3d.ai.evil.example/model.glb" }; },
    },
    fetchImpl: async () => { downloads += 1; return new Response("bad"); },
    storeGeneratedCandidate: async () => { stores += 1; return { assetId: "should-not-exist" }; },
    sleepImpl: async () => {},
  });
  await assert.rejects(engine.generateAndStoreReferenceCandidate({
    ...base, quality: "reference-assisted", allowExternalProviderProcessing: true,
    references: [image("front", "front")],
  }), (error) => error.code === "provider-output-validation-failed");
  assert.equal(downloads, 0);
  assert.equal(stores, 0);
});
