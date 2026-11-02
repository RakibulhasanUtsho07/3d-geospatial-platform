import test from "node:test";
import assert from "node:assert/strict";

import {
  runSingleImageWorkerPreflight,
} from "../src/core/building-generation/single-image-worker-preflight.mjs";

const readyCapabilities = {
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
  const report = await runSingleImageWorkerPreflight({
    probe: async () => readyCapabilities,
    now: "2026-11-02T12:00:00.000Z",
  });
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
      strategies: { "single-image-ai": {
        status: "configured", blockers: [],
        modelWeights: "missing", backgroundRemovalWeights: "cached",
      } },
    }),
  });
  assert.equal(report.status, "blocked");
  assert.match(report.blockers[0], /both be verified as cached/);
});

test("preflight blocks when rembg cache is unknown", async () => {
  const report = await runSingleImageWorkerPreflight({
    probe: async () => ({
      strategies: { "single-image-ai": {
        status: "configured", blockers: [],
        modelWeights: "cached", backgroundRemovalWeights: "unknown",
      } },
    }),
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
