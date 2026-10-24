import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { validateTilesetManifest } from "../src/core/geospatial/tileset-manifest-validation.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "scripts/build-dhaka-3d-tiles-fixture.mjs");
const sourcePath = path.join(projectRoot, "data/overture/dhaka-buildings-3d-pilot.geojson");
let fixtureDir;
let secondFixtureDir;
let tileset;
let build;
let glb;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function wgs84ToEcef(longitude, latitude, height = 0) {
  const a = 6_378_137;
  const eccentricitySquared = 6.6943799901413165e-3;
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const normal = a / Math.sqrt(1 - eccentricitySquared * sinLat * sinLat);
  return [
    (normal + height) * cosLat * Math.cos(lon),
    (normal + height) * cosLat * Math.sin(lon),
    (normal * (1 - eccentricitySquared) + height) * sinLat,
  ];
}

function readGlbJson(bytes) {
  assert.equal(bytes.toString("ascii", 0, 4), "glTF");
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const document = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
  const binHeaderOffset = 20 + jsonLength;
  const binLength = bytes.readUInt32LE(binHeaderOffset);
  assert.equal(bytes.readUInt32LE(binHeaderOffset + 4), 0x004e4942);
  assert.equal(binHeaderOffset + 8 + binLength, bytes.length);
  assert.equal(document.buffers[0].byteLength, binLength);
  return { document, binOffset: binHeaderOffset + 8, binLength };
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dhaka-3d-tiles-fixture-"));
  secondFixtureDir = await mkdtemp(path.join(os.tmpdir(), "dhaka-3d-tiles-fixture-repeat-"));
  execFileSync(process.execPath, [scriptPath, "--source", sourcePath, "--output", fixtureDir], {
    cwd: projectRoot,
    stdio: "pipe",
    timeout: 30_000,
  });
  tileset = JSON.parse(await readFile(path.join(fixtureDir, "tileset.json"), "utf8"));
  build = JSON.parse(await readFile(path.join(fixtureDir, "build-manifest.json"), "utf8"));
  glb = await readFile(path.join(fixtureDir, "tiles", "dhaka-pilot.glb"));
});

after(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  if (secondFixtureDir) await rm(secondFixtureDir, { recursive: true, force: true });
});

test("generates a valid OGC 3D Tiles 1.1 manifest with a resolvable relative GLB", async () => {
  const result = validateTilesetManifest(tileset);
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.equal(result.version, "1.1");
  assert.equal(result.tileCount, 1);
  assert.equal(tileset.asset.tilesetVersion, "dhaka-pilot-placement-fixture-v1");
  assert.equal(tileset.root.content.uri, "tiles/dhaka-pilot.glb");
  assert.ok(await stat(path.resolve(fixtureDir, tileset.root.content.uri)));
});

test("records Overture attribution, explicit synthetic-geometry limits and stable source identity", async () => {
  const extras = tileset.asset.extras;
  assert.equal(extras.sourceDataset, "Overture Maps Buildings theme — Dhaka 3D pilot extract");
  assert.equal(extras.attribution, "© OpenStreetMap contributors, Overture Maps Foundation");
  assert.equal(extras.purpose, "geographic-placement-and-integrity-fixture");
  assert.ok(extras.sourceFeatureId);
  assert.match(extras.sourceFeatureSha256, /^[a-f0-9]{64}$/);
  assert.match(extras.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(extras.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(extras.coordinateSystems.geographic, "EPSG:4979");
  assert.equal(extras.coordinateSystems.globalCartesian, "EPSG:4978");
  assert.equal(extras.heightStatus, "synthetic-test-height");
  assert.equal(extras.fixtureHeightMeters, 8);
  assert.match(extras.disclaimer, /not a real building reconstruction or survey-accurate geometry/i);

  const source = await readFile(sourcePath);
  assert.equal(sha256(source), build.source.sha256);
  assert.equal(build.source.featureId, extras.sourceFeatureId);
  assert.equal(build.source.featureSha256, extras.sourceFeatureSha256);
});

test("maps the manifest transform to independently calculated WGS84 ECEF", () => {
  const placement = build.placement;
  const transform = tileset.root.transform;
  assert.equal(placement.crsGeographic, "EPSG:4979");
  assert.equal(placement.crsGlobalCartesian, "EPSG:4978");
  assert.equal(transform.length, 16);
  assert.ok(transform.every(Number.isFinite));

  const expected = wgs84ToEcef(placement.longitudeDegrees, placement.latitudeDegrees, 0);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(transform[12 + axis] - expected[axis]) < 0.001, `ECEF translation axis ${axis}`);
  }

  const [west, south, east, north, minimumHeight, maximumHeight] = tileset.root.boundingVolume.region;
  const sourceBounds = build.fixtureGeometry.sourceFootprintBoundsDegrees;
  assert.ok(west <= sourceBounds.west * Math.PI / 180);
  assert.ok(east >= sourceBounds.east * Math.PI / 180);
  assert.ok(south <= sourceBounds.south * Math.PI / 180);
  assert.ok(north >= sourceBounds.north * Math.PI / 180);
  assert.equal(minimumHeight, 0);
  assert.equal(maximumHeight, build.fixtureGeometry.heightMeters);
  assert.equal(build.fixtureGeometry.heightIsSynthetic, true);
});

test("GLB binary layout, mesh accessors and all recorded SHA-256 hashes verify", async () => {
  const parsed = readGlbJson(glb);
  assert.equal(parsed.document.asset.version, "2.0");
  assert.equal(parsed.document.meshes.length, 1);
  assert.equal(parsed.document.meshes[0].primitives[0].attributes.POSITION, 0);
  assert.equal(parsed.document.meshes[0].primitives[0].attributes.NORMAL, 1);
  assert.equal(parsed.document.meshes[0].primitives[0].indices, 2);
  assert.equal(parsed.document.accessors[0].count, 24);
  assert.equal(parsed.document.accessors[2].count, 36);
  assert.equal(sha256(glb), build.files["tiles/dhaka-pilot.glb"].sha256);
  assert.equal(sha256(glb), tileset.asset.extras.contentSha256);
  assert.equal(glb.length, build.files["tiles/dhaka-pilot.glb"].bytes);

  const tilesetBytes = await readFile(path.join(fixtureDir, "tileset.json"));
  assert.equal(sha256(tilesetBytes), build.files["tileset.json"].sha256);
  assert.equal(tilesetBytes.length, build.files["tileset.json"].bytes);
});

test("rebuilds identical tileset, GLB and build-manifest hashes from the same source", async () => {
  execFileSync(process.execPath, [scriptPath, "--source", sourcePath, "--output", secondFixtureDir], {
    cwd: projectRoot,
    stdio: "pipe",
    timeout: 30_000,
  });
  for (const relativePath of ["tileset.json", "tiles/dhaka-pilot.glb", "build-manifest.json"]) {
    const [first, second] = await Promise.all([
      readFile(path.join(fixtureDir, relativePath)),
      readFile(path.join(secondFixtureDir, relativePath)),
    ]);
    assert.equal(sha256(first), sha256(second), `${relativePath} should be deterministic`);
  }
});
