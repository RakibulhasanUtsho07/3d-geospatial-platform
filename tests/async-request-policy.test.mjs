import assert from "node:assert/strict";
import test from "node:test";

import { isCurrentAsyncRequest } from "../src/core/geospatial/async-request-policy.mjs";

test("the current non-aborted request may update state", () => {
  const current = {};
  assert.equal(isCurrentAsyncRequest(current, current, false), true);
});

test("a superseded request cannot overwrite newer results", () => {
  assert.equal(isCurrentAsyncRequest({}, {}, false), false);
});

test("an aborted request cannot update state", () => {
  const current = {};
  assert.equal(isCurrentAsyncRequest(current, current, true), false);
});

test("a cleared request token cannot update state after unmount", () => {
  assert.equal(isCurrentAsyncRequest({}, null, false), false);
  assert.equal(isCurrentAsyncRequest(null, null, false), false);
});
