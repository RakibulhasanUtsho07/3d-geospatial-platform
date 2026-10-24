#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const DEFAULT_SOURCE = path.join(projectRoot, "data/overture/dhaka-buildings-3d-pilot.geojson");
const DEFAULT_FIXTURE = path.join(projectRoot, "public/experimental/dhaka-3d-tiles-fixture");
const DEFAULT_OUTPUT = path.join(DEFAULT_FIXTURE, "alignment-review.json");
const WGS84_A = 6_378_137;
const WGS84_E2 = 6.6943799901413165e-3;
const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const METERS_PER_LATITUDE_DEGREE = 111_132;
const MAX_FOOTPRINT_RESIDUAL_METERS = 0.25;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getFeatureIdentity(feature) {
  if (feature.id !== undefined && feature.id !== null) return String(feature.id);
  const properties = isRecord(feature.properties) ? feature.properties : {};
  for (const key of ["id", "feature_id", "featureId", "building_id", "overture_id"]) {
    const value = properties[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return sha256(JSON.stringify(feature));
}

function getGeometryBounds(geometry) {
  if (!isRecord(geometry)) return null;
  const bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };

  function visit(value) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
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
      const childBounds = getGeometryBounds(child);
      if (!childBounds) continue;
      bounds.west = Math.min(bounds.west, childBounds.west);
      bounds.south = Math.min(bounds.south, childBounds.south);
      bounds.east = Math.max(bounds.east, childBounds.east);
      bounds.north = Math.max(bounds.north, childBounds.north);
    }
  }

  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

