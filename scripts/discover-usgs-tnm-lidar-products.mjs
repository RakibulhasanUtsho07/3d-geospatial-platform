#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TNM_PRODUCTS_ENDPOINT = "https://tnmaccess.nationalmap.gov/api/v1/products";
const LPC_DATASET = "Lidar Point Cloud (LPC)";
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_RESULTS = 50;
const TRUSTED_DOWNLOAD_HOSTS = new Set([
  "rockyweb.usgs.gov",
  "prd-tnm.s3.amazonaws.com",
  "prd-tnm.s3-us-west-2.amazonaws.com",
  "prd-tnm.s3.us-west-2.amazonaws.com",
  "prd-tnm.s3.us-east-1.amazonaws.com",
]);

function fail(message) {
  const error = new Error(message);
  error.name = "TnmLidarDiscoveryError";
  throw error;
}

function numberInRange(value, label, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(label + " must be a finite number between " + min + " and " + max + ".");
  }
  return value;
}

function trustedHttpsUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const trusted = TRUSTED_DOWNLOAD_HOSTS.has(host) ||
    host.endsWith(".rockyweb.usgs.gov") ||
    host.endsWith(".usgs.gov");
  if (url.protocol !== "https:" || url.username || url.password || url.port || !trusted) return null;
  return url.toString();
}

function anyUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseBbox(raw, fallback) {
  if (Array.isArray(raw) && raw.length >= 4) {
    const vals = raw.slice(0, 4).map(Number);
    if (vals.every(Number.isFinite)) return vals;
  }
  if (typeof raw === "string") {
    const vals = raw.split(/[ ,]+/).map(Number);
    if (vals.length >= 4 && vals.slice(0, 4).every(Number.isFinite)) return vals.slice(0, 4);
  }
  if (raw && typeof raw === "object") {
    const xmin = raw.xmin ?? raw.minX ?? raw.west;
    const ymin = raw.ymin ?? raw.minY ?? raw.south;
    const xmax = raw.xmax ?? raw.maxX ?? raw.east;
    const ymax = raw.ymax ?? raw.maxY ?? raw.north;
    const vals = [xmin, ymin, xmax, ymax].map(Number);
    if (vals.every(Number.isFinite)) return vals;
  }
  return fallback;
}

function boundsOf(item) {
  const candidates = [
    item?.boundingBox,
    item?.bbox,
    item?.spatialExtent,
    item?.extent,
  ];
  for (const candidate of candidates) {
    const parsed = parseBbox(candidate, null);
    if (parsed && parsed[0] <= parsed[2] && parsed[1] <= parsed[3]) return parsed;
  }
  return null;
}

function isLidarFormat(item) {
  const candidates = [
    item?.format,
    item?.formatName,
    item?.formatSummary,
    item?.productFormat,
    item?.urls && Object.keys(item.urls).filter(key => ["LAS", "LAZ"].includes(key.toUpperCase())).join(","),
    item?.downloadURL,
  ].filter(value => typeof value === "string").join(" ").toUpperCase();
  return /\bLAS\b|\bLAZ\b|\.LAS(?:\?|$)|\.LAZ(?:\?|$)/i.test(candidates);
}

