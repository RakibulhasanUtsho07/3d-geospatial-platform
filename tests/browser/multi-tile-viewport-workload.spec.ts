import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, test, type Page, type Request, type Route } from "@playwright/test";

type WorkloadFrameDiagnostics = {
  frameCount: number;
  lastFrameAtMs: number;
  requestRender?: () => void;
  notifyCameraIntent?: () => {
    loadInProgress: boolean;
    intentRevisionBefore: number;
    intentRevisionAfter: number;
    viewportWidthDegrees: number | null;
    viewportHeightDegrees: number | null;
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

declare global {
  interface Window {
    __MAP_ENGINE_WORKLOAD_BENCHMARK__?: boolean;
    __MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?: WorkloadFrameDiagnostics;
    __MAP_ENGINE_WORKLOAD_STAGE_EVENTS__?: StageEvent[];
    __MAP_ENGINE_WORKLOAD_FRAME_EVENTS__?: FrameEvent[];
    __MAP_ENGINE_WORKLOAD_ABORT_EVENTS__?: FetchAbortEvent[];
  }
}

type ViewportRequestObservation = {
  sequence: number;
  request: Request;
  startedAtMs: number;
  viewportHash: string | null;
  outcome: "in-flight" | "delivered" | "cancelled" | "failed" | "route-error";
  delayedForCancellation: boolean;
  routeResponseReady: boolean;
  statusCode: number | null;
  dataSource: string | null;
  selectedTileCount: number | null;
  candidateFeatureCount: number | null;
  matchedFeatureCount: number | null;
  returnedFeatureCount: number | null;
  endpointResponseMs: number | null;
  completedAtMs: number | null;
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

    // Observe the real signal supplied by BuildingViewportManager.fetch().
    // Store URLs only in this in-memory test page; exported reports contain
    // only the SHA-256 viewport hash, never raw coordinates.
    const nativeFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : typeof input === "object" && input !== null && "url" in input
            ? String((input as { url?: unknown }).url ?? "")
            : String(input);
      const signal = init?.signal;
      if (requestUrl.includes("/api/geospatial/overture-buildings/viewport") && signal) {
        const recordAbort = () => {
          const events = window.__MAP_ENGINE_WORKLOAD_ABORT_EVENTS__ ??= [];
          events.push({ atMs: performance.now(), url: requestUrl });
        };
        if (signal.aborted) recordAbort();
        else signal.addEventListener("abort", recordAbort, { once: true });
      }
      return nativeFetch(input, init);
    }) as typeof window.fetch;

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
      const observation: ViewportRequestObservation = {
        sequence: requests.length + 1,
        request,
        startedAtMs: performance.now(),
        viewportHash: hashBounds(boundsKeyFromUrl(request.url())),
        outcome: "in-flight",
        delayedForCancellation: false,
        routeResponseReady: false,
        statusCode: null,
        dataSource: null,
        selectedTileCount: null,
        candidateFeatureCount: null,
        matchedFeatureCount: null,
        returnedFeatureCount: null,
        endpointResponseMs: null,
        completedAtMs: null,
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
        observation.endpointResponseMs = Number((performance.now() - observation.startedAtMs).toFixed(2));

        if (delayNextViewportResponse && !delayedResponseClaimed) {
          delayNextViewportResponse = false;
          delayedResponseClaimed = true;
          observation.delayedForCancellation = true;
          await pause(CANCEL_RESPONSE_DELAY_MS);
        }

        await route.fulfill({ response: upstream });
        observation.routeResponseReady = true;
        observation.completedAtMs ??= performance.now();
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
    observation.completedAtMs = performance.now();
    observation.outcome = /abort|cancel/i.test(failure) ? "cancelled" : "failed";
  });

  page.on("response", (response) => {
    const observation = observationByRequest.get(response.request());
    if (!observation) return;

    observation.statusCode = response.status();
    observation.routeResponseReady = true;
    observation.completedAtMs = performance.now();
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

  const initialStageCount = await page.evaluate(
    () => window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__?.length ?? 0,
  );
  const memorySamples: MemorySample[] = [];
  await cdp.send("HeapProfiler.collectGarbage");
  memorySamples.push(await sampleMemory("initial-retained-after-gc"));

  // Force one known stale viewport response to remain pending. A pan + zoom
  // creates a newer camera intent while its AbortController signal is active.
  const existingRequestUrls = new Set(requests.map((request) => request.request.url()));
  delayNextViewportResponse = true;
  const delayedRequestPromise = page.waitForRequest(
    (request) => isViewportRequest(request.url()) && !existingRequestUrls.has(request.url()),
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: "Zoom out" }).click();
  const delayedBrowserRequest = await delayedRequestPromise;
  await expect.poll(
    () => requests.some((request) =>
      request.request === delayedBrowserRequest && request.delayedForCancellation,
    ),
    { timeout: 10_000 },
  ).toBe(true);

  await panCanvas(page, 280, 90);
  await page.getByRole("button", { name: "Zoom out" }).click();

  // Process the camera's current bounds through the same production handler
  // attached to Cesium camera.moveEnd. The actual pointer and zoom operations
  // above move the viewer; this opt-in hook only makes intent notification
  // deterministic across headless browser timing.
  const intentProbe = await page.evaluate(
    () => window.__MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?.notifyCameraIntent?.() ?? null,
  );
  expect(intentProbe, "the opt-in production camera-intent probe must be installed")
    .not.toBeNull();
  expect(intentProbe?.loadInProgress, "the deliberately delayed viewport must remain in-flight")
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
  await expect.poll(async () => {
    const abortEvents = await page.evaluate(
      () => window.__MAP_ENGINE_WORKLOAD_ABORT_EVENTS__ ?? [],
    );
    return abortEvents.some((event) =>
      hashBounds(boundsKeyFromUrl(event.url)) === delayedViewportHash,
    );
  }, { timeout: CANCEL_RESPONSE_DELAY_MS - 500, intervals: [100, 200, 300] })
    .toBe(true);

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

  const tileManifestPath = resolve(process.cwd(), "data", "overture", "spatial-tiles", "manifest.json");
  let spatialTileManifestSha256: string | null = null;
  try {
    spatialTileManifestSha256 = createHash("sha256")
      .update(await readFile(tileManifestPath))
      .digest("hex");
  } catch {
    // The endpoint-backed tile assertions below will fail if the generated
    // manifest is absent; still preserve diagnostic output first.
  }

  const report = {
    benchmark: "p2.6-real-multi-tile-viewport-workload",
    generatedAt: new Date().toISOString(),
    candidateSha: process.env.GITHUB_SHA ?? null,
    dataset: { spatialTileManifestSha256 },
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
      deliveredRequestCount: completedRequests.length,
      browserCancelledRequestCount: cancelledRequests.length,
      failedRequestCount: requests.filter((request) => request.outcome === "failed" || request.outcome === "route-error").length,
      fetchAbortSignalCount: fetchAbortEvents.length,
      uniqueViewportCount: uniqueViewports.size,
      delayedCancellationRequestObserved: delayedResponseClaimed,
      delayedCancellationOutcome: delayedCancellationRequest?.outcome ?? null,
      staleDelayedFetchSignalAborted,
      staleDelayedResponseNotStaged,
      viewportResponses: requests.map((request) => ({
        sequence: request.sequence,
        viewportHash: request.viewportHash,
        outcome: request.outcome,
        statusCode: request.statusCode,
        dataSource: request.dataSource,
        selectedTileCount: request.selectedTileCount,
        candidateFeatureCount: request.candidateFeatureCount,
        matchedFeatureCount: request.matchedFeatureCount,
        returnedFeatureCount: request.returnedFeatureCount,
        endpointResponseMs: request.endpointResponseMs,
        delayedForCancellation: request.delayedForCancellation,
        routeResponseReady: request.routeResponseReady,
        failure: request.failure,
        routeError: request.routeError,
      })),
      generatedSpatialTiles: {
        successfulResponseCount: successfulGeneratedTileRequests.length,
        totalSelectedTileLoads,
        maxTilesInOneViewport: maxTilesInViewport,
        viewportsSelectingMultipleTiles: successfulGeneratedTileRequests.filter(
          (request) => (request.selectedTileCount ?? 0) > 1,
        ).length,
      },
    },
    readiness: {
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
  expect(maxTilesInViewport, "at least one viewport must select multiple generated spatial tiles").toBeGreaterThan(1);
  expect(uniqueViewports.size, "repeated pan/zoom must produce distinct viewport requests").toBeGreaterThanOrEqual(4);
  expect(fetchAbortEvents.length, "a newer camera intent must abort at least one viewport fetch signal").toBeGreaterThan(0);
  expect(staleDelayedFetchSignalAborted, "the deliberately delayed stale viewport fetch signal must be aborted").toBe(true);
  expect(staleDelayedResponseNotStaged, "the deliberately delayed stale viewport must never be committed to Cesium").toBe(true);
  expect(finalViewportStaged, "the latest stable viewport intent must eventually commit after pan/zoom churn").toBe(true);
  expect(stages.length, "the initial and final committed viewport stages must be observed").toBeGreaterThanOrEqual(2);
  expect(stageFrameDelaysMs.length, "each staged viewport must be followed by an actual Cesium postRender frame").toBe(stages.length);
  expect(validHeapValues.length, "Chromium JS heap metrics must be available for the memory trend").toBeGreaterThanOrEqual(5);
  expect(memoryGuardPass, "repeated camera movement must not exceed the broad JS heap/DOM growth guard").toBe(true);
});
