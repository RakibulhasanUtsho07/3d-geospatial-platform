#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "http://127.0.0.1:3000/map";
const DATA_INPUTS = [
  "data/overture/spatial-tiles/manifest.json",
  "data/overture/dhaka-buildings-3d-pilot.geojson",
];

function readInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(name + " must be an integer from " + minimum + " to " + maximum + ".");
  }
  return parsed;
}

function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError("fraction must be between 0 and 1.");
  }
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

export function summarizeValues(values) {
  const clean = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (clean.length === 0) {
    return { sampleCount: 0, min: null, median: null, p95: null, max: null, mean: null };
  }
  const sorted = [...clean].sort((left, right) => left - right);
  return {
    sampleCount: clean.length,
    min: Number(sorted[0].toFixed(2)),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    mean: Number((clean.reduce((sum, value) => sum + value, 0) / clean.length).toFixed(2)),
  };
}

export function classifyResourceUrl(resourceUrl, pageOrigin) {
  try {
    const parsed = new URL(resourceUrl);
    if (parsed.origin !== pageOrigin) return "third-party";
    if (parsed.pathname.startsWith("/api/")) return "api";
    if (parsed.pathname.startsWith("/cesium/")) return "cesium-assets";
    if (/\.(?:js|mjs|css|woff2?|ttf|otf)$/i.test(parsed.pathname)) return "static-assets";
    return "same-origin-other";
  } catch {
    return "unknown";
  }
}

function roundMs(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(Math.max(0, value).toFixed(2))
    : null;
}

function safeGitValue(args) {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function hashFile(relativePath) {
  const absolutePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolutePath);
  const reportPath = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative : "external-configured-road-extract";
  try {
    const bytes = await readFile(absolutePath);
    return {
      path: reportPath,
      exists: true,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { path: reportPath, exists: false, bytes: null, sha256: null };
    }
    throw error;
  }
}

