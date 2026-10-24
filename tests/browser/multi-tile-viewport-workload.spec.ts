import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, test, type Page, type Request, type Route } from "@playwright/test";

type WorkloadFrameDiagnostics = {
  frameCount: number;
  lastFrameNumber: number;
  lastFrameAtMs: number;
};

type StageEvent = {
  atMs: number;
  summary: Record<string, unknown>;
};

type FrameEvent = {
  atMs: number;
  frameNumber: number;
};

declare global {
  interface Window {
    __MAP_ENGINE_WORKLOAD_BENCHMARK__?: boolean;
    __MAP_ENGINE_WORKLOAD_DIAGNOSTICS__?: WorkloadFrameDiagnostics;
    __MAP_ENGINE_WORKLOAD_STAGE_EVENTS__?: StageEvent[];
    __MAP_ENGINE_WORKLOAD_FRAME_EVENTS__?: FrameEvent[];
  }
}

type ViewportRequestObservation = {
  sequence: number;
  request: Request;
  startedAtMs: number;
  viewportHash: string | null;
  outcome: "in-flight" | "delivered" | "cancelled" | "failed" | "route-error";
  delayedForCancellation: boolean;
  statusCode: number | null;
  dataSource: string | null;
  selectedTileCount: number | null;
  candidateFeatureCount: number | null;
  matchedFeatureCount: number | null;
  returnedFeatureCount: number | null;
  serverResponseMs: number | null;
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
const CANCEL_RESPONSE_DELAY_MS = 1_500;
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
    const url = new URL(rawUrl);
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
  return error instanceof Error ? error.name + ": " + error.message : String(error);
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
  await page.waitForFunction(
    (previousStageCount) => {
      const stages = window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__ ?? [];
      const frames = window.__MAP_ENGINE_WORKLOAD_FRAME_EVENTS__ ?? [];

      return stages.slice(previousStageCount).some((stage) =>
        frames.some((frame) => frame.atMs >= stage.atMs),
      );
    },
    minimumStageCount,
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

    const originalInfo = console.info.bind(console);
    console.info = (...args: unknown[]) => {
      if (args[0] === "[Overture] Building viewport rendered.") {
        const summary = args[1] && typeof args[1] === "object"
          ? args[1] as Record<string, unknown>
          : {};
        const events = window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__ ??= [];
        events.push({ atMs: performance.now(), summary });
        if (events.length > 500) events.splice(0, events.length - 500);
      }
      originalInfo(...args);
    };

    window.addEventListener("map:frame-ready", (event: Event) => {
      const detail = (event as CustomEvent<WorkloadFrameDiagnostics>).detail;
      if (!detail || !Number.isFinite(detail.lastFrameAtMs)) return;

      const frames = window.__MAP_ENGINE_WORKLOAD_FRAME_EVENTS__ ??= [];
      frames.push({
        atMs: detail.lastFrameAtMs,
        frameNumber: detail.lastFrameNumber,
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
        statusCode: null,
        dataSource: null,
        selectedTileCount: null,
        candidateFeatureCount: null,
        matchedFeatureCount: null,
        returnedFeatureCount: null,
        serverResponseMs: null,
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
        observation.serverResponseMs = Number((performance.now() - observation.startedAtMs).toFixed(2));

        if (delayNextViewportResponse && !delayedResponseClaimed) {
          delayNextViewportResponse = false;
          delayedResponseClaimed = true;
          observation.delayedForCancellation = true;
          await pause(CANCEL_RESPONSE_DELAY_MS);
        }

        await route.fulfill({ response: upstream });
        observation.completedAtMs ??= performance.now();
        if (observation.outcome === "in-flight") observation.outcome = "delivered";
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
    observation.completedAtMs = performance.now();
    if (observation.outcome === "in-flight") observation.outcome = "delivered";
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

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

  await expect.poll(
    () => requests.some((request) => request.statusCode === 200),
    { timeout: 45_000 },
  ).toBe(true);
  await waitForStageThenCesiumFrame(page, 0, 45_000);

  const initialStageCount = await page.evaluate(
    () => window.__MAP_ENGINE_WORKLOAD_STAGE_EVENTS__?.length ?? 0,
  );
  const memorySamples: MemorySample[] = [];
  memorySamples.push(await sampleMemory("initial-stable"));

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
  await pause(CANCEL_RESPONSE_DELAY_MS + 300);

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

  // Allow the last fetch/stage to settle, then guarantee a report even when a
  // regression causes one of the workload gates below to fail.
  await pause(2_000);
  await Promise.allSettled([...routeTasks]);
  memorySamples.push(await sampleMemory("final-stable"));

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
  const uniqueViewports = new Set(requests.map((request) => request.viewportHash).filter(Boolean));
  const allTileCounts = successfulGeneratedTileRequests
    .map((request) => request.selectedTileCount!)
    .filter((count) => Number.isFinite(count));
  const maxTilesInViewport = allTileCounts.length ? Math.max(...allTileCounts) : 0;
  const totalSelectedTileLoads = allTileCounts.reduce((sum, count) => sum + count, 0);

  const heapValues = memorySamples.map((sample) => sample.jsHeapUsedBytes);
  const validHeapValues = heapValues.filter((value): value is number => value !== null);
  const firstHeap = validHeapValues[0] ?? null;
  const lastHeap = validHeapValues.at(-1) ?? null;
  const heapDelta = firstHeap !== null && lastHeap !== null ? lastHeap - firstHeap : null;
  const maxHeap = validHeapValues.length ? Math.max(...validHeapValues) : null;
  const firstNodeCount = memorySamples.find((sample) => sample.domNodeCount !== null)?.domNodeCount ?? null;
  const lastNodeCount = [...memorySamples].reverse().find((sample) => sample.domNodeCount !== null)?.domNodeCount ?? null;
  const nodeDelta = firstNodeCount !== null && lastNodeCount !== null
    ? lastNodeCount - firstNodeCount
    : null;
  const memoryGuardPass = heapDelta !== null &&
    heapDelta <= MAX_HEAP_GROWTH_BYTES &&
    nodeDelta !== null &&
    nodeDelta <= MAX_DOM_NODE_GROWTH;

  const report = {
    benchmark: "p2.6-real-multi-tile-viewport-workload",
    generatedAt: new Date().toISOString(),
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
      cancelledRequestCount: cancelledRequests.length,
      failedRequestCount: requests.filter((request) => request.outcome === "failed" || request.outcome === "route-error").length,
      uniqueViewportCount: uniqueViewports.size,
      delayedCancellationRequestObserved: delayedResponseClaimed,
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
        serverResponseMs: request.serverResponseMs,
        delayedForCancellation: request.delayedForCancellation,
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
      heapGrowthBytes: heapDelta,
      heapMaxBytes: maxHeap,
      heapTrendBytesPerSample: linearTrendSlope(heapValues),
      domNodeGrowth: nodeDelta,
      limits: {
        maxHeapGrowthBytes: MAX_HEAP_GROWTH_BYTES,
        maxDomNodeGrowth: MAX_DOM_NODE_GROWTH,
      },
      guardPassed: memoryGuardPass,
    },
    limitations: [
      "This is an end-to-end browser workload against the real generated Overture spatial-tile API, with road and basemap network responses stubbed for repeatability.",
      "The intentional response delay tests browser-side stale-request cancellation; the API request may already have completed on the server before the browser cancels it.",
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
  expect(cancelledRequests.length, "a stale in-flight viewport request must be cancelled after a newer camera intent").toBeGreaterThan(0);
  expect(stages.length, "several viewport payloads must be staged into Cesium").toBeGreaterThanOrEqual(4);
  expect(stageFrameDelaysMs.length, "each staged viewport must be followed by an actual Cesium postRender frame").toBeGreaterThan(0);
  expect(validHeapValues.length, "Chromium JS heap metrics must be available for the memory trend").toBeGreaterThanOrEqual(5);
  expect(memoryGuardPass, "repeated camera movement must not exceed the broad JS heap/DOM growth guard").toBe(true);
});
