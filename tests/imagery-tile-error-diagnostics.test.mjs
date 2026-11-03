import assert from "node:assert/strict";
import test from "node:test";
import {
  appendImageryTileErrorDiagnostic,
  summarizeImageryTileError,
} from "../src/core/map-engine/imagery-tile-error-diagnostics.mjs";

test("imagery diagnostics keep tile coordinates and retry metadata without URLs", () => {
  const summary = summarizeImageryTileError({
    message: "Failed to load https://tile.openstreetmap.org/12/123/456.png?token=secret",
    x: 123,
    y: 456,
    level: 12,
    timesRetried: 1,
    retry: true,
  });

  assert.equal(summary.x, 123);
  assert.equal(summary.y, 456);
  assert.equal(summary.level, 12);
  assert.equal(summary.timesRetried, 1);
  assert.equal(summary.retryWasRequested, true);
  assert.doesNotMatch(summary.message, /https?:\/\//);
  assert.doesNotMatch(summary.message, /secret|123\/456/);
});

test("query values are redacted even when an error has no URL", () => {
  const summary = summarizeImageryTileError({
    message: "tile failure token=secret west=90.4 south=23.7",
  });
  assert.doesNotMatch(summary.message, /secret|90\.4|23\.7/);
  assert.match(summary.message, /token=\[redacted\]/);
  assert.match(summary.message, /west=\[redacted\]/);
});

test("invalid or absent tile coordinates fail closed to null", () => {
  assert.deepEqual(
    summarizeImageryTileError({ x: -1, y: 2.5, level: Number.NaN, timesRetried: -3 }),
    {
      message: "Unspecified imagery tile error",
      x: null,
      y: null,
      level: null,
      timesRetried: 0,
      retryWasRequested: false,
    },
  );
});

test("recent imagery error evidence is bounded while total count remains monotonic", () => {
  const target = {};
  for (let i = 0; i < 5; i += 1) {
    appendImageryTileErrorDiagnostic(target, { message: "tile failure " + i }, 3);
  }

  assert.equal(target.__MAP_ENGINE_IMAGERY_TILE_ERRORS__.total, 5);
  assert.deepEqual(
    target.__MAP_ENGINE_IMAGERY_TILE_ERRORS__.recent.map((entry) => entry.message),
    ["tile failure 2", "tile failure 3", "tile failure 4"],
  );
});

test("diagnostic capacity bounds and target input are validated", () => {
  assert.throws(() => appendImageryTileErrorDiagnostic(null, {}), /target is required/);
  assert.throws(() => appendImageryTileErrorDiagnostic({}, {}, 0), /capacity/);
  assert.throws(() => appendImageryTileErrorDiagnostic({}, {}, 501), /capacity/);
});