function productView(item, queryBbox) {
  const bounds = boundsOf(item);
  const downloadCandidates = [
    item?.urls?.LAZ,
    item?.urls?.laz,
    item?.urls?.LAS,
    item?.urls?.las,
    item?.downloadURL,
    item?.url,
  ].filter(Boolean);
  const urls = [];
  const rejectedUrls = [];
  for (const raw of downloadCandidates) {
    const parsed = trustedHttpsUrl(raw);
    if (parsed && !urls.includes(parsed)) urls.push(parsed);
    else if (!parsed && typeof raw === "string") rejectedUrls.push(raw);
  }
  const metadataUrl = anyUrl(item?.metaUrl);
  const vendorMetadataUrl = anyUrl(item?.vendorMetaUrl);
  const productFormat = [item?.format, item?.formatName, item?.formatSummary, item?.productFormat]
    .find(value => typeof value === "string") ?? null;
  const title = typeof item?.title === "string" ? item.title : null;
  const looksLikeLpc = isLidarFormat(item);
  const boundsOverlapQuery = bounds ? (
    bounds[0] <= queryBbox[2] && bounds[2] >= queryBbox[0] &&
    bounds[1] <= queryBbox[3] && bounds[3] >= queryBbox[1]
  ) : null;
  return {
    title,
    sourceId: typeof item?.sourceId === "string" ? item.sourceId : null,
    sourceName: typeof item?.sourceName === "string" ? item.sourceName : null,
    sourceOriginId: item?.sourceOriginId ?? null,
    productFormat,
    publicationDate: typeof item?.publicationDate === "string" ? item.publicationDate : null,
    lastUpdated: typeof item?.lastUpdated === "string" ? item.lastUpdated : null,
    dateCreated: typeof item?.dateCreated === "string" ? item.dateCreated : null,
    sizeBytes: Number.isSafeInteger(item?.sizeInBytes) ? item.sizeInBytes :
      Number.isSafeInteger(item?.size) ? item.size : null,
    metadataUrl,
    vendorMetadataUrl,
    downloadUrls: urls,
    rejectedDownloadUrls: rejectedUrls,
    downloadUrlStatus: urls.length > 0 ? "allowlisted-https" :
      downloadCandidates.length > 0 ? "blocked-untrusted-url-or-unsupported-url-field" : "not-provided",
    bounds,
    boundsOverlapQuery,
    formatLooksLikeLidarPointCloud: looksLikeLpc,
    sourcePayloadFields: Object.keys(item ?? {}).sort(),
  };
}

async function readJsonResponse(response) {
  if (!response || response.ok !== true) {
    throw new Error("USGS TNM Access API returned HTTP status " + (response?.status ?? "unknown") + ".");
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType && !/json/i.test(contentType)) fail("TNM Access API returned a non-JSON content type.");
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    fail("TNM Access API response exceeded the 12 MiB safety limit.");
  }
  try {
    return JSON.parse(body);
  } catch {
    fail("TNM Access API response was not valid JSON.");
  }
}

