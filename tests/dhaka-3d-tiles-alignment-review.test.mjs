import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectRoot, "data/overture/dhaka-buildings-3d-pilot.geojson");
const buildScript = path.join(projectRoot, "scripts/build-dhaka-3d-tiles-fixture.mjs");
const reviewScript = path.join(projectRoot, "scripts/review-dhaka-3d-tiles-alignment.mjs");
let fixtureDirectory;
let evidencePath;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runReview(outputPath = evidencePath) {
  execFileSync(process.execPath, [
    reviewScript,
    "--source", sourcePath,
    "--fixture-dir", fixtureDirectory,
    "--output", outputPath,
  ], {
    cwd: projectRoot,
    stdio: "pipe",
    timeout: 30_000,
  });
}

before(async () => {
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "dhaka-alignment-fixture-"));
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), "dhaka-alignment-evidence-"));
  evidencePath = path.join(evidenceDirectory, "alignment-review.json");
  execFileSync(process.execPath, [buildScript, "--source", sourcePath, "--output", fixtureDirectory], {
    cwd: projectRoot,
    stdio: "pipe",
    timeout: 30_000,
  });
  runReview();
});

after(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
  if (evidencePath) await rm(path.dirname(evidencePath), { recursive: true, force: true });
});

test("checks transformed GLB ground corners against source WGS84 footprint envelope", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.evidenceType, "deterministic-3d-tiles-placement-review");
  assert.equal(evidence.footprintAlignment.status, "pass");
  assert.equal(evidence.regionValidation.status, "pass");
  assert.equal(evidence.regionValidation.allTransformedGroundCornersInsideRegion, true);
  assert.equal(evidence.footprintAlignment.corners.length, 4);
  assert.ok(evidence.footprintAlignment.maximumResidualMeters <= evidence.footprintAlignment.toleranceMeters);
  for (const corner of evidence.footprintAlignment.corners) {
    assert.equal(corner.insideRegion, true, corner.id);
    assert.ok(corner.residualMeters <= 0.25, `${corner.id}: ${corner.residualMeters}m`);
  }
  assert.equal(evidence.model.syntheticFixtureGeometry, true);
  assert.match(evidence.model.disclaimer, /not facade accuracy/i);
});

test("requires a proper right-handed glTF X-east, Y-up, Z-south transform", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.transform.convention, "right-handed; X=east, Y=up, Z=south");
  assert.ok(Math.abs(evidence.transform.axisQuality.axes.eastLength - 1) < 1e-9);
  assert.ok(Math.abs(evidence.transform.axisQuality.axes.upLength - 1) < 1e-9);
  assert.ok(Math.abs(evidence.transform.axisQuality.axes.southLength - 1) < 1e-9);
  assert.ok(Math.abs(evidence.transform.axisQuality.handedness - 1) < 1e-9);
  assert.ok(Math.abs(evidence.transform.translationErrorMeters) <= 0.001);
});

test("creates five fixed camera presets that share the exact same WGS84 target", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const views = evidence.cameraReview.views;
  assert.deepEqual(views.map((view) => view.id), ["north", "east", "south", "west", "oblique"]);
  const target = evidence.cameraReview.target;
  for (const view of views) {
    assert.deepEqual(view.target, {
      longitudeDegrees: target.longitudeDegrees,
      latitudeDegrees: target.latitudeDegrees,
      ellipsoidHeightMeters: target.ellipsoidHeightMeters,
    });
    assert.ok(Number.isFinite(view.camera.headingDegrees));
    assert.ok(view.camera.pitchDegrees < 0);
    assert.ok(view.rangeMeters > 0);
  }
  assert.equal(evidence.cameraReview.captureStatus, "not-captured-by-this-command");
});

test("alignment evidence binds the exact source, feature, tileset and GLB hashes", async () => {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const [sourceBytes, tilesetBytes, glbBytes] = await Promise.all([
    readFile(sourcePath),
    readFile(path.join(fixtureDirectory, "tileset.json")),
    readFile(path.join(fixtureDirectory, "tiles", "dhaka-pilot.glb")),
  ]);
  assert.equal(evidence.source.sha256, sha256(sourceBytes));
  assert.equal(evidence.model.tilesetSha256, sha256(tilesetBytes));
  assert.equal(evidence.model.glbSha256, sha256(glbBytes));
  assert.match(evidence.source.featureSha256, /^[a-f0-9]{64}$/);
});

test("fixed-view review metadata is byte-for-byte reproducible for the same fixture", async () => {
  const secondEvidenceDirectory = await mkdtemp(path.join(os.tmpdir(), "dhaka-alignment-repeat-"));
  const secondOutputPath = path.join(secondEvidenceDirectory, "alignment-review.json");
  try {
    runReview(secondOutputPath);
    const [first, second] = await Promise.all([
      readFile(evidencePath),
      readFile(secondOutputPath),
    ]);
    assert.equal(sha256(first), sha256(second));
  } finally {
    await rm(secondEvidenceDirectory, { recursive: true, force: true });
  }
});

test("rejects a left-handed matrix that would rotate the GLB footprint out of its intended axes", async () => {
  const tilesetPath = path.join(fixtureDirectory, "tileset.json");
  const buildManifestPath = path.join(fixtureDirectory, "build-manifest.json");
  const originalTilesetBytes = await readFile(tilesetPath);
  const originalBuildBytes = await readFile(buildManifestPath);
  try {
    const tileset = JSON.parse(originalTilesetBytes.toString("utf8"));
    const buildManifest = JSON.parse(originalBuildBytes.toString("utf8"));
    const matrix = tileset.root.transform;
    // Reflect one complete basis axis. Its length and orthogonality remain valid,
    // but the handedness becomes -1; translation is unchanged.
    matrix[4] *= -1;
    matrix[5] *= -1;
    matrix[6] *= -1;
    const mutatedTilesetBytes = Buffer.from(`${JSON.stringify(tileset, null, 2)}\n`);
    buildManifest.files["tileset.json"].sha256 = sha256(mutatedTilesetBytes);
    buildManifest.files["tileset.json"].bytes = mutatedTilesetBytes.length;
    await writeFile(tilesetPath, mutatedTilesetBytes);
    await writeFile(buildManifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`);

    assert.throws(
      () => execFileSync(process.execPath, [
        reviewScript,
        "--source", sourcePath,
        "--fixture-dir", fixtureDirectory,
        "--output", evidencePath,
      ], { cwd: projectRoot, stdio: "pipe", timeout: 30_000 }),
      (error) => /right-handed|orthonormal|footprint envelope|outside the 3D Tiles root region/i.test(
        String(error.stderr ?? error.message),
      ),
    );
  } finally {
    await writeFile(tilesetPath, originalTilesetBytes);
    await writeFile(buildManifestPath, originalBuildBytes);
  }
});
