import test from "node:test";
import assert from "node:assert/strict";

import {
  runSingleImageWorkerPreflight,
} from "../src/core/building-generation/single-image-worker-preflight.mjs";

const readyCapabilities = {
  schemaVersion: "1.0.0",
  checkedAt: "2026-11-02T12:00:00.000Z",
  strategies: {
    "single-image-ai": {
      status: "ready",
      blockers: [],
      modelWeights: "cached",
      backgroundRemovalWeights: "cached",
      backgroundRemovalModel: "isnet-general-use",
    },
  },
};

test("preflight reports ready only when both model caches are verified", async () => {
  let probeOptions = null;
  const report = await runSingleImageWorkerPreflight({
    probe: async (options) => { probeOptions = options; return readyCapabilities; },
    now: "2026-11-02T12:00:00.000Z",
  });
  assert.deepEqual(probeOptions.strategies, ["single-image-ai"]);
  assert.equal(report.status, "ready");
  assert.equal(report.model.tripoModelWeights, "cached");
  assert.equal(report.model.backgroundRemovalWeights, "cached");
  assert.equal(report.model.backgroundRemovalModel, "isnet-general-use");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.mapReady, false);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.automaticApproval, false);
});

test("preflight blocks when TripoSR cache is missing", async () => {
  const report = await runSingleImageWorkerPreflight({
    probe: async () => ({
      schemaVersion: "1.0.0",
      checkedAt: "2026-11-02T12:00:00.000Z",
      strategies: { "single-image-ai": {
        status: "configured", blockers: [],
        modelWeights: "missing", backgroundRemovalWeights: "cached",
      } },
    }),
    now: "2026-11-02T12:00:00.000Z",
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some((item) => /TripoSR model weights are not verified as cached/.test(item)));
});

test("preflight blocks when rembg cache is unknown", async () => {
  const report = await runSingleImageWorkerPreflight({
    probe: async () => ({
      schemaVersion: "1.0.0",
      checkedAt: "2026-11-02T12:00:00.000Z",
      strategies: { "single-image-ai": {
        status: "configured", blockers: [],
        modelWeights: "cached", backgroundRemovalWeights: "unknown",
      } },
    }),
    now: "2026-11-02T12:00:00.000Z",
  });
  assert.equal(report.status, "blocked");
});

test("preflight blocks malformed or missing capability results", async () => {
  const report = await runSingleImageWorkerPreflight({ probe: async () => ({}) });
  assert.equal(report.status, "blocked");
  assert.match(report.blockers[0], /missing or malformed/);
});

test("preflight does not copy environment secrets into its report", async () => {
  const report = await runSingleImageWorkerPreflight({
    env: { API_TOKEN: "do-not-leak-this", BUILDING_ENGINE_PYTHON_EXECUTABLE: "/private/python" },
    probe: async () => readyCapabilities,
    now: "2026-11-02T12:00:00.000Z",
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("do-not-leak-this"), false);
  assert.equal(serialized.includes("/private/python"), false);
});

test("preflight rejects an invalid timestamp", async () => {
  await assert.rejects(
    runSingleImageWorkerPreflight({ probe: async () => readyCapabilities, now: "not-a-date" }),
    /valid timestamp/,
  );
});


test("preflight blocks a capability response with a non-canonical timestamp", async () => {
  const report = await runSingleImageWorkerPreflight({
    probe: async () => ({ ...readyCapabilities, checkedAt: "2026-11-02" }),
    now: "2026-11-02T12:30:00.000Z",
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.checkedAt, "2026-11-02T12:30:00.000Z");
  assert.ok(report.blockers.some((item) => /timestamp is missing, invalid, non-canonical, or stale/.test(item)));
});

test("preflight blocks an unsupported capability schema version", async () => {
  const report = await runSingleImageWorkerPreflight({
    probe: async () => ({ ...readyCapabilities, schemaVersion: "99.0.0" }),
    now: "2026-11-02T12:30:00.000Z",
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some((item) => /missing or unsupported schema version/.test(item)));
});


test("preflight sanitizes unsupported model states and untrusted model names", async () => {
  const report = await runSingleImageWorkerPreflight({
    probe: async () => ({
      ...readyCapabilities,
      strategies: {
        "single-image-ai": {
          status: "ready",
          blockers: [],
          modelWeights: "/private/cache/model.ckpt",
          backgroundRemovalWeights: "cached",
          backgroundRemovalModel: "/private/cache/secret.onnx",
        },
      },
    }),
    now: "2026-11-02T12:00:00.000Z",
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.model.tripoModelWeights, "unknown");
  assert.equal(report.model.backgroundRemovalModel, undefined);
  assert.equal(JSON.stringify(report).includes("/private/cache"), false);
});

test("preflight rejects a capability timestamp that does not match the requested probe time", async () => {
  const report = await runSingleImageWorkerPreflight({
    probe: async () => ({ ...readyCapabilities, checkedAt: "2026-11-02T11:59:59.000Z" }),
    now: "2026-11-02T12:00:00.000Z",
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.checkedAt, "2026-11-02T12:00:00.000Z");
});


test("preflight blocks malformed blocker arrays instead of dropping invalid entries", async () => {
  const report = await runSingleImageWorkerPreflight({
    probe: async () => ({
      ...readyCapabilities,
      strategies: {
        "single-image-ai": {
          ...readyCapabilities.strategies["single-image-ai"],
          blockers: [null],
        },
      },
    }),
    now: "2026-11-02T12:00:00.000Z",
  });
  assert.equal(report.status, "blocked");
  assert.match(report.blockers[0], /missing or malformed/);
});

test("preflight blocks cached rembg weights without a verified model identifier", async () => {
  const report = await runSingleImageWorkerPreflight({
    probe: async () => ({
      ...readyCapabilities,
      strategies: {
        "single-image-ai": {
          ...readyCapabilities.strategies["single-image-ai"],
          backgroundRemovalModel: null,
        },
      },
    }),
    now: "2026-11-02T12:00:00.000Z",
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some((item) => /no verified model identifier/.test(item)));
});
