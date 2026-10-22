import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldContinueMapInitialization,
} from "../src/core/map-engine/map-initialization-policy.mjs";

test("the current initialization may continue after the Cesium import resolves", () => {
  assert.equal(shouldContinueMapInitialization(1, 1), true);
});

test("destroying the engine invalidates the waiting initialization", () => {
  assert.equal(shouldContinueMapInitialization(1, 2), false);
});

test("a later overlapping initialization supersedes the earlier attempt", () => {
  assert.equal(shouldContinueMapInitialization(3, 4), false);
});

test("an older completion cannot replace a newer initialization", () => {
  assert.equal(shouldContinueMapInitialization(4, 5), false);
});

test("zero, negative and non-integer revisions fail closed", () => {
  for (const [requestRevision, currentRevision] of [
    [0, 0],
    [-1, 1],
    [1, 0],
    [1.5, 1.5],
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
  ]) {
    assert.equal(
      shouldContinueMapInitialization(requestRevision, currentRevision),
      false,
    );
  }
});
