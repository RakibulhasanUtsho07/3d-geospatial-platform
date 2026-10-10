import assert from "node:assert/strict";
import test from "node:test";

import { getDetailedFacadeBudget } from "../src/core/map-engine/lod-detail-budget.mjs";

const cases = [
  [100_000, 0],
  [25_000, 0],
  [24_999, 80],
  [12_000, 80],
  [11_999, 220],
  [6_000, 220],
  [5_999, 420],
  [2_500, 420],
  [2_499, 650],
  [0, 650],
  [-1, 650],
  [Number.NaN, 650],
  [Number.POSITIVE_INFINITY, 650],
];

for (const [height, expectedBudget] of cases) {
  test(
    `camera altitude ${String(height)}m uses a ${expectedBudget}-facade detail budget`,
    () => {
      assert.equal(getDetailedFacadeBudget(height), expectedBudget);
    },
  );
}

test("detail budget never exceeds the maximum facade count", () => {
  for (let height = 0; height <= 50_000; height += 137) {
    const budget = getDetailedFacadeBudget(height);
    assert.ok(budget >= 0 && budget <= 650);
  }
});