export function createNetworkCounters() {
  const groups = Object.create(null);
  const failures = Object.create(null);
  const activeRoadRequests = new Set();
  const roadApi = {
    requestCount: 0, responseCount: 0, status2xx: 0, status3xx: 0,
    status4xx: 0, status5xx: 0, otherStatus: 0, failedRequests: 0,
    detailLevelResponses: Object.create(null),
    sourceResponses: Object.create(null),
    upstreamAttempts: { sampleCount: 0, total: 0, max: null },
  };

  function isRoadApiUrl(resourceUrl, origin) {
    try {
      const parsed = new URL(resourceUrl);
      return parsed.origin === origin && parsed.pathname === "/api/geospatial/roads";
    } catch {
      return false;
    }
  }

  return {
    reset() {
      for (const key of Object.keys(groups)) delete groups[key];
      for (const key of Object.keys(failures)) delete failures[key];
      Object.assign(roadApi, {
        requestCount: 0, responseCount: 0, status2xx: 0, status3xx: 0,
        status4xx: 0, status5xx: 0, otherStatus: 0, failedRequests: 0,
        upstreamAttempts: { sampleCount: 0, total: 0, max: null },
      });
      for (const key of Object.keys(roadApi.detailLevelResponses)) delete roadApi.detailLevelResponses[key];
      for (const key of Object.keys(roadApi.sourceResponses)) delete roadApi.sourceResponses[key];
      activeRoadRequests.clear();
    },
    recordRequest(resourceUrl, origin, request) {
      if (!isRoadApiUrl(resourceUrl, origin)) return;
      roadApi.requestCount += 1;
      activeRoadRequests.add(request);
    },
    finishRequest(request) {
      activeRoadRequests.delete(request);
    },
    getPendingRoadRequestCount() {
      return activeRoadRequests.size;
    },
    recordResponse(resourceUrl, origin, status, headers = {}) {
      const group = classifyResourceUrl(resourceUrl, origin);
      if (!groups[group]) {
        groups[group] = {
          responseCount: 0, status2xx: 0, status3xx: 0,
          status4xx: 0, status5xx: 0, otherStatus: 0,
        };
      }
      const item = groups[group];
      item.responseCount += 1;
      if (status >= 200 && status < 300) item.status2xx += 1;
      else if (status >= 300 && status < 400) item.status3xx += 1;
      else if (status >= 400 && status < 500) item.status4xx += 1;
      else if (status >= 500 && status < 600) item.status5xx += 1;
      else item.otherStatus += 1;

      if (isRoadApiUrl(resourceUrl, origin)) {
        roadApi.responseCount += 1;
        if (status >= 200 && status < 300) roadApi.status2xx += 1;
        else if (status >= 300 && status < 400) roadApi.status3xx += 1;
        else if (status >= 400 && status < 500) roadApi.status4xx += 1;
        else if (status >= 500 && status < 600) roadApi.status5xx += 1;
        else roadApi.otherStatus += 1;

        const detailLevel = typeof headers["x-road-network-detail-level"] === "string"
          ? headers["x-road-network-detail-level"] : "unreported";
        const source = typeof headers["x-road-network-source"] === "string"
          ? headers["x-road-network-source"] : "unreported";
        roadApi.detailLevelResponses[detailLevel] = (roadApi.detailLevelResponses[detailLevel] || 0) + 1;
        roadApi.sourceResponses[source] = (roadApi.sourceResponses[source] || 0) + 1;
        const attemptsHeader = headers["x-road-network-upstream-attempts"];
        if (typeof attemptsHeader === "string" && /^\d+$/.test(attemptsHeader)) {
          const attempts = Number(attemptsHeader);
          roadApi.upstreamAttempts.sampleCount += 1;
          roadApi.upstreamAttempts.total += attempts;
          roadApi.upstreamAttempts.max = roadApi.upstreamAttempts.max === null
            ? attempts : Math.max(roadApi.upstreamAttempts.max, attempts);
        }
      }
    },
    recordFailure(resourceUrl, origin) {
      const group = classifyResourceUrl(resourceUrl, origin);
      failures[group] = (failures[group] || 0) + 1;
      if (isRoadApiUrl(resourceUrl, origin)) roadApi.failedRequests += 1;
    },
    snapshot() {
      return {
        responsesByResourceGroup: Object.fromEntries(
          Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, { ...value }]),
        ),
        failedRequestsByResourceGroup: Object.fromEntries(
          Object.entries(failures).sort(([a], [b]) => a.localeCompare(b)),
        ),
        roadApi: {
          ...roadApi,
          detailLevelResponses: { ...roadApi.detailLevelResponses },
          sourceResponses: { ...roadApi.sourceResponses },
          upstreamAttempts: { ...roadApi.upstreamAttempts },
          pendingRequestsAtCapture: activeRoadRequests.size,
        },
      };
    },
  };
}

