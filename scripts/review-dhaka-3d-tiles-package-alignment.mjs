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
function sourceRings(geometry) {
  if(!isRecord(geometry))throw new Error("Source geometry is missing.");
  const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.type==="MultiPolygon"?geometry.coordinates:null;
  if(!Array.isArray(polygons)||!polygons.length)throw new Error("Source tile geometry must be Polygon or MultiPolygon.");
  const rings=[];
  for(const polygon of polygons){
    if(!Array.isArray(polygon)||!polygon.length)throw new Error("Source polygon must contain an exterior ring.");
    for(const rawRing of polygon){
      if(!Array.isArray(rawRing))throw new Error("Source polygon ring must be an array.");
      const ring=[];
      for(const coordinate of rawRing){
        if(!Array.isArray(coordinate)||coordinate.length<2||!Number.isFinite(coordinate[0])||!Number.isFinite(coordinate[1])||
          coordinate[0]<-180||coordinate[0]>180||coordinate[1]<-90||coordinate[1]>90)throw new Error("Source ring contains an invalid WGS84 coordinate.");
        const point=[coordinate[0],coordinate[1]],previous=ring.at(-1);
        if(!previous||previous[0]!==point[0]||previous[1]!==point[1])ring.push(point);
      }
      if(ring.length>1&&ring[0][0]===ring.at(-1)[0]&&ring[0][1]===ring.at(-1)[1])ring.pop();
      if(ring.length<3)throw new Error("Source ring has fewer than three unique vertices.");
      rings.push(ring);
    }
  }
  return rings;
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
  if (jsonType !== 0x4e4f534a || jsonLength < 2 || offset + jsonLength > bytes.length) {
    throw new Error("GLB JSON chunk is invalid.");
  }
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

  function readAccessor(accessor, type, componentTypes, itemBytes, label) {
    if (!isRecord(accessor) || accessor.type !== type || !componentTypes.includes(accessor.componentType) ||
        !Number.isSafeInteger(accessor.count) || accessor.count < 1 ||
        !Number.isInteger(accessor.bufferView) || !isRecord(gltf.bufferViews[accessor.bufferView])) {
      throw new Error("GLB " + label + " accessor is invalid.");
    }
    const view = gltf.bufferViews[accessor.bufferView];
    const viewOffset = view.byteOffset ?? 0;
    const accessorOffset = accessor.byteOffset ?? 0;
    const stride = view.byteStride ?? itemBytes;
    if ((view.buffer !== undefined && view.buffer !== 0) ||
        !Number.isSafeInteger(viewOffset) || !Number.isSafeInteger(accessorOffset) ||
        !Number.isSafeInteger(stride) || stride < itemBytes ||
        !Number.isSafeInteger(view.byteLength) || viewOffset < 0 || accessorOffset < 0 || view.byteLength < 0) {
      throw new Error("GLB " + label + " byte range or stride is invalid.");
    }
    const start = viewOffset + accessorOffset;
    const end = start + (accessor.count - 1) * stride + itemBytes;
    if (!Number.isSafeInteger(end) || end > viewOffset + view.byteLength || end > binary.length) {
      throw new Error("GLB " + label + " accessor exceeds its binary byte range.");
    }
    return { start, stride };
  }

  const positions = [];
  const triangles = [];
  for (const mesh of gltf.meshes) {
    if (!isRecord(mesh) || !Array.isArray(mesh.primitives)) throw new Error("GLB mesh primitives are invalid.");
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4) throw new Error("GLB placement review requires TRIANGLES primitives.");
      const accessorIndex = primitive && primitive.attributes && primitive.attributes.POSITION;
      const accessor = Number.isInteger(accessorIndex) ? gltf.accessors[accessorIndex] : null;
      if (!isRecord(accessor) || accessor.componentType !== 5126 || accessor.type !== "VEC3" ||
          !Number.isSafeInteger(accessor.count) || accessor.count < 3 || accessor.count % 3 !== 0) {
        throw new Error("Each mesh primitive must reference triangle-aligned float32 VEC3 POSITION data.");
      }
      const positionRange = readAccessor(accessor, "VEC3", [5126], 12, "POSITION");
      const primitivePositions = [];
      for (let index = 0; index < accessor.count; index += 1) {
        const pointOffset = positionRange.start + index * positionRange.stride;
        const point = [binary.readFloatLE(pointOffset), binary.readFloatLE(pointOffset + 4), binary.readFloatLE(pointOffset + 8)];
        if (!point.every(Number.isFinite)) throw new Error("GLB POSITION contains a non-finite value.");
        primitivePositions.push(point);
        positions.push(point);
      }

      const indexAccessor = Number.isInteger(primitive.indices) ? gltf.accessors[primitive.indices] : null;
      let indices;
      if (indexAccessor) {
        if (indexAccessor.type !== "SCALAR" || !Number.isSafeInteger(indexAccessor.count) ||
            indexAccessor.count < 3 || indexAccessor.count % 3 !== 0 ||
            ![5121, 5123, 5125].includes(indexAccessor.componentType)) {
          throw new Error("GLB triangle index accessor is invalid.");
        }
        const indexBytes = indexAccessor.componentType === 5125 ? 4 : indexAccessor.componentType === 5123 ? 2 : 1;
        const indexRange = readAccessor(indexAccessor, "SCALAR", [indexAccessor.componentType], indexBytes, "indices");
        indices = [];
        for (let index = 0; index < indexAccessor.count; index += 1) {
          const at = indexRange.start + index * indexRange.stride;
          const value = indexBytes === 4 ? binary.readUInt32LE(at) :
            indexBytes === 2 ? binary.readUInt16LE(at) : binary.readUInt8(at);
          if (value >= primitivePositions.length) throw new Error("GLB triangle index references a missing position.");
          indices.push(value);
        }
      } else {
        indices = Array.from({ length: primitivePositions.length }, (_, index) => index);
      }
      for (let index = 0; index < indices.length; index += 3) {
        triangles.push([
          primitivePositions[indices[index]],
          primitivePositions[indices[index + 1]],
          primitivePositions[indices[index + 2]],
        ]);
      }
    }
  }
  if (positions.length < 3 || triangles.length < 1) throw new Error("GLB has no usable triangle mesh.");
  return { positions, triangles, gltf };
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

