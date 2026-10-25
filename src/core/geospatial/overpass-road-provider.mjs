const DEFAULT_OVERPASS_ENDPOINTS = Object.freeze([
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
]);
const MAX_OVERPASS_ENDPOINTS = 2;
const DEFAULT_TIMEOUT_MS = 9_000;
const DEFAULT_USER_AGENT = "3D-Geospatial-Platform/0.1 (https://github.com/RakibulhasanUtsho07/3d-geospatial-platform)";

function validateEndpoint(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new TypeError("Overpass endpoints must be valid HTTPS URLs."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError("Overpass endpoints must use HTTPS and must not contain credentials or fragments.");
  }
  return parsed.toString();
}

export function resolveOverpassEndpoints(env = process.env) {
  const configuredList = typeof env.OVERPASS_API_URLS === "string" ? env.OVERPASS_API_URLS.trim() : "";
  const configuredPrimary = typeof env.OVERPASS_API_URL === "string" ? env.OVERPASS_API_URL.trim() : "";
  let candidates;
  if (configuredList) {
    candidates = configuredList.split(",").map((item) => item.trim()).filter(Boolean);
  } else if (configuredPrimary) {
    const primary = validateEndpoint(configuredPrimary);
    candidates = [primary, ...DEFAULT_OVERPASS_ENDPOINTS.filter((endpoint) => endpoint !== primary).slice(0, MAX_OVERPASS_ENDPOINTS - 1)];
  } else candidates = [...DEFAULT_OVERPASS_ENDPOINTS];

  const endpoints = [...new Set(candidates.map(validateEndpoint))];
  if (endpoints.length < 1 || endpoints.length > MAX_OVERPASS_ENDPOINTS) {
    throw new RangeError("Configure one or two Overpass endpoints.");
  }
  return endpoints;
}

function upstreamFailure(message, statusCode, options = {}) {
  return Object.assign(new Error(message), {
    statusCode,
    retryAfter: options.retryAfter,
    retryable: options.retryable === true,
  });
}
function normalizeTransportFailure(error) {
  if (error && typeof error === "object" && Number.isInteger(error.statusCode)) return error;
  if (error && typeof error === "object" && error.name === "TimeoutError") {
    return upstreamFailure("The OpenStreetMap road query timed out.", 504, { retryable: true });
  }
  return upstreamFailure("The OpenStreetMap road service is temporarily unreachable.", 502, { retryable: true });
}
function isAbortError(error) {
  return Boolean(error && typeof error === "object" && error.name === "AbortError");
}

/** Try at most two HTTPS instances; the fallback endpoint uses the next reduced query. */
export async function fetchOverpassElements({
  endpoints,
  queries,
  signal,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userAgent = DEFAULT_USER_AGENT,
}) {
  if (!Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > MAX_OVERPASS_ENDPOINTS) {
    throw new RangeError("One or two Overpass endpoints are required.");
  }
  const checkedEndpoints = endpoints.map(validateEndpoint);
  if (!Array.isArray(queries) || queries.length < 1 || queries.some((query) => typeof query !== "string" || !query.trim())) {
    throw new TypeError("At least one non-empty Overpass query is required.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("An Overpass fetch implementation is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new RangeError("Overpass timeout must be an integer between 100 and 30000 ms.");
  }
  if (typeof userAgent !== "string" || !userAgent.trim()) {
    throw new TypeError("A meaningful Overpass User-Agent is required.");
  }

  let lastFailure = null;
  for (let index = 0; index < checkedEndpoints.length; index += 1) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException("Road request aborted.", "AbortError");
    }
    try {
      const timedSignal = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timedSignal]) : timedSignal;
      const response = await fetchImpl(checkedEndpoints[index], {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json",
          "User-Agent": userAgent,
        },
        body: new URLSearchParams({ data: queries[Math.min(index, queries.length - 1)] }).toString(),
        cache: "no-store",
        signal: requestSignal,
      });
      if (!response || typeof response.ok !== "boolean") {
        throw upstreamFailure("The OpenStreetMap road service returned an invalid response.", 502, { retryable: true });
      }
      if (!response.ok) {
        const status = Number.isInteger(response.status) ? response.status : 502;
        const retryable = status === 429 || status >= 500;
        const overloaded = status === 429 || status === 503 || status === 504;
        throw upstreamFailure(
          overloaded ? "The shared OpenStreetMap road query service is busy."
            : "The OpenStreetMap road service returned HTTP " + status + ".",
          overloaded ? 503 : 502,
          { retryable, retryAfter: overloaded ? (response.headers?.get?.("retry-after") ?? "15") : undefined },
        );
      }
      let payload;
      try { payload = await response.json(); }
      catch { throw upstreamFailure("The OpenStreetMap road service returned invalid JSON.", 502, { retryable: true }); }
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.elements)) {
        throw upstreamFailure("The OpenStreetMap road response is missing its elements array.", 502, { retryable: true });
      }
      return {
        elements: payload.elements,
        endpoint: checkedEndpoints[index],
        attempts: index + 1,
        detailLevel: index === 0 ? "full" : "reduced",
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const failure = normalizeTransportFailure(error);
      if (!failure.retryable || index === checkedEndpoints.length - 1) throw failure;
      lastFailure = failure;
    }
  }
  throw lastFailure ?? upstreamFailure("No Overpass endpoint returned road data.", 502, { retryable: false });
}
