/**
 * Return true when a new viewport makes the active network request obsolete.
 * A null active endpoint means there is no active viewport request.
 */
export function shouldAbortViewportRequest(activeEndpoint, nextEndpoint) {
  if (typeof nextEndpoint !== "string" || nextEndpoint.length === 0) {
    throw new TypeError("Next viewport endpoint must be a non-empty string.");
  }

  return activeEndpoint !== null &&
    activeEndpoint !== nextEndpoint;
}


/**
 * A wide camera view needs the full pilot dataset unless it is already active.
 * A bounded viewport cannot guarantee coverage for a world-scale view.
 */
export function shouldLoadFullDatasetForWideViewport(
  hasLoadedBuildings,
  loadedViewportBounds,
) {
  return !hasLoadedBuildings || loadedViewportBounds !== null;
}


/**
 * Keep an in-flight viewport stage only while its intent is current and the
 * building layer is visible. This also covers work after fetch has completed,
 * when there is no longer an AbortController to stop GeoJSON staging.
 */
export function shouldContinueViewportLoad(
  requestRevision,
  currentRevision,
  buildingsLayerVisible,
) {
  return requestRevision === currentRevision && buildingsLayerVisible === true;
}
