#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateTilesetManifest } from "../src/core/geospatial/tileset-manifest-validation.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const defaultSource = path.join(projectRoot, "data/overture/dhaka-buildings-3d-pilot.geojson");
const defaultOutput = path.join(projectRoot, "data/overture/dhaka-3d-tiles-fixture");
const sourceDescription = "Overture Maps Buildings theme — Dhaka 3D pilot extract";
const attribution = "© OpenStreetMap contributors, Overture Maps Foundation";
const fixtureHeightMeters = 8;
const WGS84_A = 6_378_137;
const WGS84_E2 = 6.6943799901413165e-3;
const METERS_PER_LATITUDE_DEGREE = 111_132;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function featureIdentity(feature) {
  if (feature.id !== undefined && feature.id !== null) return String(feature.id);
  const properties = isRecord(feature.properties) ? feature.properties : {};
  for (const key of ["id", "feature_id", "featureId", "building_id", "overture_id"]) {
    if (typeof properties[key] === "string" || typeof properties[key] === "number") {
      return String(properties[key]);
    }
  }
  return sha256(JSON.stringify(feature));
}

function geometryBounds(geometry) {
  if (!isRecord(geometry)) return null;
  const bounds = {
    west: Infinity,
    south: Infinity,
    east: -Infinity,
    north: -Infinity,
  };

  function visit(value) {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    ) {
      const [longitude, latitude] = value;
      if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return;
      bounds.west = Math.min(bounds.west, longitude);
      bounds.south = Math.min(bounds.south, latitude);
      bounds.east = Math.max(bounds.east, longitude);
      bounds.north = Math.max(bounds.north, latitude);
      return;
    }
    for (const child of value) visit(child);
  }

  visit(geometry.coordinates);
  if (Array.isArray(geometry.geometries)) {
    for (const child of geometry.geometries) {
      const childBounds = geometryBounds(child);
      if (!childBounds) continue;
      bounds.west = Math.min(bounds.west, childBounds.west);
      bounds.south = Math.min(bounds.south, childBounds.south);
      bounds.east = Math.max(bounds.east, childBounds.east);
      bounds.north = Math.max(bounds.north, childBounds.north);
    }
  }

  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

function chooseDhakaBuilding(source) {
  const [west, south, east, north] = [90.4, 23.77, 90.42, 23.79];
  const candidates = [];

  for (const feature of source.features) {
    if (
      !isRecord(feature) ||
      feature.type !== "Feature" ||
      !isRecord(feature.geometry) ||
      !["Polygon", "MultiPolygon"].includes(feature.geometry.type)
    ) continue;

    const bounds = geometryBounds(feature.geometry);
    if (!bounds) continue;
    const center = {
      longitude: (bounds.west + bounds.east) / 2,
      latitude: (bounds.south + bounds.north) / 2,
    };
    if (
      center.longitude < west || center.longitude > east ||
      center.latitude < south || center.latitude > north
    ) continue;

    const widthMeters = (bounds.east - bounds.west) * 111_319.49 *
      Math.cos(center.latitude * Math.PI / 180);
    const depthMeters = (bounds.north - bounds.south) * METERS_PER_LATITUDE_DEGREE;
    if (
      !Number.isFinite(widthMeters) || !Number.isFinite(depthMeters) ||
      widthMeters < 1 || depthMeters < 1 ||
      widthMeters > 80 || depthMeters > 80
    ) continue;

    candidates.push({
      feature,
      bounds,
      center,
      widthMeters,
      depthMeters,
      id: featureIdentity(feature),
    });
  }

  candidates.sort((a, b) => a.id.localeCompare(b.id));
  if (!candidates.length) {
    throw new Error("No bounded Polygon/MultiPolygon building footprint found inside the Dhaka pilot bounds.");
  }
  return candidates[0];
}

function wgs84ToEcef(longitude, latitude, height = 0) {
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (normal + height) * cosLat * Math.cos(lon),
    (normal + height) * cosLat * Math.sin(lon),
    (normal * (1 - WGS84_E2) + height) * sinLat,
  ];
}

function localEnuToEcefTransform(longitude, latitude) {
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const [x, y, z] = wgs84ToEcef(longitude, latitude);
  // glTF is Y-up. Build a right-handed local frame: X=east, Y=up, Z=south.
  // The matrix is column-major and its translation is the WGS84 ECEF anchor.
  return [
    -sinLon, cosLon, 0, 0,
    cosLat * cosLon, cosLat * sinLon, sinLat, 0,
    sinLat * cosLon, sinLat * sinLon, -cosLat, 0,
    x, y, z, 1,
  ];
}

