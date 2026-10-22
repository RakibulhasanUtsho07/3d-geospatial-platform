export type MapPerformanceMetric =
  | "viewport.fetch"
  | "viewport.stage"
  | "roads.fetch"
  | "roads.render"
  | "roads.coverage";

export type MapPerformanceOutcome =
  | "success"
  | "cache-hit"
  | "error"
  | "cancelled";

export interface MapPerformanceEvent {
  sequence: number;
  elapsedMs: number;
  metric: MapPerformanceMetric;
  outcome: MapPerformanceOutcome;
  durationMs: number;
  cacheHit?: boolean;
  featureCount?: number;
  returnedWays?: number;
  statusCode?: number;
}

export interface MapPerformanceMetricSummary {
  count: number;
  successCount: number;
  cacheHitCount: number;
  errorCount: number;
  cancelledCount: number;
  latencySamples: number;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface MapPerformanceSnapshot {
  version: 1;
  capacity: number;
  totalEvents: number;
  lastSequence: number;
  metrics: Record<MapPerformanceMetric, MapPerformanceMetricSummary>;
  recentEvents: MapPerformanceEvent[];
}

export interface MapPerformanceTelemetry {
  record(
    metric: MapPerformanceMetric,
    outcome: MapPerformanceOutcome,
    durationMs: number,
    details?: {
      cacheHit?: boolean;
      featureCount?: number;
      returnedWays?: number;
      statusCode?: number;
    },
  ): MapPerformanceEvent;
  getSnapshot(): MapPerformanceSnapshot;
  reset(): void;
}

export function createMapPerformanceTelemetry(options?: {
  capacity?: number;
  now?: () => number;
}): MapPerformanceTelemetry;
