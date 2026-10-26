import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateBuildingModel } from "../src/core/building-generation/generation-engine.mjs";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";

const spec = JSON.parse(await readFile(new URL("../data/heritage/bangabhaban-building-spec.json", import.meta.url), "utf8"));

test("Bangabhaban spec keeps non-survey inputs explicitly estimated", () => {
  const result = generateBuildingModel(spec);
  assert.equal(result.normalizedSpec.id, "bangabhaban-dhaka");
  assert.equal(result.normalizedSpec.architecture.centralDome.enabled, true);
  assert.equal(result.normalizedSpec.architecture.frontArcade.enabled, true);
  assert.ok(result.normalizedSpec.evidence.some((e) => e.field === "footprint" && e.confidence === "estimated"));
  assert.equal(result.report.reviewRequired, true);
});

test("engine emits a structurally parseable dome-and-arcade GLB candidate", () => {
  const result = generateBuildingModel(spec);
  assert.ok(Buffer.isBuffer(result.glb));
  assert.ok(result.glb.length > 20_000);
  const qa = analyzeGlbQuality(result.glb);
  assert.equal(qa.valid, true);
  assert.ok(qa.counts.triangleCount > 0);
  assert.equal(qa.counts.degenerateTriangleCount, 0, "dome apex must not emit degenerate triangles");
  assert.ok(qa.counts.meshCount >= 4);
  assert.ok(qa.counts.vertexCount > 100);
  assert.ok(qa.bounds.dimensions.every((value) => Number.isFinite(value) && value > 0));
  assert.equal(result.report.reviewRequired, true);
});

test("saved Bangabhaban candidate report cannot silently authorize map publication", async () => {
  const report = JSON.parse(await readFile(new URL("../data/heritage/generated/bangabhaban-candidate.report.json", import.meta.url), "utf8"));
  assert.equal(report.status, "candidate-generated-review-required");
  assert.equal(report.gates.mapReady, false);
  assert.equal(report.gates.publicationEligible, false);
  assert.equal(report.gates.humanReviewRequired, true);
  assert.equal(report.building.footprint.geometryStatus, "estimated-rectangle-not-survey-traced");
  assert.match(report.model.sha256, /^[a-f0-9]{64}$/);
});
