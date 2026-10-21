import assert from "node:assert/strict";
import test from "node:test";

import { getViewportFeatureLimit } from "../src/core/map-engine/viewport-budget.mjs";

const altitudeCases = [
  [50_000, 500],
  [25_000, 500],
  [24_999, 900],
  [12_000, 900],
  [11_999, 1_400],
  [6_000, 1_400],
  [5_999, 2_000],
  [2_500, 2_000],
  [2_499, 3_000],
  [0, 3_000],
  [-500, 3_000],
  [Number.NaN, 3_000],
  [Number.POSITIVE_INFINITY, 3_000],
];

for (const [height, expectedLimit] of altitudeCases) {
  test(
    `camera altitude ${String(height)}m selects a ${expectedLimit}-feature budget`,
    () => {
      assert.equal(
        getViewportFeatureLimit(height),
        expectedLimit,
      );
    },
  );
}
