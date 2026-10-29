#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyTilesetPackage } from "../src/core/geospatial/tileset-package-integrity.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = path.join(projectRoot, "data/overture/dhaka-buildings-3d-pilot.geojson");
const DEFAULT_PACKAGE = path.join(projectRoot, "public/experimental/dhaka-3d-tiles-multibuilding-pilot");
const DEFAULT_OUTPUT = path.join(projectRoot, "artifacts/p3.6-placement/placement-review.json");
const WGS84_A = 6_378_137;
const WGS84_E2 = 6.6943799901413165e-3;
const LONGITUDE_METERS_PER_DEGREE = 111_319.490793;
const LATITUDE_METERS_PER_DEGREE = 111_132.92;
const DEFAULT_MAX_RESIDUAL_METERS = 0.25;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function featureIdentity(feature) {
  if (feature.id !== undefined && feature.id !== null &&
      (typeof feature.id === "string" || typeof feature.id === "number")) {
    return String(feature.id);
  }
  const properties = isRecord(feature.properties) ? feature.properties : {};
  for (const key of ["id", "feature_id", "featureId", "building_id", "buildingId", "overture_id"]) {
    const value = properties[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return sha256(Buffer.from(JSON.stringify(feature), "utf8"));
}

function sourceFeatureHash(feature) {
  return sha256(Buffer.from(JSON.stringify(feature), "utf8"));
}

function getExteriorRings(geometry) {
  if (!isRecord(geometry)) throw new Error("Source feature geometry is missing.");
  let polygons;
  if (geometry.type === "Polygon") polygons = [geometry.coordinates];
  else if (geometry.type === "MultiPolygon") polygons = geometry.coordinates;
  else throw new Error(`Unsupported source geometry type: ${String(geometry.type)}`);
  if (!Array.isArray(polygons) || polygons.length === 0) throw new Error("Source geometry has no polygon components.");
  return polygons.map((polygon) => {
    if (!Array.isArray(polygon) || polygon.length !== 1) {
      throw new Error("Only exterior rings without interior holes are accepted by the placement reviewer.");
    }
    const raw = polygon[0];
    if (!Array.isArray(raw)) throw new Error("Source exterior ring must be an array.");
    const points = [];
    for (const coordinate of raw) {
      if (!Array.isArray(coordinate) || coordinate.length < 2 ||
          !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]) ||
          coordinate[0] < -180 || coordinate[0] > 180 ||
          coordinate[1] < -90 || coordinate[1] > 90) {
        throw new Error("Source ring contains an invalid WGS84 coordinate.");
      }
      const point = [coordinate[0], coordinate[1]];
      const previous = points.at(-1);
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
    }
    if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
    if (points.length < 3) throw new Error("Source exterior ring must contain at least three distinct points.");
    return points;
  });
}

function wgs84ToEcef(longitudeDegrees, latitudeDegrees, heightMeters = 0) {
  const longitude = longitudeDegrees * Math.PI / 180;
  const latitude = latitudeDegrees * Math.PI / 180;
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
  return [
    (normal + heightMeters) * cosLatitude * Math.cos(longitude),
    (normal + heightMeters) * cosLatitude * Math.sin(longitude),
    (normal * (1 - WGS84_E2) + heightMeters) * sinLatitude,
  ];
}

