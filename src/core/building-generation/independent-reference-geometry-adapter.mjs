import { validateAffineMatrix4x4 } from "./glb-geometry-extraction.mjs";

const EPSILON = 1e-6;
const MAX_VERTICES = 2_000_000;
const MAX_TRIANGLES = 4_000_000;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(label + " must be finite.");
  return value;
}
function clean(value) {
  const rounded = Number(value.toFixed(9));
  return Object.is(rounded, -0) ? 0 : rounded;
}
function point3(raw, label) {
  if (!Array.isArray(raw) || raw.length !== 3) throw new TypeError(label + " must be [x,y,z].");
  return raw.map((v, i) => finite(v, label + "[" + i + "]"));
}
function transformPoint(matrix, point, label) {
  const x = matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12];
  const y = matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13];
  const z = matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14];
  const w = matrix[3] * point[0] + matrix[7] * point[1] + matrix[11] * point[2] + matrix[15];
  if (!Number.isFinite(w) || Math.abs(w) <= EPSILON) throw new TypeError(label + " produces an invalid homogeneous coordinate.");
  return [x / w, y / w, z / w].map(clean);
}

/**
 * Survey-to-evaluation transforms must preserve metric scale and the Y-up
 * convention. Horizontal axes may be aligned or swapped by a cardinal 90-degree
 * rotation; arbitrary yaw, scale, shear and tilt are rejected to avoid silently
 * corrupting width/depth metrics.
 */
export function validateSurveyFrameTransformMatrix4x4(raw) {
  const matrix = validateAffineMatrix4x4(raw, "reference.sourceToEvaluationFrameMatrix4x4");
  const zeroTerms = [matrix[1], matrix[4], matrix[6], matrix[9]];
  if (zeroTerms.some((value) => Math.abs(value) > EPSILON) || Math.abs(matrix[5] - 1) > EPSILON) {
    throw new TypeError("Reference frame transform must preserve the metre-based Y-up axis without tilt.");
  }
  const axes = [matrix[0], matrix[2], matrix[8], matrix[10]];
  const allowed = (value) => [-1, 0, 1].some((target) => Math.abs(value - target) <= EPSILON);
  if (axes.some((value) => !allowed(value)) ||
      Math.abs(matrix[0] * matrix[10] - matrix[8] * matrix[2] - 1) > EPSILON ||
      Math.abs(Math.hypot(matrix[0], matrix[2]) - 1) > EPSILON ||
      Math.abs(Math.hypot(matrix[8], matrix[10]) - 1) > EPSILON ||
      Math.abs(matrix[0] * matrix[8] + matrix[2] * matrix[10]) > EPSILON) {
    throw new TypeError("Reference frame transform must be a scale-preserving 0/90/180/270-degree horizontal axis alignment.");
  }
  return matrix;
}

/**
 * Import independently measured geometry and explicitly transform all coordinate
 * payloads into the evaluator's frame. The input file hash is checked by the CLI;
 * this adapter checks coordinate semantics and geometry structure.
 */
