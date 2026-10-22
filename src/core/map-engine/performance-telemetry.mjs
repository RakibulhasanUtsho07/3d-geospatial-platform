export const DEFAULT_MAP_PERFORMANCE_EVENT_CAPACITY = 120;
export const MAP_PERFORMANCE_RECENT_EVENT_LIMIT = 20;

export const MAP_PERFORMANCE_METRICS = Object.freeze([
  "viewport.fetch",
  "viewport.stage",
  "roads.fetch",
  "roads.render",
  "roads.coverage",
]);

export const MAP_PERFORMANCE_OUTCOMES = Object.freeze([
  "success",
  "cache-hit",
  "error",
  "cancelled",
]);

const MAX_DURATION_MS = 10 * 60 * 1000;
const MAX_COUNT = 1_000_000;
const METRIC_SET = new Set(MAP_PERFORMANCE_METRICS);
const OUTCOME_SET = new Set(MAP_PERFORMANCE_OUTCOMES);

function assertCapacity(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 500) {
    throw new RangeError("Map performance telemetry capacity must be an integer from 1 to 500.");
  }
}

function normalizeDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(MAX_DURATION_MS, Math.max(0, value)) * 10) / 10;
}

function normalizeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return Math.min(MAX_COUNT, value);
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return Math.round(sortedValues[index] * 10) / 10;
}

function summarizeMetric(events) {
  const durations = events
    .filter((event) => event.outcome !== "cache-hit")
    .map((event) => event.durationMs)
    .sort((a, b) => a - b);

  const successCount = events.filter((event) => event.outcome === "success").length;
  const cacheHitCount = events.filter((event) =>
    event.outcome === "cache-hit" || event.cacheHit === true
  ).length;
  const errorCount = events.filter((event) => event.outcome === "error").length;
  const cancelledCount = events.filter((event) => event.outcome === "cancelled").length;

  return {
    count: events.length,
    successCount,
    cacheHitCount,
    errorCount,
    cancelledCount,
    latencySamples: durations.length,
    averageMs: durations.length
      ? Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10
      : null,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length ? durations.at(-1) : null,
  };
}

/**
 * In-memory, bounded telemetry for diagnosing map load stages.
 *
 * It intentionally accepts only a small allow-list of numeric metadata. URLs,
 * viewport coordinates, feature properties, and user data are never retained.
 */
export function createMapPerformanceTelemetry({
  capacity = DEFAULT_MAP_PERFORMANCE_EVENT_CAPACITY,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  assertCapacity(capacity);
  if (typeof now !== "function") {
    throw new TypeError("Map performance telemetry clock must be a function.");
  }

  const events = [];
  let sequence = 0;

  function record(metric, outcome, durationMs, details = {}) {
    if (!METRIC_SET.has(metric)) {
      throw new TypeError("Unknown map performance metric.");
    }
    if (!OUTCOME_SET.has(outcome)) {
      throw new TypeError("Unknown map performance outcome.");
    }
    if (typeof details !== "object" || details === null || Array.isArray(details)) {
      throw new TypeError("Map performance event details must be an object.");
    }

    const time = Number(now());
    const event = {
      sequence: ++sequence,
      elapsedMs: Number.isFinite(time) ? Math.round(Math.max(0, time) * 10) / 10 : 0,
      metric,
      outcome,
      durationMs: normalizeDuration(durationMs),
    };

    if (typeof details.cacheHit === "boolean") event.cacheHit = details.cacheHit;
    const featureCount = normalizeCount(details.featureCount);
    const returnedWays = normalizeCount(details.returnedWays);
    const statusCode = normalizeCount(details.statusCode);
    if (featureCount !== undefined) event.featureCount = featureCount;
    if (returnedWays !== undefined) event.returnedWays = returnedWays;
    if (statusCode !== undefined && statusCode >= 100 && statusCode <= 599) {
      event.statusCode = statusCode;
    }

    events.push(event);
    if (events.length > capacity) events.splice(0, events.length - capacity);
    return { ...event };
  }

  function getSnapshot() {
    const metrics = Object.fromEntries(
      MAP_PERFORMANCE_METRICS.map((metric) => [
        metric,
        summarizeMetric(events.filter((event) => event.metric === metric)),
      ]),
    );

    return {
      version: 1,
      capacity,
      totalEvents: events.length,
      lastSequence: sequence,
      metrics,
      recentEvents: events.slice(-MAP_PERFORMANCE_RECENT_EVENT_LIMIT).map((event) => ({ ...event })),
    };
  }

  function reset() {
    events.length = 0;
  }

  return Object.freeze({ record, getSnapshot, reset });
}
