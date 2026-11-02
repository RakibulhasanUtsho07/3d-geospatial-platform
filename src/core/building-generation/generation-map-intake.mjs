import { normalizeBuildingSpec } from "./building-spec.mjs";
import { normalizeSourceOperationScopes } from "./source-operation-scopes.mjs";

const EARTH_RADIUS_M = 6378137;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const STRATEGIES = new Set(["procedural", "single-image-ai", "photogrammetry"]);
const OPERATION_SCOPES_BY_STRATEGY = Object.freeze({
  procedural: ["private-media-ingestion", "procedural-model-derivation"],
  "single-image-ai": ["private-media-ingestion", "single-image-ai-reconstruction"],
  photogrammetry: ["private-media-ingestion", "photogrammetry-reconstruction", "texture-baking"],
});

export function getMapGenerationOperationScopes(strategy) {
  if (!STRATEGIES.has(strategy)) throw new TypeError("Unsupported map generation strategy.");
  return [...OPERATION_SCOPES_BY_STRATEGY[strategy]];
}

function finite(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be a finite number between " + minimum + " and " + maximum + ".");
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier using letters, digits, dot, underscore or hyphen (max 80 characters).");
  }
  return value;
}

/**
 * Build a metric rectangular BuildingSpec from operator-supplied WGS84 center,
 * dimensions and orientation. These values are inputs, not image-derived truth.
 */
export function buildMapGenerationBuildingSpec(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Building intake input must be an object.");
  }
  const id = safeId(input.id, "building id");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 240) {
    throw new TypeError("Building name is required (max 240 characters).");
  }

  const longitude = finite(input.longitude, "Longitude", -180, 180);
  const latitude = finite(input.latitude, "Latitude", -85, 85);
  const heightM = finite(input.heightM ?? 0, "Reference height", -1000, 10000);
  const widthM = finite(input.widthM, "Footprint width", 1, 500);
  const depthM = finite(input.depthM, "Footprint depth", 1, 500);
  const floorCount = finite(input.floorCount, "Floor count", 1, 100);
  const floorHeightM = finite(input.floorHeightM, "Floor height", 2, 8);
  const headingDegrees = finite(input.headingDegrees ?? 0, "Footprint heading", -360, 360);
  if (!Number.isInteger(floorCount)) throw new RangeError("Floor count must be an integer.");

  const heading = headingDegrees * Math.PI / 180;
  const cosine = Math.cos(heading);
  const sine = Math.sin(heading);
  const latitudeRadians = latitude * Math.PI / 180;
  const longitudeScale = EARTH_RADIUS_M * Math.cos(latitudeRadians);
  if (Math.abs(longitudeScale) < 1) {
    throw new RangeError("Longitude-based footprint placement is unsupported near the poles.");
  }

  const localCorners = [
    [-widthM / 2, -depthM / 2],
    [widthM / 2, -depthM / 2],
    [widthM / 2, depthM / 2],
    [-widthM / 2, depthM / 2],
  ];
  const ring = localCorners.map(([x, z]) => {
    const east = x * cosine - z * sine;
    const north = x * sine + z * cosine;
    return [
      longitude + east / longitudeScale * 180 / Math.PI,
      latitude + north / EARTH_RADIUS_M * 180 / Math.PI,
    ];
  });
  ring.push([...ring[0]]);

  const { spec } = normalizeBuildingSpec({
    schemaVersion: "1.0.0",
    id,
    name: input.name.trim(),
    location: { longitude, latitude, heightM },
    footprint: { type: "Polygon", coordinates: [ring] },
    dimensions: {
      floorCount,
      floorHeightM,
      parapetHeightM: 0.8,
      wallThicknessM: 0.22,
    },
    architecture: {
      style: "dhaka-residential-modern",
      roofType: "flat",
      balcony: { enabled: true, everyFloors: 2, widthM: 1.6, depthM: 0.85 },
      windows: { enabled: true, widthM: 1.15, heightM: 1.25 },
    },
    evidence: [
      {
        field: "footprint",
        value: { widthM, depthM, headingDegrees },
        confidence: "estimated",
        sourceIds: [],
        notes: "Metric rectangle generated from operator-entered dimensions; not surveyed geometry.",
      },
      {
        field: "floorCount",
        value: floorCount,
        confidence: "estimated",
        sourceIds: [],
        notes: "Operator-entered intake value; verify against independent evidence.",
      },
    ],
    tags: ["map-intake", "operator-provided-dimensions"],
  });
  return spec;
}

/**
 * Build the durable queue request from exact private intake records.
 * Strategy confirmations are explicit and mirror the server-side queue.
 */
