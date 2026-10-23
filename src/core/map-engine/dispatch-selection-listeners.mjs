/**
 * Notify each selection subscriber independently.
 *
 * Iterates the provided iterable directly to preserve Set iteration behavior;
 * one broken listener is reported without preventing later listeners from running.
 */
export function dispatchSelectionListeners(listeners, value, onListenerError) {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      onListenerError(error);
    }
  }
}
