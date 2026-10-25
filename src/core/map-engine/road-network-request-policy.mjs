/**
 * A viewport covered by already-rendered road geometry is a valid cache hit.
 * If a request for a different viewport is still pending, it must be aborted
 * so that the late response cannot replace the geometry for the current view.
 */
export function shouldCancelRoadRequestForCachedViewport(
  loadedRoadBoundsContainViewport,
  hasActiveRoadRequest,
) {
  return loadedRoadBoundsContainViewport === true &&
    hasActiveRoadRequest === true;
}

/**
 * Avoid repeating an expensive road request for a viewport that just failed.
 * Different viewports remain eligible to load, and expiry allows retry.
 */
export function shouldSkipFailedRoadViewportRetry(
  requestKey,
  lastFailedRequestKey,
  retryAfterMs,
  nowMs,
) {
  return typeof requestKey === "string" &&
    requestKey.length > 0 &&
    requestKey === lastFailedRequestKey &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0 &&
    Number.isFinite(nowMs) &&
    nowMs >= 0 &&
    nowMs < retryAfterMs;
}
