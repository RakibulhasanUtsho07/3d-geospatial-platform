#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyTilesetPackage } from "../src/core/geospatial/tileset-package-integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = path.join(ROOT, "data/overture/dhaka-buildings-3d-pilot.geojson");
const DEFAULT_PACKAGE = path.join(ROOT, "data/overture/dhaka-3d-tiles-multibuilding-pilot");
const DEFAULT_TOLERANCE_METERS = 0.5;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_GLB_BYTES = 128 * 1024 * 1024;
const WGS84_A = 6378137;
const WGS84_E2 = 6.6943799901413165e-3;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function within(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function readJson(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch (error) { throw new Error(label + " is not valid JSON: " + (error instanceof Error ? error.message : String(error))); }
}
function featureIdentity(feature) {
  if (feature.id !== undefined && feature.id !== null &&
      (typeof feature.id === "string" || typeof feature.id === "number")) return String(feature.id);
  const properties = isRecord(feature.properties) ? feature.properties : {};
  for (const key of ["id", "feature_id", "featureId", "building_id", "buildingId", "overture_id"]) {
    const value = properties[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return sha256(JSON.stringify(feature));
}
function featureHash(feature) {
  return sha256(Buffer.from(JSON.stringify(feature), "utf8"));
}
function sourceVertices(geometry) {
  if (!isRecord(geometry)) throw new Error("Source geometry is missing.");
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] :
    geometry.type === "MultiPolygon" ? geometry.coordinates : null;
  if (!Array.isArray(polygons) || polygons.length === 0) throw new Error("Source tile geometry must be Polygon or MultiPolygon.");
  const points = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length !== 1 || !Array.isArray(polygon[0])) {
      throw new Error("Alignment review supports emitted polygons with one exterior ring and no holes.");
    }
    const ring = [];
    for (const coordinate of polygon[0]) {
      if (!Array.isArray(coordinate) || coordinate.length < 2 ||
          !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]) ||
          coordinate[0] < -180 || coordinate[0] > 180 || coordinate[1] < -90 || coordinate[1] > 90) {
        throw new Error("Source ring contains an invalid WGS84 coordinate.");
      }
      const point = [coordinate[0], coordinate[1]];
      const previous = ring.at(-1);
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) ring.push(point);
    }
    if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
    if (ring.length < 3) throw new Error("Source ring has fewer than three unique vertices.");
    points.push(...ring);
  }
  return points;
}
function transformPoint(matrix, point) {
  const x = point[0], y = point[1], z = point[2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}
function ecefToWgs84(point) {
  const x = point[0], y = point[1], z = point[2];
  const longitude = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  if (!Number.isFinite(p) || !Number.isFinite(z) || p < 1) throw new Error("Invalid ECEF position.");
  let latitude = Math.atan2(z, p * (1 - WGS84_E2));
  let height = 0;
  for (let index = 0; index < 15; index += 1) {
    const sinLat = Math.sin(latitude);
    const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const cosLat = Math.cos(latitude);
    height = Math.abs(cosLat) > 1e-12 ? p / cosLat - normal : z / sinLat - normal * (1 - WGS84_E2);
    const next = Math.atan2(z, p * (1 - WGS84_E2 * normal / (normal + height)));
    if (Math.abs(next - latitude) < 1e-14) { latitude = next; break; }
    latitude = next;
  }
  const sinLat = Math.sin(latitude);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const cosLat = Math.cos(latitude);
  height = Math.abs(cosLat) > 1e-12 ? p / cosLat - normal : z / sinLat - normal * (1 - WGS84_E2);
  return { longitudeDegrees: longitude * RAD, latitudeDegrees: latitude * RAD, ellipsoidHeightMeters: height };
}
function residualMeters(a, b) {
  const aLon = a.longitudeDegrees ?? a[0], aLat = a.latitudeDegrees ?? a[1];
  const bLon = b.longitudeDegrees ?? b[0], bLat = b.latitudeDegrees ?? b[1];
  const meanLatitude = ((aLat + bLat) / 2) * DEG;
  const east = (aLon - bLon) * 111319.490793 * Math.cos(meanLatitude);
  const north = (aLat - bLat) * 111132.92;
  return Math.hypot(east, north);
}
function parseGlb(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF" ||
      bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error("GLB header, magic, version or length is invalid.");
  }
  let offset = 12;
  const jsonLength = bytes.readUInt32LE(offset);
  const jsonType = bytes.readUInt32LE(offset + 4);
  offset += 8;
  if (jsonType !== 0x4e4f534a || jsonLength < 2 || offset + jsonLength > bytes.length) throw new Error("GLB JSON chunk is invalid.");
  const gltf = readJson(bytes.subarray(offset, offset + jsonLength), "GLB JSON chunk");
  offset += jsonLength;
  if (offset + 8 > bytes.length) throw new Error("GLB binary chunk header is missing.");
  const binaryLength = bytes.readUInt32LE(offset);
  const binaryType = bytes.readUInt32LE(offset + 4);
  offset += 8;
  if (binaryType !== 0x004e4942 || offset + binaryLength > bytes.length) throw new Error("GLB binary chunk is invalid.");
  const binary = bytes.subarray(offset, offset + binaryLength);
  if (!Array.isArray(gltf.buffers) || gltf.buffers.length !== 1 ||
      !Number.isSafeInteger(gltf.buffers[0].byteLength) || gltf.buffers[0].byteLength > binary.length ||
      !Array.isArray(gltf.bufferViews) || !Array.isArray(gltf.accessors) || !Array.isArray(gltf.meshes)) {
    throw new Error("GLB must contain one embedded buffer, bufferViews, accessors and meshes.");
  }
  const positions = [];
  for (const mesh of gltf.meshes) {
    if (!isRecord(mesh) || !Array.isArray(mesh.primitives)) throw new Error("GLB mesh primitives are invalid.");
    for (const primitive of mesh.primitives) {
      const accessorIndex = primitive && primitive.attributes && primitive.attributes.POSITION;
      const accessor = Number.isInteger(accessorIndex) ? gltf.accessors[accessorIndex] : null;
      if (!isRecord(accessor) || accessor.componentType !== 5126 || accessor.type !== "VEC3" ||
          !Number.isSafeInteger(accessor.count) || accessor.count < 3 ||
          !Number.isInteger(accessor.bufferView) || !isRecord(gltf.bufferViews[accessor.bufferView])) {
        throw new Error("Each mesh primitive must reference a non-empty float32 VEC3 POSITION accessor.");
      }
      const view = gltf.bufferViews[accessor.bufferView];
      const viewOffset = view.byteOffset ?? 0;
      const accessorOffset = accessor.byteOffset ?? 0;
      const stride = view.byteStride ?? 12;
      if ((view.buffer !== undefined && view.buffer !== 0) ||
          !Number.isSafeInteger(viewOffset) || !Number.isSafeInteger(accessorOffset) ||
          !Number.isSafeInteger(stride) || stride < 12 || stride % 4 !== 0 ||
          !Number.isSafeInteger(view.byteLength) || viewOffset < 0 || accessorOffset < 0 || view.byteLength < 0) {
        throw new Error("GLB POSITION accessor byte range or stride is invalid.");
      }
      const start = viewOffset + accessorOffset;
      const end = start + (accessor.count - 1) * stride + 12;
      if (end > viewOffset + view.byteLength || end > binary.length) throw new Error("GLB POSITION accessor exceeds its binary byte range.");
      for (let index = 0; index < accessor.count; index += 1) {
        const pointOffset = start + index * stride;
        const point = [binary.readFloatLE(pointOffset), binary.readFloatLE(pointOffset + 4), binary.readFloatLE(pointOffset + 8)];
        if (!point.every(Number.isFinite)) throw new Error("GLB POSITION contains a non-finite value.");
        positions.push(point);
      }
    }
  }
  if (positions.length < 3) throw new Error("GLB has no usable mesh positions.");
  return { positions, gltf };
}
function minMax(values) {
  return { minimum: Math.min(...values), maximum: Math.max(...values) };
}
function uniquePoints(points, digits) {
  const seen = new Set(), output = [];
  for (const point of points) {
    const key = point.map((value) => Number(value.toFixed(digits))).join(",");
    if (!seen.has(key)) { seen.add(key); output.push(point); }
  }
  return output;
}
function insideRegion(point, region, toleranceMeters = 0.02) {
  if (!Array.isArray(region) || region.length !== 6 || !region.every(Number.isFinite)) {
    throw new Error("Tile boundingVolume.region must contain six finite numbers.");
  }
  const longitude = point.longitudeDegrees * DEG;
  const latitude = point.latitudeDegrees * DEG;
  const west = region[0], south = region[1], east = region[2], north = region[3];
  const minHeight = region[4], maxHeight = region[5];
  const lonPad = toleranceMeters / Math.max(1, WGS84_A * Math.cos(latitude));
  const latPad = toleranceMeters / 6300000;
  const lonInside = west <= east ? longitude >= west - lonPad && longitude <= east + lonPad :
    longitude >= west - lonPad || longitude <= east + lonPad;
  return lonInside && latitude >= south - latPad && latitude <= north + latPad &&
    point.ellipsoidHeightMeters >= minHeight - toleranceMeters && point.ellipsoidHeightMeters <= maxHeight + toleranceMeters;
}

