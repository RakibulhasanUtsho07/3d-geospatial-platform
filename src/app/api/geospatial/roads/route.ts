import { NextResponse } from "next/server";

import { attachSharedRequestConsumer } from "@/core/geospatial/shared-request-lifecycle.mjs";
import {
  buildOverpassRoadQuery,
  buildRoadNetworkCacheKey,
  normalizeOverpassRoadElements,
  parseRoadNetworkParams,
} from "@/core/geospatial/road-network.mjs";
import type {
  RoadFeature,
  RoadNetworkRequest,
} from "@/core/geospatial/road-network.mjs";
import {
  fetchOverpassElements,
  resolveOverpassEndpoints,
} from "@/core/geospatial/overpass-road-provider.mjs";
import {
  loadOfflineRoadExtract,
  queryOfflineRoadExtract,
} from "@/core/geospatial/offline-road-extract.mjs";

type RoadQueryResult = {
  roads: RoadFeature[];
  detailLevel: "full" | "reduced" | "offline";
  upstreamAttempts: number;
  upstreamEndpoint: string;
  sourceDate?: string;
  sourceUrl?: string;
};
type CachedRoads = { expiresAt: number; payload: RoadQueryResult };
type UpstreamFailure = Error & { statusCode?: number; retryAfter?: string };
type InFlightRoadRequest = {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<RoadQueryResult>;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 24;
const MAX_CONCURRENT_REQUESTS = 1;
const UPSTREAM_TIMEOUT_MS = 9_000;
const responseCache = new Map<string, CachedRoads>();
const inFlightRequests = new Map<string, InFlightRoadRequest>();
let activeRequests = 0;

function isAbortError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError";
}


