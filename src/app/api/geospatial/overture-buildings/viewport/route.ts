import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

type JsonObject = Record<string, unknown>;

type GeoJsonFeatureCollection = JsonObject & {
  type: "FeatureCollection";
  features: unknown[];
};

type ViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type IndexedFeature = {
  feature: unknown;
  bounds: ViewportBounds | null;
};

type IndexedDataset = {
  rawContents: string;
  collection: GeoJsonFeatureCollection;
  indexedFeatures: IndexedFeature[];
};

const DATA_FILE = resolve(
  process.cwd(),
  "data",
  "overture",
  "dhaka-buildings-3d-pilot.geojson",
);

const DATA_FILE_RELATIVE =
  "data/overture/dhaka-buildings-3d-pilot.geojson";
const MAX_VIEWPORT_SPAN_DEGREES = 2;

let indexedDatasetPromise: Promise<IndexedDataset> | null = null;

function isRecord(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isFeatureCollection(
  value: unknown,
): value is GeoJsonFeatureCollection {
  if (!isRecord(value) || value.type !== "FeatureCollection") {
    return false;
  }

  if (!Array.isArray(value.features)) {
    return false;
  }

  return value.features.every((feature: unknown) => {
    if (!isRecord(feature) || feature.type !== "Feature") {
      return false;
    }

    if (!isRecord(feature.geometry)) {
      return false;
    }

    return typeof feature.geometry.type === "string";
  });
}

function getGeometryCoordinates(feature: unknown): unknown {
  if (!isRecord(feature) || !isRecord(feature.geometry)) {
    return null;
  }

  return feature.geometry.coordinates;
}

function getCoordinateBounds(coordinates: unknown): ViewportBounds | null {
  const bounds: ViewportBounds = {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  };

  function visit(value: unknown): void {
    if (!Array.isArray(value)) {
      return;
    }

    // A GeoJSON position starts with longitude and latitude numbers.
    if (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    ) {
      const longitude = value[0];
      const latitude = value[1];

      bounds.west = Math.min(bounds.west, longitude);
      bounds.south = Math.min(bounds.south, latitude);
      bounds.east = Math.max(bounds.east, longitude);
      bounds.north = Math.max(bounds.north, latitude);
      return;
    }

    for (const child of value) {
      visit(child);
    }
  }

  visit(coordinates);

  if (
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.north)
  ) {
    return null;
  }

  return bounds;
}

async function readAndIndexDataset(): Promise<IndexedDataset> {
  const rawContents = await readFile(DATA_FILE, "utf8");
  let parsedData: unknown;

  try {
    parsedData = JSON.parse(rawContents);
  } catch {
    throw new Error("The Overture pilot dataset contains invalid JSON.");
  }

  if (!isFeatureCollection(parsedData)) {
    throw new Error(
      "The Overture pilot file is not a valid GeoJSON FeatureCollection.",
    );
  }

  const indexedFeatures = parsedData.features.map((feature) => ({
    feature,
    bounds: getCoordinateBounds(getGeometryCoordinates(feature)),
  }));

  console.info("[Overture Viewport API] Spatial index ready.", {
    totalFeatures: indexedFeatures.length,
    indexedFeatures: indexedFeatures.filter((item) => item.bounds !== null).length,
  });

  return {
    rawContents,
    collection: parsedData,
    indexedFeatures,
  };
}

function getIndexedDataset(): Promise<IndexedDataset> {
  if (!indexedDatasetPromise) {
    indexedDatasetPromise = readAndIndexDataset().catch((error: unknown) => {
      // Allow a later request to retry when a file read or validation fails.
      indexedDatasetPromise = null;
      throw error;
    });
  }

  return indexedDatasetPromise;
}

