import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldCancelRoadRequestForCachedViewport,
} from "../src/core/map-engine/road-network-request-policy.mjs";

test("cached road coverage cancels an in-flight request for another viewport", () => {
  assert.equal(shouldCancelRoadRequestForCachedViewport(true, true), true);
});

test("cached road coverage needs no cancellation when no request is active", () => {
  assert.equal(shouldCancelRoadRequestForCachedViewport(true, false), false);
});

test("an uncovered viewport must keep loading the requested road data", () => {
  assert.equal(shouldCancelRoadRequestForCachedViewport(false, true), false);
});

test("non-boolean policy inputs fail closed", () => {
  assert.equal(shouldCancelRoadRequestForCachedViewport(1, true), false);
  assert.equal(shouldCancelRoadRequestForCachedViewport(true, 1), false);
});
