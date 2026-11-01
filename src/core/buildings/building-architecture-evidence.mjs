/**
 * Source-bound architectural metadata extracted from Overture Buildings v2.
 *
 * This module validates claims already present on a feature. It deliberately
 * does not infer a roof, facade, part count, or architectural style when a
 * field is absent. Geometry generation remains a separate, reviewed stage.
 * Field names, value types and enumerations are pinned to Overture Buildings
 * schema v2.0.0; this is source-shape validation, not human verification.
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
  if (raw.trim() !== raw) return { status: "invalid", value: null };
  return { status: "source", value: raw };
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

function sourceNumber(properties, key, {
  minimum = -Infinity,
  exclusiveMinimum = false,
  maximum = Infinity,
  exclusiveMaximum = false,
} = {}) {
  if (!Object.hasOwn(properties, key) || properties[key] === null || properties[key] === undefined) {
    return { status: "absent", value: null };
  }
  const value = properties[key];
  const valid = typeof value === "number" && Number.isFinite(value) &&
    (exclusiveMinimum ? value > minimum : value >= minimum) &&
    (exclusiveMaximum ? value < maximum : value <= maximum);
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
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /\\s/.test(value)) {
    return { status: "invalid", value: null };
  }
  return { status: "source", value };
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
  const roofDirection = sourceNumber(properties, "roof_direction", {
    minimum: 0,
    maximum: 360,
    exclusiveMaximum: true,
  });
  const roofOrientation = sourceEnum(properties, "roof_orientation", ROOF_ORIENTATIONS);
  // Overture v2 declares roof_height as float64 without a positivity bound.
  // Preserve the finite source value; the mesh stage owns its geometry policy.
  const roofHeight = sourceNumber(properties, "roof_height");

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
    ? roofHeight.value > 0
      ? "source-roof-shape-and-positive-height-present-geometry-not-yet-generated"
      : "source-roof-height-nonpositive-geometry-not-renderable"
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

/**
 * Audit Overture's parent/building_part composition references across the
 * complete source FeatureCollection, not just the bounded set selected for
 * tile output. Parent resolution is ID-based and fail-closed.
 *
 * selectedFeatureIds, when supplied, is the exact feature-ID set emitted into
 * the package. A source relationship and package co-selection are reported
 * separately: a valid parent in the source extract may be outside the tile
 * subset.
 */
