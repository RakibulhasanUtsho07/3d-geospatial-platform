import assert from "node:assert/strict";
import test from "node:test";
import { reviewMeshSurfaces } from "../src/core/building-generation/mesh-surface-review.mjs";

const tetra = {
  vertices: [
    { id: "a", position: [0,0,0] }, { id: "b", position: [1,0,0] },
    { id: "c", position: [0,1,0] }, { id: "d", position: [0,0,1] },
  ],
  triangles: [
    { vertices: ["a","c","b"] }, { vertices: ["a","b","d"] },
    { vertices: ["a","d","c"] }, { vertices: ["b","c","d"] },
  ],
};

test("reports closed tetra topology without claiming publication readiness", () => {
  const result = reviewMeshSurfaces(tetra);
  assert.equal(result.status, "topology-check-passed");
  assert.equal(result.boundaryEdges.length, 0);
  assert.equal(result.nonManifoldEdges.length, 0);
  assert.equal(result.publicationEligible, false);
});

test("proposes evidence review instead of automatically capping boundaries", () => {
  const result = reviewMeshSurfaces({
    vertices: tetra.vertices.slice(0,3),
    triangles: [{ vertices: ["a","b","c"] }],
  });
  assert.equal(result.boundaryEdges.length, 3);
  assert.equal(result.repairProposals.length, 3);
  assert.equal(result.policy.automaticHoleFilling, false);
});

test("flags edges shared by more than two triangles", () => {
  const model = structuredClone(tetra);
  model.triangles.push({ vertices: ["a","b","c"] });
  const result = reviewMeshSurfaces(model);
  assert.ok(result.nonManifoldEdges.length > 0);
  assert.equal(result.status, "review-required");
});

test("rejects invalid vertex coordinates", () => {
  const model = structuredClone(tetra);
  model.vertices[0].position[0] = Infinity;
  assert.throws(() => reviewMeshSurfaces(model), /finite 3D positions/);
});
