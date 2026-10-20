import assert from "node:assert/strict";
import test from "node:test";

import { createTripoGenerationClient } from "../src/core/building-generation/providers/tripo-client.mjs";

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

test("requires a server-side API key", () => {
  assert.throws(() => createTripoGenerationClient({ apiKey: "" }), /TRIPO_API_KEY/);
});

test("submits image generation as an asynchronous provider task", async () => {
  let request;
  const client = createTripoGenerationClient({
    apiKey: "test-secret",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return fakeResponse(200, { code: 0, data: { task_id: "task_12345" } });
    },
  });
  const result = await client.submitImage({ input: "file_abcde" });
  assert.deepEqual(result, { taskId: "task_12345" });
  assert.equal(request.url, "https://openapi.tripo3d.ai/v3/generation/image-to-model");
  assert.equal(request.init.headers.Authorization, "Bearer test-secret");
  assert.equal(JSON.parse(request.init.body).input, "file_abcde");
});

test("uses front and side views for multiview inputs", async () => {
  let requestBody;
  const client = createTripoGenerationClient({
    apiKey: "test-secret",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return fakeResponse(200, { code: 0, data: { task_id: "task_12345" } });
    },
  });
  await client.submitMultiview({ views: { front: "file_front123", left: "file_left123" } });
  assert.deepEqual(requestBody.inputs, [
    { front: { file_token: "file_front123" } },
    { left: { file_token: "file_left123" } },
  ]);
});

test("rejects missing front view, one-view input and unsafe provider URLs", async () => {
  const client = createTripoGenerationClient({ apiKey: "test-secret", fetchImpl: async () => { throw new Error("fetch should not be reached"); } });
  await assert.rejects(client.submitMultiview({ views: { left: "file_left123", back: "file_back123" } }), /front view/);
  await assert.rejects(client.submitMultiview({ views: { front: "file_front123" } }), /at least two views/);
  await assert.rejects(client.submitImage({ input: "http://example.com/image.png" }), /HTTPS URL/);
  await assert.rejects(client.submitImage({ input: "https://user:pass@example.com/image.png" }), /without credentials/);
});

test("normalizes asynchronous task status and generated GLB URL", async () => {
  const client = createTripoGenerationClient({
    apiKey: "test-secret",
    fetchImpl: async (url) => {
      assert.equal(url, "https://openapi.tripo3d.ai/v3/tasks/task_12345");
      return fakeResponse(200, { code: 0, data: {
        task_id: "task_12345", status: "success", progress: 100,
        output: { model_url: "https://cdn.example.com/model.glb", rendered_image_url: "https://cdn.example.com/preview.png" },
      } });
    },
  });
  assert.deepEqual(await client.getTask("task_12345"), {
    taskId: "task_12345", status: "success", progress: 100,
    modelUrl: "https://cdn.example.com/model.glb", previewUrl: "https://cdn.example.com/preview.png",
  });
});

test("reports provider failures without exposing secret values in errors", async () => {
  const client = createTripoGenerationClient({
    apiKey: "test-secret",
    fetchImpl: async () => fakeResponse(402, { message: "Insufficient credits" }),
  });
  await assert.rejects(client.submitImage({ input: "file_abcde" }), /Insufficient credits/);
});

test("uploads authorized JPEG/PNG bytes and returns a provider file token", async () => {
  let request;
  const client = createTripoGenerationClient({
    apiKey: "test-secret",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return fakeResponse(200, { code: 0, data: { file_token: "file_uploaded123" } });
    },
  });
  const result = await client.uploadImage({
    bytes: new Uint8Array([255, 216, 255, 217]),
    filename: "front-view.jpg",
    contentType: "image/jpeg",
  });
  assert.deepEqual(result, { fileToken: "file_uploaded123" });
  assert.equal(request.url, "https://openapi.tripo3d.ai/v3/files");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Authorization, "Bearer test-secret");
  assert.ok(request.init.body instanceof FormData);
  const file = request.init.body.get("file");
  assert.equal(file.name, "front-view.jpg");
  assert.equal(file.type, "image/jpeg");
  assert.equal(request.init.headers["Content-Type"], undefined);
});

test("rejects unsupported or oversized image uploads before making a request", async () => {
  let called = false;
  const client = createTripoGenerationClient({ apiKey: "test-secret", fetchImpl: async () => { called = true; throw new Error("should not call provider"); } });
  await assert.rejects(client.uploadImage({ bytes: new Uint8Array([1]), contentType: "video/mp4" }), /JPEG or PNG/);
  await assert.rejects(client.uploadImage({ bytes: new Uint8Array(20 * 1024 * 1024 + 1) }), /20 MB/);
  await assert.rejects(client.uploadImage({ bytes: new Uint8Array([1]), filename: "../bad.jpg" }), /safe basename/);
  assert.equal(called, false);
});
