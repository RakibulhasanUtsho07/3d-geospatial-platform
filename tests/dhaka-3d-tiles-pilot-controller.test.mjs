import assert from "node:assert/strict";
import test from "node:test";
import {
  DHAKA_3D_TILES_PILOT_URL,
  Dhaka3DTilesPilotController,
  isDhaka3DTilesPilotEnabled,
} from "../src/core/map-engine/dhaka-3d-tiles-pilot-controller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockScene() {
  const attached = new Set();
  const calls = { adds: 0, removes: 0, renders: 0 };
  return {
    calls,
    attached,
    scene: {
      primitives: {
        add(item) {
          calls.adds += 1;
          attached.add(item);
          item.attached = true;
          return item;
        },
        remove(item) {
          calls.removes += 1;
          if (!attached.has(item)) return false;
          attached.delete(item);
          item.attached = false;
          item.destroy();
          return true;
        },
      },
      requestRender() {
        calls.renders += 1;
      },
    },
    isDestroyed() {
      return false;
    },
  };
}

function mockTileset() {
  return {
    attached: false,
    destroyed: false,
    destroyCalls: 0,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyCalls += 1;
      this.destroyed = true;
    },
  };
}

function setup({ enabled = true, fromUrl = async () => mockTileset(), viewer = mockScene() } = {}) {
  const events = [];
  const cesium = { Cesium3DTileset: { fromUrl } };
  const controller = new Dhaka3DTilesPilotController({
    getViewer: () => viewer,
    getCesium: () => cesium,
    isEnabled: () => enabled,
    onStatus: (event) => events.push(event),
  });
  return { controller, viewer, cesium, events };
}

test("the feature flag is explicitly opt-in", () => {
  assert.equal(isDhaka3DTilesPilotEnabled("true"), true);
  assert.equal(isDhaka3DTilesPilotEnabled("TRUE"), false);
  assert.equal(isDhaka3DTilesPilotEnabled("1"), false);
  assert.equal(isDhaka3DTilesPilotEnabled(undefined), false);
  assert.equal(DHAKA_3D_TILES_PILOT_URL, "/experimental/dhaka-3d-tiles-fixture/tileset.json");
});

test("does not request or attach a tileset while the feature flag is disabled", async () => {
  let requests = 0;
  const { controller, viewer, events } = setup({
    enabled: false,
    fromUrl: async () => {
      requests += 1;
      return mockTileset();
    },
  });

  const result = await controller.enable();
  assert.equal(result.status, "disabled");
  assert.equal(requests, 0);
  assert.equal(viewer.calls.adds, 0);
  assert.equal(controller.getState().attached, false);
  assert.deepEqual(events, []);
  controller.destroy();
});

test("loads and attaches exactly one tileset, then removes and destroys it on disable", async () => {
  const tileset = mockTileset();
  const calls = [];
  const { controller, viewer, events } = setup({
    fromUrl: async (url, options) => {
      calls.push({ url, options });
      return tileset;
    },
  });

  const first = await controller.enable();
  const second = await controller.enable();
  assert.equal(first.status, "loaded");
  assert.equal(second.status, "already-loaded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DHAKA_3D_TILES_PILOT_URL);
  assert.equal(calls[0].options.maximumScreenSpaceError, 16);
  assert.equal(viewer.calls.adds, 1);
  assert.equal(viewer.calls.renders, 1);
  assert.equal(controller.getState().attached, true);
  assert.ok(events.some((event) => event.status === "loading"));
  assert.ok(events.some((event) => event.status === "loaded"));

  controller.disable();
  assert.equal(viewer.calls.removes, 1);
  assert.equal(viewer.attached.size, 0);
  assert.equal(tileset.destroyed, true);
  assert.equal(controller.getState().attached, false);
  controller.destroy();
});

test("disable invalidates an in-flight load and destroys the late result without attaching it", async () => {
  const pending = deferred();
  const tileset = mockTileset();
  const { controller, viewer } = setup({ fromUrl: () => pending.promise });

  const loading = controller.enable();
  controller.disable();
  pending.resolve(tileset);

  const result = await loading;
  assert.equal(result.status, "cancelled");
  assert.equal(viewer.calls.adds, 0);
  assert.equal(viewer.attached.size, 0);
  assert.equal(tileset.destroyed, true);
  assert.equal(tileset.destroyCalls, 1);
  assert.equal(controller.getState().attached, false);
  controller.destroy();
});

test("viewer replacement during async loading prevents attachment to the stale viewer", async () => {
  const pending = deferred();
  const staleViewer = mockScene();
  const nextViewer = mockScene();
  let activeViewer = staleViewer;
  const tileset = mockTileset();
  const events = [];
  const controller = new Dhaka3DTilesPilotController({
    getViewer: () => activeViewer,
    getCesium: () => ({ Cesium3DTileset: { fromUrl: () => pending.promise } }),
    isEnabled: () => true,
    onStatus: (event) => events.push(event),
  });

  const loading = controller.enable();
  activeViewer = nextViewer;
  pending.resolve(tileset);
  const result = await loading;

  assert.equal(result.status, "cancelled");
  assert.equal(staleViewer.calls.adds, 0);
  assert.equal(nextViewer.calls.adds, 0);
  assert.equal(tileset.destroyed, true);
  controller.destroy();
});

test("destroy tears down an attached tileset and permanently rejects later loads", async () => {
  const tileset = mockTileset();
  let requests = 0;
  const { controller, viewer } = setup({
    fromUrl: async () => {
      requests += 1;
      return tileset;
    },
  });

  await controller.enable();
  controller.destroy();
  const later = await controller.enable();

  assert.equal(later.status, "disposed");
  assert.equal(requests, 1);
  assert.equal(viewer.calls.removes, 1);
  assert.equal(viewer.attached.size, 0);
  assert.equal(tileset.destroyed, true);
  assert.equal(controller.getState().disposed, true);
});

test("late errors after cancellation do not emit stale error statuses", async () => {
  const pending = deferred();
  const { controller, events } = setup({ fromUrl: () => pending.promise });
  const loading = controller.enable();
  controller.disable();
  pending.reject(new Error("simulated late request failure"));

  await assert.rejects(loading, /simulated late request failure/);
  assert.equal(events.some((event) => event.status === "error"), false);
  controller.destroy();
});
