import { NextResponse } from "next/server";

import {
  parsePropertySearchParams,
  searchPropertyListings,
} from "@/core/geospatial/property-listings.mjs";

export function GET(request: Request): Response {
  const parsed = parsePropertySearchParams(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const result = searchPropertyListings(parsed.value);
  return NextResponse.json(
    {
      ...result,
      center: { latitude: parsed.value.latitude, longitude: parsed.value.longitude },
      filters: {
        radiusMeters: parsed.value.radiusMeters,
        minRentBdt: parsed.value.minRentBdt,
        maxRentBdt: parsed.value.maxRentBdt,
        minBedrooms: parsed.value.minBedrooms,
        propertyType: parsed.value.propertyType,
        furnishing: parsed.value.furnishing,
        savedOnly: parsed.value.savedOnly,
      },
      source: "Illustrative property seed data",
      dataStatus: "demo",
      notice: "These records are for product prototyping only; they are not real, verified, or live rental offers.",
    },
    {
      headers: {
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
        "X-Property-Search-Matches": String(result.totalMatches),
        "X-Property-Search-Returned": String(result.returnedCount),
        "X-Property-Data-Status": "demo",
      },
    },
  );
}
