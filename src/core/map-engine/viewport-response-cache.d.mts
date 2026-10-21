export const DEFAULT_VIEWPORT_RESPONSE_CACHE_SIZE: number;

export function getCachedViewportResponse<T>(
  cache: Map<string, T>,
  key: string,
): T | undefined;

export function cacheViewportResponse<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  maxEntries?: number,
): void;
