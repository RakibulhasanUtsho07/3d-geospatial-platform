#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  auditBuildingPartComposition,
  resolveBuildingArchitectureEvidence,
  summarizeBuildingArchitectureEvidence,
} from "../src/core/buildings/building-architecture-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = path.join(ROOT, "data/overture/dhaka-buildings-3d-pilot.geojson");
export const DHAKA_ARCHITECTURE_COVERAGE_SCHEMA = "dhaka-overture-architecture-coverage-v1";
const ROLES = ["building", "building_parent", "building_part", "unknown"];
const FIELDS = Object.freeze({
  overtureType: ["featureType"],
  compositionRole: ["compositionRole"],
  hasParts: ["hasParts"],
  buildingId: ["buildingId"],
  facadeColor: ["facade", "color"],
  facadeMaterial: ["facade", "material"],
  roofColor: ["roof", "color"],
  roofMaterial: ["roof", "material"],
  roofShape: ["roof", "shape"],
  roofDirection: ["roof", "directionDegrees"],
  roofOrientation: ["roof", "orientation"],
  roofHeight: ["roof", "heightMeters"],
});
const STATUSES = ["source", "absent", "invalid", "extractor-derived", "missing-evidence"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function atPath(value, parts) {
  return parts.reduce((current, part) => current?.[part], value);
}
function emptyCounts() {
  return Object.fromEntries(STATUSES.map((status) => [status, 0]));
}
function emptyCoverage() {
  return Object.fromEntries(Object.keys(FIELDS).map((field) => [field, emptyCounts()]));
}
function addStatus(counts, status) {
  counts[STATUSES.includes(status) ? status : "missing-evidence"] += 1;
}
function percentage(count, total) {
  return total === 0 ? null : Number((count / total * 100).toFixed(4));
}
function validFeatureId(feature) {
  const id = feature?.id;
  return typeof id === "string" && id.length > 0 && id.trim() === id && !/\s/.test(id) ? id : null;
}
function countSourceProvenance(features) {
  const datasets = {}, licenses = {}, providers = {};
  let featuresWithSourceRecords = 0, sourceRecordCount = 0;
  for (const feature of features) {
    const sources = Array.isArray(feature.properties.sources) ? feature.properties.sources : [];
    if (sources.length > 0) featuresWithSourceRecords += 1;
    for (const source of sources) {
      if (!isRecord(source)) continue;
      sourceRecordCount += 1;
      for (const [target, value] of [[datasets, source.dataset], [licenses, source.license], [providers, source.provider]]) {
        if (typeof value === "string" && value.length > 0 && value.trim() === value) {
          target[value] = (target[value] ?? 0) + 1;
        }
      }
    }
  }
  return { featuresWithSourceRecords, sourceRecordCount, datasetCounts: datasets, licenseCounts: licenses, providerCounts: providers };
}

/**
 * Coverage for the complete FeatureCollection. Overture properties.type remains
 * distinct from extractor-derived properties._renderRole.
 */
export function buildDhakaOvertureArchitectureCoverage(featureCollection, {
  sourceSha256 = null,
  inputBytes = null,
} = {}) {
  if (!isRecord(featureCollection) || featureCollection.type !== "FeatureCollection" ||
      !Array.isArray(featureCollection.features) || featureCollection.features.length === 0) {
    throw new TypeError("Dhaka architecture coverage requires a non-empty GeoJSON FeatureCollection.");
  }
  if (sourceSha256 !== null && !/^[a-f0-9]{64}$/i.test(sourceSha256)) {
    throw new TypeError("sourceSha256 must be a 64-character SHA-256 hex digest or null.");
  }
  if (inputBytes !== null && (!Number.isSafeInteger(inputBytes) || inputBytes < 0)) {
    throw new TypeError("inputBytes must be a non-negative safe integer or null.");
  }

  const features = featureCollection.features;
  const roleCounts = Object.fromEntries(ROLES.map((role) => [role, 0]));
  const fieldCoverageByRole = Object.fromEntries(ROLES.map((role) => [role, emptyCoverage()]));
  const roleEvidenceCounts = {};
  const ids = new Map();
  const evidenceItems = [];
  let missingOrInvalidFeatureIdCount = 0;
  let overtureTypePresentCount = 0;
  let facadeStyleFeatureCount = 0;
  let roofShapeFeatureCount = 0;
  let positiveRoofHeightFeatureCount = 0;
  let roofShapeAndPositiveHeightFeatureCount = 0;

  for (const feature of features) {
    if (!isRecord(feature) || feature.type !== "Feature" || !isRecord(feature.properties)) {
      throw new TypeError("FeatureCollection contains a malformed Feature or missing properties object.");
    }
    const evidence = resolveBuildingArchitectureEvidence(feature.properties);
    evidenceItems.push(evidence);

    const role = ROLES.includes(evidence.compositionRole?.value) ? evidence.compositionRole.value : "unknown";
    roleCounts[role] += 1;
    const key = (evidence.compositionRole?.status ?? "missing") + ":" +
      (evidence.compositionRole?.origin ?? "none") + ":" + role;
    roleEvidenceCounts[key] = (roleEvidenceCounts[key] ?? 0) + 1;

    for (const [field, parts] of Object.entries(FIELDS)) {
      addStatus(fieldCoverageByRole[role][field], atPath(evidence, parts)?.status);
    }

    if (evidence.featureType?.status === "source") overtureTypePresentCount += 1;
    if (evidence.facade.color.status === "source" || evidence.facade.material.status === "source") {
      facadeStyleFeatureCount += 1;
    }
    if (evidence.roof.shape.status === "source") roofShapeFeatureCount += 1;
    if (evidence.roof.heightMeters.status === "source" && evidence.roof.heightMeters.value > 0) {
      positiveRoofHeightFeatureCount += 1;
    }
    if (evidence.roof.shape.status === "source" &&
        evidence.roof.heightMeters.status === "source" &&
        evidence.roof.heightMeters.value > 0) {
      roofShapeAndPositiveHeightFeatureCount += 1;
    }

    const id = validFeatureId(feature);
    if (!id) missingOrInvalidFeatureIdCount += 1;
    else ids.set(id, (ids.get(id) ?? 0) + 1);
  }

  const duplicateFeatureIdCount = [...ids.values()].filter((count) => count > 1).length;
  const composition = auditBuildingPartComposition(features);
  if (composition.summary.buildingFeatureCount !== roleCounts.building + roleCounts.building_parent ||
      composition.summary.buildingPartFeatureCount !== roleCounts.building_part) {
    throw new Error("Normalized render-role counts disagree with the parent/part composition audit.");
  }

  const totalCoverage = emptyCoverage();
  for (const role of ROLES) {
    for (const field of Object.keys(FIELDS)) {
      for (const status of STATUSES) {
        totalCoverage[field][status] += fieldCoverageByRole[role][field][status];
      }
    }
  }
  const evidenceSummary = summarizeBuildingArchitectureEvidence(evidenceItems);

  return {
    schema: DHAKA_ARCHITECTURE_COVERAGE_SCHEMA,
    sourceSchema: "overture-buildings-" + evidenceSummary.schema.split("-").at(-1),
    source: {
      sha256: sourceSha256,
      inputBytes,
      featureCount: features.length,
      provenance: countSourceProvenance(features),
    },
    featureIdentity: { missingOrInvalidFeatureIdCount, duplicateFeatureIdCount },
    featureRoleEvidence: {
      rawOvertureTypeFieldPresentCount: overtureTypePresentCount,
      extractorRenderRolePresentCounts: roleEvidenceCounts,
      normalizedRoleCounts: roleCounts,
      note: "properties.type is Overture schema evidence; properties._renderRole is extractor-derived metadata and is reported separately.",
    },
    fieldCoverage: {
      totals: totalCoverage,
      byNormalizedRole: fieldCoverageByRole,
      statusDefinitions: {
        source: "Present and passes strict source-field type/value validation.",
        absent: "Field is absent from the extracted feature.",
        invalid: "Field is present but fails strict type, enum, identifier or range validation.",
        "extractor-derived": "Role is supplied by the extractor's _renderRole field, not Overture properties.type.",
        "missing-evidence": "No usable status was available.",
      },
    },
    architectureAvailability: {
      facadeStyleFeatureCount,
      facadeStyleCoveragePercent: percentage(facadeStyleFeatureCount, features.length),
      roofShapeFeatureCount,
      positiveRoofHeightFeatureCount,
      roofShapeAndPositiveHeightFeatureCount,
      roofShapeAndPositiveHeightCoveragePercent: percentage(roofShapeAndPositiveHeightFeatureCount, features.length),
      renderedArchitecturalDetailCount: 0,
      geometryCompleteness: "footprint-extrusion-only",
    },
    composition: composition.summary,
    evidenceSummary,
    releaseFlags: {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
    limitations: [
      "Coverage describes only fields in this exact FeatureCollection; absent fields are not inferred.",
      "Extractor-derived _renderRole is not represented as an original Overture properties.type value.",
      "Roof shape plus positive roof_height is only a metadata candidate; this audit does not generate or validate a roof mesh.",
      "Parent/part ID resolution is not geometry assembly and does not prove physical building composition.",
      "The extract contains 2D footprints and does not establish surveyed vertical datum, facade geometry, textures, image rights or reconstruction accuracy.",
    ],
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError("Missing value for " + name + ".");
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run audit:dhaka-overture-architecture-coverage -- [--source <FeatureCollection.geojson>] [--output <report.json>]");
    return;
  }
  const sourcePath = path.resolve(option(args, "--source") ?? DEFAULT_SOURCE);
  const outputPath = option(args, "--output");
  const sourceBytes = await readFile(sourcePath);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const featureCollection = JSON.parse(sourceBytes.toString("utf8"));
  const report = buildDhakaOvertureArchitectureCoverage(featureCollection, {
    sourceSha256,
    inputBytes: sourceBytes.length,
  });
  report.reportSha256 = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  const output = JSON.stringify(report, null, 2) + "\n";
  if (outputPath) {
    const destination = path.resolve(outputPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, output, { flag: "w" });
  }
  console.log(JSON.stringify({
    status: "audit-complete",
    reportSha256: report.reportSha256,
    sourceSha256,
    featureCount: report.source.featureCount,
    normalizedRoleCounts: report.featureRoleEvidence.normalizedRoleCounts,
    linkedPartCount: report.composition.linkedPartCount,
    facadeStyleFeatureCount: report.architectureAvailability.facadeStyleFeatureCount,
    roofShapeAndPositiveHeightFeatureCount: report.architectureAvailability.roofShapeAndPositiveHeightFeatureCount,
    geometryCompleteness: report.architectureAvailability.geometryCompleteness,
    outputPath: outputPath ? path.resolve(outputPath) : null,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Dhaka architecture coverage audit blocked: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  });
}
