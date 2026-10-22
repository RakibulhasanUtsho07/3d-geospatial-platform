import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldAbortViewportRequest,
  shouldLoadFullDatasetForWideViewport,
} from "../src/core/map-engine/viewport-load-policy.mjs";

test("no active request means there is nothing to abort", () => {
  assert.equal(shouldAbortViewportRequest(null, "/viewport?a=1"), false);
});

test("same viewport endpoint keeps the active request alive", () => {
  assert.equal(
    shouldAbortViewportRequest("/viewport?a=1", "/viewport?a=1"),
    false,
  );
});

test("a different viewport endpoint makes the active request obsolete", () => {
  assert.equal(
    shouldAbortViewportRequest("/viewport?a=1", "/viewport?a=2"),
    true,
  );
});

test("request policy rejects an empty next endpoint", () => {
  assert.throws(
    () => shouldAbortViewportRequest("/viewport?a=1", ""),
    /non-empty string/,
  );
});


test("a wide view requests the full dataset before any buildings are loaded", () => {
  assert.equal(shouldLoadFullDatasetForWideViewport(false, null), true);
});

test("a wide view upgrades a previously loaded bounded viewport to the full dataset", () => {
  assert.equal(
    shouldLoadFullDatasetForWideViewport(true, {
      west: 90.4,
      south: 23.7,
      east: 90.5,
      north: 23.8,
    }),
    true,
  );
});

test("a wide view reuses the full dataset when it is already loaded", () => {
  assert.equal(shouldLoadFullDatasetForWideViewport(true, null), false);
});