function createGlb(widthMeters, depthMeters, heightMeters) {
  const x = widthMeters / 2;
  const y = heightMeters;
  const z = depthMeters / 2;
  const positions = [];
  const normals = [];
  const indices = [];

  function face(corners, normal) {
    const start = positions.length / 3;
    for (const p of corners) {
      positions.push(...p);
      normals.push(...normal);
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  // A deterministic box mesh in local glTF coordinates. This is a placement
  // fixture, not a photogrammetric or survey-grade building reconstruction.
  face([[-x, 0, z], [x, 0, z], [x, y, z], [-x, y, z]], [0, 0, 1]);
  face([[x, 0, -z], [-x, 0, -z], [-x, y, -z], [x, y, -z]], [0, 0, -1]);
  face([[x, 0, z], [x, 0, -z], [x, y, -z], [x, y, z]], [1, 0, 0]);
  face([[-x, 0, -z], [-x, 0, z], [-x, y, z], [-x, y, -z]], [-1, 0, 0]);
  face([[-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z]], [0, 1, 0]);
  face([[-x, 0, z], [-x, 0, -z], [x, 0, -z], [x, 0, z]], [0, -1, 0]);

  const positionBytes = Buffer.alloc(positions.length * 4);
  const normalBytes = Buffer.alloc(normals.length * 4);
  const indexBytes = Buffer.alloc(indices.length * 2);
  positions.forEach((v, i) => positionBytes.writeFloatLE(v, i * 4));
  normals.forEach((v, i) => normalBytes.writeFloatLE(v, i * 4));
  indices.forEach((v, i) => indexBytes.writeUInt16LE(v, i * 2));
  const binary = Buffer.concat([positionBytes, normalBytes, indexBytes]);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }

  const gltf = {
    asset: { version: "2.0", generator: "3d-geospatial-platform P2.1 Dhaka fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Dhaka placement fixture (synthetic box)", mesh: 0 }],
    meshes: [{
      name: "Footprint-bounds box",
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1 },
        indices: 2,
        material: 0,
      }],
    }],
    materials: [{
      name: "Neutral QA material",
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [0.42, 0.62, 0.78, 1],
        metallicFactor: 0,
        roughnessFactor: 0.9,
      },
    }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: normalBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length + normalBytes.length, byteLength: indexBytes.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: indices.length, type: "SCALAR", min: [0], max: [positions.length / 3 - 1] },
    ],
  };

  const jsonBytes = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPadding = (4 - jsonBytes.length % 4) % 4;
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
  const binaryPadding = (4 - binary.length % 4) % 4;
  const paddedBinary = Buffer.concat([binary, Buffer.alloc(binaryPadding)]);
  const headerLength = 12 + 8 + paddedJson.length + 8 + paddedBinary.length;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(headerLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(paddedBinary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBinary]);
}

function parseArgs(argv) {
  const args = { source: defaultSource, output: defaultOutput };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--source" && argv[i + 1]) args.source = path.resolve(argv[++i]);
    else if (argv[i] === "--output" && argv[i + 1]) args.output = path.resolve(argv[++i]);
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  return args;
}