export function adaptIndependentReferenceGeometry(truth, options = {}) {
  if (!object(truth) || truth.schemaVersion !== "1.0.0") {
    throw new TypeError("Reference geometry must use schemaVersion 1.0.0.");
  }
  const sourceFrame = options.sourceCoordinateFrameId;
  const evaluationFrame = options.evaluationCoordinateFrameId;
  if (typeof sourceFrame !== "string" || !sourceFrame.trim() ||
      typeof evaluationFrame !== "string" || !evaluationFrame.trim()) {
    throw new TypeError("Source and evaluation coordinate-frame IDs are required.");
  }
  if (truth.coordinateFrameId !== sourceFrame) {
    throw new TypeError("Reference source coordinateFrameId must match reference.sourceCoordinateFrameId.");
  }
  if (truth.units !== "m") throw new TypeError("Reference source geometry must use metres.");
  const matrix = validateSurveyFrameTransformMatrix4x4(options.sourceToEvaluationFrameMatrix4x4);
  const elevation = finite(truth.footprintElevationM, "reference.footprintElevationM");

  if (!Array.isArray(truth.footprint) || truth.footprint.length < 3 || truth.footprint.length > 500) {
    throw new TypeError("Reference footprint must contain 3 to 500 ordered X/Z points.");
  }
  const footprint = truth.footprint.map((point, index) => {
    if (!object(point)) throw new TypeError("Reference footprint[" + index + "] must be an object.");
    const x = finite(point.x, "reference.footprint[" + index + "].x");
    const z = finite(point.z, "reference.footprint[" + index + "].z");
    const transformed = transformPoint(matrix, [x, elevation, z], "reference footprint point " + index);
    return { x: transformed[0], z: transformed[2] };
  });

  if (!object(truth.dimensionsM)) throw new TypeError("Reference dimensionsM are required.");
  const widthM = finite(truth.dimensionsM.widthM, "reference.dimensionsM.widthM");
  const depthM = finite(truth.dimensionsM.depthM, "reference.dimensionsM.depthM");
  const heightM = finite(truth.dimensionsM.heightM, "reference.dimensionsM.heightM");
  if (widthM <= 0 || depthM <= 0 || heightM <= 0) throw new RangeError("Reference dimensionsM must be positive.");
  const swapsHorizontalAxes = Math.abs(matrix[0]) <= EPSILON;
  const dimensionsM = swapsHorizontalAxes
    ? { widthM: depthM, depthM: widthM, heightM }
    : { widthM, depthM, heightM };

  if (!Array.isArray(truth.checkPoints) || truth.checkPoints.length > 1000) {
    throw new TypeError("Reference checkPoints must be an array of at most 1000 entries.");
  }
  const seenIds = new Set();
  const checkPoints = truth.checkPoints.map((point, index) => {
    if (!object(point) || typeof point.id !== "string" || !ID.test(point.id)) {
      throw new TypeError("Reference checkPoints[" + index + "] needs a safe point ID.");
    }
    if (seenIds.has(point.id)) throw new TypeError("Duplicate reference check point ID: " + point.id);
    seenIds.add(point.id);
    if (point.independentOfFit !== true) {
      throw new TypeError("Reference check point " + point.id + " must declare independentOfFit: true.");
    }
    const p = transformPoint(matrix, [
      finite(point.x, "reference.checkPoints[" + index + "].x"),
      finite(point.y, "reference.checkPoints[" + index + "].y"),
      finite(point.z, "reference.checkPoints[" + index + "].z"),
    ], "reference check point " + point.id);
    return { id: point.id, x: p[0], y: p[1], z: p[2], independentOfFit: true };
  });

  const sourceMesh = truth.surfaceMesh;
  if (!object(sourceMesh) || !Array.isArray(sourceMesh.vertices) ||
      sourceMesh.vertices.length < 3 || sourceMesh.vertices.length > MAX_VERTICES ||
      !Array.isArray(sourceMesh.triangles) || !sourceMesh.triangles.length ||
      sourceMesh.triangles.length > MAX_TRIANGLES) {
    throw new TypeError("Reference surfaceMesh must contain bounded vertices and triangles.");
  }
  const vertices = sourceMesh.vertices.map((vertex, index) => transformPoint(
    matrix, point3(vertex, "reference.surfaceMesh.vertices[" + index + "]"),
    "reference surface vertex " + index
  ));
  const triangles = sourceMesh.triangles.map((triangle, index) => {
    if (!Array.isArray(triangle) || triangle.length !== 3 ||
        triangle.some((v) => !Number.isSafeInteger(v) || v < 0 || v >= vertices.length) ||
        new Set(triangle).size !== 3) {
      throw new TypeError("Reference triangle " + index + " must contain three distinct in-range vertex indices.");
    }
    const [a, b, c] = triangle.map((vertexIndex) => vertices[vertexIndex]);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    if (Math.hypot(...cross) <= EPSILON) throw new TypeError("Reference triangle " + index + " is degenerate.");
    return [...triangle];
  });

  return {
    coordinateFrameId: evaluationFrame,
    units: "m",
    footprint,
    dimensionsM,
    checkPoints,
    surfaceMesh: { vertices, triangles },
    frameTransform: {
      sourceCoordinateFrameId: sourceFrame,
      evaluationCoordinateFrameId: evaluationFrame,
      sourceToEvaluationFrameMatrix4x4: matrix,
      sourceFootprintElevationM: elevation,
      horizontalAxesSwapped: swapsHorizontalAxes,
      method: "survey-frame-rigid-axis-alignment-v1",
    },
  };
}
