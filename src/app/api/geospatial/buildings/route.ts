
import { NextResponse } from "next/server";


interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  geometry?: Array<{
    lat: number;
    lon: number;
  }>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

const OVERPASS_ENDPOINT =
  "https://overpass-api.de/api/interpreter";

const MAX_LATITUDE_SPAN = 0.02;
const MAX_LONGITUDE_SPAN = 0.02;
const MAX_RETURNED_BUILDINGS = 180;

function isValidBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== "object") {
    return false;
  }

  const bounds = value as Record<string, unknown>;

  const { south, west, north, east } = bounds;

  if (
    typeof south !== "number" ||
    typeof west !== "number" ||
    typeof north !== "number" ||
    typeof east !== "number"
  ) {
    return false;
  }

  if (
    !Number.isFinite(south) ||
    !Number.isFinite(west) ||
    !Number.isFinite(north) ||
    !Number.isFinite(east)
  ) {
    return false;
  }

  if (
    south < -85 ||
    north > 85 ||
    west < -180 ||
    east > 180
  ) {
    return false;
  }

  if (south >= north || west >= east) {
    return false;
  }

  if (
    north - south > MAX_LATITUDE_SPAN ||
    east - west > MAX_LONGITUDE_SPAN
  ) {
    return false;
  }

  return true;
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();

    if (!isValidBounds(body)) {
      return NextResponse.json(
        { error: "Invalid or oversized geographic bounds." },
        { status: 400 },
      );
    }

    const { south, west, north, east } = body;

    const query = `
      [out:json][timeout:15];
      way["building"](
        ${south.toFixed(6)},
        ${west.toFixed(6)},
        ${north.toFixed(6)},
        ${east.toFixed(6)}
      );
      out geom;
    `;

    const upstream = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({
        data: query,
      }).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(18_000),
    });

    if (!upstream.ok) {
      console.error(
        "Overpass API request failed:",
        upstream.status,
      );

      return NextResponse.json(
        {
          error:
            upstream.status === 429
              ? "Building data service is rate-limited. Try again later."
              : "Building data service is temporarily unavailable.",
        },
        {
          status: upstream.status === 429 ? 429 : 502,
        },
      );
    }

    const data =
      (await upstream.json()) as OverpassResponse;

    const elements = Array.isArray(data.elements)
      ? data.elements
          .filter(
            (element) =>
              element.type === "way" &&
              typeof element.id === "number" &&
              typeof element.tags?.building === "string" &&
              Array.isArray(element.geometry) &&
              element.geometry.length >= 3,
          )
          .slice(0, MAX_RETURNED_BUILDINGS)
      : [];

    return NextResponse.json(
      {
        elements,
        source: "OpenStreetMap",
        attribution: "© OpenStreetMap contributors",
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error: unknown) {
    console.error(
      "Building data API error:",
      error instanceof Error
        ? error.message
        : String(error),
    );

    return NextResponse.json(
      {
        error: "Unable to fetch building data.",
      },
      {
        status: 502,
      },
    );
  }
}