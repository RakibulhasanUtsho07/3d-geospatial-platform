import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, test, type Page, type Request, type Route } from "@playwright/test";

type WorkloadRequestLifecycleDiagnostics = {
  intentRevision: number;
  loadInProgress: boolean;
  hasActiveEndpoint: boolean;
  hasAbortController: boolean;
  hasPendingRequest: boolean;
};

type WorkloadFrameDiagnostics = {
  frameCount: number;
  lastFrameAtMs: number;
  requestRender?: () => void;
  getRequestLifecycleDiagnostics?: () => WorkloadRequestLifecycleDiagnostics | null;
  focusViewportForBenchmark?: (
    longitudeDegrees: number,
    latitudeDegrees: number,
    heightMeters: number,
  ) => boolean;
  notifyCameraIntent?: () => {
    loadInProgress: boolean;
    intentRevisionBefore: number;
    intentRevisionAfter: number;
    cameraBoundsChanged: boolean;
    viewportWidthDegrees: number | null;
    viewportHeightDegrees: number | null;
    lifecycleBefore: WorkloadRequestLifecycleDiagnostics;
    lifecycleAfter: WorkloadRequestLifecycleDiagnostics;
  } | null;
};

type StageEvent = {
  atMs: number;
  summary: Record<string, unknown>;
};

type FrameEvent = {
  atMs: number;
  frameSequence: number;
};

type FetchAbortEvent = {
  atMs: number;
  url: string;
};

type BrowserResourceTimingObservation = {
  startTimeMs: number;
  responseEndMs: number;
  viewportKey: string | null;
};

declare global {
  interface Window {
    __MAP_ENGINE_WORKLOAD_BENCHMARK__?: boolean;
    __MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?: WorkloadFrameDiagnostics;
    __MAP_ENGINE_WORKLOAD_STAGE_EVENTS__?: StageEvent[];
    __MAP_ENGINE_WORKLOAD_FRAME_EVENTS__?: FrameEvent[];
    __MAP_ENGINE_WORKLOAD_ABORT_EVENTS__?: FetchAbortEvent[];
  }
}

type NumericTileBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type SpatialTileManifest = {
  tileCount?: unknown;
  tiles?: Array<{
    bounds?: Partial<Record<"west" | "south" | "east" | "north", unknown>>;
  }>;
};

type ViewportRequestObservation = {
  sequence: number;
  request: Request;
  startedAtMs: number;
  viewportHash: string | null;
  viewportWidthDegrees: number | null;
  viewportHeightDegrees: number | null;
  outcome: "in-flight" | "delivered" | "cancelled" | "failed" | "route-error";
  delayedForCancellation: boolean;
  routeResponseReady: boolean;
  statusCode: number | null;
  dataSource: string | null;
  selectedTileCount: number | null;
  candidateFeatureCount: number | null;
  matchedFeatureCount: number | null;
  returnedFeatureCount: number | null;
  candidatePayloadBytes: number | null;
  indexReadBytes: number | null;
  featureReadBytes: number | null;
  fetchedFeatureCount: number | null;
  featureLimit: number | null;
  endpointResponseMs: number | null;
  responseAvailableAtMs: number | null;
  failure: string | null;
  routeError: string | null;
};

type MemorySample = {
  label: string;
  elapsedMs: number;
  jsHeapUsedBytes: number | null;
  jsHeapTotalBytes: number | null;
  domNodeCount: number | null;
  eventListenerCount: number | null;
  renderedFrameCount: number;
};

const VIEWPORT_API_FRAGMENT = "/api/geospatial/overture-buildings/viewport";
const CANCEL_RESPONSE_DELAY_MS = 5_000;
const MOVEMENT_CYCLES = 8;
const MAX_HEAP_GROWTH_BYTES = 128 * 1024 * 1024;
const MAX_DOM_NODE_GROWTH = 10_000;

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQ4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
  "base64",
);

function pause(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isViewportRequest(url: string): boolean {
  return url.includes(VIEWPORT_API_FRAGMENT);
}

function canonicalBoundsKey(values: unknown): string | null {
  if (typeof values !== "object" || values === null) return null;

  const record = values as Record<string, unknown>;
  const keys = ["west", "south", "east", "north"];
  const numbers = keys.map((key) => Number(record[key]));
  if (!numbers.every(Number.isFinite)) return null;

  return numbers.map((value) => value.toFixed(6)).join("|");
}

function boundsKeyFromUrl(rawUrl: string): string | null {
  try {
    // CesiumAdapter intentionally calls fetch with a same-origin relative URL.
    // Playwright Request.url() is absolute, while the wrapped application fetch
    // reports that relative string; accept both so abort events retain the
    // same coordinate hash without exporting the raw bounds.
    const url = new URL(rawUrl, "http://viewport-benchmark.invalid");
    return canonicalBoundsKey({
      west: url.searchParams.get("west"),
      south: url.searchParams.get("south"),
      east: url.searchParams.get("east"),
      north: url.searchParams.get("north"),
    });
  } catch {
    return null;
  }
}

function hashBounds(key: string | null): string | null {
  return key
    ? createHash("sha256").update(key).digest("hex").slice(0, 12)
    : null;
}

/** Persist only viewport dimensions, never the source coordinates themselves. */
function viewportSpanFromUrl(rawUrl: string): { widthDegrees: number; heightDegrees: number } | null {
  try {
    const url = new URL(rawUrl, "http://viewport-benchmark.invalid");
    const west = Number(url.searchParams.get("west"));
    const south = Number(url.searchParams.get("south"));
    const east = Number(url.searchParams.get("east"));
    const north = Number(url.searchParams.get("north"));
    if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
      return null;
    }
    return {
      widthDegrees: Number((east - west).toFixed(6)),
      heightDegrees: Number((north - south).toFixed(6)),
    };
  } catch {
    return null;
  }
}

function summarizeSpan(values: number[]): {
  minDegrees: number | null;
  p50Degrees: number | null;
  p95Degrees: number | null;
  maxDegrees: number | null;
} {
  if (values.length === 0) {
    return { minDegrees: null, p50Degrees: null, p95Degrees: null, maxDegrees: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  const round = (value: number) => Number(value.toFixed(6));
  return {
    minDegrees: round(sorted[0]),
    p50Degrees: round(at(0.5)),
    p95Degrees: round(at(0.95)),
    maxDegrees: round(sorted[sorted.length - 1]),
  };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.name + ": " + error.message : String(error);
  // Avoid leaking viewport query parameters into a report that otherwise stores
  // only short hashes of the requested map bounds.
  return message.replace(/https?:\/\/[^\s)]+/g, (candidate) => {
    try {
      const url = new URL(candidate);
      return url.origin + url.pathname;
    } catch {
      return "[redacted URL]";
    }
  }).slice(0, 400);
}
function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return Number(sorted[index].toFixed(2));
}

