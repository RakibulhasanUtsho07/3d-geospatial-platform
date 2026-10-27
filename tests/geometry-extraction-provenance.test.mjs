import assert from "node:assert/strict";
import test from "node:test";
import {
  geometryPayloadSha256,
  validateGeometryExtractionProvenance,
} from "../src/core/building-generation/geometry-extraction-provenance.mjs";

const sourceSha256 = "a".repeat(64);
const extractorSha256 = "b".repeat(64);
const configurationSha256 = "c".repeat(64);
const geometry = {
  coordinateFrameId: "site-enu-v1",
  units: "m",
  footprint: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }],
  dimensionsM: { widthM: 2, depthM: 2, heightM: 3 },
  checkPoints: [{ id: "survey-point-01", x: 0, y: 0, z: 0 }],
  surfaceMesh: null,
};
function provenance(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    extractionRunId: "site-a-run-01",
    method: "glb-position-accessor-and-reviewed-survey-adapter",
    extractedAt: "2026-10-27T08:00:00Z",
    inputArtifactSha256: sourceSha256,
    outputGeometrySha256: geometryPayloadSha256(geometry),
    coordinateFrameId: "site-enu-v1",
    units: "m",
    extractor: {
      id: "geometry-extractor",
      version: "1.2.0",
      commitSha: "1234567890abcdef1234567890abcdef12345678",
      artifactPath: "tools/geometry-extractor.mjs",
      artifactSha256: extractorSha256,
      configurationPath: "configs/extractor.json",
      configurationSha256,
    },
    ...overrides,
  };
}
function validate(record = provenance(), overrides = {}) {
  return validateGeometryExtractionProvenance({
    provenance: record,
    sourceSha256,
    geometrySha256: geometryPayloadSha256(geometry),
    coordinateFrameId: "site-enu-v1",
    units: "m",
    label: "candidate",
    ...overrides,
  });
}

test("geometry payload digest is stable under key-order changes but changes when geometry changes", () => {
  const reverseKeys = {
    surfaceMesh: null,
    checkPoints: geometry.checkPoints,
    dimensionsM: { heightM: 3, depthM: 2, widthM: 2 },
    footprint: geometry.footprint.map((point) => ({ z: point.z, x: point.x })),
    units: "m",
    coordinateFrameId: "site-enu-v1",
  };
  assert.equal(geometryPayloadSha256(geometry), geometryPayloadSha256(reverseKeys));
  const changed = structuredClone(geometry);
  changed.footprint[1].x = 2.1;
  assert.notEqual(geometryPayloadSha256(geometry), geometryPayloadSha256(changed));
});

test("accepts a complete provenance declaration tied to the expected input and geometry digest", () => {
  const result = validate();
  assert.equal(result.status, "passed");
  assert.ok(result.checks.every((check) => check.status === "passed"));
});

test("fails when the geometry payload digest or input artifact SHA-256 is stale", () => {
  const changedGeometry = provenance({ outputGeometrySha256: "d".repeat(64) });
  const changedInput = provenance({ inputArtifactSha256: "e".repeat(64) });
  assert.equal(validate(changedGeometry).status, "failed");
  assert.ok(validate(changedGeometry).checks.some((check) => check.id === "candidate-extraction-output-binding" && check.status === "failed"));
  assert.equal(validate(changedInput).status, "failed");
  assert.ok(validate(changedInput).checks.some((check) => check.id === "candidate-extraction-input-binding" && check.status === "failed"));
});

test("keeps missing provenance incomplete and rejects malformed or mismatched coordinate frames", () => {
  assert.equal(validateGeometryExtractionProvenance({
    provenance: null, sourceSha256, geometrySha256: geometryPayloadSha256(geometry),
    coordinateFrameId: "site-enu-v1", units: "m", label: "candidate",
  }).status, "incomplete");
  assert.equal(validate(provenance({ coordinateFrameId: "other-frame" })).status, "failed");
  assert.equal(validate(provenance({ extractor: { id: "bad/path" } })).status, "failed");
});
