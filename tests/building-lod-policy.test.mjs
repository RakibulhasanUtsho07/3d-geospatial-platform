import assert from "node:assert/strict";
import test from "node:test";

import {
  selectDetailedBuildingRecords,
  shouldRecomputeBuildingLod,
} from "../src/core/map-engine/building-lod-policy.mjs";

function record(id, distance, { isPart = false, renderable = true } = {}) {
  return {
    id,
    distance,
    isPart,
    center: renderable ? { id: `${id}-center` } : null,
    wallPositions: renderable ? [{ id: `${id}-wall` }] : null,
  };
}

test("LOD refresh only runs for forced updates, camera movement, or budget changes", () => {
  assert.equal(shouldRecomputeBuildingLod({
    force: false, originMoved: false, previousBudget: 10, detailBudget: 10,
  }), false);
  assert.equal(shouldRecomputeBuildingLod({
    force: true, originMoved: false, previousBudget: 10, detailBudget: 10,
  }), true);
  assert.equal(shouldRecomputeBuildingLod({
    force: false, originMoved: true, previousBudget: 10, detailBudget: 10,
  }), true);
  assert.equal(shouldRecomputeBuildingLod({
    force: false, originMoved: false, previousBudget: 10, detailBudget: 11,
  }), true);
  assert.equal(shouldRecomputeBuildingLod({
    force: false, originMoved: false, previousBudget: null, detailBudget: 0,
  }), true);
});

test("LOD scheduler accepts a zero-detail budget for distant city views", () => {
  assert.equal(shouldRecomputeBuildingLod({
    originMoved: false, previousBudget: 0, detailBudget: 0,
  }), false);
  assert.throws(() => shouldRecomputeBuildingLod({
    previousBudget: 10, detailBudget: -1,
  }), /non-negative safe integer/);
  assert.throws(() => shouldRecomputeBuildingLod({
    previousBudget: 10, detailBudget: Number.NaN,
  }), /non-negative safe integer/);
});

test("detail selection remains bounded and uses the nearest-record policy", () => {
  const records = [
    record("near-shell", 1),
    record("near-part", 10, { isPart: true }),
    record("far-part", 80, { isPart: true }),
    record("middle-shell", 30),
  ];

  const selected = selectDetailedBuildingRecords(records, 2, (entry) => entry.distance);

  assert.deepEqual([...selected].map((entry) => entry.id), ["near-part", "far-part"]);
  assert.equal(selected.size, 2);
});

test("selected renderable building remains detailed outside the camera budget", () => {
  const near = record("near", 1);
  const selected = record("selected-far", 100);
  const unrenderableSelected = record("unrenderable", 200, { renderable: false });

  const desired = selectDetailedBuildingRecords(
    [near, selected, unrenderableSelected],
    1,
    (entry) => entry.distance,
    selected,
  );

  assert.deepEqual([...desired].map((entry) => entry.id), ["near", "selected-far"]);

  const withoutSelected = selectDetailedBuildingRecords(
    [near, unrenderableSelected],
    1,
    (entry) => entry.distance,
    unrenderableSelected,
  );
  assert.deepEqual([...withoutSelected].map((entry) => entry.id), ["near"]);
});

test("zero detail budget keeps only the selected renderable building", () => {
  const near = record("near", 1);
  const selected = record("selected", 100);

  assert.deepEqual(
    [...selectDetailedBuildingRecords(
      [near, selected],
      0,
      (entry) => entry.distance,
      selected,
    )].map((entry) => entry.id),
    ["selected"],
  );
  assert.equal(
    selectDetailedBuildingRecords([near], 0, (entry) => entry.distance).size,
    0,
  );
});

test("selection policy validates budgets, records and distance accessor", () => {
  const records = [record("one", 1)];

  assert.throws(() => selectDetailedBuildingRecords(records, -1, () => 1), /non-negative safe integer/);
  assert.throws(() => selectDetailedBuildingRecords(records, 1.5, () => 1), /non-negative safe integer/);
  assert.throws(() => selectDetailedBuildingRecords(null, 1, () => 1), /array/);
  assert.throws(() => selectDetailedBuildingRecords(records, 1, null), /accessor/);
});