function linearTrendSlope(values: Array<number | null>): number | null {
  const points = values
    .map((value, index) => ({ x: index, y: value }))
    .filter((point): point is { x: number; y: number } => point.y !== null && Number.isFinite(point.y));

  if (points.length < 2) return null;

  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;

  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }

  return denominator === 0 ? null : Number((numerator / denominator).toFixed(2));
}

async function panCanvas(page: Page, dx: number, dy: number): Promise<void> {
  const canvas = page.getByTestId("cesium-map-container").locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Cesium canvas has no bounding box.");

  const startX = box.x + box.width * 0.5;
  const startY = box.y + box.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
}

async function waitForStageThenCesiumFrame(
  page: Page,
  minimumStageCount: number,
  timeout = 25_000,
): Promise<void> {
  // First prove the actual building layer reached its stage/commit log.
  await page.waitForFunction(
    (previousStageCount) =>
      (window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__ ?? []).length > previousStageCount,
    minimumStageCount,
    { timeout },
  );

  // requestRenderMode intentionally avoids continuous idle frames. Ask Cesium
  // for a frame after the stage commit, then wait for its actual postRender
  // callback rather than treating canvas visibility as render readiness.
  const previousFrameCount = await page.evaluate(
    () => window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.frameCount ?? 0,
  );
  await page.evaluate(() => window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.requestRender?.());
  await page.waitForFunction(
    (frameCount) =>
      (window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.frameCount ?? 0) > frameCount,
    previousFrameCount,
    { timeout },
  );
}

