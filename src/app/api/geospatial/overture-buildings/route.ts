
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

type JsonObject = Record<string, unknown>;

type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: unknown[];
};

const DATA_FILE = resolve(
  process.cwd(),
  "data",
  "overture",
  "dhaka-buildings-3d-pilot.geojson",
);

const DATA_FILE_RELATIVE =
  "data/overture/dhaka-buildings-3d-pilot.geojson";

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
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.type !== "FeatureCollection" ||
    !Array.isArray(value.features)
  ) {
    return false;
  }

  // Validate every GeoJSON feature's basic structure.
  return value.features.every((feature: unknown) => {
    if (!isRecord(feature)) {
      return false;
    }

    if (feature.type !== "Feature") {
      return false;
    }

    if (!isRecord(feature.geometry)) {
      return false;
    }

    return typeof feature.geometry.type === "string";
  });
}

function getRenderRole(feature: unknown): string {
  if (!isRecord(feature) || !isRecord(feature.properties)) {
    return "unknown";
  }

  const role = feature.properties._renderRole;

  return typeof role === "string" ? role : "unknown";
}

export async function GET(): Promise<Response> {
  try {
    const contents = await readFile(DATA_FILE, "utf8");

    let parsedData: unknown;

    try {
      parsedData = JSON.parse(contents);
    } catch {
      console.error(
        "[Overture API] The pilot dataset contains invalid JSON.",
      );

      return NextResponse.json(
        {
          error: "The Overture pilot dataset contains invalid JSON.",
        },
        { status: 500 },
      );
    }

    if (!isFeatureCollection(parsedData)) {
      console.error(
        "[Overture API] Invalid GeoJSON FeatureCollection.",
      );

      return NextResponse.json(
        {
          error:
            "The Overture pilot file is not a valid GeoJSON FeatureCollection.",
        },
        { status: 500 },
      );
    }

    const features = parsedData.features;

    if (features.length === 0) {
      return NextResponse.json(
        {
          error: "The Overture pilot dataset contains no features.",
        },
        { status: 500 },
      );
    }

    // Count the rendering roles prepared by the data pipeline.
    let buildingCount = 0;
    let parentCount = 0;
    let partCount = 0;
    let unknownRoleCount = 0;

    for (const feature of features) {
      const role = getRenderRole(feature);

      switch (role) {
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

    console.info("[Overture API] Pilot dataset ready.", {
      totalFeatures: features.length,
      buildings: buildingCount,
      parents: parentCount,
      buildingParts: partCount,
      unknownRoles: unknownRoleCount,
    });

    return new Response(contents, {
      status: 200,
      headers: {
        "Content-Type": "application/geo+json; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        "X-Building-Dataset": "overture-3d-pilot",
        "X-Building-Feature-Count": String(features.length),
        "X-Building-Count": String(buildingCount),
        "X-Building-Parent-Count": String(parentCount),
        "X-Building-Part-Count": String(partCount),
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
        `[Overture API] Dataset not found: ${DATA_FILE_RELATIVE}`,
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
      "[Overture API] Could not read pilot dataset:",
      error instanceof Error ? error.message : String(error),
    );

    return NextResponse.json(
      {
        error: "Could not load the Overture pilot dataset.",
      },
      { status: 500 },
    );
  }
}