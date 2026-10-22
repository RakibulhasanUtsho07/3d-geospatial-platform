import assert from "node:assert/strict";
import test from "node:test";

import { flattenRoadCoordinates } from "../src/core/geospatial/flatten-road-coordinates.mjs";
import { selectNearestLodRecords } from "../src/core/map-engine/lod-record-selection.mjs";

test("optimization path keeps exact LOD selection parity for a large stable fixture", () => {
  const records = Array.from({ length: 5000 }, (_, index) => ({
    id: index,
    isPart: index % 17 === 0,
    distance: ((index * 104729) % 999983) / 7,
  }));
  const reference = records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      if (left.record.isPart !== right.record.isPart) return left.record.isPart ? -1 : 1;
      return left.record.distance - right.record.distance || left.index - right.index;
    })
    .slice(0, 48)
    .map(({ record }) => record.id);

  const optimized = selectNearestLodRecords(records, 48, (record) => record.distance).map((record) => record.id);
  assert.deepEqual(optimized, reference);
});

test("preallocated coordinate flattening matches flatMap for large valid road fixtures", () => {
  const coordinates = Array.from({ length: 5000 }, (_, index) => [
    90.2 + index / 1_000_000,
    23.6 + index / 1_000_000,
  ]);
  assert.deepEqual(flattenRoadCoordinates(coordinates), coordinates.flatMap(([lon, lat]) => [lon, lat]));
});
