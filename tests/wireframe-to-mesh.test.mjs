import assert from "node:assert/strict";
import test from "node:test";
import { buildMeshFromReviewedWireframe } from "../src/core/building-generation/wireframe-to-mesh.mjs";

const tetra = {
  vertices: [
    { id: "a", point: [0, 0, 0] }, { id: "b", point: [1, 0, 0] },
    { id: "c", point: [0, 1, 0] }, { id: "d", point: [0, 0, 1] },
  ],
  faces: [["a","c","b"],["a","b","d"],["a","d","c"],["b","c","d"]],
};

test("creates a closed tetrahedral mesh from explicit faces", () => {
  const result = buildMeshFromReviewedWireframe(tetra);
  assert.equal(result.triangles.length, 4);
  assert.equal(result.qa.boundaryEdgeCount, 0);
  assert.equal(result.qa.nonManifoldEdges.length, 0);
  assert.equal(result.qa.closedManifoldCandidate, true);
  assert.equal(result.publicationEligible, false);
});

test("rejects unknown, duplicate and degenerate faces", () => {
  const model = structuredClone(tetra);
  model.faces.push(["a","b","missing"], ["a","b","c"], ["a","b","c"]);
  const result = buildMeshFromReviewedWireframe(model);
  assert.equal(result.qa.rejectedFaces.length, 3);
  assert.equal(result.qa.rejectedFaces[0].reason, "face-must-reference-three-distinct-known-vertices");
  assert.equal(result.qa.rejectedFaces[1].reason, "duplicate-triangle");
});

test("reports open boundaries rather than silently capping them", () => {
  const result = buildMeshFromReviewedWireframe({
    vertices: tetra.vertices.slice(0, 3),
    faces: [["a","b","c"]],
  });
  assert.equal(result.qa.boundaryEdgeCount, 3);
  assert.equal(result.qa.closedManifoldCandidate, false);
});

test("rejects invalid vertex coordinates", () => {
  const model = structuredClone(tetra);
  model.vertices[0].point[0] = Number.NaN;
  assert.throws(() => buildMeshFromReviewedWireframe(model), /finite 3D/);
});
