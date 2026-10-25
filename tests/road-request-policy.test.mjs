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

import {
  shouldSkipFailedRoadViewportRetry,
} from "../src/core/map-engine/road-network-request-policy.mjs";

test("skips the same failed viewport while its retry cooldown is active", () => {
  assert.equal(shouldSkipFailedRoadViewportRetry("viewport-a", "viewport-a", 60_000, 12_000), true);
});

test("allows a different viewport during the previous viewport cooldown", () => {
  assert.equal(shouldSkipFailedRoadViewportRetry("viewport-b", "viewport-a", 60_000, 12_000), false);
});

test("allows retry after cooldown expires", () => {
  assert.equal(shouldSkipFailedRoadViewportRetry("viewport-a", "viewport-a", 60_000, 60_000), false);
  assert.equal(shouldSkipFailedRoadViewportRetry("viewport-a", "viewport-a", 60_000, 61_000), false);
});

test("invalid cooldown inputs fail open instead of permanently suppressing road requests", () => {
  assert.equal(shouldSkipFailedRoadViewportRetry("", "", 60_000, 12_000), false);
  assert.equal(shouldSkipFailedRoadViewportRetry("viewport-a", null, 60_000, 12_000), false);
  assert.equal(shouldSkipFailedRoadViewportRetry("viewport-a", "viewport-a", Number.NaN, 12_000), false);
  assert.equal(shouldSkipFailedRoadViewportRetry("viewport-a", "viewport-a", 60_000, Number.NaN), false);
});