function findSourceFeature(source, expectedId) {
  if (!isRecord(source) || source.type !== "FeatureCollection" || !Array.isArray(source.features)) {
    throw new Error("The source must be a GeoJSON FeatureCollection.");
  }
  const matches = source.features.filter((feature) =>
    isRecord(feature) &&
    feature.type === "Feature" &&
    isRecord(feature.geometry) &&
    getFeatureIdentity(feature) === expectedId
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one source feature for ID ${expectedId}; found ${matches.length}.`);
  }
  const feature = matches[0];
  const bounds = getGeometryBounds(feature.geometry);
  if (!bounds) throw new Error("Selected source feature has no finite WGS84 footprint bounds.");
  return { feature, bounds };
}

function multiplyPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function wgs84ToEcef(longitudeDegrees, latitudeDegrees, heightMeters = 0) {
  const longitude = longitudeDegrees * DEGREES_TO_RADIANS;
  const latitude = latitudeDegrees * DEGREES_TO_RADIANS;
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
  let height = 0;

  for (let index = 0; index < 12; index += 1) {
    const sinLatitude = Math.sin(latitude);
    const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
    const cosLatitude = Math.cos(latitude);
    height = Math.abs(cosLatitude) > 1e-12
      ? p / cosLatitude - normal
      : z / sinLatitude - normal * (1 - WGS84_E2);
    const nextLatitude = Math.atan2(z, p * (1 - WGS84_E2 * normal / (normal + height)));
    if (Math.abs(nextLatitude - latitude) < 1e-14) {
      latitude = nextLatitude;
      break;
    }
    latitude = nextLatitude;
  }

  const sinLatitude = Math.sin(latitude);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
  const cosLatitude = Math.cos(latitude);
  height = Math.abs(cosLatitude) > 1e-12
    ? p / cosLatitude - normal
    : z / sinLatitude - normal * (1 - WGS84_E2);
  return {
    longitudeDegrees: longitude * RADIANS_TO_DEGREES,
    latitudeDegrees: latitude * RADIANS_TO_DEGREES,
    heightMeters: height,
  };
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

function footprintResidualMeters(actual, expected, latitudeReference) {
  const longitudeScale = 111_319.49 * Math.cos(latitudeReference * DEGREES_TO_RADIANS);
  const latitudeScale = METERS_PER_LATITUDE_DEGREE;
  const east = (actual.longitudeDegrees - expected.longitudeDegrees) * longitudeScale;
  const north = (actual.latitudeDegrees - expected.latitudeDegrees) * latitudeScale;
  return Math.hypot(east, north);
}

function pointTransformQuality(transform) {
  if (!Array.isArray(transform) || transform.length !== 16 || !transform.every(Number.isFinite)) {
    throw new Error("The root transform must contain 16 finite column-major values.");
  }

  const east = [transform[0], transform[1], transform[2]];
  const up = [transform[4], transform[5], transform[6]];
  const south = [transform[8], transform[9], transform[10]];
  const axes = { eastLength: vectorLength(east), upLength: vectorLength(up), southLength: vectorLength(south) };
  const orthogonality = { eastUpDot: dot(east, up), eastSouthDot: dot(east, south), upSouthDot: dot(up, south) };
  const crossEastUp = [
    east[1] * up[2] - east[2] * up[1],
    east[2] * up[0] - east[0] * up[2],
    east[0] * up[1] - east[1] * up[0],
  ];
  const handedness = dot(crossEastUp, south);

  const tolerance = 1e-9;
  if (
    Math.abs(axes.eastLength - 1) > tolerance ||
    Math.abs(axes.upLength - 1) > tolerance ||
    Math.abs(axes.southLength - 1) > tolerance ||
    Math.abs(orthogonality.eastUpDot) > tolerance ||
    Math.abs(orthogonality.eastSouthDot) > tolerance ||
    Math.abs(orthogonality.upSouthDot) > tolerance ||
    Math.abs(handedness - 1) > tolerance
  ) {
    throw new Error("The root transform axes must be orthonormal, right-handed, and aligned to glTF X-east/Y-up/Z-south.");
  }

  return { axes, orthogonality, handedness };
}

function cameraHeadingPitchToEcefTarget(cameraPosition, cameraEcef, targetEcef) {
  // Cesium heading/pitch are expressed in the camera position's local ENU frame.
  // Derive them from the ECEF target direction rather than reusing a nominal
  // local-map bearing, which can leave a camera looking just outside the tile
  // root's bounding volume after the ECEF transform.
  const longitude = cameraPosition.longitudeDegrees * Math.PI / 180;
  const latitude = cameraPosition.latitudeDegrees * Math.PI / 180;
  const dx = targetEcef[0] - cameraEcef[0];
  const dy = targetEcef[1] - cameraEcef[1];
  const dz = targetEcef[2] - cameraEcef[2];

  const east = -Math.sin(longitude) * dx + Math.cos(longitude) * dy;
  const north =
    -Math.sin(latitude) * Math.cos(longitude) * dx
    - Math.sin(latitude) * Math.sin(longitude) * dy
    + Math.cos(latitude) * dz;
  const up =
    Math.cos(latitude) * Math.cos(longitude) * dx
    + Math.cos(latitude) * Math.sin(longitude) * dy
    + Math.sin(latitude) * dz;

  const headingDegrees = (Math.atan2(east, north) * RADIANS_TO_DEGREES + 360) % 360;
  const pitchDegrees = Math.atan2(up, Math.hypot(east, north)) * RADIANS_TO_DEGREES;
  return { headingDegrees, pitchDegrees };
}

function makeCameraViews({ widthMeters, depthMeters, heightMeters, transform }) {
  const horizontalRangeMeters = Math.max(30, Math.min(120, Math.max(widthMeters, depthMeters, heightMeters) * 4));
  const targetLocal = [0, heightMeters / 2, 0];
  const targetEcef = multiplyPoint(transform, targetLocal);
  const target = ecefToWgs84(targetEcef);
  const cameraSpecs = [
    { id: "north", eastMeters: 0, northMeters: horizontalRangeMeters, upMeters: heightMeters / 2 + horizontalRangeMeters * 0.25, headingDegrees: 180 },
    { id: "east", eastMeters: horizontalRangeMeters, northMeters: 0, upMeters: heightMeters / 2 + horizontalRangeMeters * 0.25, headingDegrees: 270 },
    { id: "south", eastMeters: 0, northMeters: -horizontalRangeMeters, upMeters: heightMeters / 2 + horizontalRangeMeters * 0.25, headingDegrees: 0 },
    { id: "west", eastMeters: -horizontalRangeMeters, northMeters: 0, upMeters: heightMeters / 2 + horizontalRangeMeters * 0.25, headingDegrees: 90 },
    { id: "oblique", eastMeters: horizontalRangeMeters * 0.7, northMeters: horizontalRangeMeters * 0.7, upMeters: heightMeters / 2 + horizontalRangeMeters * 0.65, headingDegrees: 225 },
  ];

  return {
    schemaVersion: 1,
    target: {
      longitudeDegrees: target.longitudeDegrees,
      latitudeDegrees: target.latitudeDegrees,
      ellipsoidHeightMeters: target.heightMeters,
      localOffsetMeters: targetLocal,
    },
    horizontalRangeMeters,
    views: cameraSpecs.map((spec) => {
      const localGlb = [spec.eastMeters, spec.upMeters, -spec.northMeters];
      const cameraEcef = multiplyPoint(transform, localGlb);
      const position = ecefToWgs84(cameraEcef);
      const orientation = cameraHeadingPitchToEcefTarget(position, cameraEcef, targetEcef);
      const horizontalDistance = Math.hypot(spec.eastMeters, spec.northMeters);
      const verticalDistance = Math.abs(spec.upMeters - heightMeters / 2);
      return {
        id: spec.id,
        camera: {
          longitudeDegrees: position.longitudeDegrees,
          latitudeDegrees: position.latitudeDegrees,
          ellipsoidHeightMeters: position.heightMeters,
          headingDegrees: orientation.headingDegrees,
          pitchDegrees: orientation.pitchDegrees,
          rollDegrees: 0,
        },
        target: {
          longitudeDegrees: target.longitudeDegrees,
          latitudeDegrees: target.latitudeDegrees,
          ellipsoidHeightMeters: target.heightMeters,
        },
        rangeMeters: Math.hypot(horizontalDistance, verticalDistance),
      };
    }),
  };
}

function parseArgs(argv) {
  const args = { sourcePath: DEFAULT_SOURCE, fixtureDirectory: DEFAULT_FIXTURE, outputPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    if (key === "--source") args.sourcePath = path.resolve(value);
    else if (key === "--fixture-dir") args.fixtureDirectory = path.resolve(value);
    else if (key === "--output") args.outputPath = path.resolve(value);
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
  }
  if (!args.outputPath) args.outputPath = path.join(args.fixtureDirectory, "alignment-review.json");
  return args;
}

function within(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function reviewDhaka3DTilesAlignment({ sourcePath = DEFAULT_SOURCE, fixtureDirectory = DEFAULT_FIXTURE, outputPath = null } = {}) {
  const normalizedSource = path.resolve(sourcePath);
  const normalizedFixture = path.resolve(fixtureDirectory);
  const normalizedOutput = path.resolve(outputPath ?? path.join(normalizedFixture, "alignment-review.json"));
  if (!within(projectRoot, normalizedOutput) && !within(os.tmpdir(), normalizedOutput)) throw new Error("Refusing to write alignment evidence outside the repository or OS temporary directory.");
  if (!within(projectRoot, normalizedFixture) && !within(os.tmpdir(), normalizedFixture)) throw new Error("Refusing to read fixture data outside the repository or OS temporary directory.");
  if (!within(projectRoot, normalizedSource)) throw new Error("Refusing to read source data outside the repository.");

  const [sourceBytes, tilesetBytes, glbBytes, buildManifestBytes, sourcePreviewBytes] = await Promise.all([
    readFile(normalizedSource),
    readFile(path.join(normalizedFixture, "tileset.json")),
    readFile(path.join(normalizedFixture, "tiles", "dhaka-pilot.glb")),
    readFile(path.join(normalizedFixture, "build-manifest.json")),
    readFile(path.join(normalizedFixture, "source-feature.geojson")),
  ]);
  const sourceText = sourceBytes.toString("utf8");
  const tileset = readJson(tilesetBytes.toString("utf8"), "tileset.json");
  const buildManifest = readJson(buildManifestBytes.toString("utf8"), "build-manifest.json");
  const source = readJson(sourceText, "source GeoJSON");
  const sourcePreview = readJson(sourcePreviewBytes.toString("utf8"), "source-feature.geojson");
  const asset = tileset.asset;
  const root = tileset.root;
  if (!Number.isFinite(tileset.geometricError) || tileset.geometricError <= 0) {
    throw new Error("Tileset geometricError must be positive so Cesium traverses the single-leaf GLB fixture.");
  }
  if (!Number.isFinite(root?.geometricError) || root.geometricError <= 0) {
    throw new Error("Root tile geometricError must be positive so Cesium requests the single-leaf GLB content.");
  }
  if (root.geometricError !== tileset.geometricError) {
    throw new Error("Root and tileset geometricError must match for the single-leaf placement fixture.");
  }
  const extras = asset?.extras;
  if (!isRecord(asset) || asset.version !== "1.1" || !isRecord(root) || !isRecord(extras)) {
    throw new Error("The fixture is missing the OGC 3D Tiles 1.1 asset/root metadata.");
  }
  if (root.content?.uri !== "tiles/dhaka-pilot.glb") throw new Error("Unexpected fixture content URI.");
  if (sha256(sourceBytes) !== buildManifest.source?.sha256) throw new Error("Source dataset SHA-256 does not match build-manifest.json.");
  if (sha256(sourcePreviewBytes) !== buildManifest.files?.["source-feature.geojson"]?.sha256) throw new Error("Source GeoJSON browser preview SHA-256 does not match build-manifest.json.");
  if (
    !isRecord(sourcePreview) ||
    sourcePreview.type !== "FeatureCollection" ||
    !Array.isArray(sourcePreview.features) ||
    sourcePreview.features.length !== 1 ||
    !isRecord(sourcePreview.features[0]) ||
    getFeatureIdentity(sourcePreview.features[0]) !== buildManifest.source?.featureId
  ) {
    throw new Error("The browser GeoJSON preview must contain exactly the selected source feature.");
  }
  if (sha256(Buffer.from(JSON.stringify(sourcePreview.features[0]))) !== buildManifest.source?.featureSha256) {
    throw new Error("Browser GeoJSON preview feature hash does not match the selected source feature.");
  }
  if (sha256(glbBytes) !== buildManifest.files?.["tiles/dhaka-pilot.glb"]?.sha256) throw new Error("GLB SHA-256 does not match build-manifest.json.");
  if (sha256(tilesetBytes) !== buildManifest.files?.["tileset.json"]?.sha256) throw new Error("tileset.json SHA-256 does not match build-manifest.json.");
  if (sha256(glbBytes) !== extras.contentSha256) throw new Error("GLB SHA-256 does not match tileset asset extras.");

  const selected = findSourceFeature(source, buildManifest.source.featureId);
  const sourceFeatureBytes = Buffer.from(JSON.stringify(selected.feature));
  if (sha256(sourceFeatureBytes) !== buildManifest.source.featureSha256) throw new Error("Selected GeoJSON feature hash has changed.");
  const sourceBounds = selected.bounds;
  const claimedBounds = extras.sourceBoundsDegrees;
  if (!isRecord(claimedBounds)) throw new Error("Missing source footprint bounds in tileset extras.");
  for (const key of ["west", "south", "east", "north"]) {
    if (Math.abs(sourceBounds[key] - claimedBounds[key]) > 1e-10) throw new Error(`Source footprint bound ${key} changed since fixture generation.`);
  }

  const transform = root.transform;
  const transformQuality = pointTransformQuality(transform);
  const anchor = extras.placementAnchor;
  if (!isRecord(anchor) || !Number.isFinite(anchor.longitudeDegrees) || !Number.isFinite(anchor.latitudeDegrees)) {
    throw new Error("Missing WGS84 placement anchor in tileset asset extras.");
  }
  const anchorCheck = wgs84ToEcef(anchor.longitudeDegrees, anchor.latitudeDegrees, anchor.ellipsoidHeightMeters ?? 0);
  const translationErrorMeters = vectorLength(subtract(transform.slice(12, 15), anchorCheck));
  if (translationErrorMeters > 0.001) throw new Error(`ECEF transform translation differs from its anchor by ${translationErrorMeters.toFixed(6)} m.`);

  const glbTextLength = glbBytes.readUInt32LE(8);
  if (glbBytes.toString("ascii", 0, 4) !== "glTF" || glbBytes.readUInt32LE(4) !== 2 || glbTextLength !== glbBytes.length) {
    throw new Error("Referenced content is not a complete GLB 2.0 file.");
  }
  const jsonChunkLength = glbBytes.readUInt32LE(12);
  if (glbBytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error("GLB JSON chunk is missing.");
  const gltf = readJson(glbBytes.toString("utf8", 20, 20 + jsonChunkLength), "GLB JSON chunk");
  const positionAccessor = gltf.accessors?.[gltf.meshes?.[0]?.primitives?.[0]?.attributes?.POSITION ?? -1];
  if (!isRecord(positionAccessor) || !Array.isArray(positionAccessor.min) || !Array.isArray(positionAccessor.max)) {
    throw new Error("GLB POSITION accessor bounds are missing.");
  }
  const dimensions = {
    widthMeters: positionAccessor.max[0] - positionAccessor.min[0],
    heightMeters: positionAccessor.max[1] - positionAccessor.min[1],
    depthMeters: positionAccessor.max[2] - positionAccessor.min[2],
  };
  const expectedDimensions = buildManifest.fixtureGeometry;
  for (const [actualKey, expectedKey] of [
    ["widthMeters", "widthMeters"],
    ["heightMeters", "heightMeters"],
    ["depthMeters", "depthMeters"],
  ]) {
    if (Math.abs(dimensions[actualKey] - expectedDimensions[expectedKey]) > 1e-5) {
      throw new Error(`GLB ${actualKey} differs from build manifest.`);
    }
  }

  const radians = (degrees) => degrees * DEGREES_TO_RADIANS;
  const [west, south, east, north, minimumHeight, maximumHeight] = root.boundingVolume?.region ?? [];
  if (![west, south, east, north, minimumHeight, maximumHeight].every(Number.isFinite)) {
    throw new Error("Root region bounding volume must contain six finite radians/metres values.");
  }
  const envelopeCorners = [
    { id: "south-west", longitudeDegrees: sourceBounds.west, latitudeDegrees: sourceBounds.south },
    { id: "south-east", longitudeDegrees: sourceBounds.east, latitudeDegrees: sourceBounds.south },
    { id: "north-west", longitudeDegrees: sourceBounds.west, latitudeDegrees: sourceBounds.north },
    { id: "north-east", longitudeDegrees: sourceBounds.east, latitudeDegrees: sourceBounds.north },
  ];
  const fixtureGroundCorners = [
    { id: "south-west", local: [-dimensions.widthMeters / 2, 0, dimensions.depthMeters / 2] },
    { id: "south-east", local: [dimensions.widthMeters / 2, 0, dimensions.depthMeters / 2] },
    { id: "north-west", local: [-dimensions.widthMeters / 2, 0, -dimensions.depthMeters / 2] },
    { id: "north-east", local: [dimensions.widthMeters / 2, 0, -dimensions.depthMeters / 2] },
  ];

  const cornerResiduals = fixtureGroundCorners.map((corner, index) => {
    const ecef = multiplyPoint(transform, corner.local);
    const geodetic = ecefToWgs84(ecef);
    const expected = envelopeCorners[index];
    const residualMeters = footprintResidualMeters(geodetic, expected, anchor.latitudeDegrees);
    const insideRegion = geodetic.longitudeDegrees * DEGREES_TO_RADIANS >= west - 1e-12 &&
      geodetic.longitudeDegrees * DEGREES_TO_RADIANS <= east + 1e-12 &&
      geodetic.latitudeDegrees * DEGREES_TO_RADIANS >= south - 1e-12 &&
      geodetic.latitudeDegrees * DEGREES_TO_RADIANS <= north + 1e-12 &&
      geodetic.heightMeters >= minimumHeight - 0.25 &&
      geodetic.heightMeters <= maximumHeight + 0.25;
    return { id: corner.id, expected, actual: geodetic, residualMeters, insideRegion };
  });
  const maxCornerResidualMeters = Math.max(...cornerResiduals.map((entry) => entry.residualMeters));
  if (cornerResiduals.some((entry) => !entry.insideRegion)) throw new Error("A transformed GLB ground corner lies outside the 3D Tiles root region.");
  if (maxCornerResidualMeters > MAX_FOOTPRINT_RESIDUAL_METERS) {
    throw new Error(`GLB footprint envelope does not align with source WGS84 bounds; residual=${maxCornerResidualMeters.toFixed(4)} m.`);
  }

  const cameraViews = makeCameraViews({
    widthMeters: dimensions.widthMeters,
    depthMeters: dimensions.depthMeters,
    heightMeters: dimensions.heightMeters,
    transform,
  });
  const tilesetHash = sha256(tilesetBytes);
  const glbHash = sha256(glbBytes);
  const sourceHash = sha256(sourceBytes);
  const evidence = {
    schemaVersion: 1,
    evidenceType: "deterministic-3d-tiles-placement-review",
    fixtureId: buildManifest.fixtureId,
    source: {
      path: path.relative(projectRoot, normalizedSource).replaceAll(path.sep, "/"),
      sha256: sourceHash,
      featureId: buildManifest.source.featureId,
      featureSha256: buildManifest.source.featureSha256,
      previewPath: "source-feature.geojson",
      previewSha256: sha256(sourcePreviewBytes),
      boundsDegrees: sourceBounds,
    },
    model: {
      tilesetPath: "tileset.json",
      tilesetSha256: tilesetHash,
      glbPath: root.content.uri,
      glbSha256: glbHash,
      sourceGeometryKind: selected.feature.geometry.type,
      syntheticFixtureGeometry: true,
      dimensionsMeters: dimensions,
      disclaimer: "This validates transformed footprint-envelope placement, not facade accuracy, footprint polygon similarity, true building height, or photogrammetric fidelity.",
    },
    transform: {
      convention: extras.gltfCoordinateConvention,
      matrixColumnMajor: transform,
      anchor,
      translationErrorMeters,
      axisQuality: transformQuality,
    },
    footprintAlignment: {
      status: "pass",
      comparison: "WGS84 source bounding-box corners vs GLB ground-box corners transformed through tileset.root.transform",
      maximumResidualMeters: maxCornerResidualMeters,
      toleranceMeters: MAX_FOOTPRINT_RESIDUAL_METERS,
      corners: cornerResiduals,
      caveat: "A rectangular GLB footprint envelope is compared to the source geometry's bounding rectangle; the original Polygon/MultiPolygon outline is not reconstructed.",
    },
    regionValidation: {
      status: "pass",
      regionRadians: [west, south, east, north, minimumHeight, maximumHeight],
      allTransformedGroundCornersInsideRegion: true,
    },
    cameraReview: {
      status: "presets-ready",
      captureStatus: "not-captured-by-this-command",
      instructions: "Use the fixed positions and targets for north/east/south/west/oblique browser captures. Store each PNG with source/model hashes and the browser/Cesium version.",
      ...cameraViews,
    },
    measurement: {
      measuredAt: "reproducible-build-time-not-wall-clock",
      tool: "scripts/review-dhaka-3d-tiles-alignment.mjs",
      algorithmVersion: "p2.3-envelope-transform-v1",
    },
  };

  await mkdir(path.dirname(normalizedOutput), { recursive: true });
  await writeFile(normalizedOutput, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await reviewDhaka3DTilesAlignment(args);
    process.stdout.write(`${JSON.stringify({
      output: args.outputPath ?? path.join(args.fixtureDirectory, "alignment-review.json"),
      status: result.footprintAlignment.status,
      maximumResidualMeters: result.footprintAlignment.maximumResidualMeters,
      toleranceMeters: result.footprintAlignment.toleranceMeters,
      cameraViews: result.cameraReview.views.map((view) => view.id),
      sourceSha256: result.source.sha256,
      tilesetSha256: result.model.tilesetSha256,
      glbSha256: result.model.glbSha256,
    }, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