export function auditBuildingPartComposition(features, { selectedFeatureIds = null } = {}) {
  if (!Array.isArray(features)) {
    throw new TypeError("Building composition audit requires a source feature array.");
  }
  if (selectedFeatureIds !== null && !(selectedFeatureIds instanceof Set)) {
    throw new TypeError("selectedFeatureIds must be a Set or null.");
  }

  const getFeatureId = (feature) => {
    const id = isRecord(feature) ? feature.id : null;
    return typeof id === "string" && id.length > 0 && id.trim() === id && !/\\s/.test(id)
      ? id
      : null;
  };
  const parentRecords = [];
  const partRecords = [];
  for (const feature of features) {
    if (!isRecord(feature) || !isRecord(feature.properties)) continue;
    const featureId = getFeatureId(feature);
    if (feature.properties.type === "building") {
      parentRecords.push({ featureId, properties: feature.properties });
    } else if (feature.properties.type === "building_part") {
      partRecords.push({ featureId, properties: feature.properties });
    }
  }

  const parentsById = new Map();
  for (const parent of parentRecords) {
    if (!parent.featureId) continue;
    const records = parentsById.get(parent.featureId) ?? [];
    records.push(parent);
    parentsById.set(parent.featureId, records);
  }

  const partsByParentId = new Map();
  const partLinks = partRecords.map((part) => {
    const id = sourceIdentifier(part.properties, "building_id");
    const parents = id.status === "source" ? parentsById.get(id.value) ?? [] : [];
    const status = id.status !== "source"
      ? "missing-or-invalid-parent-id"
      : parents.length === 0
        ? "parent-feature-not-in-source-extract"
        : parents.length > 1
          ? "ambiguous-duplicate-parent-feature-id"
          : "parent-feature-resolved";
    if (id.status === "source") {
      const linked = partsByParentId.get(id.value) ?? [];
      linked.push(part);
      partsByParentId.set(id.value, linked);
    }
    const parent = parents.length === 1 ? parents[0] : null;
    return {
      partFeatureId: part.featureId,
      parentBuildingId: id.value,
      status,
      parentHasPartsClaim: parent ? sourceBoolean(parent.properties, "has_parts") : { status: "unavailable", value: null },
      parentSelectedInPackage: parent && selectedFeatureIds
        ? selectedFeatureIds.has(parent.featureId)
        : null,
      partSelectedInPackage: selectedFeatureIds && part.featureId
        ? selectedFeatureIds.has(part.featureId)
        : null,
    };
  });

  const byFeatureId = {};
  const parentStatusCounts = {};
  for (const parent of parentRecords) {
    if (!parent.featureId) continue;
    const associatedParts = partsByParentId.get(parent.featureId) ?? [];
    const hasParts = sourceBoolean(parent.properties, "has_parts");
    const duplicateId = (parentsById.get(parent.featureId) ?? []).length > 1;
    const status = duplicateId
      ? "ambiguous-duplicate-parent-feature-id"
      : associatedParts.length > 0
        ? hasParts.status === "source" && hasParts.value === false
          ? "parts-found-despite-false-has-parts-claim"
          : hasParts.status === "source" && hasParts.value === true
            ? "parts-found-and-declared"
            : "parts-found-has-parts-claim-unavailable"
        : hasParts.status === "source" && hasParts.value === true
          ? "parts-declared-but-none-in-source-extract"
          : hasParts.status === "source" && hasParts.value === false
            ? "no-parts-declared"
            : "part-association-unknown";
    parentStatusCounts[status] = (parentStatusCounts[status] ?? 0) + 1;
    byFeatureId[parent.featureId] = {
      featureType: "building",
      status,
      hasPartsClaim: hasParts,
      associatedPartFeatureIds: associatedParts.map((part) => part.featureId),
      associatedPartCount: associatedParts.length,
      associatedPartsSelectedInPackageCount: selectedFeatureIds
        ? associatedParts.filter((part) => part.featureId && selectedFeatureIds.has(part.featureId)).length
        : null,
      selectedInPackage: selectedFeatureIds
        ? selectedFeatureIds.has(parent.featureId)
        : null,
    };
  }

  const partStatusCounts = {};
  for (const link of partLinks) {
    partStatusCounts[link.status] = (partStatusCounts[link.status] ?? 0) + 1;
    if (link.partFeatureId) {
      byFeatureId[link.partFeatureId] = {
        featureType: "building_part",
        status: link.status,
        parentBuildingId: link.parentBuildingId,
        parentHasPartsClaim: link.parentHasPartsClaim,
        parentSelectedInPackage: link.parentSelectedInPackage,
        partSelectedInPackage: link.partSelectedInPackage,
      };
    }
  }

  const summary = {
    schema: `overture-buildings-${OVERTURE_BUILDINGS_SCHEMA_VERSION}`,
    sourceFeatureCount: features.length,
    buildingFeatureCount: parentRecords.length,
    buildingPartFeatureCount: partRecords.length,
    linkedPartCount: partStatusCounts["parent-feature-resolved"] ?? 0,
    partStatusCounts,
    parentStatusCounts,
    duplicateParentIdCount: [...parentsById.values()].filter((records) => records.length > 1).length,
    selectedFeatureCount: selectedFeatureIds ? selectedFeatureIds.size : null,
  };
  return { schemaVersion: 1, byFeatureId, partLinks, summary };
}

/**
 * Aggregate only source-bound metadata states from the already-resolved
 * per-feature records. This summary is derived data and is recomputed by the
 * independent package reviewer before it is accepted.
 */
export function summarizeBuildingArchitectureEvidence(evidenceItems) {
  if (!Array.isArray(evidenceItems) || evidenceItems.length === 0 ||
      evidenceItems.some((item) => !isRecord(item))) {
    throw new TypeError("Architecture evidence summary requires a non-empty evidence array.");
  }

  const fieldNames = [
    "featureType",
    "hasParts",
    "buildingId",
    "facade.color",
    "facade.material",
    "roof.color",
    "roof.material",
    "roof.shape",
    "roof.directionDegrees",
    "roof.orientation",
    "roof.heightMeters",
  ];
  const field = (evidence, name) => {
    let value = evidence;
    for (const part of name.split(".")) value = value?.[part];
    return value;
  };
  const fieldAvailability = Object.fromEntries(fieldNames.map((name) => [
    name,
    evidenceItems.reduce((counts, evidence) => {
      const status = field(evidence, name)?.status;
      const key = status === "source" || status === "absent" || status === "invalid"
        ? status
        : "missing-evidence";
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, { source: 0, absent: 0, invalid: 0, "missing-evidence": 0 }),
  ]));
  const countValues = (selector) => evidenceItems.reduce((counts, evidence) => {
    const value = selector(evidence);
    if (typeof value === "string" && value) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});

  return {
    schema: `overture-buildings-${OVERTURE_BUILDINGS_SCHEMA_VERSION}`,
    tileCount: evidenceItems.length,
    featureTypeCounts: countValues((item) => item.featureType?.value),
    compositionStatusCounts: countValues((item) => item.compositionStatus),
    roofGeometryStatusCounts: countValues((item) => item.roof?.geometryStatus),
    facadeStyleStatusCounts: countValues((item) => item.facade?.status),
    compositionLinkStatusCounts: countValues((item) => item.compositionLink?.status),
    fieldAvailability,
    geometryCompleteness: "footprint-extrusion-only",
    renderedArchitecturalDetailCount: 0,
  };
}