function ecefToWgs84([x, y, z]) {
  const longitude = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let latitude = Math.atan2(z, p * (1 - WGS84_E2));
  let heightMeters = 0;
  for (let index = 0; index < 12; index += 1) {
    const sinLatitude = Math.sin(latitude);
    const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
    const cosLatitude = Math.cos(latitude);
    heightMeters = Math.abs(cosLatitude) > 1e-12
      ? p / cosLatitude - normal
      : z / sinLatitude - normal * (1 - WGS84_E2);
    const nextLatitude = Math.atan2(z, p * (1 - WGS84_E2 * normal / (normal + heightMeters)));
    if (Math.abs(nextLatitude - latitude) < 1e-14) {
      latitude = nextLatitude;
      break;
    }
    latitude = nextLatitude;
  }
  const sinLatitude = Math.sin(latitude);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
  const cosLatitude = Math.cos(latitude);
  heightMeters = Math.abs(cosLatitude) > 1e-12
    ? p / cosLatitude - normal
    : z / sinLatitude - normal * (1 - WGS84_E2);
  return {
    longitudeDegrees: longitude * 180 / Math.PI,
    latitudeDegrees: latitude * 180 / Math.PI,
    heightMeters,
  };
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function vectorLength(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function validateTransform(matrix, expectedLongitude, expectedLatitude) {
  if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(Number.isFinite)) {
    throw new Error("Child tile transform must have 16 finite column-major values.");
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
  const axisDots = [dot(east, up), dot(east, south), dot(up, south)];
  const handedness = dot(cross, south);
  const anchorEcef = wgs84ToEcef(expectedLongitude, expectedLatitude, 0);
  const translationResidualMeters = vectorLength(subtract(matrix.slice(12, 15), anchorEcef));
  const axisTolerance = 1e-8;
  if (axisLengths.some((value) => Math.abs(value - 1) > axisTolerance) ||
      axisDots.some((value) => Math.abs(value) > axisTolerance) ||
      Math.abs(handedness - 1) > axisTolerance) {
    throw new Error("Child transform is not an orthonormal, right-handed ENU-to-ECEF matrix.");
  }
  if (translationResidualMeters > 0.001) {
    throw new Error(`Child transform translation differs from source anchor by ${translationResidualMeters.toFixed(6)} m.`);
  }
  return { axisLengths, axisDots, handedness, translationResidualMeters };
}

function parseGlb(bytes, label) {
  if (bytes.length < 28 || bytes.toString("ascii", 0, 4) !== "glTF" ||
      bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${label} is not a complete GLB 2.0 file.`);
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || jsonLength < 2 || 20 + jsonLength + 8 > bytes.length) {
    throw new Error(`${label} has an invalid JSON chunk.`);
  }
  const gltf = readJson(bytes.subarray(20, 20 + jsonLength), `${label} GLB JSON chunk`);
  const binaryHeader = 20 + jsonLength;
  const binaryLength = bytes.readUInt32LE(binaryHeader);
  if (bytes.readUInt32LE(binaryHeader + 4) !== 0x004e4942 ||
      binaryHeader + 8 + binaryLength > bytes.length) {
    throw new Error(`${label} has an invalid BIN chunk.`);
  }
  const binary = bytes.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength);
  if (!Array.isArray(gltf.meshes) || gltf.meshes.length !== 1 ||
      !Array.isArray(gltf.meshes[0].primitives) || gltf.meshes[0].primitives.length !== 1) {
    throw new Error(`${label} must contain exactly one mesh primitive for the pilot contract.`);
  }
  const primitive = gltf.meshes[0].primitives[0];
  const positionAccessor = gltf.accessors?.[primitive.attributes?.POSITION];
  const indexAccessor = gltf.accessors?.[primitive.indices];
  if (!isRecord(positionAccessor) || positionAccessor.componentType !== 5126 ||
      positionAccessor.type !== "VEC3" || !Number.isSafeInteger(positionAccessor.count) ||
      positionAccessor.count < 3) {
    throw new Error(`${label} POSITION accessor must be non-empty float32 VEC3 data.`);
  }
  if (!isRecord(indexAccessor) || indexAccessor.type !== "SCALAR" ||
      ![5121, 5123, 5125].includes(indexAccessor.componentType) ||
      !Number.isSafeInteger(indexAccessor.count) || indexAccessor.count < 3 ||
      indexAccessor.count % 3 !== 0) {
    throw new Error(`${label} index accessor must describe triangle indices.`);
  }

  function viewRange(accessor, itemBytes, accessorName) {
    const view = gltf.bufferViews?.[accessor.bufferView];
    if (!isRecord(view) || view.buffer !== 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 0) {
      throw new Error(`${label} ${accessorName} points to an invalid bufferView.`);
    }
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = view.byteStride ?? itemBytes;
    const finalByte = offset + (accessor.count - 1) * stride + itemBytes;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(stride) ||
        stride < itemBytes || finalByte > binary.length ||
        (accessor.byteOffset ?? 0) + (accessor.count - 1) * stride + itemBytes > view.byteLength) {
      throw new Error(`${label} ${accessorName} reads outside its declared GLB bufferView.`);
    }
    return { offset, stride };
  }

  const positionRange = viewRange(positionAccessor, 12, "POSITION");
  const positions = [];
  for (let i = 0; i < positionAccessor.count; i += 1) {
    const offset = positionRange.offset + i * positionRange.stride;
    const point = [binary.readFloatLE(offset), binary.readFloatLE(offset + 4), binary.readFloatLE(offset + 8)];
    if (!point.every(Number.isFinite)) throw new Error(`${label} has a non-finite GLB vertex.`);
    positions.push(point);
  }

  const indexBytes = indexAccessor.componentType === 5125 ? 4 : indexAccessor.componentType === 5123 ? 2 : 1;
  const indexRange = viewRange(indexAccessor, indexBytes, "indices");
  const indices = [];
  for (let i = 0; i < indexAccessor.count; i += 1) {
    const offset = indexRange.offset + i * indexRange.stride;
    const index = indexBytes === 4 ? binary.readUInt32LE(offset) :
      indexBytes === 2 ? binary.readUInt16LE(offset) : binary.readUInt8(offset);
    if (index >= positions.length) throw new Error(`${label} has an out-of-range triangle index.`);
    indices.push(index);
  }
  return { gltf, positions, indices };
}

function distancePointToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-18) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dz));
}

function minDistanceToSegments(point, segments) {
  let minimum = Infinity;
  for (const segment of segments) {
    minimum = Math.min(minimum, distancePointToSegment(point, segment[0], segment[1]));
  }
  return minimum;
}

function projectSourceRings(rings, longitude, latitude) {
  const cosine = Math.cos(latitude * Math.PI / 180);
  return rings.map((ring) => ring.map(([lon, lat]) => [
    (lon - longitude) * LONGITUDE_METERS_PER_DEGREE * cosine,
    -(lat - latitude) * LATITUDE_METERS_PER_DEGREE,
  ]));
}

function boundaryResidual(sourceRings, modelSegments) {
  const sourceSegments = [];
  for (const ring of sourceRings) {
    for (let i = 0; i < ring.length; i += 1) {
      sourceSegments.push([ring[i], ring[(i + 1) % ring.length]]);
    }
  }
  const residuals = [];
  for (const segment of sourceSegments) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const point = [
        segment[0][0] + (segment[1][0] - segment[0][0]) * fraction,
        segment[0][1] + (segment[1][1] - segment[0][1]) * fraction,
      ];
      residuals.push(minDistanceToSegments(point, modelSegments));
    }
  }
  for (const segment of modelSegments) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const point = [
        segment[0][0] + (segment[1][0] - segment[0][0]) * fraction,
        segment[0][1] + (segment[1][1] - segment[0][1]) * fraction,
      ];
      residuals.push(minDistanceToSegments(point, sourceSegments));
    }
  }
  const sourcePerimeterMeters = sourceSegments.reduce((sum, segment) =>
    sum + Math.hypot(segment[1][0] - segment[0][0], segment[1][1] - segment[0][1]), 0);
  const modelPerimeterMeters = modelSegments.reduce((sum, segment) =>
    sum + Math.hypot(segment[1][0] - segment[0][0], segment[1][1] - segment[0][1]), 0);
  return {
    maxBoundaryResidualMeters: Math.max(...residuals),
    sourcePerimeterMeters,
    modelPerimeterMeters,
    perimeterDifferenceMeters: Math.abs(sourcePerimeterMeters - modelPerimeterMeters),
  };
}

function nearestBoundarySegments(positions, indices, heightMeters, label) {
  const tolerance = Math.max(1e-4, heightMeters * 1e-6);
  const segments = new Map();
  let degenerateTriangleCount = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = [positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]]];
    const edge1 = subtract(triangle[1], triangle[0]);
    const edge2 = subtract(triangle[2], triangle[0]);
    const cross = [
      edge1[1] * edge2[2] - edge1[2] * edge2[1],
      edge1[2] * edge2[0] - edge1[0] * edge2[2],
      edge1[0] * edge2[1] - edge1[1] * edge2[0],
    ];
    if (vectorLength(cross) < 1e-8) degenerateTriangleCount += 1;
    const base = triangle.filter((point) => Math.abs(point[1]) <= tolerance);
    const top = triangle.filter((point) => Math.abs(point[1] - heightMeters) <= tolerance);
    if (base.length === 2 && top.length === 1) {
      const a = [base[0][0], base[0][2]];
      const b = [base[1][0], base[1][2]];
      const keyA = a.map(value => value.toFixed(6)).join(",");
      const keyB = b.map(value => value.toFixed(6)).join(",");
      const key = keyA < keyB ? keyA + "|" + keyB : keyB + "|" + keyA;
      segments.set(key, [a, b]);
    }
  }
  if (segments.size < 3) throw new Error(`${label} contains fewer than three recoverable footprint boundary edges.`);
  return { segments: Array.from(segments.values()), degenerateTriangleCount };
}

function projectedVertexEcefResiduals(sourceRings, longitude, latitude, transform) {
  const expected = [];
  for (const ring of sourceRings) {
    for (const [lon, lat] of ring) {
      const east = (lon - longitude) * LONGITUDE_METERS_PER_DEGREE * Math.cos(latitude * Math.PI / 180);
      const south = -(lat - latitude) * LATITUDE_METERS_PER_DEGREE;
      const actualEcef = transformPoint(transform, [east, 0, south]);
      const sourceEcef = wgs84ToEcef(lon, lat, 0);
      expected.push(vectorLength(subtract(actualEcef, sourceEcef)));
    }
  }
  return Math.max(...expected);
}

function parseArgs(argv) {
  const args = { sourcePath: DEFAULT_SOURCE, packageDirectory: DEFAULT_PACKAGE, outputPath: DEFAULT_OUTPUT, maxResidualMeters: DEFAULT_MAX_RESIDUAL_METERS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    if (key === "--source") args.sourcePath = path.resolve(value);
    else if (key === "--package") args.packageDirectory = path.resolve(value);
    else if (key === "--output") args.outputPath = path.resolve(value);
    else if (key === "--max-residual-meters") args.maxResidualMeters = Number(value);
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
  }
  return args;
}

export async function reviewDhaka3DTilesPackagePlacement({
  sourcePath = DEFAULT_SOURCE,
  packageDirectory = DEFAULT_PACKAGE,
  outputPath = DEFAULT_OUTPUT,
  maxResidualMeters = DEFAULT_MAX_RESIDUAL_METERS,
} = {}) {
  const sourceFile = path.resolve(sourcePath);
  const packageRoot = path.resolve(packageDirectory);
  const outputFile = path.resolve(outputPath);
  if (!within(projectRoot, sourceFile)) throw new Error("Refusing to read placement source outside the repository.");
  if (!within(projectRoot, packageRoot) && !within(os.tmpdir(), packageRoot)) throw new Error("Refusing to read package outside the repository or OS temp directory.");
  if (!within(projectRoot, outputFile) && !within(os.tmpdir(), outputFile)) throw new Error("Refusing to write placement evidence outside the repository or OS temp directory.");
  if (!Number.isFinite(maxResidualMeters) || maxResidualMeters <= 0 || maxResidualMeters > 5) {
    throw new Error("maxResidualMeters must be finite and in the range (0, 5].");
  }

  const sourceInfo = await lstat(sourceFile);
  const rootInfo = await lstat(packageRoot);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sourceInfo.size < 1 || sourceInfo.size > MAX_SOURCE_BYTES) {
    throw new Error("Placement source must be a non-empty regular GeoJSON file within the size limit.");
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Placement package root must be a real directory, not a symbolic link.");
  }

  const sourceBytes = await readFile(sourceFile);
  const source = readJson(sourceBytes, "Source GeoJSON");
  if (!isRecord(source) || source.type !== "FeatureCollection" || !Array.isArray(source.features)) {
    throw new Error("Placement source must be a GeoJSON FeatureCollection.");
  }

  const integrity = await verifyTilesetPackage({ directory: packageRoot, maxTotalBytes: MAX_PACKAGE_BYTES });
  if (!integrity.valid) throw new Error("Package integrity must pass before geometry placement review: " + integrity.errors.join("; "));
  const tilesetBytes = await readFile(path.join(packageRoot, "tileset.json"));
  const buildBytes = await readFile(path.join(packageRoot, "build-manifest.json"));
  const tileset = readJson(tilesetBytes, "tileset.json");
  const build = readJson(buildBytes, "build-manifest.json");
  if (tileset?.asset?.version !== "1.1" || tileset?.asset?.extras?.heightStatus !== "synthetic-test-height") {
    throw new Error("Placement review requires the bounded OGC 3D Tiles 1.1 synthetic-height pilot package.");
  }
  if (build?.source?.sha256 !== sha256(sourceBytes)) throw new Error("Placement source SHA-256 differs from the package build manifest.");
  if (!Array.isArray(tileset.root?.children) || !Array.isArray(build.tiles) ||
      tileset.root.children.length !== build.tiles.length || tileset.root.children.length === 0) {
    throw new Error("Tileset child hierarchy and build-manifest tile list are inconsistent or empty.");
  }
  const releaseKeys = ["acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"];
  if (!build.releaseFlags || releaseKeys.some((key) => build.releaseFlags[key] !== false)) {
    throw new Error("All package release flags must remain explicitly false during placement review.");
  }

  const sourceById = new Map();
  for (const feature of source.features) {
    if (!isRecord(feature) || feature.type !== "Feature" || !isRecord(feature.geometry)) continue;
    const id = featureIdentity(feature);
    if (sourceById.has(id)) sourceById.set(id, null);
    else sourceById.set(id, feature);
  }
  const manifestByUri = new Map(build.tiles.map((tile) => [tile.contentUri, tile]));
  const childUris = new Set();
  const reports = [];
  let maximumBoundaryResidualMeters = 0;
  let maximumEcefPlacementResidualMeters = 0;
  let maximumPerimeterDifferenceMeters = 0;
  let maximumDegenerateTriangles = 0;

  for (const child of tileset.root.children) {
    const uri = child?.content?.uri;
    if (typeof uri !== "string" || childUris.has(uri)) throw new Error("Tileset contains a missing or duplicate child content URI.");
    childUris.add(uri);
    const tile = manifestByUri.get(uri);
    if (!isRecord(tile)) throw new Error(`Child ${uri} has no matching build-manifest record.`);
    const feature = sourceById.get(tile.featureId);
    if (!isRecord(feature)) throw new Error(`Source feature ${tile.featureId} is missing or ambiguously identified.`);
    const featureHash = sourceFeatureHash(feature);
    if (featureHash !== tile.featureSha256) throw new Error(`Source feature hash changed for ${tile.featureId}.`);
    if (child.extras?.sourceFeatureId !== tile.featureId || child.extras?.sourceFeatureSha256 !== featureHash) {
      throw new Error(`Tileset child source identity/hash mismatch for ${tile.featureId}.`);
    }
    const ringsDegrees = getExteriorRings(feature.geometry);
    const anchor = {
      longitude: (tile.sourceBoundsDegrees.west + tile.sourceBoundsDegrees.east) / 2,
      latitude: (tile.sourceBoundsDegrees.south + tile.sourceBoundsDegrees.north) / 2,
    };
    const transformReport = validateTransform(child.transform, anchor.longitude, anchor.latitude);
    const glbBytes = await readFile(path.join(packageRoot, uri));
    const glb = parseGlb(glbBytes, uri);
    if (glb.gltf.extras?.sourceFeatureId !== tile.featureId ||
        glb.gltf.extras?.sourceFeatureSha256 !== featureHash ||
        glb.gltf.extras?.heightStatus !== "synthetic-test-height") {
      throw new Error(`GLB source identity, hash, or height status mismatch for ${tile.featureId}.`);
    }
    const expectedHeight = build.configuration?.syntheticHeightMeters;
    if (!Number.isFinite(expectedHeight) || expectedHeight <= 0 ||
        glb.gltf.extras.syntheticHeightMeters !== expectedHeight) {
      throw new Error(`Synthetic height is inconsistent for ${tile.featureId}.`);
    }
    const bounds = glb.gltf.accessors[glb.gltf.meshes[0].primitives[0].attributes.POSITION];
    const emittedHeight = bounds.max[1] - bounds.min[1];
    const baseResidual = Math.abs(bounds.min[1]);
    const heightResidual = Math.abs(emittedHeight - expectedHeight);
    if (baseResidual > 1e-4 || heightResidual > 1e-3) {
      throw new Error(`GLB vertical bounds do not match the synthetic test height for ${tile.featureId}.`);
    }
    const boundary = nearestBoundarySegments(glb.positions, glb.indices, expectedHeight, uri);
    const expectedRings = projectSourceRings(ringsDegrees, anchor.longitude, anchor.latitude);
    const residual = boundaryResidual(expectedRings, boundary.segments);
    const ecefPlacementResidualMeters = projectedVertexEcefResiduals(ringsDegrees, anchor.longitude, anchor.latitude, child.transform);
    const childRegion = child.boundingVolume?.region;
    if (!Array.isArray(childRegion) || childRegion.length !== 6 || !childRegion.every(Number.isFinite)) {
      throw new Error(`Child ${uri} has no valid geographic region.`);
    }
    const regionCoversSourceBounds =
      tile.sourceBoundsDegrees.west * Math.PI / 180 >= childRegion[0] - 1e-10 &&
      tile.sourceBoundsDegrees.south * Math.PI / 180 >= childRegion[1] - 1e-10 &&
      tile.sourceBoundsDegrees.east * Math.PI / 180 <= childRegion[2] + 1e-10 &&
      tile.sourceBoundsDegrees.north * Math.PI / 180 <= childRegion[3] + 1e-10 &&
      childRegion[4] <= -0.25 + 1e-9 && childRegion[5] >= expectedHeight + 0.25 - 1e-9;
    if (!regionCoversSourceBounds) throw new Error(`Child ${uri} bounding region does not enclose the source footprint and pilot height range.`);
    if (residual.maxBoundaryResidualMeters > maxResidualMeters) {
      throw new Error(`Footprint boundary residual for ${tile.featureId} is ${residual.maxBoundaryResidualMeters.toFixed(4)} m, above ${maxResidualMeters} m.`);
    }
    if (ecefPlacementResidualMeters > maxResidualMeters) {
      throw new Error(`ECEF placement residual for ${tile.featureId} is ${ecefPlacementResidualMeters.toFixed(4)} m, above ${maxResidualMeters} m.`);
    }
    if (residual.perimeterDifferenceMeters > maxResidualMeters) {
      throw new Error(`Footprint perimeter difference for ${tile.featureId} is ${residual.perimeterDifferenceMeters.toFixed(4)} m.`);
    }
    const report = {
      featureId: tile.featureId,
      contentUri: uri,
      contentSha256: sha256(glbBytes),
      vertexCount: glb.positions.length,
      triangleCount: glb.indices.length / 3,
      degenerateTriangleCount: boundary.degenerateTriangleCount,
      footprintBoundaryResidualMeters: Number(residual.maxBoundaryResidualMeters.toFixed(6)),
      ecefPlacementResidualMeters: Number(ecefPlacementResidualMeters.toFixed(6)),
      sourcePerimeterMeters: Number(residual.sourcePerimeterMeters.toFixed(6)),
      emittedPerimeterMeters: Number(residual.modelPerimeterMeters.toFixed(6)),
      perimeterDifferenceMeters: Number(residual.perimeterDifferenceMeters.toFixed(6)),
      verticalBounds: { baseResidualMeters: baseResidual, emittedHeightMeters: emittedHeight, expectedSyntheticHeightMeters: expectedHeight, heightResidualMeters: heightResidual },
      transform: transformReport,
      regionCoversSourceBounds,
      status: "pass",
    };
    maximumBoundaryResidualMeters = Math.max(maximumBoundaryResidualMeters, residual.maxBoundaryResidualMeters);
    maximumEcefPlacementResidualMeters = Math.max(maximumEcefPlacementResidualMeters, ecefPlacementResidualMeters);
    maximumPerimeterDifferenceMeters = Math.max(maximumPerimeterDifferenceMeters, residual.perimeterDifferenceMeters);
    maximumDegenerateTriangles = Math.max(maximumDegenerateTriangles, boundary.degenerateTriangleCount);
    reports.push(report);
  }

  if (childUris.size !== build.tiles.length) throw new Error("Some build-manifest records are not represented in the tileset hierarchy.");
  const report = {
    schemaVersion: 1,
    evidenceType: "p3.6-independent-source-footprint-glb-placement-residuals",
    status: "pass",
    method: {
      maxResidualThresholdMeters: maxResidualMeters,
      footprintComparison: "bidirectional sampled distance between GeoJSON exterior boundaries projected in local ENU and recovered GLB base-perimeter edges",
      worldPlacementComparison: "source WGS84 footprint vertices transformed through child ENU-to-ECEF matrix versus independently computed WGS84 ECEF coordinates",
      heightInterpretation: "synthetic test extrusion only; this check does not establish actual building heights",
    },
    input: {
      sourceSha256: sha256(sourceBytes),
      tilesetSha256: sha256(tilesetBytes),
      buildManifestSha256: sha256(buildBytes),
      emittedTileCount: reports.length,
      integrity: { valid: integrity.valid, bytesVerified: integrity.bytesVerified },
    },
    summary: {
      maximumFootprintBoundaryResidualMeters: Number(maximumBoundaryResidualMeters.toFixed(6)),
      maximumEcefPlacementResidualMeters: Number(maximumEcefPlacementResidualMeters.toFixed(6)),
      maximumPerimeterDifferenceMeters: Number(maximumPerimeterDifferenceMeters.toFixed(6)),
      maximumDegenerateTriangleCount: maximumDegenerateTriangles,
      maxResidualThresholdMeters: maxResidualMeters,
      allTileResidualsWithinThreshold: true,
      allChildRegionsCoverSourceBounds: reports.every((item) => item.regionCoversSourceBounds),
    },
    tiles: reports,
    limitations: [
      "The footprint baseline is the supplied GeoJSON source itself, not independent surveyed truth.",
      "The mesh height is synthetic and is validated only against the package configuration.",
      "Boundary residuals sample both polylines at vertices, quarter points and midpoints; this is a deterministic geometric QA measure, not a legal/survey acceptance metric.",
      "Source rights, architectural facade/roof accuracy and production readiness are not established.",
    ],
    releaseFlags: build.releaseFlags,
  };
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await reviewDhaka3DTilesPackagePlacement(args);
    process.stdout.write(JSON.stringify({ status: report.status, ...report.summary, output: args.outputPath, sourceSha256: report.input.sourceSha256 }) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
