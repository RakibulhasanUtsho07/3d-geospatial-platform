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


function parseGlbJson(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x46546c67);
  assert.equal(buffer.readUInt32LE(4), 2);
  assert.equal(buffer.readUInt32LE(8), buffer.byteLength);
  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.readUInt32LE(16), 0x4e4f534a);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8").trim());
}

test("Bangabhaban selects its estimated south facade and centers the dome on the footprint bounds", () => {
  const result = generateBuildingModel(spec);
  assert.equal(result.normalizedSpec.architecture.frontFacingAzimuthDegrees, 180);
  assert.equal(result.normalizedSpec.architecture.centralDome.anchor, "footprint-bounds-center");
  assert.equal(result.report.facadeSelection.method, "azimuth-nearest-edge");
  assert.equal(result.report.facadeSelection.requestedAzimuthDegrees, 180);
  assert.equal(result.report.facadeSelection.actualAzimuthDegrees, 180);
  assert.equal(result.report.architecturePlacement.centralDome.anchor, "footprint-bounds-center");
  assert.ok(Math.abs(result.report.architecturePlacement.centralDome.centerModelMeters.x) < 0.05);
  assert.ok(Math.abs(result.report.architecturePlacement.centralDome.centerModelMeters.z) < 0.05);
  assert.equal(result.report.architecturePlacement.centralDome.evidenceConfidence, "estimated");
  const gltf = parseGlbJson(result.glb);
  assert.equal(gltf.extras.building.frontFacingAzimuthDegrees, 180);
  assert.equal(gltf.extras.building.frontAxisConfidence, "operator-specified");
  assert.equal(gltf.extras.building.frontAxisSource, "buildingSpec.architecture.frontFacingAzimuthDegrees");
  assert.equal(gltf.extras.building.coordinateFrame, "x-east,y-up,z-north");
});

test("rejects ambiguous facade selectors and unsupported central-dome anchors", () => {
  const ambiguous = {
    ...spec,
    architecture: { ...spec.architecture, frontFacadeEdgeIndex: 0, frontFacingAzimuthDegrees: 180 },
  };
  assert.throws(() => generateBuildingModel(ambiguous), /specify either frontFacadeEdgeIndex or frontFacingAzimuthDegrees/);
  const invalidAnchor = {
    ...spec,
    architecture: { ...spec.architecture, centralDome: { ...spec.architecture.centralDome, anchor: "guess-a-location" } },
  };
  assert.throws(() => generateBuildingModel(invalidAnchor), /unsupported centralDome.anchor/);
  const invalidBearing = {
    ...spec,
    architecture: { ...spec.architecture, frontFacingAzimuthDegrees: 361 },
  };
  assert.throws(() => generateBuildingModel(invalidBearing), /frontFacingAzimuthDegrees must be between 0 and 360/);
});
