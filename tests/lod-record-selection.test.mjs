import assert from "node:assert/strict";
import test from "node:test";
import { selectNearestLodRecords } from "../src/core/map-engine/lod-record-selection.mjs";

function fullSortReference(records, limit) {
  return records
    .map((record, index) => ({ record, index, distance: record.distance }))
    .filter((entry) => Number.isFinite(entry.distance) && entry.distance >= 0)
    .sort((left, right) => {
      if (left.record.isPart !== right.record.isPart) return left.record.isPart ? -1 : 1;
      return left.distance - right.distance || left.index - right.index;
    })
    .slice(0, limit)
    .map((entry) => entry.record);
}

test("bounded selection matches full sort while prioritizing building parts", () => {
  const records = [
    { id: "shell-near", isPart: false, distance: 1 },
    { id: "part-far", isPart: true, distance: 80 },
    { id: "shell-far", isPart: false, distance: 50 },
    { id: "part-near", isPart: true, distance: 10 },
    { id: "part-tie-first", isPart: true, distance: 10 },
    { id: "part-tie-second", isPart: true, distance: 10 },
  ];
  assert.deepEqual(
    selectNearestLodRecords(records, 4, (record) => record.distance).map((record) => record.id),
    ["part-near", "part-tie-first", "part-tie-second", "part-far"],
  );
});

test("bounded selection matches full-sort reference over deterministic data sizes and budgets", () => {
  for (const count of [0, 1, 30, 1000, 5000]) {
    const records = Array.from({ length: count }, (_, index) => ({
      id: String(index), isPart: index % 13 === 0,
      distance: ((index * 104729) % 7919) + (index % 7) / 10,
    }));
    if (count > 4) {
      records[2].distance = Number.NaN;
      records[3].distance = -1;
    }
    for (const budget of [1, 4, 24, 80]) {
      assert.deepEqual(
        selectNearestLodRecords(records, budget, (record) => record.distance).map((record) => record.id),
        fullSortReference(records, budget).map((record) => record.id),
        `candidate count ${count}, budget ${budget}`,
      );
    }
  }
});

test("selection excludes records without finite non-negative distances", () => {
  const records = [
    { id: "valid", isPart: false, distance: 4 },
    { id: "nan", isPart: true, distance: Number.NaN },
    { id: "negative", isPart: true, distance: -1 },
    { id: "missing", isPart: false },
  ];
  assert.deepEqual(
    selectNearestLodRecords(records, 10, (record) => record.distance).map((record) => record.id),
    ["valid"],
  );
});

test("invalid limits, records and accessors fail clearly", () => {
  assert.throws(() => selectNearestLodRecords([], 0, () => 1), /positive safe integer/);
  assert.throws(() => selectNearestLodRecords([], 1.2, () => 1), /positive safe integer/);
  assert.throws(() => selectNearestLodRecords(null, 1, () => 1), /array/);
  assert.throws(() => selectNearestLodRecords([], 1, null), /accessor/);
});
