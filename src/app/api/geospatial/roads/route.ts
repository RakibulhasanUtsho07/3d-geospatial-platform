import { NextResponse } from "next/server";

import {
  buildOverpassRoadQuery,
  normalizeOverpassRoadElements,
  parseRoadNetworkParams,
} from "@/core/geospatial/road-network.mjs";
import type {
  RoadFeature,
  RoadNetworkRequest,
} from "@/core/geospatial/road-network.mjs";

type CachedRoads = { expiresAt: number; roads: RoadFeature[] };
type UpstreamFailure = Error & { statusCode?: number; retryAfter?: string };

const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 24;
const MAX_CONCURRENT_REQUESTS = 1;
const UPSTREAM_TIMEOUT_MS = 22_000;
const responseCache = new Map<string, CachedRoads>();
const inFlightRequests = new Map<string, Promise<RoadFeature[]>>();
let activeRequests = 0;

function getOverpassUrl(): string {
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

function cacheKey(request: RoadNetworkRequest): string {
  return [
    request.west.toFixed(3),
    request.south.toFixed(3),
    request.east.toFixed(3),
    request.north.toFixed(3),
    request.limit,
  ].join("|");
}

function remember(key: string, roads: RoadFeature[]): void {
  responseCache.delete(key);
  while (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, roads });
}

async function queryRoads(request: RoadNetworkRequest): Promise<RoadFeature[]> {
  let response: Response;
  try {
    response = await fetch(getOverpassUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json",
        "User-Agent": "3D-Geospatial-Platform/0.1 (https://github.com/RakibulhasanUtsho07/3d-geospatial-platform)",
      },
      body: new URLSearchParams({ data: buildOverpassRoadQuery(request) }).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const timeout = typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError";
    throw Object.assign(
      new Error(timeout ? "The OpenStreetMap road query timed out." : "The OpenStreetMap road service is temporarily unreachable."),
      { statusCode: timeout ? 504 : 502 },
    ) as UpstreamFailure;
  }

  if (!response.ok) {
    const overloaded = response.status === 429 || response.status === 503 || response.status === 504;
    throw Object.assign(
      new Error(overloaded
        ? "The shared OpenStreetMap road query service is busy. Please retry shortly."
        : "The OpenStreetMap road service returned HTTP " + response.status + "."),
      {
        statusCode: overloaded ? 503 : 502,
        retryAfter: overloaded ? (response.headers.get("retry-after") ?? "30") : undefined,
      },
    ) as UpstreamFailure;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error("The OpenStreetMap road service returned invalid JSON."), { statusCode: 502 }) as UpstreamFailure;
  }
  if (!payload || typeof payload !== "object" || !("elements" in payload) || !Array.isArray(payload.elements)) {
    throw Object.assign(new Error("The OpenStreetMap road response is missing its elements array."), { statusCode: 502 }) as UpstreamFailure;
  }
  return normalizeOverpassRoadElements(payload.elements, request);
}

function respond(roads: RoadFeature[], request: RoadNetworkRequest, cacheStatus: "HIT" | "MISS" | "COALESCED"): Response {
  return NextResponse.json(
    {
      dataStatus: "openstreetmap-road-network",
      bbox: {
        west: request.west,
        south: request.south,
        east: request.east,
        north: request.north,
      },
      count: roads.length,
      results: roads,
      source: "OpenStreetMap via Overpass API",
      license: "ODbL 1.0",
      attribution: "© OpenStreetMap contributors",
      note: "Road geometry reflects mapped OpenStreetMap centerlines and tags. Unmapped/private roads, incomplete widths and stale tags remain possible. Rendered road widths are sourced where tagged, otherwise estimated from highway class/lanes.",
    },
    {
      headers: {
        "Cache-Control": "public, max-age=120, stale-while-revalidate=600",
        "X-Road-Network-Cache": cacheStatus,
        "X-Road-Network-Count": String(roads.length),
      },
    },
  );
}

export async function GET(request: Request): Promise<Response> {
  const parsed = parseRoadNetworkParams(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const bounds = parsed.value;
  const key = cacheKey(bounds);
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    responseCache.delete(key);
    responseCache.set(key, cached);
    return respond(cached.roads, bounds, "HIT");
  }
  if (cached) responseCache.delete(key);

  let pending = inFlightRequests.get(key);
  let cacheStatus: "MISS" | "COALESCED" = "MISS";
  if (pending) {
    cacheStatus = "COALESCED";
  } else {
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      return NextResponse.json(
        { error: "Detailed road searches are temporarily busy. Please retry shortly." },
        { status: 503, headers: { "Retry-After": "15" } },
      );
    }
    activeRequests += 1;
    pending = queryRoads(bounds)
      .then((roads) => {
        remember(key, roads);
        return roads;
      })
      .finally(() => {
        activeRequests = Math.max(0, activeRequests - 1);
        inFlightRequests.delete(key);
      });
    inFlightRequests.set(key, pending);
  }

  try {
    return respond(await pending, bounds, cacheStatus);
  } catch (error: unknown) {
    const failure = error as UpstreamFailure;
    return NextResponse.json(
      { error: failure instanceof Error ? failure.message : "Road network query failed." },
      {
        status: Number.isInteger(failure?.statusCode) ? failure.statusCode! : 502,
        headers: failure?.retryAfter ? { "Retry-After": failure.retryAfter } : undefined,
      },
    );
  }
}
