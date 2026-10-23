import assert from "node:assert/strict";
import test from "node:test";

import { BuildingViewportManager } from "../src/core/map-engine/building-viewport-manager.ts";

const boundsA = { west: 1, south: 2, east: 3, north: 4 };
const boundsB = { west: 5, south: 6, east: 7, north: 8 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeResponse() {
  return new Response(
    JSON.stringify({ type: "FeatureCollection", features: [] }),
    { status: 200, headers: { "Content-Type": "application/geo+json" } },
  );
}

function createFixture(overrides = {}) {
  const added = [];
  const removed = [];
  const telemetry = [];
  const created = [];
  let currentDataSource = null;
  const viewer = {
    camera: { positionCartographic: { height: 1000 } },
    isDestroyed: () => false,
    dataSources: {
      add: async (dataSource) => {
        added.push(dataSource);
        return dataSource;
      },
      remove: (dataSource, destroy) => {
        removed.push({ dataSource, destroy });
        return true;
      },
    },
  };
  const Cesium = {
    Color: { fromCssColorString: (value) => value },
    GeoJsonDataSource: {
      load: async () => {
        const dataSource = {
          entities: { values: [] },
          name: "",
          show: true,
        };
        created.push(dataSource);
        return dataSource;
      },
    },
  };
  const dependencies = {
    getViewportEndpoint: (bounds, featureLimit) =>
      `/api/geospatial/overture-buildings/viewport?west=${bounds.west}&south=${bounds.south}&east=${bounds.east}&north=${bounds.north}&limit=${featureLimit}`,
    isViewerActive: (candidate) => candidate === viewer && !candidate.isDestroyed(),
    isLayerVisible: () => true,
    getViewportFeatureLimit: () => 500,
    isCurrentDataSource: (dataSource) => currentDataSource === dataSource,
    recordMapPerformance: (metric, outcome, durationMs, details = {}) => {
      telemetry.push({ metric, outcome, durationMs, details });
    },
    prepareAndCommit: async (dataSource) => {
      currentDataSource = dataSource;
      return true;
    },
    reportFollowupError: (_request, error) => {
      throw error;
    },
    ...overrides,
  };

  return {
    viewer,
    Cesium,
    dependencies,
    added,
    removed,
    telemetry,
    created,
    setCurrentDataSource: (dataSource) => { currentDataSource = dataSource; },
    getCurrentDataSource: () => currentDataSource,
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

test("successful loads keep the staged datasource hidden and commit coverage afterward", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return makeResponse();
  };

  const manager = new BuildingViewportManager();
  const fixture = createFixture({
    prepareAndCommit: async (dataSource) => {
      assert.equal(dataSource.show, false, "staged datasource must remain hidden during commit");
      assert.equal(manager.hasLoadedBuildings(), false, "coverage must not be committed early");
      fixtureState = dataSource;
      return true;
    },
  });
  let fixtureState = null;

  await manager.load(fixture.viewer, fixture.Cesium, { bounds: boundsA, featureLimit: 250 }, fixture.dependencies);

  assert.equal(fetchCount, 1);
  assert.equal(fixture.added.length, 1);
  assert.equal(fixture.added[0].show, false);
  assert.equal(fixtureState, fixture.added[0]);
  assert.equal(manager.hasLoadedBuildings(), true);
  assert.deepEqual(manager.getLoadedBounds(), boundsA);
  assert.equal(manager.getLoadedFeatureLimit(), 250);
  assert.ok(fixture.telemetry.some((event) => event.metric === "viewport.fetch" && event.outcome === "success"));
  assert.ok(fixture.telemetry.some((event) => event.metric === "viewport.stage" && event.outcome === "success"));
});

test("same endpoint reuses the response cache while staging a fresh datasource", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return makeResponse();
  };

  const manager = new BuildingViewportManager();
  const fixture = createFixture();

  await manager.load(fixture.viewer, fixture.Cesium, { bounds: boundsA, featureLimit: 250 }, fixture.dependencies);
  await manager.load(fixture.viewer, fixture.Cesium, { bounds: boundsA, featureLimit: 250 }, fixture.dependencies);

  assert.equal(fetchCount, 1, "the second request should reuse cached GeoJSON");
  assert.equal(fixture.created.length, 2, "a cached response still needs a new Cesium datasource");
  assert.ok(fixture.telemetry.some((event) => event.metric === "viewport.fetch" && event.outcome === "cache-hit"));
  assert.equal(manager.hasLoadedBuildings(), true);
});

test("invalidating intent during asynchronous commit prevents coverage updates and removes the stale stage", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => makeResponse();

  const commitEntered = deferred();
  const commitGate = deferred();
  const manager = new BuildingViewportManager();
  const fixture = createFixture({
    prepareAndCommit: async (dataSource) => {
      commitEntered.resolve(dataSource);
      return commitGate.promise;
    },
  });

  const loading = manager.load(
    fixture.viewer,
    fixture.Cesium,
    { bounds: boundsA, featureLimit: 250 },
    fixture.dependencies,
  );
  const stagedDataSource = await commitEntered.promise;

  assert.equal(stagedDataSource.show, false);
  assert.equal(manager.hasLoadedBuildings(), false);
  manager.invalidateLayer();
  commitGate.resolve(true);
  await loading;

  assert.equal(manager.hasLoadedBuildings(), false);
  assert.equal(manager.getLoadedBounds(), null);
  assert.equal(fixture.getCurrentDataSource(), null, "stale datasource must not become active");
  assert.ok(
    fixture.removed.some((entry) => entry.dataSource === stagedDataSource && entry.destroy === true),
    "stale hidden datasource should be removed and destroyed",
  );
  assert.ok(fixture.telemetry.some((event) => event.metric === "viewport.stage" && event.outcome === "cancelled"));
});

test("rapid camera movement coalesces to the newest viewport intent", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const firstFetch = deferred();
  const firstRequested = deferred();
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("west=1&")) {
      firstRequested.resolve();
      // Deliberately ignore AbortSignal to simulate a transport that settles late.
      return firstFetch.promise;
    }
    return makeResponse();
  };

  const preparedWests = [];
  const manager = new BuildingViewportManager();
  const fixture = createFixture({
    prepareAndCommit: async (dataSource, context) => {
      preparedWests.push(context.requestedBounds.west);
      fixture.setCurrentDataSource(dataSource);
      return true;
    },
  });

  const firstLoad = manager.load(
    fixture.viewer,
    fixture.Cesium,
    { bounds: boundsA, featureLimit: 250 },
    fixture.dependencies,
  );
  await firstRequested.promise;

  await manager.load(
    fixture.viewer,
    fixture.Cesium,
    { bounds: boundsB, featureLimit: 500 },
    fixture.dependencies,
  );
  firstFetch.resolve(makeResponse());
  await firstLoad;

  await waitFor(
    () => manager.hasLoadedBuildings() && manager.getLoadedBounds()?.west === boundsB.west,
    "the latest queued viewport was not committed",
  );

  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls[0].includes("west=1&"));
  assert.ok(requestedUrls[1].includes("west=5&"));
  assert.deepEqual(preparedWests, [boundsB.west], "obsolete viewport must never be staged for commit");
  assert.deepEqual(manager.getLoadedBounds(), boundsB);
  assert.equal(manager.getLoadedFeatureLimit(), 500);
});
