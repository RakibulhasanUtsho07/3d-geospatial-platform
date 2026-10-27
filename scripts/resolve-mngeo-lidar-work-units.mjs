#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const QUERY_ENDPOINT =
  "https://enterprise.gisdata.mn.gov/aghost/rest/services/MnTOPO_Flight_Swaths/FeatureServer/0/query";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ALLOWED_METADATA_HOSTS = [
  "gis.data.mn.gov",
  "gisdata.mn.gov",
  "gis.mn.gov",
];
const ALLOWED_METADATA_SUFFIXES = [
  ".gis.data.mn.gov",
  ".gisdata.mn.gov",
  ".mn.gov",
];

function fail(message) {
  const error = new Error(message);
  error.name = "WorkUnitDiscoveryError";
  throw error;
}

function metadataUrl(rawValue) {
  if (typeof rawValue !== "string" || !rawValue.trim()) return null;
  let url;
  try {
    url = new URL(rawValue.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const trustedHost = ALLOWED_METADATA_HOSTS.includes(host) ||
    ALLOWED_METADATA_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (url.protocol !== "https:" || url.username || url.password || url.port || !trustedHost) {
    return null;
  }
  return url.toString();
}

function finiteCoordinate(value, label, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(label + " must be a finite number between " + min + " and " + max + ".");
  }
  return value;
}

function normalizedFeature(feature, index) {
  const attributes = feature?.attributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return { id: "feature-" + index, valid: false, reason: "missing-attributes" };
  }
  const rawId = attributes.objectid;
  const id = Number.isSafeInteger(rawId) ? String(rawId) : "feature-" + index;
  const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
  const workUnit = typeof attributes.work_unit === "string" ? attributes.work_unit.trim() : "";
  const metadata = metadataUrl(attributes.metadata);
  const rawDate = attributes.date;
  const date = typeof rawDate === "number" && Number.isFinite(rawDate)
    ? new Date(rawDate).toISOString()
    : typeof rawDate === "string" && rawDate.trim()
      ? rawDate.trim()
      : null;
  return {
    id,
    valid: Boolean(name || workUnit),
    name: name || null,
    workUnit: workUnit || null,
    date,
    metadataUrl: metadata,
    metadataUrlStatus: !attributes.metadata
      ? "missing"
      : metadata
        ? "allowlisted-https"
        : "blocked-untrusted-or-invalid",
  };
}

function groupFeatures(features) {
  const groups = new Map();
  for (const feature of features) {
    const identity = JSON.stringify([
      feature.name ?? "",
      feature.workUnit ?? "",
      feature.metadataUrl ?? "",
    ]);
    let group = groups.get(identity);
    if (!group) {
      group = {
        name: feature.name,
        workUnit: feature.workUnit,
        metadataUrl: feature.metadataUrl,
        featureIds: [],
        collectionDates: [],
        metadataUrlStatus: feature.metadataUrlStatus,
      };
      groups.set(identity, group);
    }
    group.featureIds.push(feature.id);
    if (feature.date && !group.collectionDates.includes(feature.date)) {
      group.collectionDates.push(feature.date);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      featureIds: [...new Set(group.featureIds)].sort(),
      collectionDates: group.collectionDates.sort(),
    }))
    .sort((a, b) =>
      String(a.name ?? "").localeCompare(String(b.name ?? "")) ||
      String(a.workUnit ?? "").localeCompare(String(b.workUnit ?? "")) ||
      String(a.metadataUrl ?? "").localeCompare(String(b.metadataUrl ?? "")),
    );
}

async function readJsonResponse(response) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType && !/json/i.test(contentType)) {
    fail("MnGeo flight-swath service returned a non-JSON content type.");
  }
  let payload;
  if (typeof response.text === "function") {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      fail("MnGeo flight-swath response exceeded the 8 MiB safety limit.");
    }
    try {
      payload = JSON.parse(body);
    } catch {
      fail("MnGeo flight-swath service response was not valid JSON.");
    }
  } else {
    payload = await response.json();
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_RESPONSE_BYTES) {
      fail("MnGeo flight-swath response exceeded the 8 MiB safety limit.");
    }
  }
  return payload;
}

/**
 * Locate official second-generation Minnesota lidar flight-swath metadata at
 * one sample GPS point. This discovers candidate work units only; it does not
 * download or validate point-cloud/LAZ data and does not establish survey truth.
 */
