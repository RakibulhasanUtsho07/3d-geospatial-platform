import assert from "node:assert/strict";
import test from "node:test";

import { resolveBuildingHeight } from "../src/core/buildings/building-height.mjs";

test("prefers explicit source height and preserves its provenance", () => {
  assert.deepEqual(
    resolveBuildingHeight({ height: 18.5, num_floors: 10, min_height: 2 }),
    {
      meters: 18.5,
      baseHeight: 2,
      source: "overture-height",
      unclampedMeters: 18.5,
      heightWasClamped: false,
      unclampedBaseHeight: 2,
      baseHeightWasClamped: false,
    },
  );
});

test("accepts the documented source-height aliases and numeric strings", () => {
  assert.deepEqual(
    resolveBuildingHeight({ height_m: "24.5", heightMeters: 12 }),
    {
      meters: 24.5,
      baseHeight: 0,
      source: "overture-height",
      unclampedMeters: 24.5,
      heightWasClamped: false,
      unclampedBaseHeight: 0,
      baseHeightWasClamped: false,
    },
  );
  assert.equal(resolveBuildingHeight({ heightMeters: 14 }).meters, 14);
  assert.equal(resolveBuildingHeight({ heightMeters: 14 }).source, "overture-height");
});

test("uses a labelled floor estimate when explicit height is absent", () => {
  assert.deepEqual(
    resolveBuildingHeight({ num_floors: 4, min_height: "1.2" }),
    {
      meters: 12,
      baseHeight: 1.2,
      source: "floor-estimate",
      unclampedMeters: 12,
      heightWasClamped: false,
      unclampedBaseHeight: 1.2,
      baseHeightWasClamped: false,
    },
  );
  const levels = resolveBuildingHeight({ "building:levels": "5" });
  assert.equal(levels.meters, 15);
  assert.equal(levels.source, "floor-estimate");
  assert.equal(resolveBuildingHeight({ levels: 2 }).meters, 6);
});

test("uses an explicitly labelled fallback estimate when source height and floors are missing", () => {
  assert.deepEqual(
    resolveBuildingHeight({ building: "yes" }),
    {
      meters: 9,
      baseHeight: 0,
      source: "fallback-estimate",
      unclampedMeters: 9,
      heightWasClamped: false,
      unclampedBaseHeight: 0,
      baseHeightWasClamped: false,
    },
  );
});

test("discloses when source height is capped to renderer-safe limits", () => {
  const lower = resolveBuildingHeight({ height: 1.5, min_height: 2 });
  assert.equal(lower.meters, 3);
  assert.equal(lower.unclampedMeters, 1.5);
  assert.equal(lower.heightWasClamped, true);
  assert.equal(lower.source, "overture-height");

  const upper = resolveBuildingHeight({ height: 450, min_height: 250 });
  assert.equal(upper.meters, 300);
  assert.equal(upper.unclampedMeters, 450);
  assert.equal(upper.heightWasClamped, true);
  assert.equal(upper.baseHeight, 100);
  assert.equal(upper.unclampedBaseHeight, 250);
  assert.equal(upper.baseHeightWasClamped, true);
});

test("discloses when a floor-derived estimate is capped", () => {
  const result = resolveBuildingHeight({ num_floors: 120 });
  assert.equal(result.meters, 300);
  assert.equal(result.unclampedMeters, 360);
  assert.equal(result.heightWasClamped, true);
  assert.equal(result.source, "floor-estimate");
});

test("ignores non-positive heights and floors instead of treating them as measurements", () => {
  const none = resolveBuildingHeight({ height: 0, num_floors: -2 });
  assert.equal(none.meters, 9);
  assert.equal(none.source, "fallback-estimate");

  const floors = resolveBuildingHeight({ height: -4, levels: 2 });
  assert.equal(floors.meters, 6);
  assert.equal(floors.source, "floor-estimate");
});

test("rejects malformed property containers", () => {
  assert.throws(() => resolveBuildingHeight(null), TypeError);
  assert.throws(() => resolveBuildingHeight([]), TypeError);
});
