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

function mockScene({ removeReturns = true, addError = null, destroyOnRemove = true } = {}) {
  const attached = new Set();
  const calls = { adds: 0, removes: 0, renders: 0 };
  return {
    calls,
    attached,
    scene: {
      primitives: {
        add(item) {
          calls.adds += 1;
          if (addError) throw addError;
          attached.add(item);
          item.attached = true;
          return item;
        },
        remove(item) {
          calls.removes += 1;
          if (!removeReturns || !attached.has(item)) return false;
          attached.delete(item);
          item.attached = false;
          if (destroyOnRemove) item.destroy();
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

function setup({
  enabled = true,
  fromUrl = async () => mockTileset(),
  viewer = mockScene(),
  onStatus = null,
  ...controllerOptions
} = {}) {
  const events = [];
  const cesium = { Cesium3DTileset: { fromUrl } };
  const controller = new Dhaka3DTilesPilotController({
    getViewer: () => viewer,
    getCesium: () => cesium,
    isEnabled: () => enabled,
    onStatus: (event) => {
      events.push(event);
      onStatus?.(event);
    },
    ...controllerOptions,
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

test("rejects unbounded or malformed retry configuration", () => {
  assert.throws(() => new Dhaka3DTilesPilotController({
    getViewer: () => mockScene(),
    getCesium: () => ({ Cesium3DTileset: { fromUrl: async () => mockTileset() } }),
    isEnabled: () => true,
    maxAttemptsPerUrl: 0,
  }), /maxAttemptsPerUrl/);
  assert.throws(() => new Dhaka3DTilesPilotController({
    getViewer: () => mockScene(),
    getCesium: () => ({ Cesium3DTileset: { fromUrl: async () => mockTileset() } }),
    isEnabled: () => true,
    retryDelayMs: 6000,
  }), /retryDelayMs/);
  assert.throws(() => new Dhaka3DTilesPilotController({
    getViewer: () => mockScene(),
    getCesium: () => ({ Cesium3DTileset: { fromUrl: async () => mockTileset() } }),
    isEnabled: () => true,
    url: " ",
  }), /url/);
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

test("runtime feature-flag disable detaches existing content and invalidates pending work", async () => {
  let enabled = true;
  const firstTileset = mockTileset();
  const pending = deferred();
  let requests = 0;
  const { controller, viewer } = setup({
    get enabled() { return enabled; },
    isEnabled: () => enabled,
    fromUrl: () => {
      requests += 1;
      return requests === 1 ? Promise.resolve(firstTileset) : pending.promise;
    },
  });

  await controller.enable();
  assert.equal(viewer.attached.size, 1);
  const loading = controller.enable({ url: "/next/tileset.json", fallbackUrl: null });
  assert.equal(requests, 2);
  enabled = false;
  const disabled = await controller.enable();

  assert.equal(disabled.status, "disabled");
  assert.equal(firstTileset.destroyed, true);
  assert.equal(viewer.attached.size, 0);
  pending.resolve(mockTileset());
  assert.equal((await loading).status, "cancelled");
  assert.equal(viewer.attached.size, 0);
  assert.equal(controller.getState().attached, false);
  assert.equal(controller.getState().loading, false);
  controller.destroy();
});

test("loads and attaches one tileset, then removes and destroys it on disable", async () => {
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

test("concurrent requests for the same source coalesce into one Cesium load", async () => {
  const pending = deferred();
  const tileset = mockTileset();
  let requests = 0;
  const { controller, viewer } = setup({
    fromUrl: () => {
      requests += 1;
      return pending.promise;
    },
  });

  const first = controller.enable();
  const second = controller.enable();
  assert.strictEqual(second, first, "Duplicate same-source calls should receive the same in-flight promise.");
  assert.equal(requests, 1);
  pending.resolve(tileset);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.status, "loaded");
  assert.equal(secondResult.status, "loaded");
  assert.equal(viewer.calls.adds, 1);
  assert.equal(controller.getState().loading, false);
  controller.destroy();
});

test("disable invalidates an in-flight load and destroys its late result without attaching it", async () => {
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
  assert.equal(controller.getState().loading, false);
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
  assert.equal(events.some((event) => event.status === "error"), false);
  controller.destroy();
});

test("bounded retry recovers after a transient first failure", async () => {
  const tileset = mockTileset();
  let requests = 0;
  const { controller, viewer, events } = setup({
    maxAttemptsPerUrl: 2,
    retryDelayMs: 0,
    fromUrl: async () => {
      requests += 1;
      if (requests === 1) throw new Error("temporary network interruption");
      return tileset;
    },
  });

  const result = await controller.enable();
  assert.equal(result.status, "loaded");
  assert.equal(requests, 2);
  assert.equal(viewer.calls.adds, 1);
  assert.ok(events.some((event) => event.status === "retrying" && event.nextAttempt === 2));
  assert.equal(events.some((event) => event.status === "error"), false);
  controller.destroy();
});

test("uses an explicitly configured fallback only after bounded primary retries", async () => {
  const tileset = mockTileset();
  const requests = [];
  const { controller, viewer, events } = setup({
    url: "/primary/tileset.json",
    fallbackUrl: "/fallback/tileset.json",
    maxAttemptsPerUrl: 2,
    retryDelayMs: 0,
    fromUrl: async (url) => {
      requests.push(url);
      if (url === "/primary/tileset.json") throw new Error("primary source unavailable");
      return tileset;
    },
  });

  const result = await controller.enable();
  assert.deepEqual(requests, [
    "/primary/tileset.json",
    "/primary/tileset.json",
    "/fallback/tileset.json",
  ]);
  assert.equal(result.status, "loaded");
  assert.equal(result.url, "/fallback/tileset.json");
  assert.equal(result.fallbackUsed, true);
  assert.equal(viewer.calls.adds, 1);
  assert.equal(controller.getState().attachedUrl, "/fallback/tileset.json");
  assert.ok(events.some((event) => event.status === "fallback" && event.toUrl === "/fallback/tileset.json"));
  assert.ok(events.some((event) => event.status === "loaded" && event.fallbackUsed));
  controller.destroy();
});

test("final source failure is visible and leaves no attached resource", async () => {
  let requests = 0;
  const { controller, viewer, events } = setup({
    maxAttemptsPerUrl: 2,
    retryDelayMs: 0,
    fromUrl: async () => {
      requests += 1;
      throw new Error("permanent fixture failure");
    },
  });

  await assert.rejects(controller.enable(), /permanent fixture failure/);
  assert.equal(requests, 2);
  assert.equal(viewer.calls.adds, 0);
  assert.equal(viewer.attached.size, 0);
  assert.equal(controller.getState().loading, false);
  assert.equal(controller.getState().loadingOrAttached, false);
  assert.equal(events.filter((event) => event.status === "error").length, 1);
  controller.destroy();
});

test("disable during a retry delay stops before another network attempt", async () => {
  let requests = 0;
  let markRetrying;
  const retryingSeen = new Promise((resolve) => { markRetrying = resolve; });
  const { controller, events } = setup({
    maxAttemptsPerUrl: 3,
    retryDelayMs: 100,
    fromUrl: async () => {
      requests += 1;
      throw new Error("offline");
    },
    onStatus: (event) => {
      if (event.status === "retrying") markRetrying();
    },
  });

  const pendingLoad = controller.enable();
  await retryingSeen;
  controller.disable();
  const result = await pendingLoad;
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(result.status, "cancelled");
  assert.equal(requests, 1);
  assert.equal(events.some((event) => event.status === "error"), false);
  assert.equal(controller.getState().loading, false);
  controller.destroy();
});

test("cancellation after a failed request does not try the fallback or publish stale errors", async () => {
  const firstRequest = deferred();
  const requests = [];
  const { controller, events } = setup({
    url: "/primary/tileset.json",
    fallbackUrl: "/fallback/tileset.json",
    maxAttemptsPerUrl: 1,
    fromUrl: (url) => {
      requests.push(url);
      return firstRequest.promise;
    },
  });

  const pendingLoad = controller.enable();
  firstRequest.reject(new Error("primary failed after the controller was disabled"));
  controller.disable();
  const result = await pendingLoad;

  assert.equal(result.status, "cancelled");
  assert.deepEqual(requests, ["/primary/tileset.json"]);
  assert.equal(events.some((event) => event.status === "fallback"), false);
  assert.equal(events.some((event) => event.status === "error"), false);
  controller.destroy();
});

test("viewer replacement and a second source detach old content and only attach the current result", async () => {
  const firstTileset = mockTileset();
  const secondTileset = mockTileset();
  const { controller, viewer } = setup({
    fromUrl: async (url) => url === "/source-a/tileset.json" ? firstTileset : secondTileset,
  });

  const first = await controller.enable({ url: "/source-a/tileset.json", fallbackUrl: null });
  assert.equal(first.status, "loaded");
  const second = await controller.enable({ url: "/source-b/tileset.json", fallbackUrl: null });

  assert.equal(second.status, "loaded");
  assert.equal(second.url, "/source-b/tileset.json");
  assert.equal(firstTileset.destroyed, true);
  assert.equal(secondTileset.destroyed, false);
  assert.equal(viewer.attached.size, 1);
  assert.ok(viewer.attached.has(secondTileset));
  assert.equal(controller.getState().attachedUrl, "/source-b/tileset.json");
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

test("if Cesium refuses attachment the loaded primitive is destroyed and the error is reported", async () => {
  const tileset = mockTileset();
  const viewer = mockScene({ addError: new Error("primitive collection rejected the tile") });
  const { controller, events } = setup({ viewer, fromUrl: async () => tileset });

  await assert.rejects(controller.enable(), /primitive collection rejected the tile/);
  assert.equal(tileset.destroyed, true);
  assert.equal(tileset.destroyCalls, 1);
  assert.equal(controller.getState().attached, false);
  assert.equal(events.filter((event) => event.status === "error").length, 1);
  controller.destroy();
});

test("if primitive insertion mutates then throws, the partial scene attachment is removed", async () => {
  const tileset = mockTileset();
  const viewer = mockScene();
  viewer.scene.primitives.add = (item) => {
    viewer.attached.add(item);
    item.attached = true;
    throw new Error("collection failed after insert");
  };
  const { controller } = setup({ viewer, fromUrl: async () => tileset });

  await assert.rejects(controller.enable(), /collection failed after insert/);
  assert.equal(viewer.attached.size, 0);
  assert.equal(viewer.calls.removes, 1);
  assert.equal(tileset.destroyed, true);
  assert.equal(tileset.destroyCalls, 1);
  assert.equal(controller.getState().attached, false);
  controller.destroy();
});

test("disable explicitly destroys tilesets when collection removal does not destroy primitives", async () => {
  const tileset = mockTileset();
  // Cesium PrimitiveCollection supports destroyPrimitives=false. The primitive
  // is removed from the scene, but the owner must still release the resource.
  const viewer = mockScene({ destroyOnRemove: false });
  const { controller } = setup({ viewer, fromUrl: async () => tileset });

  await controller.enable();
  controller.disable();

  assert.equal(viewer.attached.size, 0);
  assert.equal(tileset.destroyed, true);
  assert.equal(tileset.destroyCalls, 1);
  assert.equal(controller.getState().attached, false);
  controller.destroy();
});

test("partial primitive insertion is cleaned up when removal succeeds without destroying", async () => {
  const tileset = mockTileset();
  const viewer = mockScene({ destroyOnRemove: false });
  viewer.scene.primitives.add = (item) => {
    viewer.attached.add(item);
    item.attached = true;
    throw new Error("collection failed after insert");
  };
  const { controller } = setup({ viewer, fromUrl: async () => tileset });

  await assert.rejects(controller.enable(), /collection failed after insert/);
  assert.equal(viewer.attached.size, 0);
  assert.equal(viewer.calls.removes, 1);
  assert.equal(tileset.destroyed, true);
  assert.equal(tileset.destroyCalls, 1);
  controller.destroy();
});

test("requestRender exceptions do not turn successful attachment into a failed load", async () => {
  const tileset = mockTileset();
  const viewer = mockScene();
  viewer.scene.requestRender = () => { throw new Error("scene is shutting down"); };
  const { controller } = setup({ viewer, fromUrl: async () => tileset });

  const result = await controller.enable();
  assert.equal(result.status, "loaded");
  assert.equal(controller.getState().attached, true);
  controller.disable();
  assert.equal(viewer.attached.size, 0);
  assert.equal(tileset.destroyed, true);
  controller.destroy();
});

test("if primitive removal fails, disable still destroys the owned tileset", async () => {
  const tileset = mockTileset();
  const viewer = mockScene({ removeReturns: false });
  const { controller } = setup({ viewer, fromUrl: async () => tileset });

  await controller.enable();
  controller.disable();
  assert.equal(viewer.attached.size, 1, "The mock simulates a primitive collection that refused removal.");
  assert.equal(tileset.destroyed, true);
  assert.equal(tileset.destroyCalls, 1);
  assert.equal(controller.getState().attached, false);
  controller.destroy();
});

test("a late error after cancellation resolves as cancelled instead of emitting a stale error", async () => {
  const pending = deferred();
  const { controller, events } = setup({ fromUrl: () => pending.promise });
  const loading = controller.enable();
  controller.disable();
  pending.reject(new Error("simulated late request failure"));

  const result = await loading;
  assert.equal(result.status, "cancelled");
  assert.equal(events.some((event) => event.status === "error"), false);
  controller.destroy();
});

test("status callback failures cannot break loading or teardown", async () => {
  const tileset = mockTileset();
  const { controller, viewer } = setup({
    fromUrl: async () => tileset,
    onStatus: () => { throw new Error("telemetry callback failure"); },
  });

  assert.equal((await controller.enable()).status, "loaded");
  controller.destroy();
  assert.equal(viewer.attached.size, 0);
  assert.equal(tileset.destroyed, true);
});