/** Discover USGS 3DEP lidar point-cloud products intersecting a bounded GPS bbox. */
export async function discoverTnmLidarProducts({
  latitude,
  longitude,
  bufferMeters = 100,
  fetchImpl = globalThis.fetch,
  timeoutMs = 25_000,
  maxResults = MAX_RESULTS,
}) {
  numberInRange(latitude, "latitude", -85, 85);
  numberInRange(longitude, "longitude", -180, 180);
  numberInRange(bufferMeters, "bufferMeters", 10, 1000);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new RangeError("timeoutMs must be between 1000 and 120000 milliseconds.");
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new RangeError("maxResults must be between 1 and " + MAX_RESULTS + ".");
  }

  const latDelta = bufferMeters / 111_320;
  const lonDelta = bufferMeters / (111_320 * Math.cos(latitude * Math.PI / 180));
  const bbox = [
    Number((longitude - lonDelta).toFixed(7)),
    Number((latitude - latDelta).toFixed(7)),
    Number((longitude + lonDelta).toFixed(7)),
    Number((latitude + latDelta).toFixed(7)),
  ];
  const queryUrl = new URL(TNM_PRODUCTS_ENDPOINT);
  queryUrl.searchParams.set("bbox", bbox.join(","));
  queryUrl.searchParams.set("datasets", LPC_DATASET);
  queryUrl.searchParams.set("prodFormats", "LAS,LAZ");
  queryUrl.searchParams.set("max", String(maxResults));

  const response = await fetchImpl(queryUrl.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await readJsonResponse(response);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.items)) {
    fail("TNM Access API response is missing the expected items array.");
  }
  if (payload.errorMessage) fail("TNM Access API reported an error: " + String(payload.errorMessage).slice(0, 500));
  if (typeof payload.total !== "number" || !Number.isFinite(payload.total) || payload.total < 0) {
    fail("TNM Access API response is missing a valid total count.");
  }

  const products = payload.items.map(item => productView(item, bbox));
  const pointCloudProducts = products.filter(product => product.formatLooksLikeLidarPointCloud);
  const readyUrls = pointCloudProducts.filter(product =>
    product.downloadUrlStatus === "allowlisted-https" &&
    (product.boundsOverlapQuery !== false)
  );
  const blockers = [];
  if (payload.total === 0 || products.length === 0) blockers.push("no-lidar-point-cloud-products-returned");
  if (pointCloudProducts.length === 0 && products.length > 0) blockers.push("returned-products-do-not-identify-las-or-laz");
  if (pointCloudProducts.some(product => product.downloadUrlStatus !== "allowlisted-https")) {
    blockers.push("one-or-more-point-cloud-products-lack-an-allowlisted-download-url");
  }
  if (products.some(product => product.boundsOverlapQuery === false)) blockers.push("one-or-more-products-do-not-overlap-query-bbox");
  if (payload.total > products.length) blockers.push("tnm-result-pagination-incomplete");
  const successfulDiscovery = payload.total > 0 && readyUrls.length > 0 &&
    !blockers.includes("tnm-result-pagination-incomplete");
  return {
    schemaVersion: "1.0.0",
    resolver: "usgs-tnm-lpc-product-discovery-v1",
    status: successfulDiscovery ? "products-discovered" : "blocked",
    queriedAt: new Date().toISOString(),
    sourceService: TNM_PRODUCTS_ENDPOINT,
    dataset: LPC_DATASET,
    point: {
      longitude,
      latitude,
      inputSpatialReference: "EPSG:4326",
      bufferMeters,
    },
    queryBboxWgs84: bbox,
    counts: {
      totalProductsReported: payload.total,
      productsReturned: products.length,
      pointCloudProducts: pointCloudProducts.length,
      productsWithAllowlistedDownloadUrl: products.filter(product => product.downloadUrlStatus === "allowlisted-https").length,
      productsWithReportedBounds: products.filter(product => product.bounds !== null).length,
      readyCandidateProducts: readyUrls.length,
    },
    products,
    blockers,
    interpretation: "Product-catalog discovery only. A result does not prove that a LAS/LAZ tile contains the specific building, that its header CRS/vertical datum is compatible, that building returns are dense enough, or that the data are independent held-out survey truth.",
    nextRequiredChecks: [
      "Open candidate product metadata and inspect the complete spatial footprint and acquisition lineage.",
      "Download only the smallest suitable LAZ tile, then measure actual file bytes/SHA-256 and inspect header CRS, units, bounds, point count and classification.",
      "Check actual point returns around the photographed building and retain roof/building classes; a bare-earth DEM is not sufficient.",
      "Keep the reference separate from the image-derived candidate and reserve independent held-out checkpoints.",
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
  const parsed = { latitude: 45.0518, longitude: -93.391, bufferMeters: 100, reportPath: null, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      return parsed;
    }
    if (!["--latitude", "--longitude", "--buffer-meters", "--report"].includes(arg)) {
      fail("Unknown argument: " + arg + ".");
    }
    if (seen.has(arg)) fail("Duplicate argument: " + arg + ".");
    seen.add(arg);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("Missing value after " + arg + ".");
    index += 1;
    if (arg === "--latitude") parsed.latitude = Number(value);
    else if (arg === "--longitude") parsed.longitude = Number(value);
    else if (arg === "--buffer-meters") parsed.bufferMeters = Number(value);
    else parsed.reportPath = value;
  }
  return parsed;
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
    console.log("Usage: node scripts/discover-usgs-tnm-lidar-products.mjs [--latitude 45.0518] [--longitude -93.391] [--buffer-meters 100] [--report artifacts/brf-16/tnm-lidar-products.json]\nQueries USGS TNM for LPC LAS/LAZ products. It does not download data or certify survey accuracy.");
    return;
  }
  try {
    const report = await discoverTnmLidarProducts(args);
    if (args.reportPath) {
      const reportPath = path.resolve(args.reportPath);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
    console.log(JSON.stringify({
      status: report.status,
      queryBboxWgs84: report.queryBboxWgs84,
      counts: report.counts,
      products: report.products,
      blockers: report.blockers,
      candidateGlbGenerated: false,
      independentReferenceVerified: false,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
    }, null, 2));
    if (report.status !== "products-discovered") process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.name === "TnmLidarDiscoveryError" ? 2 : 1;
  }
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) await main();
