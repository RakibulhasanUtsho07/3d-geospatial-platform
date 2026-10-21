import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTriangleTopology } from "../src/core/building-generation/mesh-topology-qa.mjs";

function triangleIndices(values) {
  return { count: values.length, read: index => values[index] };
}

test("welds duplicated seam vertices so adjacent textured triangles remain one component", () => {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    1, 0, 0, 1, 1, 0, 0, 1, 0,
  ]);
  const result = analyzeTriangleTopology(positions, triangleIndices([0, 1, 2, 3, 4, 5]));

  assert.equal(result.topologyAnalyzed, true);
  assert.equal(result.weldedVertexCount, 4);
  assert.equal(result.connectedComponentCount, 1);
  assert.equal(result.uniqueEdgeCount, 5);
  assert.equal(result.boundaryEdgeCount, 4);
  assert.equal(result.nonManifoldEdgeCount, 0);
  assert.ok(result.warnings.includes("open-boundary-edges-present"));
  assert.ok(!result.warnings.includes("disconnected-mesh-components-present"));
});

test("detects detached triangle islands and reports the small detached component", () => {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    20, 0, 0, 21, 0, 0, 20, 1, 0,
  ]);
  const result = analyzeTriangleTopology(positions, triangleIndices([0, 1, 2, 3, 4, 5]));

  assert.equal(result.connectedComponentCount, 2);
  assert.equal(result.smallDetachedComponentCount, 1);
  assert.ok(result.warnings.includes("disconnected-mesh-components-present"));
  assert.ok(result.warnings.includes("small-detached-components-present"));
});

test("flags extremely long triangle edges relative to the primitive bounds", () => {
  const positions = new Float32Array([
    0, 0, 0, 100, 0, 0, 0, 1, 0,
  ]);
  const result = analyzeTriangleTopology(positions, triangleIndices([0, 1, 2]));

  assert.ok(result.maxEdgeLength > 99);
  assert.equal(result.longEdgeTriangleCount, 1);
  assert.ok(result.warnings.includes("long-triangle-edges-present"));
});

test("detects non-manifold edges used by more than two triangles", () => {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1,
  ]);
  const result = analyzeTriangleTopology(positions, triangleIndices([0, 1, 2, 1, 0, 3, 0, 1, 4]));

  assert.equal(result.nonManifoldEdgeCount, 1);
  assert.ok(result.warnings.includes("non-manifold-edges-present"));
});

test("skips expensive topology maps over the configured vertex limit but keeps edge metrics", () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0, 3, 0, 0]);
  const result = analyzeTriangleTopology(positions, triangleIndices([0, 1, 2, 3, 4, 5]), { maxTopologyVertices: 3 });

  assert.equal(result.topologyAnalyzed, false);
  assert.equal(result.topologySkipReason, "vertex-limit");
  assert.ok(Number.isFinite(result.maxEdgeLength));
  assert.ok(result.warnings.includes("topology-analysis-skipped-vertex-limit"));
});

test("validates limits and rejects invalid positions or indices", () => {
  assert.throws(() => analyzeTriangleTopology(new Float32Array(9), triangleIndices([0, 1, 2]), { maxTopologyVertices: 2 }), /maxTopologyVertices/);
  assert.throws(() => analyzeTriangleTopology(new Float32Array([0, 0, 0, NaN, 0, 0, 0, 1, 0]), triangleIndices([0, 1, 2])), /non-finite/);
  assert.throws(() => analyzeTriangleTopology(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), triangleIndices([0, 1, 3])), /outside the POSITION/);
});