async function attachLongTaskObserver(context) {
  await context.addInitScript(() => {
    window.__MAP_BASELINE_LONG_TASKS__ = { count: 0, totalDurationMs: 0, maxDurationMs: 0 };
    if (typeof PerformanceObserver !== "function") return;
    try {
      const observer = new PerformanceObserver((list) => {
        const state = window.__MAP_BASELINE_LONG_TASKS__;
        for (const entry of list.getEntries()) {
          state.count += 1;
          state.totalDurationMs += entry.duration;
          state.maxDurationMs = Math.max(state.maxDurationMs, entry.duration);
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      // Not every Chromium build exposes the Long Tasks API.
    }
  });
}

async function waitForMapReady(page, timeoutMs) {
  await page.locator('[data-testid="cesium-map-container"]').waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.waitForFunction(() => {
    const container = document.querySelector('[data-testid="cesium-map-container"]');
    const text = document.body?.innerText || "";
    const hasError = text.includes("3D map initialization failed");
    const loading = text.includes("Loading Ahsan Manzil 3D map");
    const telemetry = window.__MAP_ENGINE_PERFORMANCE__?.snapshot?.();
    const stage = telemetry?.metrics?.["viewport.stage"];
    return hasError || (
      Boolean(container?.querySelector("canvas")) &&
      !loading &&
      Number(stage?.successCount) > 0
    );
  }, null, { timeout: timeoutMs });

  const state = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const telemetry = window.__MAP_ENGINE_PERFORMANCE__?.snapshot?.() ?? null;
    const stage = telemetry?.metrics?.["viewport.stage"];
    const stageEvent = telemetry?.recentEvents?.slice().reverse().find(
      (event) => event.metric === "viewport.stage" && event.outcome === "success"
    );
    return {
      hasError: text.includes("3D map initialization failed"),
      telemetryAvailable: typeof window.__MAP_ENGINE_PERFORMANCE__?.snapshot === "function",
      canvasCount: document.querySelectorAll('[data-testid="cesium-map-container"] canvas').length,
      viewportStageSuccessCount: Number(stage?.successCount) || 0,
      stagedFeatureCount: Number.isSafeInteger(stageEvent?.featureCount) ? stageEvent.featureCount : null,
    };
  });
  if (state.hasError) throw new Error("The map showed its initialization error state.");
  if (!state.telemetryAvailable) {
    throw new Error("Map telemetry is missing. Start the app with npm run dev, not production mode.");
  }
  if (state.canvasCount < 1) throw new Error("Cesium did not create a map canvas.");
  if (!validateMapReadyState(state)) {
    throw new Error("Map readiness requires a successful viewport stage containing at least one building feature; observed " +
      state.viewportStageSuccessCount + " successful stage(s), feature count " + String(state.stagedFeatureCount) + ".");
  }
  return state;
}

export function resolveRoadReadiness(snapshot) {
  const events = Array.isArray(snapshot?.recentEvents) ? snapshot.recentEvents : [];
  const fetchEvent = events.slice().reverse().find((event) => event.metric === "roads.fetch");
  if (!fetchEvent || !["success", "cache-hit", "error", "cancelled"].includes(fetchEvent.outcome)) return null;

  const base = {
    fetchSequence: Number.isSafeInteger(fetchEvent.sequence) ? fetchEvent.sequence : null,
    fetchOutcome: fetchEvent.outcome,
    fetchDurationMs: Number.isFinite(fetchEvent.durationMs) ? fetchEvent.durationMs : null,
  };
  if (fetchEvent.outcome === "error") return { ...base, status: "fetch-error" };
  if (fetchEvent.outcome === "cancelled") return { ...base, status: "fetch-cancelled" };

  const renderEvent = events.slice().reverse().find((event) =>
    event.metric === "roads.render" &&
    Number.isSafeInteger(event.sequence) &&
    Number.isSafeInteger(fetchEvent.sequence) &&
    event.sequence > fetchEvent.sequence
  );
  if (!renderEvent || !["success", "error", "cancelled"].includes(renderEvent.outcome)) return null;
  return {
    ...base,
    renderSequence: renderEvent.sequence,
    renderOutcome: renderEvent.outcome,
    renderDurationMs: Number.isFinite(renderEvent.durationMs) ? renderEvent.durationMs : null,
    renderedFeatureCount: Number.isSafeInteger(renderEvent.featureCount) ? renderEvent.featureCount : null,
    status: renderEvent.outcome === "success"
      ? Number.isSafeInteger(renderEvent.featureCount)
        ? renderEvent.featureCount > 0 ? "rendered" : "render-empty"
        : "render-unverified"
      : renderEvent.outcome === "error" ? "render-error" : "render-cancelled",
  };
}

async function waitForRoadsSettled(page, timeoutMs, getPendingRoadRequestCount, retryGraceMs) {
  const startedAt = performance.now();
  let failureQuietSince = null;
  let failureSignature = null;
  const isFailureTerminal = (status) => [
    "fetch-error", "fetch-cancelled", "render-error", "render-cancelled", "render-empty", "render-unverified",
  ].includes(status);

  while (performance.now() - startedAt < timeoutMs) {
    const telemetry = await page.evaluate(() => window.__MAP_ENGINE_PERFORMANCE__?.snapshot?.() ?? null);
    const readiness = resolveRoadReadiness(telemetry);
    const pendingRequests = getPendingRoadRequestCount();

    if (readiness?.status === "rendered" && pendingRequests === 0) {
      return {
        ...readiness,
        waitStatus: "rendered",
        retryGraceMs,
        elapsedMs: roundMs(performance.now() - startedAt),
      };
    }

    if (pendingRequests > 0) {
      // A later road request is still active. Do not let an earlier timeout
      // hide a recovery attempt that may return/render successfully.
      failureQuietSince = null;
      failureSignature = null;
    } else if (readiness && isFailureTerminal(readiness.status)) {
      const signature = readiness.status + ":" + String(readiness.fetchSequence) + ":" + String(readiness.renderSequence ?? "");
      if (signature !== failureSignature) {
        failureSignature = signature;
        failureQuietSince = performance.now();
      } else if (failureQuietSince !== null && performance.now() - failureQuietSince >= retryGraceMs) {
        return {
          ...readiness,
          waitStatus: "settled-after-retry-grace",
          retryGraceMs,
          elapsedMs: roundMs(performance.now() - startedAt),
        };
      }
    } else {
      failureQuietSince = null;
      failureSignature = null;
    }

    await page.waitForTimeout(200);
  }

  const telemetry = await page.evaluate(() => window.__MAP_ENGINE_PERFORMANCE__?.snapshot?.() ?? null);
  return {
    status: "timeout",
    waitStatus: "timeout",
    retryGraceMs,
    elapsedMs: roundMs(performance.now() - startedAt),
    observedState: resolveRoadReadiness(telemetry) ?? "no-terminal-road-event",
    pendingRoadRequests: getPendingRoadRequestCount(),
  };
}

export function validateMapReadyState(state) {
  return Boolean(
    state &&
    state.hasError === false &&
    state.telemetryAvailable === true &&
    Number.isSafeInteger(state.canvasCount) &&
    state.canvasCount >= 1 &&
    Number.isSafeInteger(state.viewportStageSuccessCount) &&
    state.viewportStageSuccessCount > 0 &&
    Number.isSafeInteger(state.stagedFeatureCount) &&
    state.stagedFeatureCount > 0
  );
}

async function capturePageMetrics(
  page, counters, origin, screenshotPath, loadToMapReadyMs, mode, index, scenario,
  readiness, roadReadiness, loadToRoadTerminalMs,
) {
  const metrics = await page.evaluate((pageOrigin) => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint");
    const resources = performance.getEntriesByType("resource");
    const grouped = Object.create(null);

    for (const entry of resources) {
      let group = "unknown";
      try {
        const parsed = new URL(entry.name);
        if (parsed.origin !== pageOrigin) group = "third-party";
        else if (parsed.pathname.startsWith("/api/")) group = "api";
        else if (parsed.pathname.startsWith("/cesium/")) group = "cesium-assets";
        else if (/\.(?:js|mjs|css|woff2?|ttf|otf)$/i.test(parsed.pathname)) group = "static-assets";
        else group = "same-origin-other";
      } catch {
        group = "unknown";
      }
      if (!grouped[group]) grouped[group] = {
        resourceCount: 0,
        transferBytes: 0,
        encodedBytes: 0,
        decodedBytes: 0,
        durationsMs: [],
      };
      const item = grouped[group];
      item.resourceCount += 1;
      item.transferBytes += Number(entry.transferSize) || 0;
      item.encodedBytes += Number(entry.encodedBodySize) || 0;
      item.decodedBytes += Number(entry.decodedBodySize) || 0;
      if (Number.isFinite(entry.duration)) item.durationsMs.push(entry.duration);
    }

    const resourceSummary = {};
    for (const [group, value] of Object.entries(grouped)) {
      const durations = value.durationsMs.sort((left, right) => left - right);
      const pick = (fraction) => durations.length
        ? Number(durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)].toFixed(2))
        : null;
      resourceSummary[group] = {
        resourceCount: value.resourceCount,
        transferBytes: value.transferBytes,
        encodedBytes: value.encodedBytes,
        decodedBytes: value.decodedBytes,
        medianDurationMs: pick(0.5),
        p95DurationMs: pick(0.95),
      };
    }

    const telemetry = window.__MAP_ENGINE_PERFORMANCE__?.snapshot?.() ?? null;
    const tasks = window.__MAP_BASELINE_LONG_TASKS__ ?? null;
    const memory = performance.memory && Number.isFinite(performance.memory.usedJSHeapSize)
      ? {
          usedJsHeapBytes: performance.memory.usedJSHeapSize,
          totalJsHeapBytes: performance.memory.totalJSHeapSize,
          jsHeapLimitBytes: performance.memory.jsHeapSizeLimit,
        }
      : null;
    return {
      navigation: nav ? {
        durationMs: Number(nav.duration.toFixed(2)),
        domContentLoadedMs: Number(nav.domContentLoadedEventEnd.toFixed(2)),
        loadEventEndMs: nav.loadEventEnd > 0 ? Number(nav.loadEventEnd.toFixed(2)) : null,
        responseStartMs: Number(nav.responseStart.toFixed(2)),
        transferSizeBytes: Number(nav.transferSize) || 0,
        encodedBodyBytes: Number(nav.encodedBodySize) || 0,
        decodedBodyBytes: Number(nav.decodedBodySize) || 0,
      } : null,
      paintTimingsMs: Object.fromEntries(paints.map((entry) => [entry.name, Number(entry.startTime.toFixed(2))])),
      resources: resourceSummary,
      telemetry,
      longTasks: tasks ? {
        count: tasks.count,
        totalDurationMs: Number(tasks.totalDurationMs.toFixed(2)),
        maxDurationMs: Number(tasks.maxDurationMs.toFixed(2)),
      } : null,
      memory,
      environment: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
        canvasCount: document.querySelectorAll('[data-testid="cesium-map-container"] canvas').length,
      },
    };
  }, origin);

  const screenshotBytes = await page.screenshot({
    path: screenshotPath,
    fullPage: false,
    animations: "disabled",
  });
  return {
    index,
    mode,
    status: "ok",
    scenario,
    loadToMapReadyMs,
    readiness,
    roadReadiness,
    loadToRoadTerminalMs,
    navigation: metrics.navigation,
    paintTimingsMs: metrics.paintTimingsMs,
    resources: metrics.resources,
    mapTelemetry: metrics.telemetry,
    longTasks: metrics.longTasks,
    memory: metrics.memory,
    environment: metrics.environment,
    network: counters.snapshot(),
    screenshot: {
      path: path.relative(projectRoot, screenshotPath).split(path.sep).join("/"),
      bytes: screenshotBytes.byteLength,
      sha256: createHash("sha256").update(screenshotBytes).digest("hex"),
    },
  };
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/https?:\/\/[^\s)]+/g, "[URL]").slice(0, 500);
}