export function buildMapGenerationJobInput({
  buildingSpec,
  strategy,
  uploadedSources,
  confirmRights,
  confirmOperationScopes,
  selectedViewSourceIds,
  confirmSingleViewInference = false,
  confirmSameBuilding = false,
  confirmOverlapReviewed = false,
  confirmUpAxisReviewed = false,
  upAxis = "Y",
} = {}) {
  if (!STRATEGIES.has(strategy)) {
    throw new TypeError("Strategy must be procedural, single-image-ai or photogrammetry.");
  }
  if (!Array.isArray(uploadedSources) || uploadedSources.length > 100) {
    throw new TypeError("Uploaded sources must be an array with at most 100 records.");
  }
  if (uploadedSources.length > 0 && confirmRights !== true) {
    throw new Error("Confirm source rights before queueing generation.");
  }
  if (uploadedSources.length > 0 && confirmOperationScopes !== true) {
    throw new Error("Confirm that every uploaded source permits the selected generation operation(s).");
  }

  const requiredOperationScopes = OPERATION_SCOPES_BY_STRATEGY[strategy];
  const seen = new Set();
  const sources = uploadedSources.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new TypeError("Uploaded source " + index + " must be a record.");
    }
    const sourceId = safeId(source.sourceId, "source " + index + " ID");
    if (seen.has(sourceId)) throw new TypeError("Uploaded source IDs must be unique.");
    seen.add(sourceId);
    if (typeof source.relativePath !== "string" || !source.relativePath.trim() ||
        source.relativePath.includes("\\") || source.relativePath.startsWith("/") ||
        source.relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new TypeError("Uploaded source " + sourceId + " has an unsafe workspace-relative path.");
    }
    if (typeof source.licence !== "string" || !source.licence.trim() ||
        ["unknown", "n/a", "none"].includes(source.licence.trim().toLowerCase())) {
      throw new TypeError("Uploaded source " + sourceId + " needs a known licence/permission basis.");
    }
    if (source.kind !== "image") throw new TypeError("Map image intake only accepts image sources.");
    const permittedOperations = normalizeSourceOperationScopes(
      source.permittedOperations,
      "Uploaded source " + sourceId + " permittedOperations",
    );
    const missingScopes = requiredOperationScopes.filter((scope) => !permittedOperations.includes(scope));
    if (missingScopes.length) {
      throw new Error("Uploaded source " + sourceId + " lacks the selected strategy's required operation permission(s): " + missingScopes.join(", "));
    }
    return {
      sourceId,
      relativePath: source.relativePath,
      kind: "image",
      licence: source.licence.trim().slice(0, 300),
      permittedOperations,
      ...(typeof source.author === "string" && source.author.trim() ? { author: source.author.trim().slice(0, 500) } : {}),
      ...(typeof source.attribution === "string" && source.attribution.trim() ? { attribution: source.attribution.trim().slice(0, 500) } : {}),
      ...(typeof source.sourceUrl === "string" && source.sourceUrl.trim() ? { sourceUrl: source.sourceUrl.trim().slice(0, 2000) } : {}),
      ...(typeof source.description === "string" && source.description.trim() ? { description: source.description.trim().slice(0, 2000) } : {}),
    };
  });

  const viewIds = selectedViewSourceIds ?? [];
  if (!Array.isArray(viewIds) || new Set(viewIds).size !== viewIds.length ||
      viewIds.some((id) => typeof id !== "string" || !seen.has(id))) {
    throw new TypeError("Selected view IDs must be unique uploaded source IDs.");
  }

  const request = {
    buildingSpec,
    strategy,
    sources,
    confirmRights: confirmRights === true,
    confirmOperationScopes: confirmOperationScopes === true,
  };

  if (strategy === "single-image-ai") {
    if (viewIds.length !== 1 || confirmSingleViewInference !== true) {
      throw new Error("Single-image AI requires exactly one selected image and explicit single-view inference confirmation.");
    }
    request.viewSourceIds = [...viewIds];
    request.confirmSingleViewInference = true;
  } else if (strategy === "photogrammetry") {
    if (viewIds.length < 3 || confirmSameBuilding !== true ||
        confirmOverlapReviewed !== true || confirmUpAxisReviewed !== true ||
        !["X", "Y", "Z"].includes(upAxis)) {
      throw new Error("Photogrammetry requires at least three selected images and explicit same-building, overlap and up-axis confirmations.");
    }
    request.viewSourceIds = [...viewIds];
    request.confirmSameBuilding = true;
    request.confirmOverlapReviewed = true;
    request.confirmUpAxisReviewed = true;
    request.upAxis = upAxis;
  }

  return request;
}
