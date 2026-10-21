export const DEFAULT_VIEWPORT_RESPONSE_CACHE_SIZE = 2;

function assertCache(cache) {
  if (!(cache instanceof Map)) {
    throw new TypeError("Viewport response cache must be a Map.");
  }
}

function assertKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("Viewport response cache key must be a non-empty string.");
  }
}

function assertCapacity(maxEntries) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("Viewport response cache capacity must be a positive safe integer.");
  }
}

/** Read a response and promote it to the most-recently-used cache position. */
export function getCachedViewportResponse(cache, key) {
  assertCache(cache);
  assertKey(key);

  if (!cache.has(key)) return undefined;

  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/** Store a response using insertion order as a small bounded LRU cache. */
export function cacheViewportResponse(
  cache,
  key,
  value,
  maxEntries = DEFAULT_VIEWPORT_RESPONSE_CACHE_SIZE,
) {
  assertCache(cache);
  assertKey(key);
  assertCapacity(maxEntries);

  cache.delete(key);
  cache.set(key, value);

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}
