import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateFootprintAreaM2,
  SQUARE_METERS_TO_SQUARE_FEET,
} from "../src/core/geospatial/footprint-area.mjs";

function squareRing(west, south, east, north) {
  return [
    { longitude: west, latitude: south },
    { longitude: east, latitude: south },
    { longitude: east, latitude: north },
    { longitude: west, latitude: north },
    { longitude: west, latitude: south },
  ];
}

test("calculates the approximate area of a small geographic rectangle", () => {
  const area = calculateFootprintAreaM2([squareRing(0, 0, 0.001, 0.001)]);
  assert.ok(area > 12_000 && area < 12_600, `unexpected area: ${area}`);
});

test("area reflects longitude scale at Dhaka latitude", () => {
  const equatorial = calculateFootprintAreaM2([squareRing(90.4, 0, 90.401, 0.001)]);
  const dhaka = calculateFootprintAreaM2([squareRing(90.4, 23.78, 90.401, 23.781)]);
  assert.ok(dhaka < equatorial);
  assert.ok(dhaka > equatorial * 0.90);
});

test("subtracts interior holes from the exterior polygon area", () => {
  const exterior = squareRing(0, 0, 0.01, 0.01);
  const hole = squareRing(0.002, 0.002, 0.004, 0.004);
  const withHole = calculateFootprintAreaM2([exterior, hole]);
  const withoutHole = calculateFootprintAreaM2([exterior]);
  const expectedRatio = 1 - (0.002 * 0.002) / (0.01 * 0.01);
  assert.ok(Math.abs(withHole / withoutHole - expectedRatio) < 0.01);
});

test("supports closed and open rings without double-counting the final coordinate", () => {
  const closed = squareRing(90.4, 23.78, 90.401, 23.781);
  const open = closed.slice(0, -1);
  assert.equal(
    calculateFootprintAreaM2([closed]),
    calculateFootprintAreaM2([open]),
  );
});

test("returns null for invalid, degenerate, or non-positive footprints", () => {
  assert.equal(calculateFootprintAreaM2([]), null);
  assert.equal(calculateFootprintAreaM2([[{ longitude: 0, latitude: 0 }]]), null);
  assert.equal(calculateFootprintAreaM2([squareRing(0, 0, 0.001, 0.001), squareRing(-1, -1, 2, 2)]), null);
  assert.equal(calculateFootprintAreaM2([[{ longitude: 200, latitude: 0 }, { longitude: 0, latitude: 1 }, { longitude: 1, latitude: 0 }]]), null);
  assert.throws(() => calculateFootprintAreaM2(null), TypeError);
});

test("exports the square-metre to square-foot conversion factor", () => {
  assert.ok(SQUARE_METERS_TO_SQUARE_FEET > 10.76);
  assert.ok(SQUARE_METERS_TO_SQUARE_FEET < 10.77);
});