export async function reviewDhaka3DTilesPackageAlignment({
  sourcePath = DEFAULT_SOURCE,
  packageDirectory = DEFAULT_PACKAGE,
  outputPath = null,
  toleranceMeters = DEFAULT_TOLERANCE_METERS,
} = {}) {
  const sourceFile = path.resolve(sourcePath);
  const packageRoot = path.resolve(packageDirectory);
  const outputFile = outputPath ? path.resolve(outputPath) : null;
  if (!within(ROOT, sourceFile) && !within(os.tmpdir(), sourceFile)) throw new Error("Source must be in repository or OS temporary directory.");
  if (!within(ROOT, packageRoot) && !within(os.tmpdir(), packageRoot)) throw new Error("Package must be in repository or OS temporary directory.");
  if (outputFile && !within(ROOT, outputFile) && !within(os.tmpdir(), outputFile)) throw new Error("Output must be in repository or OS temporary directory.");
  if (!Number.isFinite(toleranceMeters) || toleranceMeters <= 0 || toleranceMeters > 5) throw new Error("toleranceMeters must be in (0, 5].");
  const info = await lstat(sourceFile);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SOURCE_BYTES) throw new Error("Source must be a regular bounded GeoJSON file.");
  const sourceBytes = await readFile(sourceFile);
  const source = readJson(sourceBytes, "Source GeoJSON");
  if (!isRecord(source) || source.type !== "FeatureCollection" || !Array.isArray(source.features)) throw new Error("Source must be a GeoJSON FeatureCollection.");

  const integrity = await verifyTilesetPackage({ directory: packageRoot });
  if (!integrity.valid) throw new Error("Package integrity failed: " + integrity.errors.join("; "));
  const tilesetBytes = await readFile(path.join(packageRoot, "tileset.json"));
  const manifestBytes = await readFile(path.join(packageRoot, "build-manifest.json"));
  const tileset = readJson(tilesetBytes, "tileset.json");
  const manifest = readJson(manifestBytes, "build-manifest.json");
  if (sha256(sourceBytes) !== manifest.source?.sha256) throw new Error("Source dataset SHA-256 does not match package manifest.");
  if (tileset.asset?.extras?.sourceSha256 !== manifest.source.sha256) throw new Error("Source hashes are not cross-bound between manifests.");
  if (!Array.isArray(manifest.tiles) || !Array.isArray(tileset.root?.children) ||
      manifest.tiles.length !== tileset.root.children.length) throw new Error("Tileset child count does not match manifest tile count.");
  const releaseKeys = ["acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"];
  const releaseFlags = manifest.releaseFlags;
  if (!isRecord(releaseFlags) || releaseKeys.some((key) => releaseFlags[key] !== false)) {
    throw new Error("All package release flags must remain explicitly false.");
  }

  const byId = new Map();
  for (const feature of source.features) {
    if (!isRecord(feature) || feature.type !== "Feature" || !isRecord(feature.geometry)) continue;
    const id = featureIdentity(feature);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(feature);
  }
  const children = new Map(tileset.root.children.map((child) => [child?.content?.uri, child]));
  const emitted = [];
  const errors = [];
  let totalSourceVertices = 0, totalGroundVertices = 0, totalWorldVertices = 0;
  let globalMaxResidual = 0, globalMaxHeightResidual = 0, allInside = true;

  for (const tile of manifest.tiles) {
    if (!isRecord(tile) || typeof tile.featureId !== "string" || typeof tile.contentUri !== "string" ||
        !/^[a-f0-9]{64}$/i.test(tile.featureSha256 ?? "")) {
      errors.push("Manifest contains invalid tile identity/content/hash fields.");
      continue;
    }
    const matches = byId.get(tile.featureId) ?? [];
    if (matches.length !== 1) { errors.push("Feature " + tile.featureId + " must match exactly one source feature; found " + matches.length + "."); continue; }
    const feature = matches[0];
    if (featureHash(feature) !== tile.featureSha256) { errors.push("Feature hash mismatch for " + tile.featureId + "."); continue; }
    const child = children.get(tile.contentUri);
    if (!child) { errors.push("No child tile exists for " + tile.contentUri + "."); continue; }
    if (child.extras?.sourceFeatureId !== tile.featureId || child.extras?.sourceFeatureSha256 !== tile.featureSha256) {
      errors.push("Child/source identity mismatch for " + tile.contentUri + "."); continue;
    }
    if (!Array.isArray(child.transform) || child.transform.length !== 16 || !child.transform.every(Number.isFinite)) {
      errors.push("Invalid child transform for " + tile.contentUri + "."); continue;
    }
    const contentPath = path.resolve(packageRoot, tile.contentUri);
    if (!within(packageRoot, contentPath)) { errors.push("Content path escapes package root: " + tile.contentUri); continue; }
    const contentInfo = await lstat(contentPath);
    if (contentInfo.isSymbolicLink() || !contentInfo.isFile() || contentInfo.size > MAX_GLB_BYTES) {
      errors.push("Tile content is not a regular bounded GLB: " + tile.contentUri); continue;
    }
    const glbBytes = await readFile(contentPath);
    if (sha256(glbBytes) !== tile.contentSha256 || glbBytes.length !== tile.bytes) {
      errors.push("GLB integrity metadata mismatch for " + tile.contentUri); continue;
    }
    const parsed = parseGlb(glbBytes);
    if (parsed.gltf.extras?.sourceFeatureId !== tile.featureId || parsed.gltf.extras?.sourceFeatureSha256 !== tile.featureSha256) {
      errors.push("GLB source identity extras mismatch for " + tile.contentUri); continue;
    }
    const height = parsed.gltf.extras?.syntheticHeightMeters;
    if (parsed.gltf.extras?.heightStatus !== "synthetic-test-height" || !Number.isFinite(height) || height <= 0 || height > 250) {
      errors.push("GLB lacks valid explicit synthetic-height metadata for " + tile.contentUri); continue;
    }
    const groundLocal = parsed.positions.filter((point) => Math.abs(point[1]) <= 1e-4);
    const topLocal = parsed.positions.filter((point) => Math.abs(point[1] - height) <= 1e-4);
    if (groundLocal.length < 3 || topLocal.length < 3) { errors.push("GLB lacks ground or top vertices for " + tile.contentUri); continue; }

    const source = sourceVertices(feature.geometry);
    const uniqueSource = uniquePoints(source, 10);
    const groundWorld = groundLocal.map((point) => ecefToWgs84(transformPoint(child.transform, point)));
    const topWorld = topLocal.map((point) => ecefToWgs84(transformPoint(child.transform, point)));
    const uniqueGround = uniquePoints(groundWorld.map((point) => [point.longitudeDegrees, point.latitudeDegrees]), 7);
    if (uniqueGround.length < 3 || uniqueSource.length < 3) { errors.push("Tile has insufficient unique vertices: " + tile.contentUri); continue; }
    const sourceResiduals = uniqueSource.map((point) => Math.min(...uniqueGround.map((meshPoint) => residualMeters(point, meshPoint))));
    const groundResiduals = uniqueGround.map((point) => Math.min(...uniqueSource.map((sourcePoint) => residualMeters(point, sourcePoint))));
    const maxSourceResidual = Math.max(...sourceResiduals);
    const maxGroundResidual = Math.max(...groundResiduals);
    const maxResidual = Math.max(maxSourceResidual, maxGroundResidual);
    const heightResidual = Math.max(
      ...groundWorld.map((point) => Math.abs(point.ellipsoidHeightMeters)),
      ...topWorld.map((point) => Math.abs(point.ellipsoidHeightMeters - height)),
    );
    const allTileVertices = [...groundWorld, ...topWorld];
    const region = child.boundingVolume?.region;
    const inside = allTileVertices.every((point) => insideRegion(point, region));
    if (maxResidual > toleranceMeters) errors.push("Tile " + tile.contentUri + " footprint residual " + maxResidual.toFixed(4) + "m exceeds " + toleranceMeters + "m.");
    if (heightResidual > 0.05) errors.push("Tile " + tile.contentUri + " ECEF/geodetic height residual " + heightResidual.toFixed(4) + "m exceeds 0.05m.");
    if (!inside) errors.push("Transformed vertices escape child region for " + tile.contentUri + ".");
    const metric = {
      featureId: tile.featureId,
      contentUri: tile.contentUri,
      sourceFeatureSha256: tile.featureSha256,
      contentSha256: tile.contentSha256,
      sourceVertexCount: uniqueSource.length,
      transformedGroundVertexCount: uniqueGround.length,
      transformedTopVertexCount: uniquePoints(topWorld.map((point) => [point.longitudeDegrees, point.latitudeDegrees]), 7).length,
      maximumSourceToMeshResidualMeters: Number(maxSourceResidual.toFixed(6)),
      maximumMeshToSourceResidualMeters: Number(maxGroundResidual.toFixed(6)),
      maximumHorizontalResidualMeters: Number(maxResidual.toFixed(6)),
      maximumEllipsoidHeightResidualMeters: Number(heightResidual.toFixed(6)),
      transformedEllipsoidHeightRangeMeters: {
        ground: minMax(groundWorld.map((point) => point.ellipsoidHeightMeters)),
        top: minMax(topWorld.map((point) => point.ellipsoidHeightMeters)),
      },
      allTransformedVerticesInsideDeclaredRegion: inside,
      declaredRegionRadians: region,
      status: maxResidual <= toleranceMeters && heightResidual <= 0.05 && inside ? "pass" : "fail",
    };
    emitted.push(metric);
    totalSourceVertices += uniqueSource.length;
    totalGroundVertices += uniqueGround.length;
    totalWorldVertices += allTileVertices.length;
    globalMaxResidual = Math.max(globalMaxResidual, maxResidual);
    globalMaxHeightResidual = Math.max(globalMaxHeightResidual, heightResidual);
    allInside &&= inside;
  }

  const report = {
    schemaVersion: 1,
    evidenceType: "dhaka-3d-tiles-per-tile-footprint-placement-residual",
    status: errors.length === 0 && emitted.length === manifest.tiles.length ? "pass" : "fail",
    source: { relativePath: manifest.source.relativePath ?? null, sha256: sha256(sourceBytes), bytes: sourceBytes.length, featureCount: source.features.length },
    package: {
      packageType: manifest.packageType,
      tilesetSha256: sha256(tilesetBytes),
      buildManifestSha256: sha256(manifestBytes),
      integrityStatus: "pass",
      bytesVerified: integrity.bytesVerified,
      syntheticHeightMeters: manifest.configuration?.syntheticHeightMeters ?? null,
    },
    thresholds: {
      maximumHorizontalResidualMeters: toleranceMeters,
      maximumEllipsoidHeightResidualMeters: 0.05,
      regionBoundaryToleranceMeters: 0.02,
      verticalReference: "WGS84 ellipsoid; not surveyed vertical datum",
    },
    summary: {
      tileCount: emitted.length,
      sourceVertexCount: totalSourceVertices,
      transformedUniqueGroundVertexCount: totalGroundVertices,
      transformedWorldVertexCountIncludingDuplicates: totalWorldVertices,
      maximumHorizontalResidualMeters: Number(globalMaxResidual.toFixed(6)),
      maximumEllipsoidHeightResidualMeters: Number(globalMaxHeightResidual.toFixed(6)),
      allTransformedVerticesInsideDeclaredRegions: allInside,
    },
    tiles: emitted,
    errors,
    limitations: [
      "This checks GLB footprint vertex coordinates after child ECEF transform, child-region containment and source/hash binding. It is not rendered-pixel comparison or architectural accuracy.",
      "Source input has 2D footprints; vertical checks only validate ellipsoid transform and explicitly synthetic extrusion height.",
      "A pass is placement-plumbing evidence, not surveyed height, source-rights approval or production readiness.",
    ],
    releaseFlags,
  };
  if (outputFile) {
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  return report;
}

function parseArgs(argv) {
  const args = { sourcePath: DEFAULT_SOURCE, packageDirectory: DEFAULT_PACKAGE, outputPath: null, toleranceMeters: DEFAULT_TOLERANCE_METERS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index], value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--source") args.sourcePath = path.resolve(value);
    else if (flag === "--package") args.packageDirectory = path.resolve(value);
    else if (flag === "--output") args.outputPath = path.resolve(value);
    else if (flag === "--tolerance-meters") args.toleranceMeters = Number(value);
    else throw new Error("Unknown argument: " + flag);
    index += 1;
  }
  return args;
}
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await reviewDhaka3DTilesPackageAlignment(args);
    process.stdout.write(JSON.stringify({
      status: report.status,
      evidenceType: report.evidenceType,
      outputPath: args.outputPath,
      tileCount: report.summary.tileCount,
      maximumHorizontalResidualMeters: report.summary.maximumHorizontalResidualMeters,
      maximumEllipsoidHeightResidualMeters: report.summary.maximumEllipsoidHeightResidualMeters,
      errors: report.errors,
    }, null, 2) + "\n");
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}