async function newInstrumentedPage(browser, viewport, origin) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  await attachLongTaskObserver(context);
  const page = await context.newPage();
  const counters = createNetworkCounters();
  page.on("request", (request) => {
    counters.recordRequest(request.url(), origin, request);
  });
  page.on("response", (response) => {
    counters.recordResponse(response.url(), origin, response.status(), response.headers());
  });
  page.on("requestfinished", (request) => {
    counters.finishRequest(request);
  });
  page.on("requestfailed", (request) => {
    try {
      counters.recordFailure(request.url(), origin);
    } catch {
      counters.recordFailure("", origin);
    }
    counters.finishRequest(request);
  });
  return { context, page, counters };
}

function summarizeRuns(runs) {
  const successful = runs.filter((run) => run.status === "ok");
  const failed = runs.filter((run) => run.status !== "ok");
  const telemetry = {};
  const metricNames = ["viewport.fetch", "viewport.stage", "roads.fetch", "roads.render", "roads.coverage"];

  for (const name of metricNames) {
    const snapshots = successful.map((run) => run.mapTelemetry?.metrics?.[name]).filter(Boolean);
    telemetry[name] = {
      runsWithMetric: snapshots.length,
      perRunP50Ms: summarizeValues(snapshots.map((item) => item.p50Ms)),
      perRunP95Ms: summarizeValues(snapshots.map((item) => item.p95Ms)),
      eventCount: summarizeValues(snapshots.map((item) => item.count)),
      errorCount: summarizeValues(snapshots.map((item) => item.errorCount)),
      cacheHitCount: summarizeValues(snapshots.map((item) => item.cacheHitCount)),
    };
  }
  const roadReadinessCounts = {};
  for (const run of successful) {
    const status = run.roadReadiness?.status || "not-recorded";
    roadReadinessCounts[status] = (roadReadinessCounts[status] || 0) + 1;
  }
  return {
    totalRuns: runs.length,
    successfulRuns: successful.length,
    failedRuns: failed.length,
    failures: failed.map((run) => ({ index: run.index, error: run.error })),
    roadReadinessCounts,
    loadToMapReadyMs: summarizeValues(successful.map((run) => run.loadToMapReadyMs)),
    loadToRoadTerminalMs: summarizeValues(successful.map((run) => run.loadToRoadTerminalMs)),
    domContentLoadedMs: summarizeValues(successful.map((run) => run.navigation?.domContentLoadedMs)),
    loadEventEndMs: summarizeValues(successful.map((run) => run.navigation?.loadEventEndMs)),
    longTaskCount: summarizeValues(successful.map((run) => run.longTasks?.count)),
    longTaskTotalDurationMs: summarizeValues(successful.map((run) => run.longTasks?.totalDurationMs)),
    viewportFetchP95Ms: summarizeValues(successful.map((run) => run.mapTelemetry?.metrics?.["viewport.fetch"]?.p95Ms)),
    viewportStageP95Ms: summarizeValues(successful.map((run) => run.mapTelemetry?.metrics?.["viewport.stage"]?.p95Ms)),
    roadsFetchP95Ms: summarizeValues(successful.map((run) => run.mapTelemetry?.metrics?.["roads.fetch"]?.p95Ms)),
    roadsRenderP95Ms: summarizeValues(successful.map((run) => run.mapTelemetry?.metrics?.["roads.render"]?.p95Ms)),
    telemetry,
  };
}

