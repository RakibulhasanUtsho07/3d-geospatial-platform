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
