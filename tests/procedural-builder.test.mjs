import assert from "node:assert/strict";
import test from "node:test";

import { generateParametricBuildingGlb } from "../src/core/building-generation/procedural-builder.mjs";

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: "glb-test-1",
    quality: "parametric-facade",
    allowExternalProviderProcessing: false,
    references: [],
    building: {
      name: "Test Apartment",
      buildingType: "apartment",
      dimensions: { aboveGroundFloors: 5, floorToFloorHeightMeters: 3, totalHeightMeters: 15 },
      footprint: { widthMeters: 18, depthMeters: 12 },
      architecturalStyle: "modern",
      facadeColours: ["#e8e0d3"],
      frontAzimuthDegrees: 180,
      roofType: "flat",
      ...overrides,
    },
  };
}

function readGlbJson(glb) {
  assert.equal(glb.toString("ascii", 0, 4), "glTF");
  assert.equal(glb.readUInt32LE(4), 2);
  assert.equal(glb.readUInt32LE(8), glb.length);
  const jsonLength = glb.readUInt32LE(12);
  assert.equal(glb.readUInt32LE(16), 0x4e4f534a);
  return JSON.parse(glb.toString("utf8", 20, 20 + jsonLength).trim());
}

test("generates a valid binary glTF 2.0 asset with named building metadata", () => {
  const result = generateParametricBuildingGlb(request());
  assert.ok(result.glb.length > 2000);
  const json = readGlbJson(result.glb);
  assert.equal(json.asset.version, "2.0");
  assert.equal(json.nodes[0].name, "Test Apartment · procedural base");
  assert.ok(json.meshes[0].primitives.length >= 3);
  assert.ok(json.accessors.length > 0);
  assert.equal(json.extras.totalHeightMeters, 15);
  assert.equal(json.extras.floors, 5);
  assert.equal(result.metadata.footprintWidthMeters, 18);
  assert.equal(result.metadata.footprintDepthMeters, 12);
});

test("derives an estimated floor count from height only and reports the assumption", () => {
  const result = generateParametricBuildingGlb(request({
    dimensions: { totalHeightMeters: 16 },
  }));
  assert.equal(result.metadata.floorCount, 5);
  assert.ok(result.metadata.warnings.some((warning) => warning.includes("estimated")));
});

test("supports simple concave footprints through polygon triangulation", () => {
  const result = generateParametricBuildingGlb(request({
    footprint: { polygonXYMeters: [[0, 0], [12, 0], [12, 4], [5, 4], [5, 10], [0, 10]] },
  }));
  const json = readGlbJson(result.glb);
  assert.equal(json.extras.footprintWidthMeters, 12);
  assert.equal(json.extras.footprintDepthMeters, 10);
});

test("rejects self-intersecting, degenerate or missing dimensions", () => {
  assert.throws(() => generateParametricBuildingGlb(request({
    footprint: { polygonXYMeters: [[0, 0], [10, 10], [0, 10], [10, 0]] },
  })), /area|self-intersects|degenerate/i);
  assert.throws(() => generateParametricBuildingGlb(request({
    dimensions: {},
  })), /totalHeightMeters|floorToFloorHeightMeters/i);
  assert.throws(() => generateParametricBuildingGlb(request({
    footprint: undefined,
  })), /footprint/i);
});
