import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { FeaturePickingController } from "../src/core/map-engine/feature-picking-controller.mjs";

const adapterUrl = new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url);
const adapter = await readFile(adapterUrl, "utf8");

function fixture(overrides = {}) {
  const handlers = [];
  const picks = [];
  const errors = [];
  let active = true;

  const controller = new FeaturePickingController({
    createHandler(canvas) {
      const handler = {
        canvas,
        destroyed: false,
        action: null,
        eventType: null,
        setInputAction(action, eventType) {
          this.action = action;
          this.eventType = eventType;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      handlers.push(handler);
      return handler;
    },
    leftClickType: 7,
    isActive: () => active,
    onPick: (movement) => picks.push(movement),
    ...overrides,
  });

  return {
    controller,
    handlers,
    picks,
    errors,
    setActive(value) {
      active = value;
    },
  };
}

test("attaches a left-click handler and forwards the original screen position", () => {
  const state = fixture();
  const canvas = { name: "map-canvas" };
  const movement = { position: { x: 24, y: 52 } };

  state.controller.attach(canvas);

  assert.equal(state.handlers.length, 1);
  assert.strictEqual(state.handlers[0].canvas, canvas);
  assert.equal(state.handlers[0].eventType, 7);
  assert.equal(typeof state.handlers[0].action, "function");

  state.handlers[0].action(movement);
  assert.deepEqual(state.picks, [movement]);
});

test("ignores picks when the owning viewer is no longer active", () => {
  const state = fixture();
  state.controller.attach({ name: "map-canvas" });
  const action = state.handlers[0].action;

  state.setActive(false);
  action({ position: { x: 4, y: 9 } });

  assert.deepEqual(state.picks, []);
});

test("re-attaching destroys the previous handler and rejects its stale callback", () => {
  const state = fixture();
  const firstCanvas = { name: "first-canvas" };
  const secondCanvas = { name: "second-canvas" };

  state.controller.attach(firstCanvas);
  const oldHandler = state.handlers[0];
  const staleAction = oldHandler.action;
  state.controller.attach(secondCanvas);
  const activeHandler = state.handlers[1];

  assert.equal(oldHandler.destroyed, true);
  assert.strictEqual(activeHandler.canvas, secondCanvas);
  staleAction({ position: { x: 1, y: 1 } });
  activeHandler.action({ position: { x: 2, y: 2 } });
  assert.deepEqual(state.picks, [{ position: { x: 2, y: 2 } }]);
});

test("destroy is idempotent and rejects callbacks captured before teardown", () => {
  const state = fixture();
  state.controller.attach({ name: "map-canvas" });
  const handler = state.handlers[0];
  const capturedAction = handler.action;

  state.controller.destroy();
  state.controller.destroy();
  capturedAction({ position: { x: 3, y: 8 } });

  assert.equal(handler.destroyed, true);
  assert.deepEqual(state.picks, []);
});

test("a destroyed controller cannot be attached again", () => {
  const state = fixture();
  state.controller.destroy();
  state.controller.attach({ name: "late-canvas" });

  assert.equal(state.handlers.length, 0);
});

test("cleans up a handler when its callback registration throws", () => {
  const failure = new Error("registration failed");
  const handlers = [];
  const controller = new FeaturePickingController({
    createHandler() {
      const handler = {
        destroyed: false,
        setInputAction() {
          throw failure;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      handlers.push(handler);
      return handler;
    },
    leftClickType: 7,
    isActive: () => true,
    onPick: () => assert.fail("pick callback must not run"),
  });

  assert.throws(() => controller.attach({ name: "map-canvas" }), failure);
  assert.equal(handlers[0].destroyed, true);
  controller.destroy();
});

test("CesiumAdapter delegates handler lifecycle to FeaturePickingController", () => {
  assert.match(adapter, /new FeaturePickingController\(/);
  assert.match(adapter, /this\.featurePickingController\?\.destroy\(\)/);
  assert.match(adapter, /this\.featurePickingController = null/);
  assert.doesNotMatch(adapter, /private clickHandler:/);
});
