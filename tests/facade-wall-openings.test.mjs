import assert from "node:assert/strict";
import test from "node:test";
import {
  addExtrudedFacadeProfile,
  createFacadeOpeningProfile,
} from "../src/core/building-generation/facade-wall-openings.mjs";

function signedArea(profile) {
  return profile.reduce((sum, point, index) => {
    const next = profile[(index + 1) % profile.length];
    return sum + point.u * next.y - next.u * point.y;
  }, 0) / 2;
}

function createGeometrySpy() {
  const quads = [];
  return {
    quads,
    geo: {
      quad(...args) {
        quads.push(args);
      },
    },
  };
}

const edge = {
  p: { x: 0, z: 0 },
  tangent: { x: 1, z: 0 },
  out: { x: 0, z: -1 },
};

test("creates deterministic rectangular and arched facade opening profiles", () => {
  const rectangle = createFacadeOpeningProfile({
    centerU: 4,
    bottomM: 1,
    widthM: 2,
    heightM: 3,
  });
  assert.deepEqual(rectangle, [
    { u: 3, y: 1 },
    { u: 5, y: 1 },
    { u: 5, y: 4 },
    { u: 3, y: 4 },
  ]);
  assert.equal(signedArea(rectangle), 6);

  const arch = createFacadeOpeningProfile({
    centerU: 4,
    bottomM: 0.5,
    widthM: 2,
    heightM: 2,
    shape: "arched",
    archSegments: 16,
  });
  assert.equal(arch.length, 19);
  assert.ok(signedArea(arch) > 3.45 && signedArea(arch) < 3.58);
  assert.ok(arch.every(({ u, y }) => Number.isFinite(u) && Number.isFinite(y)));
  assert.ok(arch.every((point) => point.u >= 3 - 1e-8 && point.u <= 5 + 1e-8));
  assert.ok(Math.abs(Math.max(...arch.map((point) => point.y)) - 2.5) < 1e-8);
});

test("rejects invalid opening dimensions, shapes and arch tessellation limits", () => {
  assert.throws(() => createFacadeOpeningProfile({
    centerU: Number.NaN, bottomM: 0, widthM: 1, heightM: 1,
  }), /finite number/);
  assert.throws(() => createFacadeOpeningProfile({
    centerU: 0, bottomM: -0.1, widthM: 1, heightM: 1,
  }), /non-negative/);
  assert.throws(() => createFacadeOpeningProfile({
    centerU: 0, bottomM: 0, widthM: 0, heightM: 1,
  }), /positive/);
  assert.throws(() => createFacadeOpeningProfile({
    centerU: 0, bottomM: 0, widthM: 1, heightM: 1, shape: "circular",
  }), /rectangular or arched/);
  assert.throws(() => createFacadeOpeningProfile({
    centerU: 0, bottomM: 0, widthM: 1, heightM: 1, shape: "arched", archSegments: 7,
  }), /between 8 and 96/);
});

test("extrudes a closed facade profile with front, back and reveal faces", () => {
  const profile = createFacadeOpeningProfile({
    centerU: 2,
    bottomM: 0,
    widthM: 3,
    heightM: 4,
  });
  const { geo, quads } = createGeometrySpy();
  const result = addExtrudedFacadeProfile(geo, {
    edge,
    baseY: 2,
    profile,
    frontDepth: 0.1,
    depthM: 0.06,
    material: "glass",
  });

  assert.equal(result.faceAreaM2, 12);
  assert.equal(result.boundaryEdgeCount, 4);
  assert.equal(quads.length, 6);
  assert.ok(quads.every((quad) => quad[0] === "glass"));
  assert.deepEqual(quads[0][1], [0.5, 2, -0.1]);
  assert.deepEqual(quads[1][1], [0.5, 2, -0.04]);
});

test("subtracts an interior frame aperture and preserves every contour reveal", () => {
  const outer = createFacadeOpeningProfile({
    centerU: 2,
    bottomM: 0,
    widthM: 4,
    heightM: 4,
  });
  const inner = createFacadeOpeningProfile({
    centerU: 2,
    bottomM: 1,
    widthM: 2,
    heightM: 2,
  });
  const { geo, quads } = createGeometrySpy();
  const result = addExtrudedFacadeProfile(geo, {
    edge,
    baseY: 0,
    profile: outer,
    holes: [inner],
    frontDepth: 0.12,
    depthM: 0.08,
    material: "frame",
  });

  assert.equal(result.faceAreaM2, 12);
  assert.equal(result.boundaryEdgeCount, 8);
  assert.equal(quads.length, 16);
  assert.ok(quads.every((quad) => quad[0] === "frame"));
});

test("rejects out-of-profile and overlapping frame apertures", () => {
  const outer = createFacadeOpeningProfile({
    centerU: 2,
    bottomM: 0,
    widthM: 4,
    heightM: 4,
  });
  const outside = createFacadeOpeningProfile({
    centerU: 4.5,
    bottomM: 1,
    widthM: 1,
    heightM: 1,
  });
  const firstHole = createFacadeOpeningProfile({
    centerU: 1.5,
    bottomM: 1,
    widthM: 2,
    heightM: 2,
  });
  const overlappingHole = createFacadeOpeningProfile({
    centerU: 2.5,
    bottomM: 1,
    widthM: 2,
    heightM: 2,
  });
  const { geo } = createGeometrySpy();
  const base = { edge, baseY: 0, profile: outer, frontDepth: 0.1, depthM: 0.05, material: "frame" };

  assert.throws(() => addExtrudedFacadeProfile(geo, { ...base, holes: [outside] }), /fully inside/);
  assert.throws(() => addExtrudedFacadeProfile(geo, { ...base, holes: [firstHole, overlappingHole] }), /must not overlap/);
  assert.throws(() => addExtrudedFacadeProfile(geo, { ...base, depthM: 0.2 }), /must be positive/);
});
