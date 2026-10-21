import assert from "node:assert/strict";
import test from "node:test";
import { assessTextureBakeReadiness } from "../src/core/building-generation/texture-bake-readiness.mjs";

const candidate = () => ({
  images: [{ id: "front", sha256: "a".repeat(64), width: 1600, height: 1200, verifiedSource: true }],
  materials: [{ id: "stone", name: "Reviewed stone facade", reviewed: true }],
  faces: [{ uv: [[0,0],[1,0],[0.5,1]], sourceImageId: "front", materialId: "stone" }],
});

test("accepts complete reviewed inputs but does not claim a texture was generated", () => {
  const result = assessTextureBakeReadiness(candidate());
  assert.equal(result.status, "bake-inputs-ready-for-external-baker");
  assert.deepEqual(result.eligibleFaceIndices, [0]);
  assert.equal(result.policy.rasterTextureGenerated, false);
  assert.equal(result.publicationEligible, false);
});

test("blocks unreviewed material and unverified image", () => {
  const input = candidate();
  input.images[0].verifiedSource = false;
  input.materials[0].reviewed = false;
  const result = assessTextureBakeReadiness(input);
  assert.ok(result.faceIssues[0].reasons.includes("source-image-not-verified"));
  assert.ok(result.faceIssues[0].reasons.includes("material-not-reviewed"));
});

test("reports UV bounding-box overlaps as candidates, not proven intersections", () => {
  const input = candidate();
  input.faces.push({ uv: [[0.2,0.2],[0.8,0.2],[0.5,0.8]], sourceImageId: "front", materialId: "stone" });
  const result = assessTextureBakeReadiness(input);
  assert.equal(result.overlapCandidates.length, 1);
  assert.equal(result.overlapCandidates[0].requiresExactTriangleIntersectionCheck, true);
  assert.ok(result.blockers.includes("uv-overlap-candidates-require-review"));
});

test("rejects invalid atlas sizes and missing face input", () => {
  assert.throws(() => assessTextureBakeReadiness(candidate(), { atlasWidth: 0 }), /positive integers/);
  assert.ok(assessTextureBakeReadiness({ images: [], materials: [], faces: [] }).blockers.includes("no-faces-to-bake"));
});
