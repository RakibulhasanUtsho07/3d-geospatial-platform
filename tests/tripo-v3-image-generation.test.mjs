import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
import { runMediaToModelWorkflow } from "../src/core/building-generation/media-to-model-workflow.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(128, 31)]);
const BROAD_TEST_SCOPES = [
  "private-media-ingestion",
  "private-image-quality-preflight",
  "video-frame-extraction",
  "procedural-model-derivation",
  "single-image-ai-reconstruction",
  "photogrammetry-reconstruction",
  "external-provider-image-generation",
  "texture-baking",
];
const candidateGlb = generateProceduralGlb(fixture).glb;

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tripo-v3-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  return root;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetchMock(expectedStage) {
  const calls = [];
  const fileTokens = [];
  let pollCount = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    if (url.origin === "https://openapi.tripo3d.ai" && url.pathname === "/v3/files") {
      assert.equal(init.method, "POST");
      assert.match(init.headers?.Authorization ?? "", /^Bearer test-api-key$/);
      assert.ok(init.body instanceof FormData, "image bytes must use multipart/form-data");
      const uploaded = init.body.get("file");
      assert.ok(uploaded instanceof Blob);
      assert.ok(["image/jpeg", "image/png"].includes(uploaded.type));
      assert.ok(uploaded.size > 0 && uploaded.size <= 20 * 1024 * 1024);
      const fileToken = "file_test_" + String(fileTokens.length + 1).padStart(4, "0");
      fileTokens.push(fileToken);
      return jsonResponse({ code: 0, data: { file_token: fileToken } });
    }
    if (url.origin === "https://openapi.tripo3d.ai" && url.pathname === "/v3/generation/image-to-model") {
      assert.equal(expectedStage, "image-to-model");
      assert.equal(init.method, "POST");
      assert.match(init.headers?.Authorization ?? "", /^Bearer test-api-key$/);
      const body = JSON.parse(init.body);
      assert.equal(body.input, fileTokens[0]);
      assert.equal(body.model, "v3.1-20260211");
      assert.equal(body.texture, true);
      assert.equal(body.pbr, true);
      assert.equal(body.auto_size, false);
      assert.equal(body.enable_image_autofix, false);
      return jsonResponse({ code: 0, data: { task_id: "task_image_1234" } });
    }
    if (url.origin === "https://openapi.tripo3d.ai" && url.pathname === "/v3/generation/multiview-to-model") {
      assert.equal(expectedStage, "multiview-to-model");
      assert.equal(init.method, "POST");
      assert.match(init.headers?.Authorization ?? "", /^Bearer test-api-key$/);
      const body = JSON.parse(init.body);
      assert.equal(body.model, "v3.1-20260211");
      assert.deepEqual(body.inputs, [
        { front: fileTokens[0] },
        { left: fileTokens[1] },
      ]);
      return jsonResponse({ code: 0, data: { task_id: "task_multi_1234" } });
    }
    if (url.origin === "https://openapi.tripo3d.ai" && url.pathname.startsWith("/v3/tasks/")) {
      assert.equal(init.method, "GET");
      assert.match(init.headers?.Authorization ?? "", /^Bearer test-api-key$/);
      const taskId = url.pathname.split("/").at(-1);
      pollCount += 1;
      if (pollCount === 1) return jsonResponse({ code: 0, data: { task_id: taskId, status: "queued", progress: 5 } });
      return jsonResponse({
        code: 0,
        data: {
          task_id: taskId,
          type: expectedStage === "image-to-model" ? "image_to_model" : "multiview_to_model",
          status: "success",
          progress: 100,
          credits_consumed: 12,
          output: { model_url: "https://cdn.tripo3d.ai/output/candidate.glb" },
        },
      });
    }
    if (url.origin === "https://cdn.tripo3d.ai" && url.pathname === "/output/candidate.glb") {
      assert.equal(init.headers?.Authorization, undefined, "the Tripo API bearer token must not be forwarded to the model CDN");
      return new Response(candidateGlb, { status: 200, headers: { "content-type": "model/gltf-binary" } });
    }
    throw new Error("Unexpected mocked Tripo URL: " + url.toString());
  };
  return { fetchImpl, calls, fileTokens, get pollCount() { return pollCount; } };
}

async function createSourceInputs(root, sourceIds) {
  const sources = [];
  for (const sourceId of sourceIds) {
    const relativePath = "uploads/" + sourceId + ".png";
    await writeFile(path.join(root, relativePath), Buffer.concat([png, Buffer.from(sourceId)]));
    sources.push({
      sourceId,
      relativePath,
      kind: "image",
      licence: "CC BY 4.0",
      permittedOperations: BROAD_TEST_SCOPES,
      author: "Test photographer",
      attribution: "Test-only attribution",
    });
  }
  return sources;
}