function wgs84ToEcef(longitudeDegrees, latitudeDegrees, heightMeters = 0) {
  const longitude = longitudeDegrees * DEG;
  const latitude = latitudeDegrees * DEG;
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
  return [
    (normal + heightMeters) * cosLatitude * Math.cos(longitude),
    (normal + heightMeters) * cosLatitude * Math.sin(longitude),
    (normal * (1 - WGS84_E2) + heightMeters) * sinLatitude,
  ];
}
function vectorLength(point) { return Math.hypot(point[0], point[1], point[2]); }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function subtract3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function validateTransformQuality(matrix, longitude, latitude) {
  const errors = [];
  if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(Number.isFinite)) {
    return { valid: false, errors: ["Child transform must contain 16 finite column-major values."], translationResidualMeters: null };
  }
  const east = [matrix[0], matrix[1], matrix[2]];
  const up = [matrix[4], matrix[5], matrix[6]];
  const south = [matrix[8], matrix[9], matrix[10]];
  const cross = [
    east[1] * up[2] - east[2] * up[1],
    east[2] * up[0] - east[0] * up[2],
    east[0] * up[1] - east[1] * up[0],
  ];
  const axisLengths = [vectorLength(east), vectorLength(up), vectorLength(south)];
  const axisDots = [dot3(east, up), dot3(east, south), dot3(up, south)];
  const handedness = dot3(cross, south);
  const translationResidualMeters = vectorLength(subtract3(
    matrix.slice(12, 15),
    wgs84ToEcef(longitude, latitude, 0),
  ));
  const tolerance = 1e-8;
  if (axisLengths.some((length) => Math.abs(length - 1) > tolerance) ||
      axisDots.some((value) => Math.abs(value) > tolerance) ||
      Math.abs(handedness - 1) > tolerance) {
    errors.push("Child transform axes are not orthonormal and right-handed ENU-to-ECEF.");
  }
  if (translationResidualMeters > 0.001) {
    errors.push("Child transform translation differs from the source footprint anchor by " + translationResidualMeters.toFixed(4) + "m.");
  }
  return { valid: errors.length === 0, errors, axisLengths, axisDots, handedness, translationResidualMeters };
}
function projectToAnchorPlane(point, anchorLongitude, anchorLatitude) {
  const longitude = point.longitudeDegrees ?? point[0];
  const latitude = point.latitudeDegrees ?? point[1];
  return [
    (longitude - anchorLongitude) * 111319.490793 * Math.cos(anchorLatitude * DEG),
    (latitude - anchorLatitude) * 111132.92,
  ];
}
function pointToSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-18) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}
function minDistanceToLinework(point, segments) {
  let minimum = Infinity;
  for (const segment of segments) minimum = Math.min(minimum, pointToSegmentDistance(point, segment[0], segment[1]));
  return minimum;
}
function measureBoundaryResidual(expectedSegments, actualSegments) {
  if (expectedSegments.length < 3 || actualSegments.length < 3) {
    throw new Error("Source and emitted mesh must each provide at least three footprint boundary segments.");
  }
  const residuals = [];
  for (const segments of [[expectedSegments, actualSegments], [actualSegments, expectedSegments]]) {
    const [sampledSegments, targetSegments] = segments;
    for (const segment of sampledSegments) {
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const point = [
          segment[0][0] + (segment[1][0] - segment[0][0]) * fraction,
          segment[0][1] + (segment[1][1] - segment[0][1]) * fraction,
        ];
        residuals.push(minDistanceToLinework(point, targetSegments));
      }
    }
  }
  const perimeter = (segments) => segments.reduce((sum, segment) =>
    sum + Math.hypot(segment[1][0] - segment[0][0], segment[1][1] - segment[0][1]), 0);
  const expectedPerimeterMeters = perimeter(expectedSegments);
  const actualPerimeterMeters = perimeter(actualSegments);
  return {
    maximumResidualMeters: Math.max(...residuals),
    expectedPerimeterMeters,
    actualPerimeterMeters,
    perimeterDifferenceMeters: Math.abs(expectedPerimeterMeters - actualPerimeterMeters),
    expectedSegmentCount: expectedSegments.length,
    actualSegmentCount: actualSegments.length,
  };
}
function sourceBoundarySegments(rings, anchorLongitude, anchorLatitude) {
  const segments = [];
  for (const ring of rings) {
    const projected = ring.map((point) => projectToAnchorPlane(point, anchorLongitude, anchorLatitude));
    for (let index = 0; index < projected.length; index += 1) {
      segments.push([projected[index], projected[(index + 1) % projected.length]]);
    }
  }
  return segments;
}
function recoverMeshBoundarySegments(triangles, height, label) {
  const tolerance = Math.max(1e-4, height * 1e-6);
  const segments = new Map();
  let degenerateTriangleCount = 0;
  for (const triangle of triangles) {
    const [a, b, c] = triangle;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    if (vectorLength(cross) < 1e-8) degenerateTriangleCount += 1;
    const ground = triangle.filter((point) => Math.abs(point[1]) <= tolerance);
    const top = triangle.filter((point) => Math.abs(point[1] - height) <= tolerance);
    if (ground.length !== 2 || top.length !== 1) continue;
    const first = [ground[0][0], -ground[0][2]];
    const second = [ground[1][0], -ground[1][2]];
    const firstKey = first.map((value) => value.toFixed(5)).join(",");
    const secondKey = second.map((value) => value.toFixed(5)).join(",");
    const key = firstKey < secondKey ? firstKey + "|" + secondKey : secondKey + "|" + firstKey;
    segments.set(key, [first, second]);
  }
  if (segments.size < 3) throw new Error("GLB " + label + " has fewer than three recoverable footprint boundary edges.");
  return { segments: Array.from(segments.values()), degenerateTriangleCount };
}
function transformBoundarySegmentsToAnchorPlane(segments, transform, anchorLongitude, anchorLatitude) {
  const output = [];
  for (const segment of segments) {
    const samplePoints = [];
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const east = segment[0][0] + (segment[1][0] - segment[0][0]) * fraction;
      const north = segment[0][1] + (segment[1][1] - segment[0][1]) * fraction;
      const world = ecefToWgs84(transformPoint(transform, [east, 0, -north]));
      samplePoints.push(projectToAnchorPlane(world, anchorLongitude, anchorLatitude));
    }
    for (let index = 0; index < samplePoints.length - 1; index += 1) {
      output.push([samplePoints[index], samplePoints[index + 1]]);
    }
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
  let globalMaxResidual = 0, globalMaxHeightResidual = 0, globalMaxPerimeterDifference = 0, globalDegenerateTriangleCount = 0, allInside = true;

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

    const sourceRingsDegrees = sourceRings(feature.geometry);
    const source = sourceRingsDegrees.flat();
    const uniqueSource = uniquePoints(source, 10);
    const groundWorld = groundLocal.map((point) => ecefToWgs84(transformPoint(child.transform, point)));
    const topWorld = topLocal.map((point) => ecefToWgs84(transformPoint(child.transform, point)));
    const uniqueGround = uniquePoints(groundWorld.map((point) => [point.longitudeDegrees, point.latitudeDegrees]), 7);
    if (uniqueGround.length < 3 || uniqueSource.length < 3) { errors.push("Tile has insufficient unique vertices: " + tile.contentUri); continue; }

    const sourceBounds = tile.sourceBoundsDegrees;
    if (!isRecord(sourceBounds) || ![sourceBounds.west, sourceBounds.south, sourceBounds.east, sourceBounds.north].every(Number.isFinite)) {
      errors.push("Tile " + tile.contentUri + " has no valid sourceBoundsDegrees record.");
      continue;
    }
    const anchorLongitude = (sourceBounds.west + sourceBounds.east) / 2;
    const anchorLatitude = (sourceBounds.south + sourceBounds.north) / 2;
    const transformQuality = validateTransformQuality(child.transform, anchorLongitude, anchorLatitude);
    for (const error of transformQuality.errors) errors.push("Tile " + tile.contentUri + " transform: " + error);

    // Vertex-to-vertex residual remains a diagnostic only: a valid polygon may
    // include redundant collinear source vertices that the mesh simplifier removes.
    const sourceResiduals = uniqueSource.map((point) => Math.min(...uniqueGround.map((meshPoint) => residualMeters(point, meshPoint))));
    const groundResiduals = uniqueGround.map((point) => Math.min(...uniqueSource.map((sourcePoint) => residualMeters(point, sourcePoint))));
    const maxSourceVertexResidual = Math.max(...sourceResiduals);
    const maxGroundVertexResidual = Math.max(...groundResiduals);

    const sourceSegments = sourceBoundarySegments(sourceRingsDegrees, anchorLongitude, anchorLatitude);
    const recoveredBoundary = recoverMeshBoundarySegments(parsed.triangles, height, tile.contentUri);
    const localBoundary = measureBoundaryResidual(sourceSegments, recoveredBoundary.segments);
    const worldBoundarySegments = transformBoundarySegmentsToAnchorPlane(
      recoveredBoundary.segments,
      child.transform,
      anchorLongitude,
      anchorLatitude,
    );
    const worldBoundary = measureBoundaryResidual(sourceSegments, worldBoundarySegments);
    const maxResidual = Math.max(localBoundary.maximumResidualMeters, worldBoundary.maximumResidualMeters);
    const maximumPerimeterDifferenceMeters = Math.max(
      localBoundary.perimeterDifferenceMeters,
      worldBoundary.perimeterDifferenceMeters,
    );
    const heightResidual = Math.max(
      ...groundWorld.map((point) => Math.abs(point.ellipsoidHeightMeters)),
      ...topWorld.map((point) => Math.abs(point.ellipsoidHeightMeters - height)),
    );
    const allTileVertices = [...groundWorld, ...topWorld];
    const region = child.boundingVolume?.region;
    const inside = allTileVertices.every((point) => insideRegion(point, region));
    if (maxResidual > toleranceMeters) errors.push("Tile " + tile.contentUri + " footprint boundary residual " + maxResidual.toFixed(4) + "m exceeds " + toleranceMeters + "m.");
    if (maximumPerimeterDifferenceMeters > toleranceMeters) errors.push("Tile " + tile.contentUri + " footprint perimeter difference " + maximumPerimeterDifferenceMeters.toFixed(4) + "m exceeds " + toleranceMeters + "m.");
    if (recoveredBoundary.degenerateTriangleCount > 0) errors.push("Tile " + tile.contentUri + " contains " + recoveredBoundary.degenerateTriangleCount + " degenerate triangles.");
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
      maximumSourceToMeshVertexResidualMeters: Number(maxSourceVertexResidual.toFixed(6)),
      maximumMeshToSourceVertexResidualMeters: Number(maxGroundVertexResidual.toFixed(6)),
      maximumLocalFootprintBoundaryResidualMeters: Number(localBoundary.maximumResidualMeters.toFixed(6)),
      maximumTransformedFootprintBoundaryResidualMeters: Number(worldBoundary.maximumResidualMeters.toFixed(6)),
      maximumHorizontalResidualMeters: Number(maxResidual.toFixed(6)),
      sourcePerimeterMeters: Number(localBoundary.expectedPerimeterMeters.toFixed(6)),
      localMeshPerimeterMeters: Number(localBoundary.actualPerimeterMeters.toFixed(6)),
      transformedMeshPerimeterMeters: Number(worldBoundary.actualPerimeterMeters.toFixed(6)),
      maximumFootprintPerimeterDifferenceMeters: Number(maximumPerimeterDifferenceMeters.toFixed(6)),
      sourceBoundarySegmentCount: localBoundary.expectedSegmentCount,
      meshBoundarySegmentCount: localBoundary.actualSegmentCount,
      degenerateTriangleCount: recoveredBoundary.degenerateTriangleCount,
      transformQuality: {
        valid: transformQuality.valid,
        axisLengths: transformQuality.axisLengths ?? null,
        axisDots: transformQuality.axisDots ?? null,
        handedness: transformQuality.handedness ?? null,
        translationResidualMeters: transformQuality.translationResidualMeters,
      },
      maximumEllipsoidHeightResidualMeters: Number(heightResidual.toFixed(6)),
      transformedEllipsoidHeightRangeMeters: {
        ground: minMax(groundWorld.map((point) => point.ellipsoidHeightMeters)),
        top: minMax(topWorld.map((point) => point.ellipsoidHeightMeters)),
      },
      allTransformedVerticesInsideDeclaredRegion: inside,
      declaredRegionRadians: region,
      status: maxResidual <= toleranceMeters && maximumPerimeterDifferenceMeters <= toleranceMeters &&
        recoveredBoundary.degenerateTriangleCount === 0 && transformQuality.valid && heightResidual <= 0.05 && inside ? "pass" : "fail",
    };
    emitted.push(metric);
    totalSourceVertices += uniqueSource.length;
    totalGroundVertices += uniqueGround.length;
    totalWorldVertices += allTileVertices.length;
    globalMaxResidual = Math.max(globalMaxResidual, maxResidual);
    globalMaxHeightResidual = Math.max(globalMaxHeightResidual, heightResidual);
    globalMaxPerimeterDifference = Math.max(globalMaxPerimeterDifference, maximumPerimeterDifferenceMeters);
    globalDegenerateTriangleCount = Math.max(globalDegenerateTriangleCount, recoveredBoundary.degenerateTriangleCount);
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
      maximumFootprintPerimeterDifferenceMeters: Number(globalMaxPerimeterDifference.toFixed(6)),
      degenerateTriangleCountMaximumAcrossTiles: globalDegenerateTriangleCount,
      maximumEllipsoidHeightResidualMeters: Number(globalMaxHeightResidual.toFixed(6)),
      allTransformedVerticesInsideDeclaredRegions: allInside,
    },
    tiles: emitted,
    errors,
    limitations: [
      "Acceptance uses bidirectional sampled source-perimeter versus GLB base-boundary residuals in both local coordinates and after the ECEF transform; source-vertex nearest-vertex distances are diagnostic because collinear source vertices can be simplified away.",
      "The reviewer checks indexed GLB triangles, degenerate triangles, transform axis orthonormality/handedness, source-anchor translation, vertical consistency and child-region containment. It is not rendered-pixel comparison or architectural accuracy.",
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
