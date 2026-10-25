const MAX_ERROR_MESSAGE_LENGTH = 240;

function finiteIntegerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Convert Cesium imagery-provider errors into small diagnostics suitable for
 * browser reports. Never preserve tile URLs or query parameters from errors.
 */
export function summarizeImageryTileError(error) {
  const source = error && typeof error === "object" ? error : {};
  const rawMessage = typeof source.message === "string" && source.message.trim()
    ? source.message.trim()
    : "Unspecified imagery tile error";
  const message = rawMessage
    .replace(/https?:\/\/[^\s)\]}>]+/gi, "[imagery-url]")
    .replace(/\b(?:west|south|east|north|x|y|z|s|access_token|token)=([^&\s)\]}]+)/gi, "$1=[redacted]")
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);

  return {
    message,
    x: finiteIntegerOrNull(source.x),
    y: finiteIntegerOrNull(source.y),
    level: finiteIntegerOrNull(source.level),
    timesRetried: finiteIntegerOrNull(source.timesRetried) ?? 0,
    retryWasRequested: source.retry === true,
  };
}

export function appendImageryTileErrorDiagnostic(target, error, capacity = 50) {
  if (!target || typeof target !== "object") {
    throw new TypeError("An imagery diagnostics target is required");
  }
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 500) {
    throw new RangeError("Imagery diagnostics capacity must be an integer from 1 to 500");
  }

  const diagnostic = summarizeImageryTileError(error);
  const current = target.__MAP_ENGINE_IMAGERY_TILE_ERRORS__ &&
    typeof target.__MAP_ENGINE_IMAGERY_TILE_ERRORS__ === "object"
    ? target.__MAP_ENGINE_IMAGERY_TILE_ERRORS__
    : { total: 0, recent: [] };

  current.total = Number.isSafeInteger(current.total) && current.total >= 0
    ? current.total + 1
    : 1;
  current.recent = Array.isArray(current.recent) ? current.recent : [];
  current.recent.push(diagnostic);
  if (current.recent.length > capacity) {
    current.recent.splice(0, current.recent.length - capacity);
  }

  target.__MAP_ENGINE_IMAGERY_TILE_ERRORS__ = current;
  return diagnostic;
}
