import assert from "node:assert/strict";
import test from "node:test";
import { runWireframeQaRepairPasses } from "../src/core/building-generation/wireframe-qa-repair-passes.mjs";

const base = {
  vertices: [
    { id: "a", point: [0, 0, 0], rmsReprojectionError: 0.2 },
    { id: "b", point: [1, 0, 0], rmsReprojectionError: 0.3 },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
    { from: "a", to: "missing" },
    { from: "a", to: "a" },
  ],
};

test("removes invalid and duplicate edges without moving geometry", () => {
  const result = runWireframeQaRepairPasses(base);
  assert.equal(result.status, "qa-clean");
  assert.equal(result.edges.length, 1);
  assert.equal(result.repairs.length, 3);
  assert.deepEqual(result.vertices.map((v) => v.point), [[0, 0, 0], [1, 0, 0]]);
  assert.equal(result.publicationEligible, false);
});

test("flags high reprojection error for review instead of changing coordinates", () => {
  const model = structuredClone(base);
  model.edges = [{ from: "a", to: "b" }];
  model.vertices[1].rmsReprojectionError = 12;
  const result = runWireframeQaRepairPasses(model, { maxRmsReprojectionError: 2, maxPasses: 4 });
  assert.equal(result.status, "review-required");
  assert.equal(result.passesExecuted, 2);
  assert.equal(result.history.at(-1).flaggedVertices[0].vertexId, "b");
  assert.deepEqual(result.vertices[1].point, [1, 0, 0]);
});

test("requires three or four bounded passes and finite thresholds", () => {
  assert.throws(() => runWireframeQaRepairPasses(base, { maxPasses: 2 }), /3 or 4/);
  assert.throws(() => runWireframeQaRepairPasses(base, { maxRmsReprojectionError: 0 }), /positive finite/);
});

test("rejects duplicate vertex identifiers", () => {
  const model = structuredClone(base);
  model.vertices[1].id = "a";
  assert.throws(() => runWireframeQaRepairPasses(model), /unique/);
});
