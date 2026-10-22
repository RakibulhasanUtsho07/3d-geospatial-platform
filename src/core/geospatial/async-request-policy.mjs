/**
 * Return whether a result belongs to the latest, non-aborted request.
 * This protects UI state from slower responses that finish after a newer query.
 */
export function isCurrentAsyncRequest(
  requestToken,
  currentRequestToken,
  signalAborted,
) {
  return requestToken !== null &&
    requestToken === currentRequestToken &&
    signalAborted !== true;
}