test("P2.6 measures real multi-tile viewport churn, cancellation, frame readiness and memory trend", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const tileManifestPath = resolve(
    process.cwd(),
    "data",
    "overture",
    "spatial-tiles",
    "manifest.json",
  );
  const tileManifestBytes = await readFile(tileManifestPath);
  const tileManifest = JSON.parse(tileManifestBytes.toString("utf8")) as SpatialTileManifest;
  const manifestBounds = (tileManifest.tiles ?? [])
    .map((tile) => tile.bounds)
    .filter((bounds): bounds is NumericTileBounds => {
      if (!bounds) return false;
      const values = [bounds.west, bounds.south, bounds.east, bounds.north];
      return values.every((value) => typeof value === "number" && Number.isFinite(value))
        && Number(bounds.west) < Number(bounds.east)
        && Number(bounds.south) < Number(bounds.north);
    });
  const availableSpatialTileCount = typeof tileManifest.tileCount === "number"
    && Number.isInteger(tileManifest.tileCount)
    && tileManifest.tileCount >= 0
    ? tileManifest.tileCount
    : manifestBounds.length;
  if (availableSpatialTileCount < 2 || manifestBounds.length !== availableSpatialTileCount) {
    throw new Error(
      "The generated spatial-tile manifest must expose consistent tile bounds before the workload can run.",
    );
  }
  const spatialTileManifestSha256 = createHash("sha256").update(tileManifestBytes).digest("hex");
  const pilotExtent = {
    west: Math.min(...manifestBounds.map((bounds) => bounds.west)),
    south: Math.min(...manifestBounds.map((bounds) => bounds.south)),
    east: Math.max(...manifestBounds.map((bounds) => bounds.east)),
    north: Math.max(...manifestBounds.map((bounds) => bounds.north)),
  };
  const pilotFocus = {
    longitude: (pilotExtent.west + pilotExtent.east) / 2,
    latitude: (pilotExtent.south + pilotExtent.north) / 2,
  };

  const workloadStartedAt = performance.now();
  const requests: ViewportRequestObservation[] = [];
  const observationByRequest = new Map<Request, ViewportRequestObservation>();
  const routeTasks = new Set<Promise<void>>();
  let delayNextViewportResponse = false;
  let delayedResponseClaimed = false;

  await page.addInitScript(() => {
    window.__MAP_ENGINE_WORKLOAD_BENCHMARK__ = true;
    window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__ = [];
    window.__MAP_ENGINE_WORKLOAD_FRAME_EVENTS__ = [];
    window.__MAP_ENGINE_WORKLOAD_ABORT_EVENTS__ = [];

    // Browser Resource Timing exposes startTime and responseEnd in the same
    // performance clock as the map's stage and postRender events. Avoid wrapping
    // window.fetch so the benchmark cannot alter application request behavior.

    // Observe the actual AbortController signal from BuildingViewportManager.
    // Raw endpoints stay in-memory only; persisted reports store viewport hashes.
    window.addEventListener("map:viewport-request-aborted", (event: Event) => {
      const detail = (event as CustomEvent<{
        atMs?: number;
        endpoint?: string | null;
      }>).detail;
      if (!detail || typeof detail.endpoint !== "string") return;
      const events = window.__MAP_ENGINE_WORKLOAD_ABORT_EVENTS__ ??= [];
      events.push({
        atMs: Number.isFinite(detail.atMs) ? detail.atMs as number : performance.now(),
        url: detail.endpoint,
      });
    });

    window.addEventListener("map:building-viewport-staged", (event: Event) => {
      const detail = (event as CustomEvent<{
        atMs?: number;
        summary?: Record<string, unknown>;
      }>).detail;
      if (!detail || typeof detail.summary !== "object" || detail.summary === null) return;

      const events = window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__ ??= [];
      events.push({
        atMs: Number.isFinite(detail.atMs) ? detail.atMs as number : performance.now(),
        summary: detail.summary,
      });
      if (events.length > 500) events.splice(0, events.length - 500);
      // The map is in requestRenderMode; request a post-commit frame so the
      // benchmark measures render readiness after an actual datasource commit.
      window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.requestRender?.();
    });

    window.addEventListener("map:frame-ready", (event: Event) => {
      const detail = (event as CustomEvent<WorkloadFrameDiagnostics>).detail;
      if (!detail || !Number.isFinite(detail.lastFrameAtMs)) return;

      const frames = window.__MAP_ENGINE_WORKLOAD_FRAME_EVENTS__ ??= [];
      frames.push({
        atMs: detail.lastFrameAtMs,
        frameSequence: detail.frameCount,
      });
      if (frames.length > 1_000) frames.splice(0, frames.length - 1_000);
    });
  });

  await page.route("https://tile.openstreetmap.org/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: TRANSPARENT_PNG,
    });
  });

  // Do not let optional landmark GLBs dominate this viewport workload sample.
  await page.route("**/models/*.glb", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "Landmark GLBs are excluded from the P2.6 viewport workload sample.",
    });
  });

  // Keep the public roads provider out of the benchmark. The building viewport
  // endpoint below is intentionally not mocked: it reads the generated Overture
  // spatial-tile manifest and tile files prepared by CI.
  await page.route("**/api/geospatial/roads**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: [] }),
    });
  });

  await page.route("**/api/geospatial/overture-buildings/viewport**", async (route: Route) => {
    const task = (async () => {
      const request = route.request();
      const viewportSpan = viewportSpanFromUrl(request.url());
      const observation: ViewportRequestObservation = {
        sequence: requests.length + 1,
        request,
        startedAtMs: performance.now(),
        viewportHash: hashBounds(boundsKeyFromUrl(request.url())),
        viewportWidthDegrees: viewportSpan?.widthDegrees ?? null,
        viewportHeightDegrees: viewportSpan?.heightDegrees ?? null,
        outcome: "in-flight",
        delayedForCancellation: false,
        routeResponseReady: false,
        statusCode: null,
        dataSource: null,
        selectedTileCount: null,
        candidateFeatureCount: null,
        matchedFeatureCount: null,
        returnedFeatureCount: null,
        candidatePayloadBytes: null,
        indexReadBytes: null,
        featureReadBytes: null,
        fetchedFeatureCount: null,
        featureLimit: null,
        endpointResponseMs: null,
        responseAvailableAtMs: null,
        failure: null,
        routeError: null,
      };
      requests.push(observation);
      observationByRequest.set(request, observation);

      try {
        // This calls the real Next.js endpoint. The browser response is held only
        // when explicitly requested below so a newer camera intent can abort it.
        const upstream = await route.fetch();
        const headers = upstream.headers();

        observation.statusCode = upstream.status();
        observation.dataSource = headers["x-building-data-source"] ?? null;
        observation.selectedTileCount = Number.isFinite(Number(headers["x-building-tile-count"]))
          ? Number(headers["x-building-tile-count"])
          : null;
        observation.candidateFeatureCount = Number.isFinite(Number(headers["x-building-candidate-feature-count"]))
          ? Number(headers["x-building-candidate-feature-count"])
          : null;
        observation.matchedFeatureCount = Number.isFinite(Number(headers["x-building-matched-feature-count"]))
          ? Number(headers["x-building-matched-feature-count"])
          : null;
        observation.returnedFeatureCount = Number.isFinite(Number(headers["x-building-feature-count"]))
          ? Number(headers["x-building-feature-count"])
          : null;
        const readMetric = (header: string): number | null => {
          const rawValue = headers[header];
          if (typeof rawValue !== "string" || rawValue.trim() === "") return null;
          const parsed = Number(rawValue);
          return Number.isFinite(parsed) ? parsed : null;
        };
        observation.candidatePayloadBytes = readMetric("x-building-candidate-bytes");
        observation.indexReadBytes = readMetric("x-building-index-read-bytes");
        observation.featureReadBytes = readMetric("x-building-feature-read-bytes");
        observation.fetchedFeatureCount = readMetric("x-building-fetched-feature-count");
        observation.featureLimit = readMetric("x-building-feature-limit");
        observation.endpointResponseMs = Number((performance.now() - observation.startedAtMs).toFixed(2));

        if (delayNextViewportResponse && !delayedResponseClaimed) {
          delayNextViewportResponse = false;
          delayedResponseClaimed = true;
          observation.delayedForCancellation = true;
          await pause(CANCEL_RESPONSE_DELAY_MS);
        }

        await route.fulfill({ response: upstream });
        observation.routeResponseReady = true;
        observation.responseAvailableAtMs ??= performance.now();
      } catch (error) {
        observation.routeError = errorText(error);
        if (observation.outcome === "in-flight") observation.outcome = "route-error";
        try {
          await route.abort();
        } catch {
          // The browser may already have cancelled the request, which is the
          // behavior this benchmark is trying to observe.
        }
      }
    })();

    routeTasks.add(task);
    try {
      await task;
    } finally {
      routeTasks.delete(task);
    }
  });

  page.on("requestfailed", (request) => {
    const observation = observationByRequest.get(request);
    if (!observation) return;

    const failure = request.failure()?.errorText ?? "Unknown network failure";
    observation.failure = failure;
    observation.responseAvailableAtMs = performance.now();
    observation.outcome = /abort|cancel/i.test(failure) ? "cancelled" : "failed";
  });

  page.on("response", (response) => {
    const observation = observationByRequest.get(response.request());
    if (!observation) return;

    observation.statusCode = response.status();
    observation.routeResponseReady = true;
    observation.responseAvailableAtMs = performance.now();
    if (observation.outcome === "in-flight") observation.outcome = "delivered";
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");

  const sampleMemory = async (label: string): Promise<MemorySample> => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const metric = (name: string): number | null => {
      const value = metrics.find((entry) => entry.name === name)?.value;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    const heapUsed = metric("JSHeapUsedSize");
    const heapTotal = metric("JSHeapTotalSize");
    const frameCount = await page.evaluate(
      () => window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.frameCount ?? 0,
    );
    const nodeCount = metric("Nodes");
    const listenerCount = metric("JSEventListeners");

    return {
      label,
      elapsedMs: Number((performance.now() - workloadStartedAt).toFixed(2)),
      jsHeapUsedBytes: heapUsed === null ? null : Math.round(heapUsed),
      jsHeapTotalBytes: heapTotal === null ? null : Math.round(heapTotal),
      domNodeCount: nodeCount === null ? null : Math.round(nodeCount),
      eventListenerCount: listenerCount === null ? null : Math.round(listenerCount),
      renderedFrameCount: frameCount,
    };
  };

  await page.goto("/map", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("checkbox", { name: "Detailed OSM roads" }),
  ).toBeEnabled({ timeout: 45_000 });
  await expect(
    page.getByTestId("cesium-map-container").locator("canvas").first(),
  ).toBeVisible({ timeout: 45_000 });

  const browserDiagnostics: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error" &&
      (/^\\[Overture\\]/.test(text) || /Cesium|WebGL/i.test(text))
    ) {
      browserDiagnostics.push(text.slice(0, 500));
      if (browserDiagnostics.length > 30) browserDiagnostics.shift();
    }
  });
  page.on("pageerror", (error) => {
    browserDiagnostics.push(("pageerror: " + error.message).slice(0, 500));
    if (browserDiagnostics.length > 30) browserDiagnostics.shift();
  });

  await expect.poll(
    () => requests.some((request) => request.statusCode === 200),
    { timeout: 45_000 },
  ).toBe(true);
  try {
    await waitForStageThenCesiumFrame(page, 0, 45_000);
  } catch (error) {
    const browserState = await page.evaluate(() => ({
      stageCount: window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__?.length ?? 0,
      frameCount: window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.frameCount ?? 0,
      diagnosticsInstalled: Boolean(window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__),
      buildingLayerVisible: Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        .some((input) => input.checked && /Overture 3D buildings/i.test(input.closest("li")?.textContent ?? "")),
    }));
    const requestState = requests.map((request) => ({
      sequence: request.sequence,
      outcome: request.outcome,
      statusCode: request.statusCode,
      dataSource: request.dataSource,
      selectedTileCount: request.selectedTileCount,
      candidateFeatureCount: request.candidateFeatureCount,
      matchedFeatureCount: request.matchedFeatureCount,
      returnedFeatureCount: request.returnedFeatureCount,
      endpointResponseMs: request.endpointResponseMs,
      failure: request.failure,
      routeError: request.routeError,
    }));
    throw new Error(
      "Initial building viewport did not commit before the readiness timeout. " +
      JSON.stringify({
        browserState,
        requests: requestState,
        browserDiagnostics: browserDiagnostics.slice(-20),
        cause: errorText(error),
      }),
    );
  }

  const startupShallowObservation = requests.find((request) => request.sequence === 1);
  if (!startupShallowObservation) {
    throw new Error("The startup building viewport request was not observed.");
  }
  expect(
    startupShallowObservation.viewportWidthDegrees,
    "a shallow startup view must query a bounded local width, not the full horizon rectangle",
  ).not.toBeNull();
  expect(startupShallowObservation.viewportWidthDegrees!).toBeLessThan(0.05);
  expect(
    startupShallowObservation.viewportHeightDegrees,
    "a shallow startup view must query a bounded local height, not the full horizon rectangle",
  ).not.toBeNull();
  expect(startupShallowObservation.viewportHeightDegrees!).toBeLessThan(0.05);
  expect(
    startupShallowObservation.selectedTileCount,
    "the default Dhaka startup view must intersect a populated spatial tile",
  ).not.toBeNull();
  expect(startupShallowObservation.selectedTileCount!).toBeGreaterThan(0);
  expect(
    startupShallowObservation.returnedFeatureCount,
    "the default Dhaka startup view must return building features instead of staging an empty collection",
  ).not.toBeNull();
  expect(startupShallowObservation.returnedFeatureCount!).toBeGreaterThan(0);

  const expectedStartupBoundsKey = boundsKeyFromUrl(
    startupShallowObservation.request.url(),
  );
  if (!expectedStartupBoundsKey) {
    throw new Error("The startup viewport request did not include valid geographic bounds.");
  }
  await expect.poll(async () => page.evaluate((expectedBoundsKey) => {
    const events = window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__ ?? [];
    return events.some((event) => {
      const viewport = event.summary.viewport as Record<string, unknown> | null | undefined;
      const values = ["west", "south", "east", "north"].map((key) => Number(viewport?.[key]));
      if (!values.every(Number.isFinite)) return false;
      const stageBoundsKey = values.map((value) => value.toFixed(6)).join("|");
      return stageBoundsKey === expectedBoundsKey
        && typeof event.summary.returnedFeatures === "number"
        && event.summary.returnedFeatures > 0
        && typeof event.summary.renderedBuildings === "number"
        && event.summary.renderedBuildings > 0;
    });
  }, expectedStartupBoundsKey), {
    timeout: 20_000,
    intervals: [100, 250, 500],
    message: "the first populated startup viewport must actually commit and render buildings",
  }).toBe(true);

  const shallowViewLocalWindowProbe = {
    viewportHash: startupShallowObservation.viewportHash,
    viewportSpanDegrees: {
      width: startupShallowObservation.viewportWidthDegrees,
      height: startupShallowObservation.viewportHeightDegrees,
    },
    selectedTileCount: startupShallowObservation.selectedTileCount,
    availableTileCount: availableSpatialTileCount,
  };

  const stageCountBeforeLocalFocus = await page.evaluate(
    () => window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__?.length ?? 0,
  );
  const urlsBeforeLocalFocus = new Set(requests.map((request) => request.request.url()));
  const localFocusRequestPromise = page.waitForRequest(
    (request) => isViewportRequest(request.url()) && !urlsBeforeLocalFocus.has(request.url()),
    { timeout: 20_000 },
  );
  const focusApplied = await page.evaluate(
    ({ longitude, latitude, heightMeters }) =>
      window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.focusViewportForBenchmark?.(
        longitude,
        latitude,
        heightMeters,
      ) ?? false,
    { longitude: pilotFocus.longitude, latitude: pilotFocus.latitude, heightMeters: 200 },
  );
  expect(focusApplied, "the opt-in camera probe must focus the generated-tile extent").toBe(true);
  const localFocusBrowserRequest = await localFocusRequestPromise;
  await expect.poll(() => {
    const observation = requests.find((request) => request.request === localFocusBrowserRequest);
    return Boolean(
      observation &&
      observation.outcome === "delivered" &&
      observation.statusCode === 200 &&
      observation.selectedTileCount !== null,
    );
  }, { timeout: 20_000 }).toBe(true);
  await waitForStageThenCesiumFrame(page, stageCountBeforeLocalFocus, 45_000);

  const localFocusObservation = requests.find(
    (request) => request.request === localFocusBrowserRequest,
  );
  if (!localFocusObservation || localFocusObservation.selectedTileCount === null) {
    throw new Error("The local-focus viewport response did not expose generated-tile selection diagnostics.");
  }
  expect(localFocusObservation.dataSource, "local focus must use the real generated-tile API")
    .toBe("generated-tiles");
  expect(localFocusObservation.selectedTileCount, "local focus must select at least one tile")
    .toBeGreaterThan(0);
  expect(
    localFocusObservation.selectedTileCount,
    "a close top-down viewport must select fewer than the full tile inventory",
  ).toBeLessThan(availableSpatialTileCount);
  const localFocusSelectivityProbe = {
    viewportHash: localFocusObservation.viewportHash,
    selectedTileCount: localFocusObservation.selectedTileCount,
    availableTileCount: availableSpatialTileCount,
    selectedTileRatio: Number((
      localFocusObservation.selectedTileCount / availableSpatialTileCount
    ).toFixed(4)),
    viewportSpanDegrees: {
      width: localFocusObservation.viewportWidthDegrees,
      height: localFocusObservation.viewportHeightDegrees,
    },
    matchedFeatureCount: localFocusObservation.matchedFeatureCount,
    returnedFeatureCount: localFocusObservation.returnedFeatureCount,
    focusAltitudeMeters: 200,
  };

  const assertViewportManagerIdle = async () => {
    await expect.poll(async () => {
      const lifecycle = await page.evaluate(
        () => window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.getRequestLifecycleDiagnostics?.() ?? null,
      );
      const unsettledBrowserRequests = requests.filter(
        (request) => request.outcome === "in-flight",
      ).length;
      return Boolean(
        lifecycle &&
        !lifecycle.loadInProgress &&
        !lifecycle.hasActiveEndpoint &&
        !lifecycle.hasAbortController &&
        !lifecycle.hasPendingRequest &&
        unsettledBrowserRequests === 0 &&
        routeTasks.size === 0,
      );
    }, {
      timeout: 15_000,
      intervals: [100, 200, 300],
      message: "viewport fetch and stage queue should be idle before the cancellation probe",
    }).toBe(true);
  };

  // A camera preset can emit a late moveEnd after its first stage. Let that
  // ordinary work drain before arming the deliberately delayed request, or the
  // probe may observe an abort from the previous endpoint rather than its own.
  await assertViewportManagerIdle();
  await page.waitForTimeout(450);
  await assertViewportManagerIdle();

  const initialStageCount = await page.evaluate(
    () => window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__?.length ?? 0,
  );
  const memorySamples: MemorySample[] = [];
  await cdp.send("HeapProfiler.collectGarbage");
  memorySamples.push(await sampleMemory("local-focus-retained-after-gc"));

  // Force one known stale viewport response to remain pending. A pan + zoom
  // creates a newer camera intent while its AbortController signal is active.
  const existingRequestUrls = new Set(requests.map((request) => request.request.url()));
  delayNextViewportResponse = true;
  const delayedRequestPromise = page.waitForRequest(
    (request) => isViewportRequest(request.url()) && !existingRequestUrls.has(request.url()),
    { timeout: 20_000 },
  );

  // Put the camera at a different bounded local focus using the opt-in probe,
  // which synchronously invokes the real camera handler. This starts exactly one
  // fresh request without an animated zoom producing competing moveEnd events.
  const cancellationFocusApplied = await page.evaluate(
    ({ longitude, latitude, heightMeters }) =>
      window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.focusViewportForBenchmark?.(
        longitude,
        latitude,
        heightMeters,
      ) ?? false,
    {
      longitude: Math.min(180, pilotFocus.longitude + 0.012),
      latitude: pilotFocus.latitude,
      heightMeters: 220,
    },
  );
  expect(cancellationFocusApplied, "the opt-in camera probe must start a deterministic fresh viewport")
    .toBe(true);

  const delayedBrowserRequest = await delayedRequestPromise;
  await expect.poll(
    () => requests.some((request) => request.request === delayedBrowserRequest),
    { timeout: 10_000 },
  ).toBe(true);
  const delayedStartObservation = requests.find(
    (request) => request.request === delayedBrowserRequest,
  );
  expect(delayedStartObservation?.viewportHash).not.toBeNull();
  await expect.poll(
    () => requests.some((request) =>
      request.request === delayedBrowserRequest && request.delayedForCancellation,
    ),
    { timeout: 10_000 },
  ).toBe(true);

  // This second synchronous camera intent changes the endpoint while the
  // browser response is held. The manager should abort precisely that request.
  const intentProbe = await page.evaluate(
    () => window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.notifyCameraIntent?.() ?? null,
  );
  expect(intentProbe, "the opt-in production camera-intent probe must remain installed")
    .not.toBeNull();
  expect(intentProbe?.loadInProgress, "the deliberately delayed viewport must remain in-flight")
    .toBe(true);
  expect(intentProbe?.cameraBoundsChanged, "the second probe must change the viewport bounds")
    .toBe(true);
  expect(
    intentProbe?.intentRevisionAfter,
    "the camera-intent handler must enqueue a newer viewport revision",
  ).toBeGreaterThan(intentProbe?.intentRevisionBefore ?? Number.MAX_SAFE_INTEGER);

  // Keep the intercepted response pending until the app's AbortController sees
  // the newer camera intent; do not pass based on route cancellation alone.
  const delayedViewportHash = requests.find(
    (request) => request.request === delayedBrowserRequest,
  )?.viewportHash;
  expect(delayedViewportHash, "the deliberately delayed request needs a stable viewport hash")
    .not.toBeNull();
  try {
    await expect.poll(async () => {
      const abortEvents = await page.evaluate(
        () => window.__MAP_ENGINE_WORKLOAD_ABORT_EVENTS__ ?? [],
      );
      return abortEvents.some((event) =>
        hashBounds(boundsKeyFromUrl(event.url)) === delayedViewportHash,
      );
    }, { timeout: CANCEL_RESPONSE_DELAY_MS - 500, intervals: [100, 200, 300] })
      .toBe(true);
  } catch (error) {
    const observedAbortEvents = await page.evaluate(
      () => window.__MAP_ENGINE_WORKLOAD_ABORT_EVENTS__ ?? [],
    );
    const delayedObservation = requests.find(
      (request) => request.request === delayedBrowserRequest,
    );
    throw new Error(
      "Delayed viewport AbortSignal was not observed. " +
      JSON.stringify({
        intentProbe,
        delayedViewportHash,
        abortEventCount: observedAbortEvents.length,
        abortEventHashes: observedAbortEvents.map((event) => ({
          atMs: Number(event.atMs.toFixed(2)),
          viewportHash: hashBounds(boundsKeyFromUrl(event.url)),
        })),
        delayedRequest: delayedObservation ? {
          outcome: delayedObservation.outcome,
          delayedForCancellation: delayedObservation.delayedForCancellation,
          routeResponseReady: delayedObservation.routeResponseReady,
          statusCode: delayedObservation.statusCode,
          routeError: delayedObservation.routeError,
        } : null,
        cause: errorText(error),
      }),
    );
  }

  // Repeat camera movement on the live viewer. This exercises tile selection,
  // response-cache turnover and entity staging over distinct viewport bounds.
  for (let index = 0; index < MOVEMENT_CYCLES; index += 1) {
    const panX = index % 2 === 0 ? -270 : 290;
    const panY = index % 3 === 0 ? 75 : -55;
    await panCanvas(page, panX, panY);

    if (index % 2 === 0) {
      await page.getByRole("button", { name: "Zoom out" }).click();
    } else {
      await page.getByRole("button", { name: "Zoom in" }).click();
    }

    await pause(180);
    memorySamples.push(await sampleMemory("movement-" + String(index + 1)));
  }

  // Let route handlers settle, then require the latest requested viewport to
  // become the committed datasource. Camera intents are coalesced by design,
  // so not every intermediate request is expected to stage.
  await pause(500);
  await Promise.allSettled([...routeTasks]);
  let finalViewportStaged = false;
  try {
    await expect.poll(async () => {
      const latestRequest = requests.filter((request) => request.viewportHash).at(-1);
      if (!latestRequest) return false;
      const expectedBoundsKey = boundsKeyFromUrl(latestRequest.request.url());
      if (!expectedBoundsKey) return false;
      const stageBoundsKeys = await page.evaluate(() =>
        (window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__ ?? []).map((event) => {
          const viewport = event.summary.viewport as Record<string, unknown> | null | undefined;
          const values = ["west", "south", "east", "north"].map((key) => Number(viewport?.[key]));
          return values.every(Number.isFinite)
            ? values.map((value) => value.toFixed(6)).join("|")
            : null;
        }),
      );
      return routeTasks.size === 0
        && stageBoundsKeys.slice(initialStageCount).includes(expectedBoundsKey);
    }, { timeout: 25_000, intervals: [250, 500, 1_000] }).toBe(true);
    finalViewportStaged = true;
  } catch {
    // Preserve the report even if the latest camera intent never reaches commit.
    finalViewportStaged = false;
  }

  await Promise.allSettled([...routeTasks]);
  memorySamples.push(await sampleMemory("final-before-gc"));
  await cdp.send("HeapProfiler.collectGarbage");
  memorySamples.push(await sampleMemory("final-retained-after-gc"));

  const rawStages = await page.evaluate(() => {
    const events = window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__ ?? [];
    return events.map((event) => {
      const summary = event.summary;
      const viewport = summary.viewport as Record<string, unknown> | null | undefined;
      const numbers = ["west", "south", "east", "north"].map((key) => Number(viewport?.[key]));
      const viewportKey = numbers.every(Number.isFinite)
        ? numbers.map((value) => value.toFixed(6)).join("|")
        : null;
      return {
        atMs: event.atMs,
        viewportKey,
        returnedFeatures: typeof summary.returnedFeatures === "number" ? summary.returnedFeatures : null,
        renderedBuildings: typeof summary.renderedBuildings === "number" ? summary.renderedBuildings : null,
        renderedParts: typeof summary.renderedParts === "number" ? summary.renderedParts : null,
        renderedExtrusions: typeof summary.renderedExtrusions === "number" ? summary.renderedExtrusions : null,
        invalidPolygons: typeof summary.invalidPolygons === "number" ? summary.invalidPolygons : null,
      };
    });
  });
  const stages = rawStages.map(({ viewportKey, ...stage }) => ({
    ...stage,
    viewportHash: hashBounds(viewportKey),
  }));

  const frameEvents = await page.evaluate(
    () => window.__MAP_ENGINE_WORKLOAD_FRAME_EVENTS__ ?? [],
  );
  const stageFrameDelaysMs = stages
    .map((stage) => {
      const nextFrame = frameEvents.find((frame) => frame.atMs >= stage.atMs);
      return nextFrame ? Number((nextFrame.atMs - stage.atMs).toFixed(2)) : null;
    })
    .filter((value): value is number => value !== null);

  const browserFetchLifecycleEvents = await page.evaluate(() => {
    return performance.getEntriesByType("resource")
      .filter((entry) => entry.name.includes("/api/geospatial/overture-buildings/viewport"))
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        let viewportKey: string | null = null;
        try {
          const url = new URL(resource.name, window.location.origin);
          const bounds = ["west", "south", "east", "north"].map((key) =>
            Number(url.searchParams.get(key)),
          );
          if (bounds.every(Number.isFinite) && bounds[0] < bounds[2] && bounds[1] < bounds[3]) {
            viewportKey = bounds.map((value) => value.toFixed(6)).join("|");
          }
        } catch {
          viewportKey = null;
        }
        return {
          startTimeMs: resource.startTime,
          responseEndMs: resource.responseEnd,
          viewportKey,
        };
      })
      .filter((event) => event.viewportKey !== null && event.responseEndMs > 0);
  });
  const startupFetchLifecycle = browserFetchLifecycleEvents.find((event) =>
    hashBounds(event.viewportKey) === startupShallowObservation.viewportHash &&
    event.responseEndMs > 0,
  );
  const startupBuildingStage = stages.find((stage) =>
    stage.viewportHash === startupShallowObservation.viewportHash &&
    (stage.renderedBuildings ?? 0) > 0 &&
    (stage.returnedFeatures ?? 0) > 0,
  );
  const startupBuildingFrame = startupBuildingStage
    ? frameEvents.find((frame) => frame.atMs >= startupBuildingStage.atMs)
    : undefined;
  const startupBuildingReadiness = startupFetchLifecycle && startupBuildingStage && startupBuildingFrame
    ? {
      viewportHash: startupShallowObservation.viewportHash,
      requestStartToRenderedBuildingStageMs: Number(
        (startupBuildingStage.atMs - startupFetchLifecycle.startTimeMs).toFixed(2),
      ),
      responseBodyEndToRenderedBuildingStageMs: Number(
        (startupBuildingStage.atMs - startupFetchLifecycle.responseEndMs).toFixed(2),
      ),
      buildingStageToPostRenderFrameMs: Number(
        (startupBuildingFrame.atMs - startupBuildingStage.atMs).toFixed(2),
      ),
      returnedFeatures: startupBuildingStage.returnedFeatures,
      renderedBuildings: startupBuildingStage.renderedBuildings,
      postRenderFrameSequence: startupBuildingFrame.frameSequence,
    }
    : null;

  const successfulGeneratedTileRequests = requests.filter((request) =>
    request.statusCode === 200 &&
    request.dataSource === "generated-tiles" &&
    request.selectedTileCount !== null,
  );
  const completedRequests = requests.filter((request) => request.outcome === "delivered");
  const cancelledRequests = requests.filter((request) => request.outcome === "cancelled");
  const delayedCancellationRequest = requests.find((request) => request.delayedForCancellation);
  const rawFetchAbortEvents = await page.evaluate(
    () => window.__MAP_ENGINE_WORKLOAD_ABORT_EVENTS__ ?? [],
  );
  const fetchAbortEvents = rawFetchAbortEvents.map((event) => ({
    atMs: Number(event.atMs),
    viewportHash: hashBounds(boundsKeyFromUrl(event.url)),
  })).filter((event) => event.viewportHash !== null);
  const abortedViewportHashes = new Set(fetchAbortEvents.map((event) => event.viewportHash));
  const staleDelayedFetchSignalAborted = Boolean(
    delayedCancellationRequest?.viewportHash &&
    abortedViewportHashes.has(delayedCancellationRequest.viewportHash),
  );
  const staleDelayedResponseNotStaged = Boolean(
    delayedCancellationRequest?.viewportHash &&
    !stages.some((stage) => stage.viewportHash === delayedCancellationRequest.viewportHash),
  );
  const latestRequestedViewportHash = requests.filter((request) => request.viewportHash).at(-1)?.viewportHash ?? null;
  const uniqueViewports = new Set(requests.map((request) => request.viewportHash).filter(Boolean));
  const allTileCounts = successfulGeneratedTileRequests
    .map((request) => request.selectedTileCount!)
    .filter((count) => Number.isFinite(count));
  const maxTilesInViewport = allTileCounts.length ? Math.max(...allTileCounts) : 0;
  const totalSelectedTileLoads = allTileCounts.reduce((sum, count) => sum + count, 0);
  const costMeasuredRequests = successfulGeneratedTileRequests.filter((request) =>
    request.candidatePayloadBytes !== null &&
    request.indexReadBytes !== null &&
    request.featureReadBytes !== null &&
    request.fetchedFeatureCount !== null &&
    request.featureLimit !== null,
  );
  const totalCandidatePayloadBytes = costMeasuredRequests.reduce(
    (sum, request) => sum + request.candidatePayloadBytes!,
    0,
  );
  const totalIndexReadBytes = costMeasuredRequests.reduce(
    (sum, request) => sum + request.indexReadBytes!,
    0,
  );
  const totalFeatureReadBytes = costMeasuredRequests.reduce(
    (sum, request) => sum + request.featureReadBytes!,
    0,
  );
  const totalSelectiveReadBytes = totalIndexReadBytes + totalFeatureReadBytes;
  const geometryPayloadReductionRatio = totalCandidatePayloadBytes > 0
    ? Number((1 - totalFeatureReadBytes / totalCandidatePayloadBytes).toFixed(4))
    : null;
  const combinedReadReductionRatio = totalCandidatePayloadBytes > 0
    ? Number((1 - totalSelectiveReadBytes / totalCandidatePayloadBytes).toFixed(4))
    : null;
  const geometryFetchBudgetViolations = costMeasuredRequests.filter(
    (request) => request.fetchedFeatureCount! > request.featureLimit!,
  ).length;
  const indexCacheMissRequestCount = costMeasuredRequests.filter(
    (request) => request.indexReadBytes! > 0,
  ).length;
  const viewportWidthSummary = summarizeSpan(
    requests.map((request) => request.viewportWidthDegrees)
      .filter((value): value is number => value !== null),
  );
  const viewportHeightSummary = summarizeSpan(
    requests.map((request) => request.viewportHeightDegrees)
      .filter((value): value is number => value !== null),
  );

  const heapValues = memorySamples.map((sample) => sample.jsHeapUsedBytes);
  const validHeapValues = heapValues.filter((value): value is number => value !== null);
  const initialRetainedHeap = memorySamples[0]?.jsHeapUsedBytes ?? null;
  const finalRetainedHeap = memorySamples.at(-1)?.jsHeapUsedBytes ?? null;
  const retainedHeapGrowthBytes = initialRetainedHeap !== null && finalRetainedHeap !== null
    ? finalRetainedHeap - initialRetainedHeap
    : null;
  const maxHeap = validHeapValues.length ? Math.max(...validHeapValues) : null;
  const transientPeakGrowthBytes = initialRetainedHeap !== null && maxHeap !== null
    ? maxHeap - initialRetainedHeap
    : null;
  const movementHeapValues = memorySamples
    .filter((sample) => sample.label.startsWith("movement-"))
    .map((sample) => sample.jsHeapUsedBytes);
  const firstNodeCount = memorySamples.find((sample) => sample.domNodeCount !== null)?.domNodeCount ?? null;
  const lastNodeCount = [...memorySamples].reverse().find((sample) => sample.domNodeCount !== null)?.domNodeCount ?? null;
  const nodeDelta = firstNodeCount !== null && lastNodeCount !== null
    ? lastNodeCount - firstNodeCount
    : null;
  const memoryGuardPass = retainedHeapGrowthBytes !== null &&
    retainedHeapGrowthBytes <= MAX_HEAP_GROWTH_BYTES &&
    nodeDelta !== null &&
    nodeDelta <= MAX_DOM_NODE_GROWTH;

  const report = {
    benchmark: "p2.6-real-multi-tile-viewport-workload",
    generatedAt: new Date().toISOString(),
    candidateSha: process.env.GITHUB_SHA ?? null,
    dataset: {
      spatialTileManifestSha256,
      availableSpatialTileCount,
      extentSpanDegrees: {
        width: Number((pilotExtent.east - pilotExtent.west).toFixed(6)),
        height: Number((pilotExtent.north - pilotExtent.south).toFixed(6)),
      },
    },
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      browser: "Chromium via Playwright/CDP",
      baseURL: process.env.MAP_E2E_BASE_URL ?? "http://127.0.0.1:3000",
      workloadDurationMs: Number((performance.now() - workloadStartedAt).toFixed(2)),
    },
    workload: {
      movementCycles: MOVEMENT_CYCLES,
      viewportRequestCount: requests.length,
      browserFetchLifecycleObservationCount: browserFetchLifecycleEvents.length,
      deliveredRequestCount: completedRequests.length,
      browserCancelledRequestCount: cancelledRequests.length,
      failedRequestCount: requests.filter((request) => request.outcome === "failed" || request.outcome === "route-error").length,
      fetchAbortSignalCount: fetchAbortEvents.length,
      uniqueViewportCount: uniqueViewports.size,
      shallowViewLocalWindowProbe,
      localFocusSelectivityProbe,
      delayedCancellationRequestObserved: delayedResponseClaimed,
      delayedCancellationOutcome: delayedCancellationRequest?.outcome ?? null,
      staleDelayedFetchSignalAborted,
      staleDelayedResponseNotStaged,
      viewportResponses: requests.map((request) => ({
        sequence: request.sequence,
        viewportHash: request.viewportHash,
        viewportSpanDegrees: {
          width: request.viewportWidthDegrees,
          height: request.viewportHeightDegrees,
        },
        outcome: request.outcome,
        statusCode: request.statusCode,
        dataSource: request.dataSource,
        selectedTileCount: request.selectedTileCount,
        candidateFeatureCount: request.candidateFeatureCount,
        matchedFeatureCount: request.matchedFeatureCount,
        returnedFeatureCount: request.returnedFeatureCount,
        fetchCost: {
          candidatePayloadBytes: request.candidatePayloadBytes,
          indexReadBytes: request.indexReadBytes,
          featureReadBytes: request.featureReadBytes,
          fetchedFeatureCount: request.fetchedFeatureCount,
          featureLimit: request.featureLimit,
        },
        endpointResponseMs: request.endpointResponseMs,
        delayedForCancellation: request.delayedForCancellation,
        routeResponseReady: request.routeResponseReady,
        failure: request.failure,
        routeError: request.routeError,
      })),
      generatedSpatialTiles: {
        successfulResponseCount: successfulGeneratedTileRequests.length,
        availableTileCount: availableSpatialTileCount,
        totalSelectedTileLoads,
        maxTilesInOneViewport: maxTilesInViewport,
        meanSelectedTilesPerViewport: allTileCounts.length
          ? Number((totalSelectedTileLoads / allTileCounts.length).toFixed(2))
          : null,
        meanSelectedTileRatio: availableSpatialTileCount && allTileCounts.length
          ? Number((totalSelectedTileLoads / (availableSpatialTileCount * allTileCounts.length)).toFixed(4))
          : null,
        viewportsSelectingMultipleTiles: successfulGeneratedTileRequests.filter(
          (request) => (request.selectedTileCount ?? 0) > 1,
        ).length,
        viewportWidthDegrees: viewportWidthSummary,
        viewportHeightDegrees: viewportHeightSummary,
        fetchCostEvidence: {
          measuredRequestCount: costMeasuredRequests.length,
          fullSelectedTilePayloadBaselineBytes: totalCandidatePayloadBytes,
          indexBytesReadDuringWorkload: totalIndexReadBytes,
          indexCacheMissRequestCount,
          selectedFeatureGeometryReadBytes: totalFeatureReadBytes,
          combinedIndexAndGeometryReadBytes: totalSelectiveReadBytes,
          geometryPayloadReductionRatio,
          combinedReadReductionRatio,
          geometryFetchBudgetViolations,
          limitation: "Selected-tile bytes are a per-request whole-payload baseline, not a physical-disk-I/O or wall-clock speedup estimate. The browser workload runs after API integration tests in the same server process, so its index cache can already be warm; cold-request index bytes are logged separately by the API integration suite.",
        },
      },
    },
    readiness: {
      firstBuilding: startupBuildingReadiness,
      buildingStageCount: stages.length,
      initialStageCount,
      cesiumPostRenderFrameCount: frameEvents.length,
      stageToNextPostRenderFrameMs: {
        samples: stageFrameDelaysMs,
        p50Ms: percentile(stageFrameDelaysMs, 0.5),
        p95Ms: percentile(stageFrameDelaysMs, 0.95),
        allStagesHaveFollowingFrame: stageFrameDelaysMs.length === stages.length && stages.length > 0,
      },
      finalViewportStaged,
      latestRequestedViewportHash,
      staleDelayedResponseNotStaged,
      stages: stages.map((stage) => ({
        viewportHash: stage.viewportHash,
        returnedFeatures: stage.returnedFeatures,
        renderedBuildings: stage.renderedBuildings,
        renderedParts: stage.renderedParts,
        renderedExtrusions: stage.renderedExtrusions,
        invalidPolygons: stage.invalidPolygons,
      })),
    },
    memory: {
      measurement: "Chromium CDP JS heap and DOM counters; excludes GPU/native tile memory",
      samples: memorySamples,
      retainedHeapGrowthBytes,
      observedHeapPeakBytes: maxHeap,
      transientPeakGrowthBytes,
      heapTrendBytesPerMovementSample: linearTrendSlope(movementHeapValues),
      domNodeGrowth: nodeDelta,
      limits: {
        maxHeapGrowthBytes: MAX_HEAP_GROWTH_BYTES,
        maxDomNodeGrowth: MAX_DOM_NODE_GROWTH,
      },
      guardPassed: memoryGuardPass,
    },
    limitations: [
      "This is an end-to-end browser workload against the real generated Overture spatial-tile API, with road and basemap network responses stubbed for repeatability.",
      "The delayed request's application AbortSignal is observed directly; browser-network cancellation events are recorded separately because route interception can outlive the upstream API response.",
      "Heap and DOM metrics do not include GPU allocations, Cesium native resources, or operating-system process memory.",
      "Tile counts describe selected generated spatial tiles for each viewport; they do not represent downloaded OGC 3D Tiles payload bytes.",
      "For shallow camera angles, detailed building queries are clipped to a camera-height-aware local window around the centre-ray ground point; distant horizon buildings are loaded when the camera moves or zooms to that area.",
    ],
  };

  const artifactPath = resolve(process.cwd(), "test-results", "multi-tile-viewport-workload.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await testInfo.attach("multi-tile-viewport-workload.json", {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });
  console.log("[P2.6 multi-tile viewport workload]", JSON.stringify(report));

  expect(successfulGeneratedTileRequests.length, "the real Overture viewport endpoint must use the generated spatial-tile manifest").toBeGreaterThan(0);
  expect(costMeasuredRequests.length, "real viewport responses must expose P2.9 byte and geometry-fetch diagnostics").toBeGreaterThan(0);
  expect(totalCandidatePayloadBytes, "the selected-tile whole-payload baseline must be measurable").toBeGreaterThan(0);
  expect(totalFeatureReadBytes, "the sampled feature payload cost must be measurable").toBeGreaterThan(0);
  expect(geometryPayloadReductionRatio, "feature-only reads should be below the whole selected-tile payload baseline").not.toBeNull();
  expect(geometryPayloadReductionRatio!).toBeGreaterThan(0);
  expect(geometryFetchBudgetViolations, "tile-backed geometry reads must remain within each request's response feature limit").toBe(0);
  expect(maxTilesInViewport, "at least one viewport must select multiple generated spatial tiles").toBeGreaterThan(1);
  expect(uniqueViewports.size, "repeated pan/zoom must produce distinct viewport requests").toBeGreaterThanOrEqual(4);
  expect(fetchAbortEvents.length, "a newer camera intent must abort at least one viewport fetch signal").toBeGreaterThan(0);
  expect(staleDelayedFetchSignalAborted, "the deliberately delayed stale viewport fetch signal must be aborted").toBe(true);
  expect(staleDelayedResponseNotStaged, "the deliberately delayed stale viewport must never be committed to Cesium").toBe(true);
  expect(finalViewportStaged, "the latest stable viewport intent must eventually commit after pan/zoom churn").toBe(true);
  expect(stages.length, "the initial and final committed viewport stages must be observed").toBeGreaterThanOrEqual(2);
  expect(stageFrameDelaysMs.length, "each staged viewport must be followed by an actual Cesium postRender frame").toBe(stages.length);
  expect(startupBuildingReadiness, "the first startup viewport must be tied to a rendered-building stage and a later Cesium postRender frame").not.toBeNull();
  expect(startupBuildingReadiness!.requestStartToRenderedBuildingStageMs, "first building readiness should be measured from browser fetch start").toBeGreaterThanOrEqual(0);
  expect(startupBuildingReadiness!.responseBodyEndToRenderedBuildingStageMs, "building staging should follow the completed browser response body").toBeGreaterThanOrEqual(0);
  expect(startupBuildingReadiness!.buildingStageToPostRenderFrameMs, "first rendered building stage should be followed by a real Cesium frame").toBeGreaterThanOrEqual(0);
  expect(validHeapValues.length, "Chromium JS heap metrics must be available for the memory trend").toBeGreaterThanOrEqual(5);
  expect(memoryGuardPass, "repeated camera movement must not exceed the broad JS heap/DOM growth guard").toBe(true);
});
