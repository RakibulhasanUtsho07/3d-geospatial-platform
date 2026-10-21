import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const DEFAULT_THRESHOLDS = Object.freeze({
  minimumCameraPositionSpreadRatio: 0.04,
  minimumViewingDirectionSpreadDegrees: 12,
});

const CAVEAT = "Camera coverage metrics are heuristic and depend on COLMAP's local coordinate frame. They can highlight concentrated viewpoints, but cannot prove facade completeness, correct camera calibration, architectural accuracy or map readiness.";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNumber(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Parse a COLMAP images.txt pose row; the following 2D-observation row is ignored. */
export function parseColmapImagePoseLine(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const fields = trimmed.split(/\s+/);
  if (fields.length < 10 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[8])) return null;
  const name = fields[9];
  // A pose row ends in an image filename/name; the adjacent 2D-observation row is numeric.
  if (!name || Number.isFinite(Number(name))) return null;

  const numbers = fields.slice(1, 8).map(parseNumber);
  if (numbers.some((number) => number === null)) return null;
  const [qw, qx, qy, qz, tx, ty, tz] = numbers;
  const quaternionLength = Math.hypot(qw, qx, qy, qz);
  if (quaternionLength < 1e-12) return null;
  const w = qw / quaternionLength, x = qx / quaternionLength, y = qy / quaternionLength, z = qz / quaternionLength;

  // COLMAP stores a world-to-camera quaternion and translation.
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - z * w);
  const r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w);
  const r21 = 2 * (y * z + x * w);
  const r22 = 1 - 2 * (x * x + y * y);

  const center = [
    -(r00 * tx + r10 * ty + r20 * tz),
    -(r01 * tx + r11 * ty + r21 * tz),
    -(r02 * tx + r12 * ty + r22 * tz),
  ];
  const direction = [r20, r21, r22];
  const directionLength = Math.hypot(...direction);
  if (center.some((value) => !finite(value)) || directionLength < 1e-12) return null;

  return {
    imageId: Number(fields[0]),
    cameraId: Number(fields[8]),
    name,
    cameraCenter: center.map((value) => Number(value.toFixed(8))),
    viewingDirection: direction.map((value) => Number((value / directionLength).toFixed(8))),
  };
}

function parsePoint3DLine(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const fields = trimmed.split(/\s+/);
  if (fields.length < 4 || !/^\d+$/.test(fields[0])) return null;
  const xyz = fields.slice(1, 4).map(parseNumber);
  if (xyz.some((value) => value === null)) return null;
  return xyz;
}

function validateThresholds(thresholds = {}) {
  const result = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const spread = result.minimumCameraPositionSpreadRatio;
  const direction = result.minimumViewingDirectionSpreadDegrees;
  if (!finite(spread) || spread < 0 || spread > 1) {
    throw new RangeError("minimumCameraPositionSpreadRatio must be between 0 and 1");
  }
  if (!finite(direction) || direction < 0 || direction > 180) {
    throw new RangeError("minimumViewingDirectionSpreadDegrees must be between 0 and 180");
  }
  return result;
}

function calculatePointStats(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const point of points) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
    count++;
  }
  return { count, min, max };
}

