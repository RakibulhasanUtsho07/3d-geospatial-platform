import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeColmapTextModelFiles,
  assessColmapViewCoverage,
  parseColmapImagePoseLine,
} from "../src/core/building-generation/colmap-view-coverage.mjs";

function imageRow(id, quaternion, translation, name) {
  return [id, ...quaternion, ...translation, 1, name].join(" ");
}

const scenePoints = [
  "# 3D point list with one line of data per point:",
  "# POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)",
  "1 0 0 0 255 255 255 0",
  "2 10 0 0 255 255 255 0",
  "3 0 10 0 255 255 255 0",
  "4 0 0 10 255 255 255 0",
].join("\n");

test("parses COLMAP world-to-camera pose rows and ignores 2D observation rows", () => {
  const pose = parseColmapImagePoseLine(imageRow(7, [1, 0, 0, 0], [2, 3, 4], "view-0007.jpg"));
  assert.equal(pose.imageId, 7);
  assert.equal(pose.name, "view-0007.jpg");
  assert.deepEqual(pose.cameraCenter, [-2, -3, -4]);
  assert.deepEqual(pose.viewingDirection, [0, 0, 1]);
  assert.equal(parseColmapImagePoseLine("0.5 0.5 1 1 2 3"), null);
  assert.equal(parseColmapImagePoseLine("1 1 0 0 0 0 0 0 1 0 2 3"), null);
});

test("flags camera poses concentrated in position and direction", () => {
  const imagesText = [
    "# Image list with two lines of data per image:",
    imageRow(1, [1, 0, 0, 0], [0, 0, 0], "front-a.jpg"),
    "0 0 -1",
    imageRow(2, [1, 0, 0, 0], [-0.1, 0, 0], "front-b.jpg"),
    "0 0 -1",
    imageRow(3, [1, 0, 0, 0], [0, -0.1, 0], "front-c.jpg"),
    "0 0 -1",
  ].join("\n");
  const result = assessColmapViewCoverage({ imagesText, points3DText: scenePoints });

  assert.equal(result.status, "review-recommended");
  assert.equal(result.registeredCameraPoseCount, 3);
  assert.ok(result.warnings.includes("camera-positions-have-low-spread-relative-to-scene"));
  assert.ok(result.warnings.includes("camera-viewing-directions-are-nearly-identical"));
  assert.ok(result.cameraPositionSpreadRatio < 0.04);
  assert.equal(result.maximumViewingDirectionAngleDegrees, 0);
});

test("accepts distinct camera positions and viewing directions as diagnostic coverage only", () => {
  const imagesText = [
    imageRow(1, [1, 0, 0, 0], [0, 0, 0], "front.jpg"),
    imageRow(2, [0.9238795, 0, 0.3826834, 0], [5, 0, 0], "side.jpg"),
    imageRow(3, [0.7071068, 0, 0.7071068, 0], [0, 5, 0], "rear.jpg"),
  ].join("\n");
  const result = assessColmapViewCoverage({ imagesText, points3DText: scenePoints });

  assert.equal(result.status, "diagnostics-passed");
  assert.deepEqual(result.warnings, []);
  assert.ok(result.cameraPositionSpreadRatio >= 0.04);
  assert.ok(result.maximumViewingDirectionAngleDegrees >= 12);
});

test("reports missing poses or scene bounds without claiming a pass", () => {
  const empty = assessColmapViewCoverage({ imagesText: "# empty", points3DText: "# empty" });
  assert.equal(empty.status, "unavailable");
  assert.ok(empty.warnings.includes("fewer-than-three-registered-camera-poses"));
  assert.ok(empty.warnings.includes("sparse-point-bounds-unavailable"));
  const noPoints = assessColmapViewCoverage({
    imagesText: [imageRow(1, [1, 0, 0, 0], [0, 0, 0], "a.jpg"), imageRow(2, [1, 0, 0, 0], [4, 0, 0], "b.jpg"), imageRow(3, [1, 0, 0, 0], [0, 4, 0], "c.jpg")].join("\n"),
    points3DText: "# no registered 3D points",
  });
  assert.ok(noPoints.warnings.includes("sparse-point-bounds-unavailable"));
  assert.equal(noPoints.cameraPositionSpreadRatio, null);
});

test("validates thresholds and streams a text model from files", async (t) => {
  assert.throws(() => assessColmapViewCoverage({ imagesText: "", points3DText: "", thresholds: { minimumViewingDirectionSpreadDegrees: 181 } }), /between 0 and 180/);
  const root = await mkdtemp(path.join(os.tmpdir(), "colmap-view-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagesPath = path.join(root, "images.txt");
  const pointsPath = path.join(root, "points3D.txt");
  await writeFile(imagesPath, [
    imageRow(1, [1, 0, 0, 0], [0, 0, 0], "front.jpg"),
    imageRow(2, [0.9238795, 0, 0.3826834, 0], [5, 0, 0], "side.jpg"),
    imageRow(3, [0.7071068, 0, 0.7071068, 0], [0, 5, 0], "rear.jpg"),
  ].join("\n"));
  await writeFile(pointsPath, scenePoints);
  const report = await analyzeColmapTextModelFiles({ imagesPath, points3DPath });
  assert.equal(report.registeredCameraPoseCount, 3);
  assert.equal(report.sparsePointCount, 4);
  assert.equal(report.engine, "colmap-view-coverage-v1");
  assert.match(report.caveat, /heuristic/);
});