test("runs a paid opt-in Tripo V3 single-image job from a rights-reviewed source and keeps it review-only", async t => {
  const root = await workspace(t);
  const mock = createFetchMock("image-to-model");
  const sources = await createSourceInputs(root, ["front-photo"]);
  const result = await runMediaToModelWorkflow({
    workspaceRoot: root,
    buildingSpec: fixture,
    jobId: "tripo-single-image",
    strategy: "tripo-image",
    sources,
    viewSourceIds: ["front-photo"],
    confirmRights: true,
    confirmExternalProviderProcessing: true,
    allowPaidProviderGeneration: true,
    apiKey: "test-api-key",
    fetchImpl: mock.fetchImpl,
    tripoPollIntervalMs: 0,
    tripoMaxPollAttempts: 3,
  });
  const saved = await readFile(result.modelPath);
  const workerReport = result.report.modelReport;
  assert.deepEqual(saved, candidateGlb);
  assert.equal(result.report.mode, "tripo-image-ai");
  assert.equal(result.report.status, "completed-requires-review");
  assert.equal(workerReport.engine, "tripo-v3-image-to-model");
  assert.equal(workerReport.generationStage, "image-to-model");
  assert.equal(workerReport.sources.length, 1);
  assert.equal(workerReport.sources[0].sourceId, "front-photo");
  assert.equal(workerReport.sources[0].externalProviderProcessing, "explicitly-authorized");
  assert.equal(workerReport.status, "completed-requires-review");
  assert.equal(workerReport.mapReady, false);
  assert.equal(workerReport.publicationEligible, false);
  assert.equal(workerReport.automaticApproval, false);
  assert.equal(workerReport.metricAlignment.status, "not-run");
  assert.equal(workerReport.georeference.status, "not-solved");
  assert.equal(workerReport.output.sha256.length, 64);
  assert.equal(workerReport.creditsConsumed, 12);
  assert.equal(mock.fileTokens.length, 1);
  assert.equal(mock.pollCount, 2);
  assert.equal(mock.calls.filter(call => call.url.endsWith("/v3/files")).length, 1);
  assert.equal(mock.calls.filter(call => call.url.endsWith("/v3/generation/image-to-model")).length, 1);
});

test("runs labelled front/side multiview generation only when every selected source is explicitly mapped", async t => {
  const root = await workspace(t);
  const mock = createFetchMock("multiview-to-model");
  const sources = await createSourceInputs(root, ["front-photo", "left-photo"]);
  const result = await runMediaToModelWorkflow({
    workspaceRoot: root,
    buildingSpec: fixture,
    jobId: "tripo-multiview",
    strategy: "tripo-image",
    sources,
    viewSourceIds: ["front-photo", "left-photo"],
    viewLabels: { front: "front-photo", left: "left-photo" },
    confirmRights: true,
    confirmExternalProviderProcessing: true,
    allowPaidProviderGeneration: true,
    apiKey: "test-api-key",
    fetchImpl: mock.fetchImpl,
    tripoPollIntervalMs: 0,
    tripoMaxPollAttempts: 3,
  });
  const workerReport = result.report.modelReport;
  assert.equal(result.report.mode, "tripo-image-ai");
  assert.equal(workerReport.generationStage, "multiview-to-model");
  assert.deepEqual(workerReport.sources.map(source => source.view), ["front", "left"]);
  assert.equal(workerReport.sources.length, 2);
  assert.equal(workerReport.output.sha256.length, 64);
  assert.equal(workerReport.mapReady, false);
  assert.equal(workerReport.publicationEligible, false);
  assert.equal(workerReport.automaticApproval, false);
  assert.equal(mock.fileTokens.length, 2);
  assert.equal(mock.calls.filter(call => call.url.endsWith("/v3/generation/multiview-to-model")).length, 1);
});

test("rejects missing paid-provider consent before creating workspace artefacts or making network requests", async t => {
  const root = await workspace(t);
  const mock = createFetchMock("image-to-model");
  const sources = await createSourceInputs(root, ["front-photo"]);
  await assert.rejects(
    runMediaToModelWorkflow({
      workspaceRoot: root,
      buildingSpec: fixture,
      jobId: "tripo-no-consent",
      strategy: "tripo-image",
      sources,
      confirmRights: true,
      confirmExternalProviderProcessing: true,
      apiKey: "test-api-key",
      fetchImpl: mock.fetchImpl,
    }),
    /allowPaidProviderGeneration=true/,
  );
  assert.equal(mock.calls.length, 0);
});

test("rejects multi-image external generation when view labels are missing or incomplete", async t => {
  const root = await workspace(t);
  const mock = createFetchMock("multiview-to-model");
  const sources = await createSourceInputs(root, ["front-photo", "left-photo"]);
  await assert.rejects(
    runMediaToModelWorkflow({
      workspaceRoot: root,
      buildingSpec: fixture,
      jobId: "tripo-labels-missing",
      strategy: "tripo-image",
      sources,
      viewSourceIds: ["front-photo", "left-photo"],
      confirmRights: true,
      confirmExternalProviderProcessing: true,
      allowPaidProviderGeneration: true,
      apiKey: "test-api-key",
      fetchImpl: mock.fetchImpl,
    }),
    /explicit viewLabels/,
  );
  assert.equal(mock.calls.length, 0);
});
