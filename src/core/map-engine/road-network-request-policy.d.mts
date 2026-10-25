export function shouldCancelRoadRequestForCachedViewport(
  loadedRoadBoundsContainViewport: boolean,
  hasActiveRoadRequest: boolean,
): boolean;

export function shouldSkipFailedRoadViewportRetry(
  requestKey: string,
  lastFailedRequestKey: string | null,
  retryAfterMs: number,
  nowMs: number,
): boolean;