function diagonal(min, max) {
  if (!min.every(finite) || !max.every(finite)) return null;
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function angleDegrees(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

function analyzeRecords(poses, pointStats, thresholds) {
  const settings = validateThresholds(thresholds);
  const warnings = [];
  if (poses.length < 3) warnings.push("fewer-than-three-registered-camera-poses");
  if (!pointStats || pointStats.count < 3) warnings.push("sparse-point-bounds-unavailable");
  const sceneBoundsDiagonal = pointStats && pointStats.count ? diagonal(pointStats.min, pointStats.max) : null;
  if (sceneBoundsDiagonal !== null && sceneBoundsDiagonal <= 1e-9) warnings.push("sparse-scene-bounds-degenerate");

  const centers = poses.map((pose) => pose.cameraCenter);
  const cameraPositionBoundsDiagonal = centers.length ? diagonal(
    [0, 1, 2].map((axis) => Math.min(...centers.map((center) => center[axis]))),
    [0, 1, 2].map((axis) => Math.max(...centers.map((center) => center[axis]))),
  ) : null;
  const cameraPositionSpreadRatio = sceneBoundsDiagonal && sceneBoundsDiagonal > 1e-9
    && cameraPositionBoundsDiagonal !== null
    ? cameraPositionBoundsDiagonal / sceneBoundsDiagonal
    : null;

  const baselines = [], viewingAngles = [];
  for (let left = 0; left < poses.length; left++) {
    for (let right = left + 1; right < poses.length; right++) {
      baselines.push(distance(poses[left].cameraCenter, poses[right].cameraCenter));
      viewingAngles.push(angleDegrees(poses[left].viewingDirection, poses[right].viewingDirection));
    }
  }
  baselines.sort((a, b) => a - b);
  viewingAngles.sort((a, b) => a - b);
  const medianPairwiseBaseline = baselines.length
    ? (baselines.length % 2
      ? baselines[Math.floor(baselines.length / 2)]
      : (baselines[baselines.length / 2 - 1] + baselines[baselines.length / 2]) / 2)
    : null;
  const maximumViewingDirectionAngleDegrees = viewingAngles.length ? viewingAngles[viewingAngles.length - 1] : null;
  const medianViewingDirectionAngleDegrees = viewingAngles.length
    ? (viewingAngles.length % 2
      ? viewingAngles[Math.floor(viewingAngles.length / 2)]
      : (viewingAngles[viewingAngles.length / 2 - 1] + viewingAngles[viewingAngles.length / 2]) / 2)
    : null;

  if (cameraPositionSpreadRatio !== null && cameraPositionSpreadRatio < settings.minimumCameraPositionSpreadRatio) {
    warnings.push("camera-positions-have-low-spread-relative-to-scene");
  }
  if (maximumViewingDirectionAngleDegrees !== null
      && poses.length >= 3
      && maximumViewingDirectionAngleDegrees < settings.minimumViewingDirectionSpreadDegrees) {
    warnings.push("camera-viewing-directions-are-nearly-identical");
  }

  const status = poses.length === 0
    ? "unavailable"
    : warnings.length ? "review-recommended" : "diagnostics-passed";
  return {
    schemaVersion: "1.0.0",
    engine: "colmap-view-coverage-v1",
    status,
    registeredCameraPoseCount: poses.length,
    sparsePointCount: pointStats?.count ?? 0,
    sceneBoundsDiagonal: sceneBoundsDiagonal === null ? null : Number(sceneBoundsDiagonal.toFixed(6)),
    cameraPositionBoundsDiagonal: cameraPositionBoundsDiagonal === null ? null : Number(cameraPositionBoundsDiagonal.toFixed(6)),
    cameraPositionSpreadRatio: cameraPositionSpreadRatio === null ? null : Number(cameraPositionSpreadRatio.toFixed(6)),
    medianPairwiseBaseline: medianPairwiseBaseline === null ? null : Number(medianPairwiseBaseline.toFixed(6)),
    maximumViewingDirectionAngleDegrees: maximumViewingDirectionAngleDegrees === null ? null : Number(maximumViewingDirectionAngleDegrees.toFixed(3)),
    medianViewingDirectionAngleDegrees: medianViewingDirectionAngleDegrees === null ? null : Number(medianViewingDirectionAngleDegrees.toFixed(3)),
    thresholds: settings,
    cameras: poses.map((pose) => ({
      imageId: pose.imageId,
      cameraId: pose.cameraId,
      name: pose.name,
      cameraCenter: pose.cameraCenter,
      viewingDirection: pose.viewingDirection,
    })),
    warnings,
    caveat: CAVEAT,
  };
}

/** Parse small fixtures or caller-provided COLMAP TXT content for unit tests and integrations. */
export function assessColmapViewCoverage({ imagesText, points3DText, thresholds = {} }) {
  if (typeof imagesText !== "string" || typeof points3DText !== "string") {
    throw new TypeError("imagesText and points3DText must be strings");
  }
  const poses = imagesText.split(/\r?\n/).map(parseColmapImagePoseLine).filter(Boolean);
  const points = points3DText.split(/\r?\n/).map(parsePoint3DLine).filter(Boolean);
  return analyzeRecords(poses, calculatePointStats(points), thresholds);
}

async function forEachLine(filePath, callback) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) await callback(line);
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Stream the text model instead of loading a potentially large points3D.txt
 * into memory. Only registered camera poses and point bounds are retained.
 */
export async function analyzeColmapTextModelFiles({ imagesPath, points3DPath, thresholds = {} }) {
  if (typeof imagesPath !== "string" || typeof points3DPath !== "string") {
    throw new TypeError("imagesPath and points3DPath are required");
  }
  const poses = [];
  await forEachLine(imagesPath, (line) => {
    const pose = parseColmapImagePoseLine(line);
    if (pose) poses.push(pose);
  });

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  await forEachLine(points3DPath, (line) => {
    const point = parsePoint3DLine(line);
    if (!point) return;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
    count++;
  });
  return analyzeRecords(poses, { count, min, max }, thresholds);
}
