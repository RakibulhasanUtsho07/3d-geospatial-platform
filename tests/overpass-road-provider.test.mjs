import assert from "node:assert/strict";
import test from "node:test";
import { fetchOverpassElements, resolveOverpassEndpoints } from "../src/core/geospatial/overpass-road-provider.mjs";

const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      if (payload instanceof Error) throw payload;
      return payload;
    },
  };
}
function timeoutError() {
  return Object.assign(new Error("Timed out"), { name: "TimeoutError" });
}

test("uses two known HTTPS global endpoints by default", () => {
  assert.deepEqual(resolveOverpassEndpoints({}), endpoints);
});

test("a custom primary endpoint retains one distinct fallback", () => {
  assert.deepEqual(resolveOverpassEndpoints({
    OVERPASS_API_URL: "https://custom.example/api/interpreter",
  }), ["https://custom.example/api/interpreter", endpoints[0]]);
});

test("an explicit endpoint list controls bounded failover order", () => {
  assert.deepEqual(resolveOverpassEndpoints({
    OVERPASS_API_URLS: "https://first.example/api/interpreter, https://second.example/api/interpreter",
  }), ["https://first.example/api/interpreter", "https://second.example/api/interpreter"]);
  assert.throws(() => resolveOverpassEndpoints({
    OVERPASS_API_URLS: "https://a.example/api,https://b.example/api,https://c.example/api",
  }), /one or two/);
});

test("rejects HTTP, credentials and fragments in endpoint configuration", () => {
  assert.throws(() => resolveOverpassEndpoints({ OVERPASS_API_URL: "http://unsafe.example/api/interpreter" }), /HTTPS/);
  assert.throws(() => resolveOverpassEndpoints({ OVERPASS_API_URL: "https://user:secret@host.example/api/interpreter" }), /credentials/);
  assert.throws(() => resolveOverpassEndpoints({ OVERPASS_API_URLS: "https://host.example/api#fragment" }), /fragments/);
});

test("falls back with a reduced query after a primary timeout", async () => {
  const calls = [];
  const result = await fetchOverpassElements({
    endpoints,
    queries: ["full geometry query", "reduced geometry query"],
    fetchImpl: async (url, options) => {
      calls.push({ url, body: new URLSearchParams(options.body).get("data"), method: options.method });
      if (calls.length === 1) throw timeoutError();
      return response(200, { elements: [{ type: "way", id: 7 }] });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, "full geometry query");
  assert.equal(calls[1].body, "reduced geometry query");
  assert.equal(calls[0].method, "POST");
  assert.equal(result.attempts, 2);
  assert.equal(result.endpoint, endpoints[1]);
  assert.equal(result.detailLevel, "reduced");
  assert.deepEqual(result.elements, [{ type: "way", id: 7 }]);
});

test("falls back after a transient overload response", async () => {
  let calls = 0;
  const result = await fetchOverpassElements({
    endpoints,
    queries: ["full query", "reduced query"],
    fetchImpl: async () => ++calls === 1
      ? response(503, {}, { "retry-after": "12" })
      : response(200, { elements: [] }),
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.detailLevel, "reduced");
});

test("does not retry a non-transient HTTP 400 response", async () => {
  let calls = 0;
  await assert.rejects(fetchOverpassElements({
    endpoints,
    queries: ["invalid query", "reduced query"],
    fetchImpl: async () => {
      calls += 1;
      return response(400, { error: "bad query" });
    },
  }), (error) => error.statusCode === 502 && /HTTP 400/.test(error.message));
  assert.equal(calls, 1);
});

test("retries invalid JSON responses on the fallback endpoint", async () => {
  let calls = 0;
  const result = await fetchOverpassElements({
    endpoints,
    queries: ["full query", "reduced query"],
    fetchImpl: async () => ++calls === 1
      ? response(200, new Error("invalid JSON"))
      : response(200, { elements: [] }),
  });
  assert.equal(calls, 2);
  assert.equal(result.detailLevel, "reduced");
});

test("reports the last timeout when all endpoints fail", async () => {
  let calls = 0;
  await assert.rejects(fetchOverpassElements({
    endpoints,
    queries: ["full query", "reduced query"],
    fetchImpl: async () => {
      calls += 1;
      throw timeoutError();
    },
  }), (error) => error.statusCode === 504 && /timed out/.test(error.message));
  assert.equal(calls, 2);
});

test("cancellation immediately stops endpoint retries", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchOverpassElements({
    endpoints,
    queries: ["full query", "reduced query"],
    signal: controller.signal,
    fetchImpl: async () => {
      calls += 1;
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
  }), (error) => error.name === "AbortError");
  assert.equal(calls, 1);
});

test("validates per-endpoint timeout and request contracts", async () => {
  await assert.rejects(fetchOverpassElements({
    endpoints, queries: ["x"], timeoutMs: 1,
    fetchImpl: async () => response(200, { elements: [] }),
  }), /between 100 and 30000/);
  await assert.rejects(fetchOverpassElements({
    endpoints: [], queries: ["x"], fetchImpl: async () => response(200, { elements: [] }),
  }), /One or two/);
});
