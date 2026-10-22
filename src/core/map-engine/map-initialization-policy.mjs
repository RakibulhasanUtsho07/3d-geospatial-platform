/**
 * Only the most recent initialization attempt may continue after an async
 * boundary. Increment the current revision when another attempt starts or the
 * engine is destroyed.
 */
export function shouldContinueMapInitialization(requestRevision, currentRevision) {
  return Number.isSafeInteger(requestRevision) &&
    requestRevision > 0 &&
    Number.isSafeInteger(currentRevision) &&
    currentRevision > 0 &&
    requestRevision === currentRevision;
}