function parseViewportBounds(
  requestUrl: URL,
): { bounds: ViewportBounds } | { error: string } {
  const keys = ["west", "south", "east", "north"] as const;
  const values = keys.map((key) => requestUrl.searchParams.get(key));

  if (values.some((value) => value === null || value.trim() === "")) {
    return {
      error:
        "Provide west, south, east, and north query parameters for the viewport.",
    };
  }

  const [westValue, southValue, eastValue, northValue] = values;
  const bounds = {
    west: Number(westValue),
    south: Number(southValue),
    east: Number(eastValue),
    north: Number(northValue),
  };

  if (Object.values(bounds).some((value) => !Number.isFinite(value))) {
    return { error: "Viewport bounds must be finite numbers." };
  }

  if (
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -85 ||
    bounds.north > 85 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north
  ) {
    return { error: "Viewport bounds are outside the supported range." };
  }

  if (
    bounds.east - bounds.west > MAX_VIEWPORT_SPAN_DEGREES ||
    bounds.north - bounds.south > MAX_VIEWPORT_SPAN_DEGREES
  ) {
    return {
      error:
        `Viewport spans cannot exceed ${MAX_VIEWPORT_SPAN_DEGREES} degrees. Use the standard Overture endpoint for a full-dataset request.`,
    };
  }

  return { bounds };
}

function intersects(
  featureBounds: ViewportBounds,
  viewport: ViewportBounds,
): boolean {
  return (
    featureBounds.west <= viewport.east &&
    featureBounds.east >= viewport.west &&
    featureBounds.south <= viewport.north &&
    featureBounds.north >= viewport.south
  );
}

function getRenderRole(feature: unknown): string {
  if (!isRecord(feature) || !isRecord(feature.properties)) {
    return "unknown";
  }

  const role = feature.properties._renderRole;
  return typeof role === "string" ? role : "unknown";
}

export async function GET(request: Request): Promise<Response> {
  const parsedBounds = parseViewportBounds(new URL(request.url));

  if ("error" in parsedBounds) {
    return NextResponse.json(
      { error: parsedBounds.error },
      { status: 400 },
    );
  }

  const viewport = parsedBounds.bounds;

  try {
    const dataset = await getIndexedDataset();
    const matchingFeatures = dataset.indexedFeatures
      .filter(
        (entry) =>
          entry.bounds !== null && intersects(entry.bounds, viewport),
      )
      .map((entry) => entry.feature);

    let buildingCount = 0;
    let parentCount = 0;
    let partCount = 0;
    let unknownRoleCount = 0;

    for (const feature of matchingFeatures) {
      switch (getRenderRole(feature)) {
        case "building":
          buildingCount += 1;
          break;
        case "building_parent":
          parentCount += 1;
          break;
        case "building_part":
          partCount += 1;
          break;
        default:
          unknownRoleCount += 1;
          break;
      }
    }

    const viewportCollection = {
      ...dataset.collection,
      features: matchingFeatures,
    };

    console.info("[Overture Viewport API] Viewport ready.", {
      totalFeatures: dataset.indexedFeatures.length,
      returnedFeatures: matchingFeatures.length,
      buildings: buildingCount,
      buildingParts: partCount,
      parents: parentCount,
    });

    return NextResponse.json(viewportCollection, {
      headers: {
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
        "X-Building-Dataset": "overture-3d-pilot",
        "X-Building-Feature-Count": String(matchingFeatures.length),
        "X-Building-Total-Feature-Count": String(
          dataset.indexedFeatures.length,
        ),
        "X-Building-Count": String(buildingCount),
        "X-Building-Parent-Count": String(parentCount),
        "X-Building-Part-Count": String(partCount),
        "X-Building-Unknown-Role-Count": String(unknownRoleCount),
        "X-Building-Viewport": [
          viewport.west,
          viewport.south,
          viewport.east,
          viewport.north,
        ].join(","),
      },
    });
  } catch (error: unknown) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error
        ? String(error.code)
        : "";

    if (code === "ENOENT") {
      console.error(
        `[Overture Viewport API] Dataset not found: ${DATA_FILE_RELATIVE}`,
      );

      return NextResponse.json(
        {
          error: "Overture pilot dataset not found.",
          expectedFile: DATA_FILE_RELATIVE,
          instruction:
            "Generate the pilot GeoJSON file before loading the map.",
        },
        { status: 404 },
      );
    }

    console.error(
      "[Overture Viewport API] Could not index the pilot dataset:",
      error instanceof Error ? error.message : String(error),
    );

    return NextResponse.json(
      {
        error: "Could not query the Overture pilot dataset.",
      },
      { status: 500 },
    );
  }
}