async function runBenchmark() {
  const { chromium } = await import("@playwright/test");
  const benchmarkUrl = process.env.MAP_BENCHMARK_URL || DEFAULT_URL;
  const parsedUrl = new URL(benchmarkUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new TypeError("MAP_BENCHMARK_URL must use http or https.");
  }
  const origin = parsedUrl.origin;
  const scenario = process.env.MAP_BENCHMARK_SCENARIO || "map-initial-camera";
  const viewport = {
    width: readInteger("MAP_BENCHMARK_WIDTH", 1280, 384, 3840),
    height: readInteger("MAP_BENCHMARK_HEIGHT", 800, 384, 2160),
  };
  const coldCount = readInteger("MAP_BENCHMARK_COLD_RUNS", 3, 1, 10);
  const warmCount = readInteger("MAP_BENCHMARK_WARM_RUNS", 3, 1, 10);
  const settleMs = readInteger("MAP_BENCHMARK_SETTLE_MS", 5000, 0, 120000);
  const readyTimeoutMs = readInteger("MAP_BENCHMARK_READY_TIMEOUT_MS", 90000, 1, 120000);
  const roadReadyTimeoutMs = readInteger("MAP_BENCHMARK_ROAD_READY_TIMEOUT_MS", 45000, 1000, 120000);
  const roadRetryGraceMs = readInteger("MAP_BENCHMARK_ROAD_RETRY_GRACE_MS", 6000, 0, 30000);
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultOutput = path.join("artifacts", "map-performance-baseline", runStamp);
  const outputDirectory = path.resolve(projectRoot, process.env.MAP_BENCHMARK_OUT_DIR || defaultOutput);
  if (!process.env.MAP_BENCHMARK_OUT_DIR &&
      !outputDirectory.startsWith(path.resolve(projectRoot, "artifacts") + path.sep)) {
    throw new Error("Refusing to write benchmark output outside artifacts/.");
  }
  await mkdir(outputDirectory, { recursive: true });

  const commitSha = process.env.MAP_BENCHMARK_COMMIT_SHA || safeGitValue(["rev-parse", "HEAD"]);
  const gitStatus = safeGitValue(["status", "--porcelain"]);
  const dirtyTree = gitStatus === null ? null : gitStatus.length > 0;
  const dataInputs = [];
  for (const relativePath of DATA_INPUTS) dataInputs.push(await hashFile(relativePath));
  const configuredRoadExtract = process.env.DHAKA_ROADS_EXTRACT_PATH?.trim();
  if (configuredRoadExtract) dataInputs.push(await hashFile(configuredRoadExtract));

  const browser = await chromium.launch({
    headless: process.env.MAP_BENCHMARK_HEADLESS !== "0",
    args: [
      "--use-gl=swiftshader",
      "--enable-unsafe-swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const results = [];
  try {
    for (let index = 1; index <= coldCount; index += 1) {
      const setupStartedAt = performance.now();
      const label = "cold-" + String(index).padStart(2, "0");
      const screenshotPath = path.join(outputDirectory, label + ".png");
      let session = null;
      let startedAt = null;
      try {
        session = await newInstrumentedPage(browser, viewport, origin);
        const cdp = await session.context.newCDPSession(session.page);
        await cdp.send("Network.enable");
        await cdp.send("Network.clearBrowserCache");
        startedAt = performance.now();
        await session.page.goto(benchmarkUrl, { waitUntil: "domcontentloaded", timeout: readyTimeoutMs });
        const readiness = await waitForMapReady(session.page, readyTimeoutMs);
        const loadToMapReadyMs = roundMs(performance.now() - startedAt);
        if (settleMs > 0) await session.page.waitForTimeout(settleMs);
        const roadReadiness = await waitForRoadsSettled(session.page, roadReadyTimeoutMs, session.counters.getPendingRoadRequestCount, roadRetryGraceMs);
        const loadToRoadTerminalMs = roundMs(performance.now() - startedAt);
        results.push(await capturePageMetrics(
          session.page, session.counters, origin, screenshotPath, loadToMapReadyMs, "cold", index, scenario,
          {
            canvasCount: readiness.canvasCount,
            viewportStageSuccessCount: readiness.viewportStageSuccessCount,
            stagedFeatureCount: readiness.stagedFeatureCount,
          },
          roadReadiness,
          loadToRoadTerminalMs,
        ));
      } catch (error) {
        results.push({
          index,
          mode: "cold",
          status: "error",
          error: sanitizeError(error),
          loadToFailureMs: roundMs(performance.now() - (startedAt ?? setupStartedAt)),
        });
      } finally {
        if (session) await session.context.close().catch(() => {});
      }
    }

    let warmSession = null;
    try {
      warmSession = await newInstrumentedPage(browser, viewport, origin);
      await warmSession.page.goto(benchmarkUrl, { waitUntil: "domcontentloaded", timeout: readyTimeoutMs });
      await waitForMapReady(warmSession.page, readyTimeoutMs);
      if (settleMs > 0) await warmSession.page.waitForTimeout(settleMs);
      await waitForRoadsSettled(warmSession.page, roadReadyTimeoutMs, warmSession.counters.getPendingRoadRequestCount, roadRetryGraceMs);
      // The primer warms this isolated context's browser HTTP cache and is excluded from measurements.
      for (let index = 1; index <= warmCount; index += 1) {
        const startedAt = performance.now();
        const screenshotPath = path.join(outputDirectory, "warm-" + String(index).padStart(2, "0") + ".png");
        try {
          warmSession.counters.reset();
          await warmSession.page.reload({ waitUntil: "domcontentloaded", timeout: readyTimeoutMs });
          const readiness = await waitForMapReady(warmSession.page, readyTimeoutMs);
          const loadToMapReadyMs = roundMs(performance.now() - startedAt);
          if (settleMs > 0) await warmSession.page.waitForTimeout(settleMs);
          const roadReadiness = await waitForRoadsSettled(warmSession.page, roadReadyTimeoutMs, warmSession.counters.getPendingRoadRequestCount, roadRetryGraceMs);
          const loadToRoadTerminalMs = roundMs(performance.now() - startedAt);
          results.push(await capturePageMetrics(
            warmSession.page, warmSession.counters, origin, screenshotPath, loadToMapReadyMs, "warm", index, scenario,
            {
              canvasCount: readiness.canvasCount,
              viewportStageSuccessCount: readiness.viewportStageSuccessCount,
              stagedFeatureCount: readiness.stagedFeatureCount,
            },
            roadReadiness,
            loadToRoadTerminalMs,
          ));
        } catch (error) {
          results.push({
            index,
            mode: "warm",
            status: "error",
            error: sanitizeError(error),
            loadToFailureMs: roundMs(performance.now() - startedAt),
          });
        }
      }
    } catch (error) {
      for (let index = 1; index <= warmCount; index += 1) {
        if (!results.some((run) => run.mode === "warm" && run.index === index)) {
          results.push({ index, mode: "warm", status: "error", error: "Warm-cache primer failed: " + sanitizeError(error) });
        }
      }
    } finally {
      if (warmSession) await warmSession.context.close().catch(() => {});
    }
  } finally {
    await browser.close();
  }

  const report = {
    schemaVersion: 1,
    benchmark: "real-dhaka-map-performance-baseline",
    generatedAt: new Date().toISOString(),
    scenario,
    target: {
      origin,
      pathname: parsedUrl.pathname,
      queryParametersOmitted: true,
      note: "Viewport query values are deliberately not written to the report.",
    },
    candidate: {
      gitCommitSha: commitSha,
      gitWorkingTreeDirty: dirtyTree,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpuCount: os.cpus().length,
      browser: "Playwright Chromium " + browser.version(),
      viewport,
      deviceScaleFactor: 1,
      headless: process.env.MAP_BENCHMARK_HEADLESS !== "0",
      dataInputs,
    },
    methodology: {
      cold: "A fresh isolated browser context per sample, followed by Network.clearBrowserCache.",
      warm: "One isolated context is primed once, then page reloads are measured with that context's browser HTTP cache retained.",
      warmPrimerIncludedInResults: false,
      applicationMemoryCacheSurvivesReload: false,
      settleMs,
      readyTimeoutMs,
      roadReadyTimeoutMs,
      roadRetryGraceMs,
      readyCondition: "A successful viewport.stage event with at least one building feature.",
      roadSettlement: "Wait for roads.fetch and, after a successful fetch, the following roads.render event; record errors, cancellation and timeout instead of silently treating the canvas as fully ready.",
      screenshotDigestsProveCapturedFileIntegrityNotCrossMachineBitIdentity: true,
      telemetryWindow: "Map-engine telemetry generated during each navigation; in-app retention is bounded.",
      fpsClaimed: false,
      notes: [
        "Cold refers to a fresh browser context and cleared Chromium HTTP cache, not DNS, OS, CDN, server or provider caches.",
        "Warm refers to browser HTTP cache reuse. A full page reload resets the JavaScript application and its in-memory map cache.",
        "Cross-origin resource byte sizes may be zero when browser timing policy hides them.",
        "Missing local input files are recorded with exists=false; this does not prove the running server did not use remote data.",
        "No FPS or release SLA is claimed by this baseline.",
      ],
    },
    summary: {
      cold: summarizeRuns(results.filter((run) => run.mode === "cold")),
      warm: summarizeRuns(results.filter((run) => run.mode === "warm")),
    },
    runs: results,
  };
  const reportPath = path.join(outputDirectory, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({
    benchmark: report.benchmark,
    outputDirectory: path.relative(projectRoot, outputDirectory).split(path.sep).join("/"),
    report: path.relative(projectRoot, reportPath).split(path.sep).join("/"),
    gitCommitSha: commitSha,
    cold: report.summary.cold,
    warm: report.summary.warm,
  }, null, 2));

  if (results.some((run) => run.status !== "ok")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBenchmark().catch((error) => {
    console.error("[Map Baseline] Benchmark failed:", error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
