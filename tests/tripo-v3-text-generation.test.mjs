import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
import { generateBuildingAsset } from "../src/core/building-generation/generation-pipeline.mjs";
import {
  buildTripoTextPrompt,
  createTripoV3Client,
  runTripoTextGeneration,
  TRIPO_V3_API_BASE_URL,
} from "../src/core/building-generation/tripo-v3-text-generation.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
const glb = generateProceduralGlb(fixture).glb;

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tripo-v3-text-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetchMock({ failTask = false } = {}) {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    if (url.origin === "https://openapi.tripo3d.ai" && url.pathname === "/v3/generation/text-to-model") {
      assert.equal(init.method, "POST");
      assert.match(init.headers?.Authorization ?? "", /^Bearer test-api-key$/);
      const body = JSON.parse(init.body);
      assert.equal(body.model, "v3.1-20260211");
      assert.equal(body.auto_size, false);
      assert.ok(body.prompt.length <= 1024);
      return jsonResponse({ code: 0, data: { task_id: "task_test_1234" } });
    }
    if (url.origin === "https://openapi.tripo3d.ai" && url.pathname === "/v3/tasks/task_test_1234") {
      assert.equal(init.method, "GET");
      assert.match(init.headers?.Authorization ?? "", /^Bearer test-api-key$/);
      polls += 1;
      if (failTask) {
        return jsonResponse({
          code: 0,
          data: { task_id: "task_test_1234", status: "failed", progress: 100, error_message: "mock provider failure" },
        });
      }
      if (polls === 1) {
        return jsonResponse({ code: 0, data: { task_id: "task_test_1234", status: "queued", progress: 5 } });
      }
      return jsonResponse({
        code: 0,
        data: {
          task_id: "task_test_1234",
          status: "success",
          progress: 100,
          credits_consumed: 12,
          output: { model_url: "https://cdn.tripo3d.ai/output/candidate.glb" },
        },
      });
    }
    if (url.origin === "https://cdn.tripo3d.ai" && url.pathname === "/output/candidate.glb") {
      assert.equal(init.headers?.Authorization, undefined, "the API bearer key must never be forwarded to the model CDN");
      return new Response(glb, { status: 200, headers: { "content-type": "model/gltf-binary" } });
    }
    throw new Error("Unexpected mocked URL: " + url.toString());
  };
  return { fetchImpl, calls, get polls() { return polls; } };
}

test("builds a bounded architecture prompt without exposing building coordinates", () => {
  const prompt = buildTripoTextPrompt(fixture);
  assert.ok(prompt.length > 100);
  assert.ok(prompt.length <= 1024);
  assert.match(prompt, /Dhaka Procedural Test Building/);
  assert.match(prompt, /5 visible floors/);
  assert.match(prompt, /Roof form: terrace/);
  assert.match(prompt, /not map-ready/);
  assert.doesNotMatch(prompt, /90\.406|23\.709/);
});

test("requires an explicit paid-provider opt-in before any workspace or network work", async () => {
  await assert.rejects(
    runTripoTextGeneration({ workspaceRoot: os.tmpdir(), buildingSpec: fixture, jobId: "no-consent" }),
    /allowPaidProviderGeneration must be explicitly true/,
  );
});

test("pins the API to Tripo V3 and rejects untrusted model download hosts", async () => {
  let calls = 0;
  const client = createTripoV3Client({
    apiKey: "test-api-key",
    fetchImpl: async () => { calls += 1; throw new Error("must not be called"); },
  });
  assert.equal(TRIPO_V3_API_BASE_URL, "https://openapi.tripo3d.ai/v3");
  await assert.rejects(
    client.downloadModel({ modelUrl: "https://attacker.example/candidate.glb" }),
    /not an approved HTTPS model CDN/,
  );
  assert.equal(calls, 0);
});

test("submits, polls, downloads and saves a structurally valid review-only GLB candidate", async t => {
  const root = await workspace(t);
  const mock = createFetchMock();
  const result = await runTripoTextGeneration({
    workspaceRoot: root,
    buildingSpec: fixture,
    jobId: "text-job-01",
    allowPaidProviderGeneration: true,
    apiKey: "test-api-key",
    fetchImpl: mock.fetchImpl,
    pollIntervalMs: 0,
    maxPollAttempts: 3,
  });
  const saved = await readFile(result.modelPath);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.deepEqual(saved, glb);
  assert.equal(result.report.status, "completed-requires-review");
  assert.equal(report.taskId, "task_test_1234");
  assert.equal(report.creditsConsumed, 12);
  assert.equal(report.output.sha256.length, 64);
  assert.ok(report.output.meshCount >= 1);
  assert.equal(report.mapReady, false);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.automaticApproval, false);
  assert.equal(report.metricAlignment.status, "not-run");
  assert.equal(report.georeference.status, "not-solved");
  assert.equal(mock.polls, 2);
  assert.equal(mock.calls.filter(call => call.url.includes("/generation/text-to-model")).length, 1);
});

test("records provider task failures and does not create a candidate GLB", async t => {
  const root = await workspace(t);
  const mock = createFetchMock({ failTask: true });
  await assert.rejects(
    runTripoTextGeneration({
      workspaceRoot: root,
      buildingSpec: fixture,
      jobId: "text-job-failed",
      allowPaidProviderGeneration: true,
      apiKey: "test-api-key",
      fetchImpl: mock.fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
    }),
    /mock provider failure/,
  );
  const reportPath = path.join(root, ".building-engine", "jobs", fixture.id, "text-job-failed-tripo-v3-text", "report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.status, "failed");
  assert.match(report.failureMessage, /mock provider failure/);
});

test("generation pipeline exposes Tripo text generation only as an explicit strategy", async t => {
  const root = await workspace(t);
  const mock = createFetchMock();
  const result = await generateBuildingAsset(fixture, {
    strategy: "tripo-text",
    tripo: {
      workspaceRoot: root,
      jobId: "pipeline-text-job",
      allowPaidProviderGeneration: true,
      apiKey: "test-api-key",
      fetchImpl: mock.fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 3,
    },
  });
  assert.equal(result.mode, "tripo-text-ai");
  assert.equal(result.report.status, "completed-requires-review");
  assert.equal(result.report.mapReady, false);
});
