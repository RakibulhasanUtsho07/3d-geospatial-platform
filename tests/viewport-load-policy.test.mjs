import assert from "node:assert/strict";
import test from "node:test";

import { shouldAbortViewportRequest } from "../src/core/map-engine/viewport-load-policy.mjs";

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
