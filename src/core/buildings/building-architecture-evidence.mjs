/**
 * Source-bound architectural metadata extracted from Overture Buildings v2.
 *
 * This module validates claims already present on a feature. It deliberately
 * does not infer a roof, facade, part count, or architectural style when a
 * field is absent. Geometry generation remains a separate, reviewed stage.
 */
export const OVERTURE_BUILDINGS_SCHEMA_VERSION = "2.0.0";

const FACADE_MATERIALS = new Set([
  "brick",
  "cement_block",
  "clay",
  "concrete",
  "glass",
  "metal",
  "plaster",
  "plastic",
  "stone",
  "timber_framing",
  "wood",
]);

const ROOF_MATERIALS = new Set([
  "concrete",
  "copper",
  "eternit",
  "glass",
  "grass",
  "gravel",
  "metal",
  "plastic",
  "roof_tiles",
  "slate",
  "solar_panels",
  "tar_paper",
  "thatch",
  "wood",
]);

const ROOF_SHAPES = new Set([
  "dome",
  "flat",
  "gabled",
  "gambrel",
  "half_hipped",
  "hipped",
  "mansard",
  "onion",
  "pyramidal",
  "round",
  "saltbox",
  "sawtooth",
  "skillion",
  "spherical",
]);

const ROOF_ORIENTATIONS = new Set(["along", "across"]);
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceText(properties, key) {
  if (!Object.hasOwn(properties, key) || properties[key] === null || properties[key] === undefined) {
    return { status: "absent", value: null };
  }
  const raw = properties[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { status: "invalid", value: null };
  }
  return { status: "source", value: raw.trim().toLowerCase() };
}

function sourceEnum(properties, key, allowed) {
  const field = sourceText(properties, key);
  if (field.status !== "source") return field;
  return allowed.has(field.value)
    ? field
    : { status: "invalid", value: null };
}

function sourceColor(properties, key) {
  const field = sourceText(properties, key);
  if (field.status !== "source") return field;
  if (!HEX_COLOR.test(field.value)) return { status: "invalid", value: null };
  const color = field.value.length === 4
    ? "#" + field.value.slice(1).split("").map((digit) => digit + digit).join("")
    : field.value;
  return { status: "source", value: color.toLowerCase() };
}

function sourcePositiveNumber(properties, key, { minimum = 0, exclusiveMinimum = false, maximum = Infinity } = {}) {
  if (!Object.hasOwn(properties, key) || properties[key] === null || properties[key] === undefined) {
    return { status: "absent", value: null };
  }
  const value = properties[key];
  const valid = typeof value === "number" && Number.isFinite(value) &&
    (exclusiveMinimum ? value > minimum : value >= minimum) && value <= maximum;
  return valid
    ? { status: "source", value }
    : { status: "invalid", value: null };
}

function sourceBoolean(properties, key) {
  if (!Object.hasOwn(properties, key) || properties[key] === null || properties[key] === undefined) {
    return { status: "absent", value: null };
  }
  return typeof properties[key] === "boolean"
    ? { status: "source", value: properties[key] }
    : { status: "invalid", value: null };
}

function sourceIdentifier(properties, key) {
  if (!Object.hasOwn(properties, key) || properties[key] === null || properties[key] === undefined) {
    return { status: "absent", value: null };
  }
  const value = properties[key];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    return { status: "invalid", value: null };
  }
  return { status: "source", value: String(value) };
}

/**
 * Returns an immutable, JSON-safe statement of which architectural fields
 * were supplied by Overture and which were absent/invalid.
 *
 * A "source" status means only that the field is schema-shaped and present;
 * it is not a human verification of the underlying physical building.
 */
export function resolveBuildingArchitectureEvidence(properties) {
  if (!isRecord(properties)) {
    throw new TypeError("Building architecture properties must be an object.");
  }

  const featureType = sourceEnum(properties, "type", new Set(["building", "building_part"]));
  const hasParts = sourceBoolean(properties, "has_parts");
  const buildingId = sourceIdentifier(properties, "building_id");
  const facadeColor = sourceColor(properties, "facade_color");
  const facadeMaterial = sourceEnum(properties, "facade_material", FACADE_MATERIALS);
  const roofColor = sourceColor(properties, "roof_color");
  const roofMaterial = sourceEnum(properties, "roof_material", ROOF_MATERIALS);
  const roofShape = sourceEnum(properties, "roof_shape", ROOF_SHAPES);
  const roofDirection = sourcePositiveNumber(properties, "roof_direction", { minimum: 0, maximum: 360 - Number.EPSILON });
  const roofOrientation = sourceEnum(properties, "roof_orientation", ROOF_ORIENTATIONS);
  const roofHeight = sourcePositiveNumber(properties, "roof_height", { minimum: 0, exclusiveMinimum: true });

  let compositionStatus = "feature-type-unknown";
  if (featureType.status === "source" && featureType.value === "building_part") {
    compositionStatus = buildingId.status === "source"
      ? "building-part-parent-join-required"
      : "building-part-parent-id-missing";
  } else if (featureType.status === "source" && featureType.value === "building") {
    compositionStatus = hasParts.status === "source"
      ? hasParts.value ? "parent-declares-associated-parts" : "parent-reports-no-associated-parts"
      : "parent-part-status-unknown";
  }

  const roofGeometryStatus = roofShape.status === "source" && roofHeight.status === "source"
    ? "source-roof-shape-and-height-present-geometry-not-yet-generated"
    : roofShape.status === "invalid" || roofHeight.status === "invalid"
      ? "invalid-roof-metadata"
      : roofShape.status === "source"
        ? "roof-shape-present-roof-height-missing"
        : "roof-shape-not-sourced";

  const facadeStyleStatus = facadeColor.status === "source" || facadeMaterial.status === "source"
    ? "source-facade-style-metadata-present-geometry-not-yet-generated"
    : facadeColor.status === "invalid" || facadeMaterial.status === "invalid"
      ? "invalid-facade-metadata"
      : "facade-style-not-sourced";

  return {
    schemaVersion: 1,
    sourceSchema: `overture-buildings-${OVERTURE_BUILDINGS_SCHEMA_VERSION}`,
    featureType,
    buildingId,
    hasParts,
    compositionStatus,
    facade: {
      color: facadeColor,
      material: facadeMaterial,
      status: facadeStyleStatus,
    },
    roof: {
      color: roofColor,
      material: roofMaterial,
      shape: roofShape,
      directionDegrees: roofDirection,
      orientation: roofOrientation,
      heightMeters: roofHeight,
      geometryStatus: roofGeometryStatus,
    },
    geometryCompleteness: "footprint-extrusion-only",
    verificationStatus: "source-metadata-validated-not-human-verified",
  };
}
