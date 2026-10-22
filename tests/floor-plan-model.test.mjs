import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateFloorPlanGlb } from "../src/core/building-generation/floor-plan-model.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-floor-plan-geometry.json", import.meta.url), "utf8"));

function parseGlb(bytes) {
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.byteLength);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").trim());
  const binHeader = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942);
  assert.ok(gltf.buffers[0].byteLength <= bytes.readUInt32LE(binHeader));
  return gltf;
}

test("extrudes explicit room polygons, walls, doors and windows into a metric GLB candidate", () => {
  const result = generateFloorPlanGlb(fixture);
  const gltf = parseGlb(result.glb);
  assert.equal(gltf.asset.version, "2.0");
  assert.equal(gltf.asset.generator, "3D Geospatial Platform / measured-floor-plan-v1");
  assert.equal(gltf.extras.floorPlan.id, "ground-floor");
  assert.equal(gltf.extras.floorPlan.buildingId, "dhaka-demo");
  assert.equal(gltf.extras.floorPlan.units, "metres");
  assert.equal(gltf.extras.floorPlan.origin.longitude, 90.406);
  assert.equal(gltf.extras.floorPlan.origin.headingDegrees, 0);
  assert.equal(gltf.extras.floorPlan.sourceEvidence.sha256, fixture.source.sha256);
  assert.deepEqual(gltf.extras.floorPlan.summary, result.report.geometry);
  assert.equal(result.report.geometry.roomCount, 1);
  assert.equal(result.report.geometry.wallCount, 4);
  assert.equal(result.report.geometry.openingCount, 2);
  assert.equal(result.report.geometry.floorPolygonAreaSumM2, 20);
  assert.ok(result.report.geometry.triangleCount > 100);
  assert.ok(gltf.materials.some((material) => material.name === "Interior Wall"));
  assert.ok(gltf.materials.some((material) => material.name === "Floor Slab"));
  assert.ok(gltf.materials.some((material) => material.name === "Door Leaf"));
  assert.ok(gltf.materials.some((material) => material.name === "Window Glass"));
  assert.ok(gltf.materials.some((material) => material.name === "Door and Window Frame"));
  assert.equal(result.report.status, "candidate-requires-human-review");
  assert.equal(result.report.mapReady, false);
  assert.equal(result.report.publicationEligible, false);
  assert.equal(result.report.output.sha256, createHash("sha256").update(result.glb).digest("hex"));
  assert.ok(result.report.warnings.some((warning) => warning.includes("does not extract walls")));
});

test("output is deterministic for the same explicit trace", () => {
  const first = generateFloorPlanGlb(fixture);
  const second = generateFloorPlanGlb(fixture);
  assert.deepEqual(first.glb, second.glb);
  assert.equal(first.report.output.sha256, second.report.output.sha256);
});

test("rejects unsupported units, self-intersecting rooms and unmeasured geometry", () => {
  assert.throws(() => generateFloorPlanGlb({ ...fixture, units: "ft" }), /units must be 'm'/);
  const crossing = {
    ...fixture,
    rooms: [{
      ...fixture.rooms[0],
      polygon: [[0, 0], [4, 4], [0, 4], [4, 0], [5, 5]],
    }],
  };
  assert.throws(() => generateFloorPlanGlb(crossing), /self-intersects|at least 0.25/);
  assert.throws(() => generateFloorPlanGlb({ ...fixture, origin: { ...fixture.origin, headingDegrees: undefined } }), /finite number/);
  assert.throws(() => generateFloorPlanGlb({ ...fixture, source: { sourceId: "pdf", sha256: "not-a-hash" } }), /SHA-256 hash/);
});

test("rejects door/window openings outside walls, overlapping openings and invalid door sill levels", () => {
  const outside = structuredClone(fixture);
  outside.walls[0].openings[0].offsetM = 4.5;
  assert.throws(() => generateFloorPlanGlb(outside), /extends beyond its wall/);

  const overlapping = structuredClone(fixture);
  overlapping.walls[0].openings.push({
    id: "second-door",
    type: "door",
    offsetM: 1.5,
    widthM: 0.75,
    heightM: 2,
    sillHeightM: 0,
  });
  assert.throws(() => generateFloorPlanGlb(overlapping), /overlapping openings/);

  const raisedDoor = structuredClone(fixture);
  raisedDoor.walls[0].openings[0].sillHeightM = 0.2;
  assert.throws(() => generateFloorPlanGlb(raisedDoor), /must start at floor level/);
});

test("rejects duplicate IDs, negative wall lengths and out-of-range room coordinates", () => {
  const duplicate = structuredClone(fixture);
  duplicate.walls[0].id = duplicate.rooms[0].id;
  assert.throws(() => generateFloorPlanGlb(duplicate), /duplicate floor-plan identifier/);

  const zeroWall = structuredClone(fixture);
  zeroWall.walls[0].end = zeroWall.walls[0].start;
  assert.throws(() => generateFloorPlanGlb(zeroWall), /at least 0.1 metres long/);

  const outside = structuredClone(fixture);
  outside.rooms[0].polygon[1][0] = 2000;
  assert.throws(() => generateFloorPlanGlb(outside), /must be between -1000 and 1000/);
});
