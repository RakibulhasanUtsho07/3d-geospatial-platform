import assert from "node:assert/strict";
import test from "node:test";

import { selectViewportFeatures } from "../src/core/geospatial/select-viewport-features.mjs";

const viewport = {
  west: 0,
  south: 0,
  east: 1,
  north: 1,
};

function makeFeature(id, longitude, latitude, role = "building") {
  return {
    id,
    role,
    bounds: {
      west: longitude,
      south: latitude,
      east: longitude,
      north: latitude,
    },
  };
}

function select(features, limit) {
  return selectViewportFeatures(
    features,
    viewport,
    limit,
    (feature) => feature.bounds,
    (feature) => feature.role,
  );
}

test("returns the complete feature list unchanged when it fits the budget", () => {
  const features = [
    makeFeature("first", 0.1, 0.1),
    makeFeature("second", 0.8, 0.8),
  ];

  const result = select(features, 2);

  assert.strictEqual(result, features);
  assert.deepEqual(result.map((feature) => feature.id), ["first", "second"]);
});

test("enforces the requested upper bound when candidates exceed the budget", () => {
  const features = Array.from({ length: 100 }, (_, index) =>
    makeFeature(
      `feature-${index}`,
      ((index % 10) + 0.5) / 10,
      (Math.floor(index / 10) + 0.5) / 10,
    ),
  );

  assert.equal(select(features, 17).length, 17);
});

test("round-robin grid selection spreads candidates across occupied cells", () => {
  const features = [];

  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      for (let copy = 0; copy < 4; copy += 1) {
        features.push(
          makeFeature(
            `r${row}-c${column}-${copy}`,
            (column + 0.5 + (copy - 1.5) * 0.01) / 4,
            (row + 0.5 + (copy - 1.5) * 0.01) / 4,
          ),
        );
      }
    }
  }

  const selected = select(features, 16);
  const occupiedCells = new Set(
    selected.map((feature) => {
      const column = Math.min(3, Math.floor(feature.bounds.west * 4));
      const row = Math.min(3, Math.floor(feature.bounds.south * 4));
      return row * 4 + column;
    }),
  );

  assert.equal(selected.length, 16);
  assert.equal(
    occupiedCells.size,
    16,
    "first selection pass should represent every occupied grid cell",
  );
});

test("prefers building parts, then buildings, before other roles within a cell", () => {
  const features = [
    makeFeature("other", 0.1, 0.5, "unknown"),
    makeFeature("building", 0.1, 0.5, "building"),
    makeFeature("part", 0.1, 0.5, "building_part"),
  ];

  assert.deepEqual(
    select(features, 2).map((feature) => feature.id),
    ["part", "building"],
  );
});

test("sampling is deterministic and does not reorder the source candidates", () => {
  const features = Array.from({ length: 36 }, (_, index) =>
    makeFeature(
      `feature-${index}`,
      ((index * 7) % 36 + 0.5) / 36,
      ((index * 11) % 36 + 0.5) / 36,
    ),
  );
  const originalOrder = features.map((feature) => feature.id);

  const first = select(features, 12);
  const second = select(features, 12);

  assert.deepEqual(first, second);
  assert.deepEqual(
    features.map((feature) => feature.id),
    originalOrder,
  );
});

test("skips candidates without valid geometry bounds instead of crashing", () => {
  const features = [
    { id: "invalid", role: "building", bounds: null },
    makeFeature("west", 0.1, 0.1),
    makeFeature("east", 0.9, 0.9),
  ];

  assert.deepEqual(
    select(features, 2).map((feature) => feature.id).sort(),
    ["east", "west"],
  );
});

test("rejects invalid feature limits and degenerate viewport bounds", () => {
  const features = [makeFeature("feature", 0.5, 0.5)];

  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => selectViewportFeatures(
        features,
        viewport,
        limit,
        (feature) => feature.bounds,
        (feature) => feature.role,
      ),
      RangeError,
      `limit ${String(limit)} should be rejected`,
    );
  }

  assert.throws(
    () => selectViewportFeatures(
      features,
      { west: 0, south: 0, east: 0, north: 1 },
      1,
      (feature) => feature.bounds,
      (feature) => feature.role,
    ),
    RangeError,
  );
});
