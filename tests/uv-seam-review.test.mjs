import assert from "node:assert/strict";
import test from "node:test";
import { reviewUvSeams } from "../src/core/building-generation/uv-seam-review.mjs";

const quad = {
  positions: [[0,0,0],[1,0,0],[1,1,0],[1,0,0],[1,1,0],[0,1,0]],
  indices: [0,1,2,3,4,5],
  uvs: [[0,0],[1,0],[1,1],[0,0],[0,1],[1,1]],
};

test("finds an atlas seam across duplicated vertices with the same geometric edge", () => {
  const report = reviewUvSeams(quad);
  assert.equal(report.seamCandidateCount,1);
  assert.deepEqual(report.candidates[0].triangleIndices,[0,1]);
  assert.ok(report.candidates[0].maxUvDistance > 0.5);
  assert.equal(report.candidates[0].classification,"review-candidate");
  assert.equal(report.candidates[0].repair,"none");
});

test("does not report a seam when adjacent triangles keep continuous edge UVs", () => {
  const continuous = { ...quad, uvs: [[0,0],[1,0],[1,1],[1,0],[1,1],[0,1]] };
  const report = reviewUvSeams(continuous);
  assert.equal(report.seamCandidateCount,0);
  assert.ok(report.sharedGeometricEdgeCount >= 1);
});

test("matches almost identical geometry using the relative position tolerance", () => {
  const noisy = { ...quad, positions: quad.positions.map((p,i)=>i===3?[1+1e-8,0,0]:i===4?[1,1-1e-8,0]:p) };
  const report = reviewUvSeams(noisy, { positionTolerance:1e-5 });
  assert.equal(report.seamCandidateCount,1);
});

test("rejects invalid indices, malformed UVs and invalid tolerances", () => {
  assert.throws(()=>reviewUvSeams({ ...quad, indices:[0,1,99] }),/outside/);
  assert.throws(()=>reviewUvSeams({ ...quad, uvs:[[0,0]] }),/same vertex count/);
  assert.throws(()=>reviewUvSeams(quad,{ positionTolerance:0 }),/positive finite/);
  assert.throws(()=>reviewUvSeams({ ...quad, indices:[0,1] }),/complete triangles/);
});
