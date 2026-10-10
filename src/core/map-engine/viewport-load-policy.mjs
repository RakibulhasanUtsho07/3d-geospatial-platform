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
