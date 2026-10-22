import assert from "node:assert/strict";
import test from "node:test";
import { flattenRoadCoordinates } from "../src/core/geospatial/flatten-road-coordinates.mjs";

test("flattens road coordinates for Cesium with the exact legacy order", () => {
  const coordinates = [[90.41, 23.72], [90.411, 23.721, 12], [90.412, 23.722]];
  assert.deepEqual(flattenRoadCoordinates(coordinates), coordinates.flatMap(([longitude, latitude]) => [longitude, latitude]));
});

test("skips malformed and out-of-range points", () => {
  assert.deepEqual(flattenRoadCoordinates([
    [90.41, 23.72], [Number.NaN, 23.721], [90.412, 95], null,
    ["90.413", 23.723], [90.414, 23.724],
  ]), [90.41, 23.72, 90.414, 23.724]);
  assert.deepEqual(flattenRoadCoordinates(null), []);
  assert.deepEqual(flattenRoadCoordinates([]), []);
});
