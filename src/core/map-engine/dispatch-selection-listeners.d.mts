/**
 * Dispatch one selection payload to each listener.
 * A listener exception is passed to onListenerError and does not stop later listeners.
 */
export function dispatchSelectionListeners<T>(
  listeners: Iterable<(value: T) => void>,
  value: T,
  onListenerError: (error: unknown) => void,
): void;
