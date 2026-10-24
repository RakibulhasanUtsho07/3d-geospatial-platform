const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 6000;

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(name + " must be a positive safe integer");
  }
}

export function createSelectedGeometryCache(options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  assertPositiveSafeInteger(maxBytes, "maxBytes");
  assertPositiveSafeInteger(maxEntries, "maxEntries");

  const entries = new Map();
  let accountedBytes = 0;
  let evictionCount = 0;
  let invalidationCount = 0;
  let oversizedRejectionCount = 0;

  function get(key) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("cache key must be a non-empty string");
    }
    const entry = entries.get(key);
    if (!entry) return undefined;

    // Touch the entry so iteration order remains least-recently-used first.
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value, byteLength) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("cache key must be a non-empty string");
    }
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
      throw new TypeError("byteLength must be a positive safe integer");
    }
    // An entry larger than the whole budget must not evict the useful cache.
    if (byteLength > maxBytes) {
      oversizedRejectionCount += 1;
      return false;
    }

    const prior = entries.get(key);
    if (prior) {
      accountedBytes -= prior.byteLength;
      entries.delete(key);
    }
    entries.set(key, { value, byteLength });
    accountedBytes += byteLength;

    while (accountedBytes > maxBytes || entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (typeof oldestKey !== "string") break;
      const oldestEntry = entries.get(oldestKey);
      if (oldestEntry) accountedBytes -= oldestEntry.byteLength;
      entries.delete(oldestKey);
      evictionCount += 1;
    }

    return entries.has(key);
  }

  function invalidateWhere(predicate) {
    if (typeof predicate !== "function") {
      throw new TypeError("predicate must be a function");
    }
    let invalidated = 0;
    for (const [key, entry] of entries) {
      if (!predicate(key, entry.value)) continue;
      entries.delete(key);
      accountedBytes -= entry.byteLength;
      invalidationCount += 1;
      invalidated += 1;
    }
    return invalidated;
  }

  function getStats() {
    return {
      entries: entries.size,
      bytes: accountedBytes,
      maxBytes,
      maxEntries,
      evictions: evictionCount,
      invalidations: invalidationCount,
      oversizedRejections: oversizedRejectionCount,
    };
  }

  function clear() {
    entries.clear();
    accountedBytes = 0;
    evictionCount = 0;
    invalidationCount = 0;
    oversizedRejectionCount = 0;
  }

  return Object.freeze({ get, set, invalidateWhere, getStats, clear });
}

export function createSelectedGeometryCacheKey({
  relativeFile,
  dataSignature,
  record,
}) {
  if (typeof relativeFile !== "string" || relativeFile.length === 0) {
    throw new TypeError("relativeFile must be a non-empty string");
  }
  if (typeof dataSignature !== "string" || dataSignature.length === 0) {
    throw new TypeError("dataSignature must be a non-empty string");
  }
  if (!record || typeof record !== "object" || !record.bounds || typeof record.bounds !== "object") {
    throw new TypeError("record must include identity, role, offsets, length and bounds");
  }

  const bounds = [record.bounds.west, record.bounds.south, record.bounds.east, record.bounds.north];
  if (!bounds.every(Number.isFinite)) {
    throw new TypeError("record bounds must be finite numbers");
  }
  if (
    typeof record.identity !== "string" ||
    typeof record.role !== "string" ||
    !Number.isSafeInteger(record.offset) ||
    record.offset < 0 ||
    !Number.isSafeInteger(record.length) ||
    record.length <= 0
  ) {
    throw new TypeError("record identity, role, offset and length must be valid");
  }

  return JSON.stringify([
    relativeFile,
    dataSignature,
    record.offset,
    record.length,
    record.identity,
    record.role,
    ...bounds,
  ]);
}
