import assert from "node:assert/strict";
import test from "node:test";

import { resolveBuildingHeight } from "../src/core/buildings/building-height.mjs";

test("prefers explicit source height and preserves its provenance", () => {
  assert.deepEqual(
    resolveBuildingHeight({ height: 18.5, num_floors: 10, min_height: 2 }),
    { meters: 18.5, baseHeight: 2, source: "overture-height" },
  );
});

test("accepts the documented source-height aliases and numeric strings", () => {
  assert.deepEqual(
    resolveBuildingHeight({ height_m: "24.5", heightMeters: 12 }),
    { meters: 24.5, baseHeight: 0, source: "overture-height" },
  );
  assert.deepEqual(
    resolveBuildingHeight({ heightMeters: 14 }),
    { meters: 14, baseHeight: 0, source: "overture-height" },
  );
});

test("uses a labelled floor estimate when explicit height is absent", () => {
  assert.deepEqual(
    resolveBuildingHeight({ num_floors: 4, min_height: "1.2" }),
    { meters: 12, baseHeight: 1.2, source: "floor-estimate" },
  );
  assert.deepEqual(
    resolveBuildingHeight({ "building:levels": "5" }),
    { meters: 15, baseHeight: 0, source: "floor-estimate" },
  );
  assert.deepEqual(
    resolveBuildingHeight({ levels: 2 }),
    { meters: 6, baseHeight: 0, source: "floor-estimate" },
  );
});

test("uses an explicitly labelled fallback estimate when source height and floors are missing", () => {
  assert.deepEqual(
    resolveBuildingHeight({ building: "yes" }),
    { meters: 9, baseHeight: 0, source: "fallback-estimate" },
  );
});

test("clamps extreme height inputs and records the correct provenance", () => {
  assert.deepEqual(
    resolveBuildingHeight({ height: 1.5, min_height: 2 }),
    { meters: 3, baseHeight: 2, source: "overture-height" },
  );
  assert.deepEqual(
    resolveBuildingHeight({ height: 450, min_height: 250 }),
    { meters: 300, baseHeight: 100, source: "overture-height" },
  );
  assert.deepEqual(
    resolveBuildingHeight({ num_floors: 120 }),
    { meters: 300, baseHeight: 0, source: "floor-estimate" },
  );
});

test("ignores non-positive heights and floors instead of treating them as measurements", () => {
  assert.deepEqual(
    resolveBuildingHeight({ height: 0, num_floors: -2 }),
    { meters: 9, baseHeight: 0, source: "fallback-estimate" },
  );
  assert.deepEqual(
    resolveBuildingHeight({ height: -4, levels: 2 }),
    { meters: 6, baseHeight: 0, source: "floor-estimate" },
  );
});

test("rejects malformed property containers", () => {
  assert.throws(() => resolveBuildingHeight(null), TypeError);
  assert.throws(() => resolveBuildingHeight([]), TypeError);
});
