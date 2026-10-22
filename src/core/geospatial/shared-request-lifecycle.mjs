/**
 * Register one downstream client as a consumer of a shared upstream request.
 * Cancelling one client only aborts the shared upstream operation when no
 * other client still needs its result.
 */
export function attachSharedRequestConsumer(entry, signal) {
  if (
    !entry ||
    !entry.controller ||
    typeof entry.controller.abort !== "function" ||
    !Number.isInteger(entry.consumers) ||
    typeof entry.settled !== "boolean" ||
    !signal ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("A shared request entry and AbortSignal are required.");
  }

  if (signal.aborted || entry.settled || entry.controller.signal.aborted) {
    return () => {};
  }

  entry.consumers += 1;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", release);
    entry.consumers = Math.max(0, entry.consumers - 1);

    if (
      entry.consumers === 0 &&
      !entry.settled &&
      !entry.controller.signal.aborted
    ) {
      entry.controller.abort();
    }
  };

  signal.addEventListener("abort", release, { once: true });
  // Recheck after subscribing to protect against an already-aborted signal.
  if (signal.aborted) release();

  return release;
}
