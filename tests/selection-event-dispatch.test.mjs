import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dispatchSelectionListeners } from "../src/core/map-engine/dispatch-selection-listeners.mjs";

const adapterUrl = new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url);
const adapter = await readFile(adapterUrl, "utf8");

test("dispatches the same payload in Set insertion order", () => {
  const payload = { id: "feature-1" };
  const seen = [];
  const errors = [];
  const listeners = new Set([
    (value) => seen.push(["first", value]),
    (value) => seen.push(["second", value]),
    (value) => seen.push(["third", value]),
  ]);

  dispatchSelectionListeners(listeners, payload, (error) => errors.push(error));

  assert.deepEqual(seen.map(([name]) => name), ["first", "second", "third"]);
  for (const [, value] of seen) assert.strictEqual(value, payload);
  assert.deepEqual(errors, []);
});

test("a listener error is reported and does not stop subsequent listeners", () => {
  const payload = null;
  const failure = new Error("listener crashed");
  const seen = [];
  const errors = [];
  const listeners = new Set([
    (value) => seen.push(["first", value]),
    () => { throw failure; },
    (value) => seen.push(["third", value]),
  ]);

  assert.doesNotThrow(() =>
    dispatchSelectionListeners(listeners, payload, (error) => errors.push(error)),
  );
  assert.deepEqual(seen, [["first", null], ["third", null]]);
  assert.deepEqual(errors, [failure]);
});

test("supports empty iterables and non-Error thrown values", () => {
  const errors = [];
  dispatchSelectionListeners(new Set(), "selection", (error) => errors.push(error));
  dispatchSelectionListeners(
    new Set([() => { throw "listener-failure"; }]),
    "selection",
    (error) => errors.push(error),
  );
  assert.deepEqual(errors, ["listener-failure"]);
});

test("retains Set's live iteration behavior when listeners unsubscribe during dispatch", () => {
  const seen = [];
  const listeners = new Set();
  const later = () => seen.push("later");
  listeners.add(() => {
    seen.push("first");
    listeners.delete(later);
  });
  listeners.add(later);
  listeners.add(() => seen.push("last"));

  dispatchSelectionListeners(listeners, null, () => assert.fail("no listener should throw"));
  assert.deepEqual(seen, ["first", "last"]);
});

test("CesiumAdapter routes all selection emitters through the dispatcher", () => {
  assert.match(adapter, /from "\.\/dispatch-selection-listeners\.mjs"/);
  const methodSpecs = [
    ["private emitFeatureSelection(", "\n  private restoreSelectedBuilding(", /this\.featureSelectionListeners/],
    ["private emitPlaceSelection(", "\n  getGroundCenter(", /this\.placeSelectionListeners/],
    ["private emitRoadSelection(", "\n  onPropertySelected(", /this\.roadSelectionListeners/],
    ["private emitPropertySelection(", "\n  async setPropertyListings\(", /this\.propertySelectionListeners/],
  ];

  for (const [startToken, endToken, listenerSet] of methodSpecs) {
    const start = adapter.indexOf(startToken);
    const end = adapter.indexOf(endToken, start + startToken.length);
    assert.ok(start >= 0 && end > start, "could not locate emitter " + startToken);
    const method = adapter.slice(start, end);
    assert.match(method, /dispatchSelectionListeners\(/, startToken + " must delegate");
    assert.match(method, listenerSet);
    assert.doesNotMatch(method, /for\s*\(const listener of this\./);
    assert.match(method, /console\.error\(/, startToken + " must keep its specific logging context");
  }
});

test("selection cleanup restores building materials before emitting clear payloads and refreshing LOD", () => {
  const start = adapter.indexOf("clearFeatureSelection(): void {");
  const end = adapter.indexOf("\n  private getEntityFromPick(", start);
  assert.ok(start >= 0 && end > start);
  const clear = adapter.slice(start, end);
  const order = [
    "this.restoreSelectedBuilding();",
    "this.emitFeatureSelection(null);",
    "this.emitPlaceSelection(null);",
    "this.emitRoadSelection(null);",
    "this.emitPropertySelection(null);",
    "this.updateBuildingLod(this.viewer, this.cesium, true);",
  ].map((token) => clear.indexOf(token));

  for (let index = 1; index < order.length; index += 1) {
    assert.ok(order[index] > order[index - 1], "selection clear event order changed");
  }
});
