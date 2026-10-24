import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test, type Page } from "@playwright/test";

const OUTPUT_DIRECTORY = path.resolve(
  process.env.P2_6_EVIDENCE_DIR ?? "artifacts/p2.6-dynamic-map-workload",
);
const BUILDING_FEATURE_COUNT = 36;
const ROAD_FEATURE_COUNT = 24;
const FIRST_BUILDING_RESPONSE_DELAY_MS = 4_000;
const FIRST_ROAD_RESPONSE_DELAY_MS = 3_500;

type MetricName = "buildings" | "roads";
type BrowserMetricEvent = {
  kind: "fetch-start" | "fetch-end" | "fetch-cancelled" | "fetch-error";
  metric: MetricName;
  url: string;
  atMs: number;
  durationMs?: number;
  status?: number;
  errorName?: string;
};
type MapRenderEvent = {
  kind: "building-render" | "road-render" | "building-cancelled";
  atMs: number;
  detail: Record<string, unknown>;
};
type TimedRoute = {
  url: string;
  startedAtMs: number;
  routeOrdinal: number;
  routeDelayMs: number;
  fulfilledAtMs?: number;
  fulfillError?: string;
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeBuildingFeatureCollection() {
  const features = Array.from({ length: BUILDING_FEATURE_COUNT }, (_, index) => {
    const column = index % 6;
    const row = Math.floor(index / 6);
    const longitude = 90.4058 + (column - 2.5) * 0.00035;
    const latitude = 23.7086 + (row - 2.5) * 0.00032;
    const halfWidth = 0.000045;
    const ring = [
      [longitude - halfWidth, latitude - halfWidth],
      [longitude + halfWidth, latitude - halfWidth],
      [longitude + halfWidth, latitude + halfWidth],
      [longitude - halfWidth, latitude + halfWidth],
      [longitude - halfWidth, latitude - halfWidth],
    ];

    return {
      type: "Feature",
      id: "p26-building-" + String(index + 1).padStart(3, "0"),
      properties: {
        id: "p26-building-" + String(index + 1).padStart(3, "0"),
        height: 9 + (index % 6) * 2,
        building: "residential",
        "building:colour": index % 2 === 0 ? "#527A9B" : "#8B9C8C",
        "roof:colour": index % 3 === 0 ? "#D8B044" : "#778899",
        subtype: "residential",
        _renderRole: "building",
        _renderPartCount: 0,
        _p26Fixture: true,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
  });

  return { type: "FeatureCollection", features };
}

function makeRoadFixture() {
  const classes = [
    { roadClass: "arterial", highway: "primary", widthMeters: 8, surface: "asphalt" },
    { roadClass: "collector", highway: "secondary", widthMeters: 5, surface: "paving_stones" },
    { roadClass: "local", highway: "residential", widthMeters: 3.2, surface: "concrete" },
    { roadClass: "path", highway: "footway", widthMeters: 1.4, surface: "gravel" },
  ] as const;

  return Array.from({ length: ROAD_FEATURE_COUNT }, (_, index) => {
    const column = index % 6;
    const row = Math.floor(index / 6);
    const longitude = 90.4058 + (column - 2.5) * 0.00034;
    const latitude = 23.7086 + (row - 1.5) * 0.00033;
    const style = classes[index % classes.length];
    const layer = style.roadClass === "collector" && index % 2 === 0 ? 1 : 0;

    return {
      id: "p26-road-" + String(index + 1).padStart(3, "0"),
      name: "Viewport fixture road " + (index + 1),
      highway: style.highway,
      roadClass: style.roadClass,
      widthMeters: style.widthMeters,
      surface: style.surface,
      layer,
      bridge: layer > 0,
      tunnel: false,
      coordinates: [
        [longitude - 0.0003, latitude - 0.00008],
        [longitude, latitude + 0.00002],
        [longitude + 0.0003, latitude + 0.00012],
      ],
    };
  });
}

function numericBounds(urlValue: string): Record<string, number> | null {
  const url = new URL(urlValue);
  const keys = ["west", "south", "east", "north"] as const;
  const values = Object.fromEntries(keys.map((key) => [key, Number(url.searchParams.get(key))]));
  return keys.every((key) => Number.isFinite(values[key])) ? values : null;
}

function sameBounds(stage: unknown, urlValue: string): boolean {
  if (!stage || typeof stage !== "object") return false;
  const expected = numericBounds(urlValue);
  if (!expected) return false;
  const candidate = stage as Record<string, unknown>;
  return ["west", "south", "east", "north"].every((key) =>
    typeof candidate[key] === "number" &&
    Math.abs((candidate[key] as number) - expected[key]) <= 0.000002
  );
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) => {
    if (sorted.length === 0) return null;
    const position = (sorted.length - 1) * fraction;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    const result = low === high
      ? sorted[low]
      : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
    return Number(result.toFixed(3));
  };
  return {
    count: sorted.length,
    minMs: at(0),
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: at(1),
  };
}

async function readBrowserEvents(page: Page): Promise<BrowserMetricEvent[]> {
  return page.evaluate(() => {
    const target = window as Window & { __P26_WORKLOAD__?: { events: BrowserMetricEvent[] } };
    return target.__P26_WORKLOAD__?.events ?? [];
  });
}

test("stresses repeated map viewport changes, cancellation, staging and memory", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });

  const buildings = makeBuildingFeatureCollection();
  const roads = makeRoadFixture();
  const buildingRoutes: TimedRoute[] = [];
  const roadRoutes: TimedRoute[] = [];
  const renderEvents: MapRenderEvent[] = [];
  const fixtureSha256 = sha256(Buffer.from(JSON.stringify({ buildings, roads })));
  let firstBuildingDelayUsed = false;
  let firstRoadDelayUsed = false;
  const apiRequestAudit: Array<{ url: string; method: string; resourceType: string }> = [];
  const apiRequestFailures: Array<{ url: string; failure: string | null }> = [];
  const pageErrors: string[] = [];

  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/geospatial/overture-buildings") || url.includes("/api/geospatial/roads")) {
      apiRequestAudit.push({ url, method: request.method(), resourceType: request.resourceType() });
    }
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.includes("/api/geospatial/overture-buildings") || url.includes("/api/geospatial/roads")) {
      apiRequestFailures.push({ url, failure: request.failure()?.errorText ?? null });
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    type EventKind = "fetch-start" | "fetch-end" | "fetch-cancelled" | "fetch-error";
    type MetricEvent = {
      kind: EventKind;
      metric: "buildings" | "roads";
      url: string;
      atMs: number;
      durationMs?: number;
      status?: number;
      errorName?: string;
    };
    const target = window as Window & { __P26_WORKLOAD__?: { events: MetricEvent[] } };
    const harness = { events: [] as MetricEvent[] };
    target.__P26_WORKLOAD__ = harness;
    const nativeFetch = window.fetch.bind(window);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const sourceUrl = input instanceof Request ? input.url : String(input);
      const parsedUrl = new URL(sourceUrl, window.location.href);
      const metric = parsedUrl.pathname.startsWith("/api/geospatial/overture-buildings")
        ? "buildings"
        : parsedUrl.pathname === "/api/geospatial/roads"
          ? "roads"
          : null;
      if (!metric) return nativeFetch(input, init);

      const atMs = performance.now();
      const url = parsedUrl.toString();
      harness.events.push({ kind: "fetch-start", metric, url, atMs });
      try {
        const response = await nativeFetch(input, init);
        harness.events.push({
          kind: "fetch-end",
          metric,
          url,
          atMs: performance.now(),
          durationMs: Number((performance.now() - atMs).toFixed(3)),
          status: response.status,
        });
        return response;
      } catch (error: unknown) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        harness.events.push({
          kind: errorName === "AbortError" ? "fetch-cancelled" : "fetch-error",
          metric,
          url,
          atMs: performance.now(),
          durationMs: Number((performance.now() - atMs).toFixed(3)),
          errorName,
        });
        throw error;
      }
    };
  });

  page.on("console", (message) => {
    if (message.type() !== "info") return;
    const args = message.args();
    if (args.length === 0) return;
    void Promise.all(args.map((arg) => arg.jsonValue().catch(() => null))).then((values) => {
      const kind = values[0];
      const rawDetail = values[1];
      if (typeof kind !== "string") return;
      if (
        kind !== "[Overture] Building viewport rendered." &&
        kind !== "[Roads] Vector road viewport rendered." &&
        kind !== "[Overture] Cancelled an obsolete viewport request."
      ) return;
      const detail = typeof rawDetail === "object" && rawDetail !== null && !Array.isArray(rawDetail)
        ? rawDetail as Record<string, unknown>
        : {};
      renderEvents.push({
        kind: kind === "[Overture] Building viewport rendered."
          ? "building-render"
          : kind === "[Roads] Vector road viewport rendered."
            ? "road-render"
            : "building-cancelled",
        atMs: performance.now(),
        detail,
      });
    });
  });

  await page.route("https://tile.openstreetmap.org/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
  });

  await page.route("**/models/*.glb", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "Heritage GLBs are disabled for the dynamic viewport workload fixture.",
    });
  });

  await page.route(/\/api\/geospatial\/overture-buildings(?:\/viewport)?\/?(?:\?.*)?$/, async (route) => {
    const startedAtMs = performance.now();
    const routeOrdinal = buildingRoutes.length + 1;
    const routeRecord: TimedRoute = {
      url: route.request().url(),
      startedAtMs,
      routeOrdinal,
      routeDelayMs: !firstBuildingDelayUsed ? FIRST_BUILDING_RESPONSE_DELAY_MS : 80,
    };
    buildingRoutes.push(routeRecord);
    if (!firstBuildingDelayUsed) firstBuildingDelayUsed = true;
    await wait(routeRecord.routeDelayMs);
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/geo+json",
        headers: { "cache-control": "no-store", "x-p26-fixture": "multi-building-viewport" },
        body: JSON.stringify(buildings),
      });
      routeRecord.fulfilledAtMs = performance.now();
    } catch (error: unknown) {
      routeRecord.fulfillError = error instanceof Error ? error.message : String(error);
    }
  });

  await page.route(/\/api\/geospatial\/roads\/?(?:\?.*)?$/, async (route) => {
    const startedAtMs = performance.now();
    const routeOrdinal = roadRoutes.length + 1;
    const routeRecord: TimedRoute = {
      url: route.request().url(),
      startedAtMs,
      routeOrdinal,
      routeDelayMs: !firstRoadDelayUsed ? FIRST_ROAD_RESPONSE_DELAY_MS : 60,
    };
    roadRoutes.push(routeRecord);
    if (!firstRoadDelayUsed) firstRoadDelayUsed = true;
    await wait(routeRecord.routeDelayMs);
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store", "x-p26-fixture": "multi-road-viewport" },
        body: JSON.stringify({ results: roads }),
      });
      routeRecord.fulfilledAtMs = performance.now();
    } catch (error: unknown) {
      routeRecord.fulfillError = error instanceof Error ? error.message : String(error);
    }
  });

  await page.setViewportSize({ width: 1600, height: 950 });
  await page.goto("/map", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect(page.getByRole("checkbox", { name: "Detailed OSM roads" })).toBeEnabled({ timeout: 45_000 });
  const canvas = page.getByTestId("cesium-map-container").locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 45_000 });
  await expect.poll(
    () => buildingRoutes.length,
    { timeout: 15_000, message: "No building viewport request reached the P2.6 route handler. Browser API requests: " + JSON.stringify(apiRequestAudit.slice(0, 20)) + "; failed: " + JSON.stringify(apiRequestFailures.slice(0, 10)) + "; page errors: " + JSON.stringify(pageErrors.slice(0, 10)) },
  ).toBeGreaterThan(0);
  await expect.poll(
    () => roadRoutes.length,
    { timeout: 15_000, message: "No road viewport request reached the P2.6 route handler. Browser API requests: " + JSON.stringify(apiRequestAudit.slice(0, 20)) + "; failed: " + JSON.stringify(apiRequestFailures.slice(0, 10)) + "; page errors: " + JSON.stringify(pageErrors.slice(0, 10)) },
  ).toBeGreaterThan(0);

  const initial = await page.evaluate(() => {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } }).memory;
    const canvas = document.querySelector('[data-testid="cesium-map-container"] canvas') as HTMLCanvasElement | null;
    const rect = canvas?.getBoundingClientRect();
    return {
      sampledAt: new Date().toISOString(),
      jsHeapUsedBytes: typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null,
      jsHeapTotalBytes: typeof memory?.totalJSHeapSize === "number" ? memory.totalJSHeapSize : null,
      canvas: { width: canvas?.width ?? 0, height: canvas?.height ?? 0, cssWidth: rect?.width ?? 0, cssHeight: rect?.height ?? 0 },
    };
  });

  const movementStartedAtMs = performance.now();
  const movementActions: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    await page.getByRole("button", { name: "Zoom out" }).click();
    movementActions.push("zoom-out");
    await wait(90);
  }
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole("button", { name: "Zoom in" }).click();
    movementActions.push("zoom-in");
    await wait(90);
  }

  const box = await canvas.boundingBox();
  assert.ok(box, "The Cesium map canvas must have a stable bounding box for pan workload.");
  const startX = box.x + box.width * 0.43;
  const startY = box.y + box.height * 0.56;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 185, startY + 62, { steps: 6 });
  await page.mouse.up();
  movementActions.push("drag-pan");

  await expect.poll(() => buildingRoutes.length, { timeout: 45_000 }).toBeGreaterThan(1);
  await expect.poll(() => roadRoutes.length, { timeout: 45_000 }).toBeGreaterThan(1);

  await expect.poll(async () => {
    const fetchEvents = await readBrowserEvents(page);
    const starts = fetchEvents.filter((event) => event.kind === "fetch-start" && event.metric === "buildings");
    const latest = starts.at(-1);
    return Boolean(latest && renderEvents.some((event) =>
      event.kind === "building-render" && sameBounds(event.detail.viewport, latest.url)
    ));
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(true);

  await expect.poll(() => renderEvents.some((event) =>
    event.kind === "building-render" &&
    event.detail.returnedFeatures === BUILDING_FEATURE_COUNT &&
    event.detail.renderedExtrusions === BUILDING_FEATURE_COUNT
  ), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => renderEvents.some((event) =>
    event.kind === "road-render" &&
    event.detail.returnedWays === ROAD_FEATURE_COUNT &&
    event.detail.renderedWays === ROAD_FEATURE_COUNT
  ), { timeout: 30_000 }).toBe(true);

  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const finalMemory = await page.evaluate(() => {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
    const canvas = document.querySelector('[data-testid="cesium-map-container"] canvas') as HTMLCanvasElement | null;
    const rect = canvas?.getBoundingClientRect();
    return {
      sampledAt: new Date().toISOString(),
      jsHeapUsedBytes: typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null,
      jsHeapTotalBytes: typeof memory?.totalJSHeapSize === "number" ? memory.totalJSHeapSize : null,
      jsHeapLimitBytes: typeof memory?.jsHeapSizeLimit === "number" ? memory.jsHeapSizeLimit : null,
      canvas: {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        cssWidth: rect?.width ?? 0,
        cssHeight: rect?.height ?? 0,
      },
      cesiumVersion: (window as Window & { Cesium?: { VERSION?: string } }).Cesium?.VERSION ?? null,
    };
  });

  const frameMetrics = await page.evaluate(async () => {
    const intervals: number[] = [];
    const startedAt = performance.now();
    return new Promise<{
      sampleDurationMs: number;
      frameCount: number;
      medianFrameIntervalMs: number | null;
      p95FrameIntervalMs: number | null;
      maximumFrameIntervalMs: number | null;
      framesOver16_7ms: number;
    }>((resolve) => {
      let previous: number | null = null;
      const tick = (now: number) => {
        if (previous !== null) intervals.push(now - previous);
        previous = now;
        if (now - startedAt < 1_200) {
          requestAnimationFrame(tick);
          return;
        }
        const sorted = [...intervals].sort((left, right) => left - right);
        const pick = (fraction: number) => {
          if (sorted.length === 0) return null;
          const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
          return Number(sorted[index].toFixed(3));
        };
        resolve({
          sampleDurationMs: Number((now - startedAt).toFixed(3)),
          frameCount: intervals.length,
          medianFrameIntervalMs: pick(0.5),
          p95FrameIntervalMs: pick(0.95),
          maximumFrameIntervalMs: pick(1),
          framesOver16_7ms: intervals.filter((value) => value > 16.7).length,
        });
      };
      requestAnimationFrame(tick);
    });
  });

  const browserEvents = await readBrowserEvents(page);
  const successfulFetches = browserEvents.filter((event) => event.kind === "fetch-end" && event.status === 200);
  const cancelledFetches = browserEvents.filter((event) => event.kind === "fetch-cancelled");
  const failedFetches = browserEvents.filter((event) => event.kind === "fetch-error");
  const buildingStarts = browserEvents.filter((event) => event.kind === "fetch-start" && event.metric === "buildings");
  const roadStarts = browserEvents.filter((event) => event.kind === "fetch-start" && event.metric === "roads");
  const buildingSuccessDurations = successfulFetches.filter((event) => event.metric === "buildings").map((event) => event.durationMs ?? 0);
  const roadSuccessDurations = successfulFetches.filter((event) => event.metric === "roads").map((event) => event.durationMs ?? 0);
  const uniqueBuildingBounds = new Set(buildingStarts.map((event) => {
    const bounds = numericBounds(event.url);
    return bounds ? [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(6)).join("|") : event.url;
  }));
  const uniqueRoadBounds = new Set(roadStarts.map((event) => {
    const bounds = numericBounds(event.url);
    return bounds ? [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(6)).join("|") : event.url;
  }));
  const lastBuildingStart = buildingStarts.at(-1);
  const finalBuildingStage = [...renderEvents].reverse().find((event) => event.kind === "building-render");
  const finalRoadStage = [...renderEvents].reverse().find((event) => event.kind === "road-render");
  const timeToLatestBuildingStageMs = finalBuildingStage
    ? Number((finalBuildingStage.atMs - movementStartedAtMs).toFixed(3))
    : null;
  const heapDelta = initial?.jsHeapUsedBytes !== null &&
    initial?.jsHeapUsedBytes !== undefined &&
    finalMemory.jsHeapUsedBytes !== null
    ? finalMemory.jsHeapUsedBytes - initial.jsHeapUsedBytes
    : null;

  assert.ok(uniqueBuildingBounds.size >= 2, "Workload must request at least two unique building viewport bounds.");
  assert.ok(uniqueRoadBounds.size >= 2, "Workload must request at least two unique road viewport bounds.");
  assert.ok(cancelledFetches.length + renderEvents.filter((event) => event.kind === "building-cancelled").length >= 1,
    "Rapid camera movement must exercise at least one obsolete-request cancellation.");
  assert.ok(lastBuildingStart, "At least one building fetch must be observed.");
  assert.ok(finalBuildingStage, "The latest viewport must be staged to Cesium.");
  assert.ok(finalRoadStage, "A road viewport must render after camera movement.");
  assert.equal(failedFetches.length, 0, "The final workload must not leave non-cancellation fetch errors.");
  assert.ok(finalMemory.canvas.width >= 640 && finalMemory.canvas.height >= 400, "Canvas buffer must remain valid after repeated moves.");
  assert.ok(finalMemory.canvas.cssWidth >= 640 && finalMemory.canvas.cssHeight >= 400, "Canvas CSS size must remain valid after repeated moves.");

  const report = {
    schemaVersion: 1,
    evidenceType: "p2.6-dynamic-map-multi-viewport-workload",
    status: "pass",
    createdAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    runtime: {
      browserName: "chromium",
      browserVersion: browser.version(),
      userAgent: await page.evaluate(() => navigator.userAgent),
      viewport: { width: 1600, height: 950 },
      cesiumVersion: finalMemory.cesiumVersion,
      renderBackend: "Playwright Chromium with SwiftShader; synthetic viewport workload, not a physical GPU benchmark",
    },
    fixture: {
      sha256: fixtureSha256,
      buildingFeatureCount: BUILDING_FEATURE_COUNT,
      roadFeatureCount: ROAD_FEATURE_COUNT,
      buildingResponseDelayMs: FIRST_BUILDING_RESPONSE_DELAY_MS,
      roadResponseDelayMs: FIRST_ROAD_RESPONSE_DELAY_MS,
      description: "Generated, deterministic local GeoJSON fixture. Multiple feature/road entities stress real Cesium staging, viewport request coalescing and cancellation. It is not a real OGC 3D Tiles multi-GLB dataset.",
    },
    workload: {
      movementActions,
      elapsedSinceCameraWorkStartedMs: Number((performance.now() - movementStartedAtMs).toFixed(3)),
      timeToLatestBuildingStageMs,
      uniqueBuildingViewportBounds: uniqueBuildingBounds.size,
      uniqueRoadViewportBounds: uniqueRoadBounds.size,
      buildingViewportRequests: buildingStarts.length,
      roadViewportRequests: roadStarts.length,
      successfulFetches: successfulFetches.length,
      cancelledFetches: cancelledFetches.length,
      failedFetches: failedFetches.length,
      buildingRequestRouteAudit: buildingRoutes,
      roadRequestRouteAudit: roadRoutes,
      browserApiRequestAudit: apiRequestAudit,
      browserApiRequestFailures: apiRequestFailures,
      browserPageErrors: pageErrors,
    },
    renderStages: {
      buildingStageCount: renderEvents.filter((event) => event.kind === "building-render").length,
      roadStageCount: renderEvents.filter((event) => event.kind === "road-render").length,
      buildingCancellationsLogged: renderEvents.filter((event) => event.kind === "building-cancelled").length,
      finalBuildingViewport: finalBuildingStage?.detail.viewport ?? null,
      finalBuildingFeatureCount: finalBuildingStage?.detail.returnedFeatures ?? null,
      finalBuildingExtrusionCount: finalBuildingStage?.detail.renderedExtrusions ?? null,
      finalRoadWayCount: finalRoadStage?.detail.returnedWays ?? null,
      finalRoadRenderedWayCount: finalRoadStage?.detail.renderedWays ?? null,
      latestBuildingRequestUrl: lastBuildingStart?.url ?? null,
      latestViewportRequestWasStaged: Boolean(lastBuildingStart && finalBuildingStage && sameBounds(finalBuildingStage.detail.viewport, lastBuildingStart.url)),
      buildingFetchLatency: summarize(buildingSuccessDurations),
      roadFetchLatency: summarize(roadSuccessDurations),
    },
    runtimeHealth: {
      initialMemory: initial,
      finalMemory,
      jsHeapUsedDeltaBytes: heapDelta,
      animationFrames: frameMetrics,
    },
    limitations: [
      "This measures the dynamic map's multi-viewport GeoJSON/road staging path using a deterministic synthetic dataset; it is not an OGC 3D Tiles multi-content tile benchmark.",
      "Request cancellation counts are browser-observed AbortError events plus the map's obsolete-viewport log; cancelled work is expected and not counted as a failed fetch.",
      "JS heap snapshots are coarse and may be unavailable; GPU/driver memory is not exposed by this portable browser harness.",
      "Timing and frame intervals depend on CI runner load and SwiftShader. Use the report for regression comparison on like-for-like runners, not as a physical-GPU FPS claim.",
    ],
  };

  assert.equal(report.renderStages.latestViewportRequestWasStaged, true, "Latest viewport request must be the viewport ultimately staged to Cesium.");

  const reportPath = path.join(OUTPUT_DIRECTORY, "dynamic-viewport-workload.json");
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
  await writeFile(reportPath, reportBytes);
  const hash = sha256(reportBytes);
  await writeFile(path.join(OUTPUT_DIRECTORY, "SHA256SUMS.txt"), hash + "  dynamic-viewport-workload.json\n", "utf8");
  console.info("[P2.6] Dynamic viewport workload evidence captured.", {
    reportPath,
    reportSha256: hash,
    buildingViewportRequests: buildingStarts.length,
    roadViewportRequests: roadStarts.length,
    cancelledFetches: cancelledFetches.length,
    timeToLatestBuildingStageMs,
    frameMetrics,
  });
});