function remember(key: string, payload: RoadQueryResult): void {
  responseCache.delete(key);
  while (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
}

async function queryRoads(request: RoadNetworkRequest, upstreamSignal: AbortSignal): Promise<RoadQueryResult> {
  const offlinePath = process.env.DHAKA_ROADS_EXTRACT_PATH?.trim();
  if (offlinePath) {
    let extract;
    try {
      extract = await loadOfflineRoadExtract(offlinePath);
    } catch (error: unknown) {
      console.error("[Roads] Configured local OSM extract failed validation.", error instanceof Error ? error.message : String(error));
      throw Object.assign(new Error("The configured local Dhaka road extract is unavailable or invalid."), {
        statusCode: 503,
        retryAfter: "60",
      }) as UpstreamFailure;
    }
    const offline = queryOfflineRoadExtract(extract, request);
    if (offline.covered) {
      return {
        roads: offline.roads,
        detailLevel: "offline",
        upstreamAttempts: 0,
        upstreamEndpoint: "local-road-extract",
        sourceDate: offline.sourceDate,
        sourceUrl: offline.sourceUrl,
      };
    }
  }
  const upstream = await fetchOverpassElements({
    endpoints: resolveOverpassEndpoints(process.env),
    queries: [
      buildOverpassRoadQuery(request),
      buildOverpassRoadQuery({ ...request, limit: Math.min(request.limit, 350) }, { detailLevel: "reduced" }),
    ],
    signal: upstreamSignal,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    userAgent: "3D-Geospatial-Platform/0.1 (https://github.com/RakibulhasanUtsho07/3d-geospatial-platform)",
  });
  if (upstream.attempts > 1) {
    console.warn("[Roads] Primary Overpass query failed; reduced-query fallback succeeded.", {
      attempts: upstream.attempts,
      detailLevel: upstream.detailLevel,
    });
  }
  return {
    roads: normalizeOverpassRoadElements(upstream.elements, request),
    detailLevel: upstream.detailLevel,
    upstreamAttempts: upstream.attempts,
    upstreamEndpoint: upstream.endpoint,
  };
}

function respond(
  payload: RoadQueryResult,
  request: RoadNetworkRequest,
  cacheStatus: "HIT" | "MISS" | "COALESCED",
  upstreamAttempts = payload.upstreamAttempts,
): Response {
  return NextResponse.json(
    {
      dataStatus: "openstreetmap-road-network",
      detailLevel: payload.detailLevel,
      bbox: {
        west: request.west,
        south: request.south,
        east: request.east,
        north: request.north,
      },
      count: payload.roads.length,
      results: payload.roads,
      source: payload.detailLevel === "offline"
        ? "OpenStreetMap regional offline extract"
        : "OpenStreetMap via Overpass API",
      sourceDate: payload.sourceDate ?? null,
      sourceUrl: payload.sourceUrl ?? null,
      license: "ODbL 1.0",
      attribution: "© OpenStreetMap contributors",
      note: payload.detailLevel === "offline"
        ? "Road geometry comes from the configured local OSM regional extract, dated " + String(payload.sourceDate) + ". It is available without an Overpass request but may be stale relative to live OSM changes."
        : payload.detailLevel === "reduced"
          ? "Road geometry is a reduced fallback after the primary query failed; some local, service and pedestrian roads may be omitted. Unmapped/private roads and stale tags remain possible."
          : "Road geometry reflects mapped OpenStreetMap centerlines and tags. Unmapped/private roads, incomplete widths and stale tags remain possible. Rendered road widths are sourced where tagged, otherwise estimated from highway class/lanes.",
    },
    {
      headers: {
        "Cache-Control": "public, max-age=120, stale-while-revalidate=600",
        "X-Road-Network-Cache": cacheStatus,
        "X-Road-Network-Count": String(payload.roads.length),
        "X-Road-Network-Upstream-Attempts": String(upstreamAttempts),
        "X-Road-Network-Detail-Level": payload.detailLevel,
        "X-Road-Network-Source": payload.detailLevel === "offline" ? "local-extract" : "overpass",
        ...(payload.sourceDate ? { "X-Road-Network-Source-Date": payload.sourceDate } : {}),
      },
    },
  );
}

export async function GET(request: Request): Promise<Response> {
  if (request.signal.aborted) return new Response(null, { status: 499 });

  const parsed = parseRoadNetworkParams(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const bounds = parsed.value;
  const key = buildRoadNetworkCacheKey(bounds);
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    responseCache.delete(key);
    responseCache.set(key, cached);
    return respond(cached.payload, bounds, "HIT", 0);
  }
  if (cached) responseCache.delete(key);

  let pending = inFlightRequests.get(key);
  if (pending?.settled || pending?.controller.signal.aborted) pending = undefined;

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

    const controller = new AbortController();
    const entry: InFlightRoadRequest = {
      controller,
      consumers: 0,
      settled: false,
      promise: Promise.resolve({ roads: [], detailLevel: "full", upstreamAttempts: 0, upstreamEndpoint: "" }),
    };
    activeRequests += 1;
    entry.promise = queryRoads(bounds, controller.signal)
      .then((payload) => {
        // A disconnected final consumer must not populate the cache with a
        // response that no active viewport still needs.
        if (controller.signal.aborted) {
          throw new DOMException("Road request was aborted.", "AbortError");
        }
        remember(key, payload);
        return payload;
      })
      .finally(() => {
        entry.settled = true;
        activeRequests = Math.max(0, activeRequests - 1);
        if (inFlightRequests.get(key) === entry) inFlightRequests.delete(key);
      });
    inFlightRequests.set(key, entry);
    pending = entry;
  }

  const entry = pending;
  const releaseConsumer = attachSharedRequestConsumer(entry, request.signal);
  if (request.signal.aborted) {
    releaseConsumer();
    return new Response(null, { status: 499 });
  }

  try {
    const payload = await entry.promise;
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return respond(payload, bounds, cacheStatus, payload.upstreamAttempts);
  } catch (error: unknown) {
    if (request.signal.aborted || isAbortError(error)) {
      return new Response(null, { status: 499 });
    }
    const failure = error as UpstreamFailure;
    return NextResponse.json(
      { error: failure instanceof Error ? failure.message : "Road network query failed." },
      {
        status: Number.isInteger(failure?.statusCode) ? failure.statusCode! : 502,
        headers: failure?.retryAfter ? { "Retry-After": failure.retryAfter } : undefined,
      },
    );
  } finally {
    releaseConsumer();
  }
}
