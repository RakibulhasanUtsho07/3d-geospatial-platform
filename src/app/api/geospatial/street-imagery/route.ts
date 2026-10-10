import { NextResponse } from "next/server";

import {
  normalizeKartaViewPhotos,
  parseStreetImageryParams,
} from "@/core/geospatial/street-imagery.mjs";
import type {
  StreetImageryReference,
  StreetImageryRequest,
} from "@/core/geospatial/street-imagery.mjs";

type CachedImagery = { expiresAt: number; references: StreetImageryReference[] };
type UpstreamError = Error & { statusCode?: number; retryAfter?: string };

const KARTAVIEW_PHOTO_ENDPOINT = "https://api.openstreetcam.org/2.0/photo/";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 48;
const MAX_CONCURRENT_REQUESTS = 2;
const UPSTREAM_TIMEOUT_MS = 15_000;
const responseCache = new Map<string, CachedImagery>();
const inFlightRequests = new Map<string, Promise<StreetImageryReference[]>>();
let activeRequests = 0;

function createCacheKey(request: StreetImageryRequest): string {
  return [
    request.latitude.toFixed(5),
    request.longitude.toFixed(5),
    request.radiusMeters,
    request.limit,
  ].join("|");
}

function rememberReferences(key: string, references: StreetImageryReference[]): void {
  responseCache.delete(key);
  while (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, references });
}

function getZoomLevel(radiusMeters: number): number {
  if (radiusMeters <= 100) return 18;
  if (radiusMeters <= 250) return 17;
  return 16;
}

async function queryKartaView(request: StreetImageryRequest): Promise<StreetImageryReference[]> {
  const url = new URL(KARTAVIEW_PHOTO_ENDPOINT);
  url.searchParams.set("lat", String(request.latitude));
  url.searchParams.set("lng", String(request.longitude));
  url.searchParams.set("zoomLevel", String(getZoomLevel(request.radiusMeters)));
  url.searchParams.set("join", "sequence");
  url.searchParams.set("orderBy", "id");
  url.searchParams.set("orderDirection", "desc");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "3D-Geospatial-Platform/0.1 (public KartaView imagery discovery)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const timeout = typeof error === "object" && error !== null && "name" in error
      && error.name === "TimeoutError";
    throw Object.assign(
      new Error(timeout
        ? "KartaView imagery search timed out."
        : "KartaView imagery service is temporarily unreachable."),
      { statusCode: timeout ? 504 : 502 },
    ) as UpstreamError;
  }

  if (!response.ok) {
    const busy = response.status === 429 || response.status === 503 || response.status === 504;
    throw Object.assign(
      new Error(busy
        ? "KartaView is busy. Please retry shortly."
        : "KartaView returned HTTP " + response.status + "."),
      {
        statusCode: busy ? 503 : 502,
        retryAfter: busy ? (response.headers.get("retry-after") ?? "30") : undefined,
      },
    ) as UpstreamError;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error("KartaView returned invalid JSON."), { statusCode: 502 }) as UpstreamError;
  }

  return normalizeKartaViewPhotos(payload, request);
}

function createResponse(
  references: StreetImageryReference[],
  request: StreetImageryRequest,
  cacheStatus: "HIT" | "MISS" | "COALESCED",
): Response {
  return NextResponse.json(
    {
      center: { latitude: request.latitude, longitude: request.longitude },
      radiusMeters: request.radiusMeters,
      count: references.length,
      results: references,
      dataStatus: references.length ? "references-found" : "no-public-references-found",
      source: "KartaView public street-level imagery API",
      license: "CC BY-SA 4.0",
      attribution: "© Grab and KartaView Contributors",
      note: "Results are nearby street-level references, not a verified image of the exact building. Frames from video sequences are still images, not downloadable videos.",
    },
    {
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        "X-Street-Imagery-Cache": cacheStatus,
        "X-Street-Imagery-Count": String(references.length),
      },
    },
  );
}

export async function GET(request: Request): Promise<Response> {
  const parsed = parseStreetImageryParams(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const query = parsed.value;
  const key = createCacheKey(query);
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    responseCache.delete(key);
    responseCache.set(key, cached);
    return createResponse(cached.references, query, "HIT");
  }
  if (cached) responseCache.delete(key);

  let pending = inFlightRequests.get(key);
  let cacheStatus: "MISS" | "COALESCED" = "MISS";
  if (pending) {
    cacheStatus = "COALESCED";
  } else {
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      return NextResponse.json(
        { error: "Street imagery searches are temporarily busy. Please retry shortly." },
        { status: 503, headers: { "Retry-After": "15" } },
      );
    }
    activeRequests += 1;
    pending = queryKartaView(query)
      .then((references) => {
        rememberReferences(key, references);
        return references;
      })
      .finally(() => {
        activeRequests = Math.max(0, activeRequests - 1);
        inFlightRequests.delete(key);
      });
    inFlightRequests.set(key, pending);
  }

  try {
    return createResponse(await pending, query, cacheStatus);
  } catch (error: unknown) {
    const failure = error as UpstreamError;
    const statusCode = Number.isInteger(failure?.statusCode) ? failure.statusCode! : 502;
    return NextResponse.json(
      { error: failure instanceof Error ? failure.message : "Street imagery search failed." },
      {
        status: statusCode,
        headers: failure?.retryAfter ? { "Retry-After": failure.retryAfter } : undefined,
      },
    );
  }
}
