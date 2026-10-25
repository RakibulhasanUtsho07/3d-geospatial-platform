import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeGeoJsonRoadFeatures } from "../src/core/geospatial/road-network.mjs";
import { OFFLINE_ROAD_EXTRACT_LIMITS, validateOfflineRoadExtract } from "../src/core/geospatial/offline-road-extract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = { west: 90.30, south: 23.60, east: 90.55, north: 23.90 };

function parseArgs(args) {
  const options = { output: "data/roads/dhaka-road-network-v1.json", ...defaults, maxFeatures: 200_000 };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const raw = args[i + 1];
    if (!flag?.startsWith("--") || !raw || raw.startsWith("--")) throw new Error("Expected flag/value pairs.");
    i += 1;
    const key = flag.slice(2);
    if (["west","south","east","north","max-features"].includes(key)) {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error("--" + key + " must be numeric.");
      options[key === "max-features" ? "maxFeatures" : key] = value;
    } else if (["input","output","source-url","source-date","source-sha256","provider"].includes(key)) {
      options[key === "source-url" ? "sourceUrl"
        : key === "source-date" ? "sourceDate"
        : key === "source-sha256" ? "sourceSha256" : key] = raw;
    } else throw new Error("Unsupported flag " + flag);
  }
  return options;
}
function validateOptions(options) {
  if (!options.input || !options.sourceUrl || !options.sourceDate) {
    throw new Error("--input, --source-url and --source-date are required.");
  }
  let sourceUrl;
  try { sourceUrl = new URL(options.sourceUrl); } catch { throw new Error("--source-url must be a valid HTTPS URL."); }
  if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password || sourceUrl.hash) {
    throw new Error("--source-url must use HTTPS without credentials or fragments.");
  }
  if (options.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(options.sourceSha256)) {
    throw new Error("--source-sha256 must be a 64-character hexadecimal SHA-256.");
  }
  const date = new Date(options.sourceDate + "T00:00:00.000Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.sourceDate)
      || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== options.sourceDate) {
    throw new Error("--source-date must be a real YYYY-MM-DD extract date.");
  }
  if (![options.west,options.south,options.east,options.north].every(Number.isFinite)
      || options.west < -180 || options.east > 180 || options.south < -90 || options.north > 90
      || options.west >= options.east || options.south >= options.north) throw new Error("Invalid coverage bounds.");
  if (!Number.isSafeInteger(options.maxFeatures) || options.maxFeatures < 1 || options.maxFeatures > 500_000) {
    throw new Error("--max-features must be from 1 to 500000.");
  }
  return { ...options, sourceUrl: sourceUrl.toString() };
}
async function main() {
  const options = validateOptions(parseArgs(process.argv.slice(2)));
  const inputPath = path.resolve(root, options.input);
  const input = await readFile(inputPath);
  const normalizationInputSha256 = createHash("sha256").update(input).digest("hex");
  let geojson;
  try { geojson = JSON.parse(input.toString("utf8")); } catch { throw new Error("Input is not valid JSON."); }
  if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    throw new Error("Input must be an OSM-derived GeoJSON FeatureCollection.");
  }
  const coverage = { west: options.west, south: options.south, east: options.east, north: options.north };
  const roads = normalizeGeoJsonRoadFeatures(
    geojson.features, { ...coverage, limit: options.maxFeatures },
    { source: "OpenStreetMap regional extract" },
  );
  if (roads.length === 0) throw new Error("No supported road features were found; inspect highway tags and input coverage.");
  const document = validateOfflineRoadExtract({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      provider: options.provider ?? "Geofabrik / OpenStreetMap",
      url: options.sourceUrl,
      extractDate: options.sourceDate,
      license: "ODbL 1.0",
      attribution: "© OpenStreetMap contributors",
      sourceSha256: options.sourceSha256 ?? normalizationInputSha256,
      normalizationInputSha256,
    },
    coverage,
    featureCount: roads.length,
    roads,
  });
  const content = JSON.stringify(document) + "\n";
  const outputBytes = Buffer.byteLength(content);
  if (outputBytes > OFFLINE_ROAD_EXTRACT_LIMITS.maxBytes) {
    throw new Error("Prepared road extract exceeds the runtime file-size cap of " + OFFLINE_ROAD_EXTRACT_LIMITS.maxBytes + " bytes.");
  }
  const outputPath = path.resolve(root, options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  console.log(JSON.stringify({
    status: "prepared", output: path.relative(root, outputPath),
    outputBytes,
    outputSha256: createHash("sha256").update(content).digest("hex"),
    sourceUrl: document.source.url, sourceDate: document.source.extractDate,
    sourceSha256: document.source.sourceSha256,
    normalizationInputSha256: document.source.normalizationInputSha256,
    license: document.source.license,
    attribution: document.source.attribution, coverage: document.coverage,
    featureCount: document.featureCount,
  }, null, 2));
}
main().catch((error) => {
  console.error("[prepare-dhaka-road-extract] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
