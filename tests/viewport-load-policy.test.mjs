import assert from "node:assert/strict";
import test from "node:test";
import { clampViewportBoundsToLocalWindow } from "../src/core/map-engine/viewport-bounds-policy.mjs";

import {
  shouldAbortViewportRequest,
  shouldContinueViewportLoad,
  shouldContinueViewportStage,
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


test("a current viewport intent may continue while buildings are visible", () => {
  assert.equal(shouldContinueViewportLoad(4, 4, true), true);
});

test("a superseded viewport intent is discarded after fetch completion", () => {
  assert.equal(shouldContinueViewportLoad(4, 5, true), false);
});

test("a hidden building layer discards a pending viewport stage", () => {
  assert.equal(shouldContinueViewportLoad(4, 4, false), false);
});

test("a restored layer does not revive an older intent revision", () => {
  assert.equal(shouldContinueViewportLoad(4, 5, true), false);
});


test("a viewport stage continues only for the current visible viewer", () => {
  assert.equal(shouldContinueViewportStage(7, 7, true, true), true);
  assert.equal(shouldContinueViewportStage(7, 8, true, true), false);
  assert.equal(shouldContinueViewportStage(7, 7, false, true), false);
  assert.equal(shouldContinueViewportStage(7, 7, true, false), false);
});

test("a shallow view's broad rectangle is clipped to a bounded local window", () => {
  const center = { longitude: 90.4, latitude: 23.7 };
  const bounds = { west: 90.1, south: 23.4, east: 90.8, north: 24.0 };
  const clipped = clampViewportBoundsToLocalWindow(bounds, center, 750);

  assert.ok(clipped);
  const latitudeHalfExtent = 750 / 111_320;
  const longitudeHalfExtent = 750 / (111_320 * Math.cos(center.latitude * Math.PI / 180));
  assert.ok(clipped.west >= center.longitude - longitudeHalfExtent - 1e-12);
  assert.ok(clipped.east <= center.longitude + longitudeHalfExtent + 1e-12);
  assert.ok(clipped.south >= center.latitude - latitudeHalfExtent - 1e-12);
  assert.ok(clipped.north <= center.latitude + latitudeHalfExtent + 1e-12);
  assert.ok(clipped.east - clipped.west < 0.02);
  assert.ok(clipped.north - clipped.south < 0.02);
});

test("a local viewport already inside the window is preserved unchanged", () => {
  const bounds = { west: 90.4, south: 23.7, east: 90.41, north: 23.71 };
  assert.deepEqual(
    clampViewportBoundsToLocalWindow(
      bounds,
      { longitude: 90.405, latitude: 23.705 },
      10_000,
    ),
    bounds,
  );
});

test("a non-intersecting viewport does not fabricate an unrelated local rectangle", () => {
  assert.equal(
    clampViewportBoundsToLocalWindow(
      { west: 90.1, south: 23.3, east: 90.11, north: 23.31 },
      { longitude: 90.4, latitude: 23.7 },
      100,
    ),
    null,
  );
});

test("invalid local window inputs return null", () => {
  assert.equal(
    clampViewportBoundsToLocalWindow(
      { west: 90.4, south: 23.7, east: 90.3, north: 23.8 },
      { longitude: 90.4, latitude: 23.7 },
      750,
    ),
    null,
  );
});
