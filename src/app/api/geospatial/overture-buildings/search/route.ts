import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

import {
  BUILDING_SEARCH_LIMITS,
  createBuildingSearchIndex,
  searchBuildingIndex,
} from "@/core/geospatial/building-search.mjs";
import type { BuildingSearchDocument } from "@/core/geospatial/building-search.mjs";

type JsonObject = Record<string, unknown>;

const DATA_FILE = resolve(
  process.cwd(),
  "data",
  "overture",
  "dhaka-buildings-3d-pilot.geojson",
);
const DATA_FILE_RELATIVE = "data/overture/dhaka-buildings-3d-pilot.geojson";

let buildingSearchIndexPromise: Promise<BuildingSearchDocument[]> | null = null;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBuildingSearchIndex(): Promise<BuildingSearchDocument[]> {
  const raw = await readFile(DATA_FILE, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The Overture pilot dataset contains invalid JSON.");
  }

  if (
    !isRecord(parsed) ||
    parsed.type !== "FeatureCollection" ||
    !Array.isArray(parsed.features)
  ) {
    throw new Error("The Overture pilot file is not a valid GeoJSON FeatureCollection.");
  }

  return createBuildingSearchIndex(parsed.features);
}

function getBuildingSearchIndex(): Promise<BuildingSearchDocument[]> {
  if (!buildingSearchIndexPromise) {
    buildingSearchIndexPromise = readBuildingSearchIndex().catch((error: unknown) => {
      // Permit a later request to retry after a temporary filesystem or data error.
      buildingSearchIndexPromise = null;
      throw error;
    });
  }

  return buildingSearchIndexPromise;
}

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const query = requestUrl.searchParams.get("q")?.trim() ?? "";

  if (
    query.length < BUILDING_SEARCH_LIMITS.minQueryLength ||
    query.length > BUILDING_SEARCH_LIMITS.maxQueryLength
  ) {
    return NextResponse.json(
      { error: "Search query must contain between 2 and 100 characters." },
      { status: 400 },
    );
  }

  const rawLimit = requestUrl.searchParams.get("limit");
  const limit = rawLimit === null
    ? BUILDING_SEARCH_LIMITS.defaultLimit
    : Number(rawLimit);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > BUILDING_SEARCH_LIMITS.maxLimit
  ) {
    return NextResponse.json(
      { error: "Search limit must be an integer between 1 and 20." },
      { status: 400 },
    );
  }

  try {
    const index = await getBuildingSearchIndex();
    const match = searchBuildingIndex(index, query, limit);

    return NextResponse.json(
      {
        query,
        totalMatches: match.totalMatches,
        returnedCount: match.results.length,
        limit,
        results: match.results,
      },
      {
        headers: {
          "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
          "X-Building-Search-Matches": String(match.totalMatches),
          "X-Building-Search-Returned": String(match.results.length),
        },
      },
    );
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";

    if (code === "ENOENT") {
      return NextResponse.json(
        {
          error: "Overture pilot dataset not found.",
          expectedFile: DATA_FILE_RELATIVE,
        },
        { status: 404 },
      );
    }

    console.error(
      "[Overture Search API] Building search failed:",
      error instanceof Error ? error.message : String(error),
    );

    return NextResponse.json(
      { error: "Could not search the Overture pilot dataset." },
      { status: 500 },
    );
  }
}