function isWithin(directory, target) {
  const relative = path.relative(directory, target);
  // Only allow a child directory; never permit recursive deletion of the root itself.
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

export async function buildDhaka3DTilesFixture({ sourcePath = defaultSource, outputPath = defaultOutput } = {}) {
  const normalizedSource = path.resolve(sourcePath);
  const normalizedOutput = path.resolve(outputPath);
  const safeOutput =
    isWithin(path.join(projectRoot, "data", "overture"), normalizedOutput) ||
    isWithin(path.join(projectRoot, "public", "experimental"), normalizedOutput) ||
    isWithin(os.tmpdir(), normalizedOutput);
  if (!safeOutput) {
    throw new Error("Refusing to write the fixture outside data/overture or the OS temporary directory.");
  }

  const sourceText = await readFile(normalizedSource, "utf8");
  const source = JSON.parse(sourceText);
  if (!isRecord(source) || source.type !== "FeatureCollection" || !Array.isArray(source.features)) {
    throw new Error("The Dhaka pilot source must be a GeoJSON FeatureCollection.");
  }
  const selected = chooseDhakaBuilding(source);
  const sourceFeatureText = JSON.stringify(selected.feature);
  const sourceFeatureCollectionText = `${JSON.stringify({ type: "FeatureCollection", features: [selected.feature] }, null, 2)}\n`;
  const sourceFeatureSha256 = sha256(sourceFeatureText);
  const sourceSha256 = sha256(sourceText);
  const { west, south, east, north } = selected.bounds;
  const latitude = selected.center.latitude;
  const longitude = selected.center.longitude;
  const widthMeters = Math.max(1, selected.widthMeters);
  const depthMeters = Math.max(1, selected.depthMeters);
  const contentBuffer = createGlb(widthMeters, depthMeters, fixtureHeightMeters);
  const contentSha256 = sha256(contentBuffer);
  const halfLon = (widthMeters / 2) / (111_319.49 * Math.cos(latitude * Math.PI / 180));
  const halfLat = (depthMeters / 2) / METERS_PER_LATITUDE_DEGREE;
  const region = [
    (longitude - halfLon * 1.05) * Math.PI / 180,
    (latitude - halfLat * 1.05) * Math.PI / 180,
    (longitude + halfLon * 1.05) * Math.PI / 180,
    (latitude + halfLat * 1.05) * Math.PI / 180,
    0,
    fixtureHeightMeters,
  ];
  const transform = localEnuToEcefTransform(longitude, latitude);
  const assetExtras = {
    purpose: "geographic-placement-and-integrity-fixture",
    sourceDataset: sourceDescription,
    sourceFile: path.relative(projectRoot, normalizedSource).replaceAll(path.sep, "/"),
    sourceFeatureId: selected.id,
    sourceFeatureSha256,
    sourceSha256,
    sourceBoundsDegrees: { west, south, east, north },
    placementAnchor: { longitudeDegrees: longitude, latitudeDegrees: latitude, ellipsoidHeightMeters: 0 },
    gltfCoordinateConvention: "right-handed; X=east, Y=up, Z=south",
    attribution,
    coordinateSystems: { geographic: "EPSG:4979", globalCartesian: "EPSG:4978" },
    heightStatus: "synthetic-test-height",
    fixtureHeightMeters,
    disclaimer: "The GLB is a synthetic box matched to source footprint bounds; it is not a real building reconstruction or survey-accurate geometry.",
  };
  const tileset = {
    asset: { version: "1.1", tilesetVersion: "dhaka-pilot-placement-fixture-v1", extras: { ...assetExtras, contentSha256 } },
    geometricError: 0,
    root: {
      boundingVolume: { region },
      geometricError: 0,
      refine: "REPLACE",
      transform,
      content: { uri: "tiles/dhaka-pilot.glb" },
    },
  };
  const validation = validateTilesetManifest(tileset);
  if (!validation.valid) throw new Error(`Generated tileset manifest failed validation: ${validation.errors.join("; ")}`);

  await rm(normalizedOutput, { recursive: true, force: true });
  const tileDirectory = path.join(normalizedOutput, "tiles");
  await mkdir(tileDirectory, { recursive: true });
  await writeFile(path.join(tileDirectory, "dhaka-pilot.glb"), contentBuffer);
  await writeFile(path.join(normalizedOutput, "source-feature.geojson"), sourceFeatureCollectionText, "utf8");
  const tilesetText = `${JSON.stringify(tileset, null, 2)}\n`;
  await writeFile(path.join(normalizedOutput, "tileset.json"), tilesetText, "utf8");
  const tilesetSha256 = sha256(tilesetText);

  const buildManifest = {
    schemaVersion: 1,
    fixtureId: "dhaka-overture-placement-fixture-v1",
    source: {
      dataset: sourceDescription,
      relativePath: path.relative(projectRoot, normalizedSource).replaceAll(path.sep, "/"),
      sha256: sourceSha256,
      featureId: selected.id,
      featureSha256: sourceFeatureSha256,
      attribution,
    },
    placement: {
      crsGeographic: "EPSG:4979",
      crsGlobalCartesian: "EPSG:4978",
      longitudeDegrees: longitude,
      latitudeDegrees: latitude,
      ellipsoidHeightMeters: 0,
      transformConvention: "column-major; glTF local X=east, Y=up, Z=south; global WGS84 ECEF",
      transform,
      boundingRegionRadians: region,
    },
    fixtureGeometry: {
      kind: "rectangular-prism",
      widthMeters,
      depthMeters,
      heightMeters: fixtureHeightMeters,
      heightIsSynthetic: true,
      axisConvention: "right-handed glTF frame; X=east, Y=up, Z=south",
      sourceFootprintBoundsDegrees: selected.bounds,
    },
    files: {
      "tileset.json": { sha256: tilesetSha256, bytes: Buffer.byteLength(tilesetText) },
      "tiles/dhaka-pilot.glb": { sha256: contentSha256, bytes: contentBuffer.length },
      "source-feature.geojson": { sha256: sha256(sourceFeatureCollectionText), bytes: Buffer.byteLength(sourceFeatureCollectionText) },
    },
    validation: { manifestValid: true, tileCount: validation.tileCount, version: validation.version },
  };
  await writeFile(path.join(normalizedOutput, "build-manifest.json"), `${JSON.stringify(buildManifest, null, 2)}\n`, "utf8");
  return buildManifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await buildDhaka3DTilesFixture({ sourcePath: args.source, outputPath: args.output });
    process.stdout.write(`${JSON.stringify({
      output: args.output,
      fixtureId: result.fixtureId,
      sourceFeatureId: result.source.featureId,
      tilesetSha256: result.files["tileset.json"].sha256,
      contentSha256: result.files["tiles/dhaka-pilot.glb"].sha256,
      sourceFeaturePreviewSha256: result.files["source-feature.geojson"].sha256,
      sourceSha256: result.source.sha256,
      validation: result.validation,
    }, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
