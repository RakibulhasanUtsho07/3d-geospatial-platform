import assert from "node:assert/strict";
import test from "node:test";

import { resolveBuildingHeight } from "../src/core/buildings/building-height.mjs";
import { resolveRenderedHeightForDisplay } from "../src/core/buildings/rendered-height-display.mjs";

test("prefers explicit source height and preserves its provenance", () => {
  assert.deepEqual(
    resolveBuildingHeight({ height: 18.5, num_floors: 10, min_height: 2 }),
    {
      meters: 18.5,
      baseHeight: 2,
      baseHeightSource: "overture-min-height",
      baseHeightEstimated: false,
      reportedMinHeight: 2,
      reportedMinFloor: null,
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
      baseHeightSource: "ground-zero-default",
      baseHeightEstimated: false,
      reportedMinHeight: null,
      reportedMinFloor: null,
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
      baseHeightSource: "overture-min-height",
      baseHeightEstimated: false,
      reportedMinHeight: 1.2,
      reportedMinFloor: null,
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
      baseHeightSource: "ground-zero-default",
      baseHeightEstimated: false,
      reportedMinHeight: null,
      reportedMinFloor: null,
      source: "fallback-estimate",
      unclampedMeters: 9,
      heightWasClamped: false,
      unclampedBaseHeight: 0,
      baseHeightWasClamped: false,
    },
  );
});

test("uses min_floor only as a labelled base-height estimate when min_height is absent", () => {
  const estimated = resolveBuildingHeight({ height: 18, min_floor: 2 });
  assert.equal(estimated.baseHeight, 6);
  assert.equal(estimated.baseHeightSource, "min-floor-estimate");
  assert.equal(estimated.baseHeightEstimated, true);
  assert.equal(estimated.reportedMinHeight, null);
  assert.equal(estimated.reportedMinFloor, 2);
  assert.equal(estimated.unclampedBaseHeight, 6);

  const explicitMinHeightWins = resolveBuildingHeight({ height: 18, min_height: 2, min_floor: 3 });
  assert.equal(explicitMinHeightWins.baseHeight, 2);
  assert.equal(explicitMinHeightWins.baseHeightSource, "overture-min-height");
  assert.equal(explicitMinHeightWins.baseHeightEstimated, false);
  assert.equal(explicitMinHeightWins.reportedMinFloor, 3);

  const invalidFractionalFloor = resolveBuildingHeight({ min_floor: 1.5 });
  assert.equal(invalidFractionalFloor.baseHeight, 0);
  assert.equal(invalidFractionalFloor.baseHeightSource, "ground-zero-default");
  assert.equal(invalidFractionalFloor.reportedMinFloor, null);

  const clampedFloor = resolveBuildingHeight({ height: 18, min_floor: 40 });
  assert.equal(clampedFloor.baseHeight, 100);
  assert.equal(clampedFloor.unclampedBaseHeight, 120);
  assert.equal(clampedFloor.baseHeightWasClamped, true);
  assert.equal(clampedFloor.baseHeightEstimated, true);
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


test("rendered height wins over source and reported attributes regardless of object key order", () => {
  assert.equal(
    resolveRenderedHeightForDisplay({
      height: 450,
      architecture_profile_reported_height_m: 480,
      rendered_height_m: 300,
    }),
    300,
  );
});

test("fallback source heights use the renderer's safety limits", () => {
  assert.equal(resolveRenderedHeightForDisplay({ height: 450 }), 300);
  assert.equal(resolveRenderedHeightForDisplay({ height: 1.5 }), 3);
});

test("unsafe reference reports do not masquerade as rendered heights", () => {
  assert.equal(
    resolveRenderedHeightForDisplay({
      architecture_profile_reported_height_m: 450,
      height: 42,
    }),
    42,
  );
  assert.equal(
    resolveRenderedHeightForDisplay({
      architecture_profile_reported_floor_count: 101,
      levels: 4,
    }),
    12,
  );
});

test("valid reference reports are usable only when no actual rendered height is supplied", () => {
  assert.equal(
    resolveRenderedHeightForDisplay({
      architecture_profile_reported_height_m: 27.5,
    }),
    27.5,
  );
  assert.equal(
    resolveRenderedHeightForDisplay({
      architecture_profile_reported_floor_count: 8,
    }),
    24,
  );
  assert.equal(resolveRenderedHeightForDisplay({}), null);
});

test("rejects partially numeric strings instead of parsing unit-suffixed values", () => {
  const invalidHeight = resolveBuildingHeight({ height: "18.5m" });
  assert.equal(invalidHeight.source, "fallback-estimate");
  assert.equal(invalidHeight.meters, 9);

  const validFloorFallback = resolveBuildingHeight({ height_m: "18.5 metres", num_floors: "4" });
  assert.equal(validFloorFallback.source, "floor-estimate");
  assert.equal(validFloorFallback.meters, 12);

  const invalidMinHeight = resolveBuildingHeight({ height: 20, min_height: "1.2m" });
  assert.equal(invalidMinHeight.baseHeight, 0);
  assert.equal(invalidMinHeight.unclampedBaseHeight, 0);
});
