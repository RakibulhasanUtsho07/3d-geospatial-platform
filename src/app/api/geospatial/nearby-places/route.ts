import { NextResponse } from "next/server";

import {
  buildOverpassQuery,
  normalizeOverpassElements,
  parseNearbyPlacesParams,
} from "@/core/geospatial/nearby-places.mjs";
import type {
  NearbyPlace,
  NearbyPlacesRequest,
} from "@/core/geospatial/nearby-places.mjs";

type JsonObject = Record<string, unknown>;
type CachedPlaces = { expiresAt: number; places: NearbyPlace[] };

const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;
const MAX_CONCURRENT_UPSTREAM_REQUESTS = 2;
const UPSTREAM_TIMEOUT_MS = 25_000;

const responseCache = new Map<string, CachedPlaces>();
const inFlightRequests = new Map<string, Promise<NearbyPlace[]>>();
let activeUpstreamRequests = 0;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getUpstreamUrl(): string {
  const candidate = process.env.OVERPASS_API_URL?.trim() || DEFAULT_OVERPASS_URL;
  let parsed: URL;

  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("OVERPASS_API_URL must be a valid HTTPS URL.");
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("OVERPASS_API_URL must be an HTTPS URL without embedded credentials.");
  }

  return parsed.toString();
}

function createCacheKey(request: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  categories: string[];
  limit: number;
}): string {
  return [
    request.latitude.toFixed(4),
    request.longitude.toFixed(4),
    request.radiusMeters,
    [...request.categories].sort().join(","),
    request.limit,
  ].join("|");
}

function rememberPlaces(key: string, places: NearbyPlace[]): void {
  if (responseCache.has(key)) responseCache.delete(key);
  while (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey === undefined) break;
    responseCache.delete(oldestKey);
  }
  responseCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, places });
}

async function queryOverpass(request: Parameters<typeof buildOverpassQuery>[0]): Promise<NearbyPlace[]> {
  const url = getUpstreamUrl();
  const query = buildOverpassQuery(request);
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json",
        "User-Agent": "3D-Geospatial-Platform/0.1 (https://github.com/RakibulhasanUtsho07/3d-geospatial-platform)",
      },
      body: new URLSearchParams({ data: query }).toString(),
      cache: "no-store",
      signal: timeout,
    });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "TimeoutError"
    ) {
      throw Object.assign(new Error("The OpenStreetMap data service timed out."), {
        statusCode: 504,
      });
    }
    throw Object.assign(new Error("The OpenStreetMap data service is temporarily unreachable."), {
      statusCode: 502,
    });
  }

  if (!response.ok) {
    if (response.status === 429 || response.status === 504 || response.status === 503) {
      throw Object.assign(
        new Error("The shared OpenStreetMap query service is busy. Please retry shortly."),
        { statusCode: 503, retryAfter: response.headers.get("retry-after") ?? "20" },
      );
    }
    throw Object.assign(
      new Error(`The OpenStreetMap data service returned HTTP ${response.status}.`),
      { statusCode: 502 },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error("The OpenStreetMap data service returned invalid JSON."), {
      statusCode: 502,
    });
  }

  if (!isRecord(payload) || !Array.isArray(payload.elements)) {
    throw Object.assign(new Error("The OpenStreetMap data response is missing its elements array."), {
      statusCode: 502,
    });
  }

  return normalizeOverpassElements(payload.elements, request);
}

function responseWithPlaces(
  places: NearbyPlace[],
  request: NearbyPlacesRequest,
  cacheStatus: "HIT" | "MISS" | "COALESCED",
): Response {
  return NextResponse.json(
    {
      center: { latitude: request.latitude, longitude: request.longitude },
      radiusMeters: request.radiusMeters,
      categories: request.categories,
      count: places.length,
      results: places,
      attribution: "© OpenStreetMap contributors",
      source: "OpenStreetMap Overpass API",
    },
    {
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        "X-Nearby-Cache": cacheStatus,
        "X-Nearby-Result-Count": String(places.length),
      },
    },
  );
}

export async function GET(request: Request): Promise<Response> {
  const parsed = parseNearbyPlacesParams(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const nearbyRequest = parsed.value;
  const key = createCacheKey(nearbyRequest);
  const cached = responseCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    responseCache.delete(key);
    responseCache.set(key, cached);
    return responseWithPlaces(cached.places, nearbyRequest, "HIT");
  }
  if (cached) responseCache.delete(key);

  let pending = inFlightRequests.get(key);
  let cacheStatus: "MISS" | "COALESCED" = "MISS";

  if (pending) {
    cacheStatus = "COALESCED";
  } else {
    if (activeUpstreamRequests >= MAX_CONCURRENT_UPSTREAM_REQUESTS) {
      return NextResponse.json(
        { error: "Nearby-place searches are temporarily busy. Please retry shortly." },
        { status: 503, headers: { "Retry-After": "15" } },
      );
    }

    activeUpstreamRequests += 1;
    pending = queryOverpass(nearbyRequest)
      .then((places) => {
        rememberPlaces(key, places);
        return places;
      })
      .finally(() => {
        activeUpstreamRequests = Math.max(0, activeUpstreamRequests - 1);
        inFlightRequests.delete(key);
      });
    inFlightRequests.set(key, pending);
  }

  try {
    const places = await pending;
    return responseWithPlaces(places, nearbyRequest, cacheStatus);
  } catch (error: unknown) {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 502;
    const retryAfter =
      typeof error === "object" && error !== null && "retryAfter" in error
        ? String(error.retryAfter)
        : null;

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Nearby-place search failed." },
      {
        status: statusCode,
        headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
      },
    );
  }
}