export async function resolveMnGeoLidarWorkUnits({
  latitude,
  longitude,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
}) {
  finiteCoordinate(latitude, "latitude", -90, 90);
  finiteCoordinate(longitude, "longitude", -180, 180);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new RangeError("timeoutMs must be between 1000 and 120000 milliseconds.");
  }

  const url = new URL(QUERY_ENDPOINT);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("geometry", longitude + "," + latitude);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", "objectid,name,work_unit,date,metadata");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("returnZ", "false");
  url.searchParams.set("returnM", "false");
  url.searchParams.set("resultRecordCount", "2000");
  url.searchParams.set("f", "json");

  const response = await fetchImpl(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response || response.ok !== true) {
    throw new Error("MnGeo flight-swath query failed with HTTP status " + (response?.status ?? "unknown") + ".");
  }

  const payload = await readJsonResponse(response);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("MnGeo flight-swath service returned an unexpected JSON shape.");
  }
  if (payload.error) {
    const code = Number.isSafeInteger(payload.error.code) ? payload.error.code : "unknown";
    fail("MnGeo flight-swath service reported error code " + code + ".");
  }
  if (!Array.isArray(payload.features)) {
    fail("MnGeo response did not contain a features array.");
  }

  const rawFeatures = payload.features;
  const features = rawFeatures.map((feature, index) => normalizedFeature(feature, index));
  const validFeatures = features.filter((feature) => feature.valid);
  const invalidFeatureCount = features.length - validFeatures.length;
  const workUnits = groupFeatures(validFeatures);
  const metadataComplete = workUnits.length > 0 &&
    workUnits.every((workUnit) => workUnit.metadataUrlStatus === "allowlisted-https");
  const blockers = [];
  if (rawFeatures.length === 0) blockers.push("no-flight-swath-intersects-sample-point");
  if (invalidFeatureCount > 0) blockers.push("malformed-flight-swath-feature");
  if (workUnits.some((workUnit) => workUnit.metadataUrlStatus !== "allowlisted-https")) {
    blockers.push("missing-or-untrusted-work-unit-metadata-url");
  }
  if (payload.exceededTransferLimit === true) blockers.push("service-transfer-limit-exceeded");

  return {
    schemaVersion: "1.0.0",
    resolver: "mngeo-flight-swath-point-query-v1",
    status: blockers.length === 0 ? "work-units-discovered" : "blocked",
    queriedAt: new Date().toISOString(),
    sourceService: QUERY_ENDPOINT,
    point: {
      longitude,
      latitude,
      inputSpatialReference: "EPSG:4326",
      verticalDatum: "not applicable to horizontal point query; sample GPS altitude remains unreferenced",
    },
    sourceLayer: {
      title: "Minnesota Second Generation Lidar Flight Swaths",
      layerType: "flight-swath polygons",
      dataPurpose: "discovery of candidate acquisition work-unit metadata only",
    },
    counts: {
      returnedFeatures: rawFeatures.length,
      validFeatures: validFeatures.length,
      invalidFeatures: invalidFeatureCount,
      uniqueWorkUnitMetadataGroups: workUnits.length,
      groupsWithMetadataUrl: workUnits.filter((item) => item.metadataUrlStatus === "allowlisted-https").length,
    },
    workUnits,
    blockers,
    nextRequiredChecks: [
      "Read the exact work-unit metadata and verify a downloadable point-cloud/LAZ asset exists.",
      "Verify the source asset bbox actually covers the photographed building, not only the flight-swath polygon.",
      "Record the LAZ file's actual byte size/SHA-256 and header CRS, units, horizontal datum and vertical datum.",
      "Assess point density/building returns and preserve a separate held-out reference.",
    ],
    candidateGlbGenerated: false,
    independentReferenceVerified: false,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  };
}

function parseArgs(argv) {
  const result = { latitude: 45.0518, longitude: -93.391, reportPath: null, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      return result;
    }
    if (!["--latitude", "--longitude", "--report"].includes(arg)) {
      fail("Unknown argument: " + arg + ".");
    }
    if (seen.has(arg)) fail("Duplicate argument: " + arg + ".");
    seen.add(arg);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("Missing value after " + arg + ".");
    index += 1;
    if (arg === "--latitude") result.latitude = Number(value);
    else if (arg === "--longitude") result.longitude = Number(value);
    else result.reportPath = value;
  }
  return result;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log("Usage: node scripts/resolve-mngeo-lidar-work-units.mjs [--latitude 45.0518] [--longitude -93.391] [--report artifacts/mngeo-work-unit-discovery.json]\nQueries the official MnGeo flight-swath service. It discovers candidate work-unit metadata only; it does not download LAZ or prove independent survey accuracy.");
    return;
  }
  try {
    const report = await resolveMnGeoLidarWorkUnits({
      latitude: args.latitude,
      longitude: args.longitude,
    });
    const output = {
      status: report.status,
      point: report.point,
      counts: report.counts,
      workUnits: report.workUnits,
      blockers: report.blockers,
      nextRequiredChecks: report.nextRequiredChecks,
      candidateGlbGenerated: false,
      independentReferenceVerified: false,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    };
    if (args.reportPath) {
      const outputPath = path.resolve(args.reportPath);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      output.reportPath = outputPath;
    }
    console.log(JSON.stringify(output, null, 2));
    if (report.status !== "work-units-discovered") process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.name === "WorkUnitDiscoveryError" ? 2 : 1;
  }
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) await main();
