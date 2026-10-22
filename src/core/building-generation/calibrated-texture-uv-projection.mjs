const EPSILON = 1e-9;
const SHA256 = /^[a-f0-9]{64}$/i;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function validateProjectionCamera(camera) {
  if (!camera || typeof camera.id !== "string" || !camera.id ||
      !Array.isArray(camera.projection) || camera.projection.length !== 3 ||
      camera.projection.some((row) => !Array.isArray(row) || row.length !== 4 || row.some((value) => !finite(value)))) {
    throw new TypeError("cameras need unique IDs and finite calibrated 3x4 projection matrices");
  }
}

function pixelFromProjection(camera, point) {
  const [x, y, z] = point;
  const homogeneous = camera.projection.map((row) => row[0] * x + row[1] * y + row[2] * z + row[3]);
  const depth = homogeneous[2];
  // This workflow requires the conventional positive-depth camera matrix scale.
  // If a calibrated P matrix is multiplied by -1, normalize its sign before use.
  if (!finite(depth) || depth <= EPSILON) {
    throw new RangeError("point is behind the camera or too close to the projection horizon");
  }
  const pixel = { x: homogeneous[0] / depth, y: homogeneous[1] / depth };
  if (!finite(pixel.x) || !finite(pixel.y)) throw new RangeError("projected image coordinates are non-finite");
  return pixel;
}

function faceKey(face) {
  return Array.isArray(face) && face.length === 3 &&
    face.every((id) => typeof id === "string" && id) && new Set(face).size === 3;
}

/**
 * Compute per-corner UVs from the reviewed camera assignment and calibrated 3x4
 * camera projection matrix. It deliberately does not guess the best view or infer
 * visibility: each source image must be explicitly reviewed as visible for the face.
 */
export function projectTextureFaces({ cameras, vertices, candidate, options = {} }) {
  if (!Array.isArray(cameras) || cameras.length < 1) throw new TypeError("at least one calibrated camera is required");
  if (!Array.isArray(vertices) || vertices.length < 3) throw new TypeError("at least three reviewed mesh vertices are required");
  if (!candidate || !Array.isArray(candidate.images) ||
      !Array.isArray(candidate.cameraCalibrations) || !Array.isArray(candidate.faces)) {
    throw new TypeError("candidate must contain images, cameraCalibrations and faces arrays");
  }
  const maxReprojectionErrorPx = options.maxReprojectionErrorPx ?? 2;
  const minProjectedTriangleAreaPx = options.minProjectedTriangleAreaPx ?? 0.5;
  if (!finite(maxReprojectionErrorPx) || maxReprojectionErrorPx < 0) {
    throw new RangeError("maxReprojectionErrorPx must be a non-negative finite number");
  }
  if (!finite(minProjectedTriangleAreaPx) || minProjectedTriangleAreaPx <= 0) {
    throw new RangeError("minProjectedTriangleAreaPx must be a positive finite number");
  }

  const cameraById = new Map();
  for (const camera of cameras) {
    validateProjectionCamera(camera);
    if (cameraById.has(camera.id)) throw new TypeError("camera IDs must be unique");
    cameraById.set(camera.id, camera);
  }
  const vertexById = new Map();
  for (const vertex of vertices) {
    const point = vertex?.position ?? vertex?.point;
    if (!vertex || typeof vertex.id !== "string" || !vertex.id || vertexById.has(vertex.id) ||
        !Array.isArray(point) || point.length !== 3 || point.some((value) => !finite(value))) {
      throw new TypeError("mesh vertices need unique IDs and finite 3D coordinates");
    }
    vertexById.set(vertex.id, point);
  }

  const imageById = new Map();
  for (const image of candidate.images) {
    if (!image || typeof image.id !== "string" || !image.id || imageById.has(image.id)) continue;
    imageById.set(image.id, image);
  }
  const calibrationById = new Map();
  for (const calibration of candidate.cameraCalibrations) {
    if (!calibration || typeof calibration.id !== "string" || !calibration.id ||
        calibrationById.has(calibration.id)) continue;
    calibrationById.set(calibration.id, calibration);
  }

  const rejectedFaces = [];
  let projectedFaceCount = 0;
  const faces = candidate.faces.map((face, index) => {
    const original = Object.fromEntries(Object.entries(face ?? {}).filter(([key]) =>
      key !== "uv" && key !== "projectionEvidence"));
    const reasons = [];
    if (!faceKey(face?.vertices)) reasons.push("face-must-reference-three-distinct-vertex-ids");
    const ids = face?.vertices;
    if (faceKey(ids) && ids.some((id) => !vertexById.has(id))) {
      reasons.push("face-references-unknown-mesh-vertex");
    }
    const image = imageById.get(face?.sourceImageId);
    if (!image) reasons.push("source-image-not-found-or-duplicated");
    else {
      if (image.verifiedSource !== true) reasons.push("source-image-not-verified");
      if (typeof image.sha256 !== "string" || !SHA256.test(image.sha256)) reasons.push("source-image-sha256-missing-or-invalid");
      if (!Number.isInteger(image.width) || image.width < 1 ||
          !Number.isInteger(image.height) || image.height < 1) reasons.push("source-image-dimensions-invalid");
    }

    const calibration = calibrationById.get(face?.cameraCalibrationId);
    if (!calibration) reasons.push("camera-calibration-not-found-or-duplicated");
    else {
      if (calibration.status !== "verified") reasons.push("camera-calibration-not-verified");
      if (!finite(calibration.reprojectionErrorPx)) reasons.push("calibration-reprojection-error-missing");
      else if (calibration.reprojectionErrorPx > maxReprojectionErrorPx) reasons.push("calibration-reprojection-error-exceeds-threshold");
    }

    // Face/view association is operator-reviewed because this worker has no z-buffer,
    // semantic facade classifier, or cross-view occlusion solver.
    if (face?.visibilityReviewed !== true) reasons.push("source-view-visibility-review-required");

    const cameraId = calibration?.cameraId ?? image?.cameraId ?? calibration?.id;
    if (image?.cameraId && cameraId && image.cameraId !== cameraId) {
      reasons.push("source-image-camera-does-not-match-calibration");
    }
    const camera = cameraById.get(cameraId);
    if (!camera) reasons.push("calibrated-camera-matrix-not-found");

    let pixels = null;
    let uv = null;
    let projectedAreaPx = null;
    if (reasons.length === 0) {
      try {
        pixels = ids.map((id) => pixelFromProjection(camera, vertexById.get(id)));
        const insideImage = pixels.every((point) =>
          point.x >= 0 && point.y >= 0 && point.x < image.width && point.y < image.height);
        if (!insideImage) reasons.push("projected-face-corners-outside-source-image");
        const [a, b, c] = pixels;
        projectedAreaPx = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
        if (!finite(projectedAreaPx) || projectedAreaPx < minProjectedTriangleAreaPx) {
          reasons.push("projected-face-is-degenerate-or-too-small");
        }
        if (!reasons.length) {
          // glTF normalized UVs use a bottom-left origin; projected image pixels use top-left.
          uv = pixels.map((point) => [point.x / image.width, 1 - point.y / image.height]);
        }
      } catch (error) {
        reasons.push(error instanceof Error && /behind the camera|projection horizon/.test(error.message)
          ? "vertex-behind-camera-or-at-projection-horizon"
          : "camera-projection-produced-invalid-coordinates");
      }
    }

    if (reasons.length) {
      const uniqueReasons = [...new Set(reasons)];
      rejectedFaces.push({ index, vertices: Array.isArray(ids) ? ids.slice() : null, reasons: uniqueReasons });
      return {
        ...original,
        projectionEvidence: {
          status: "rejected",
          cameraId: cameraId ?? null,
          sourceImageId: face?.sourceImageId ?? null,
          projectedPixels: pixels,
          projectedAreaPx,
          reasons: uniqueReasons,
        },
      };
    }

    projectedFaceCount += 1;
    return {
      ...original,
      uv,
      projectionEvidence: {
        status: "projected-with-reviewed-view-assignment",
        cameraId,
        sourceImageId: image.id,
        sourceImageSha256: image.sha256.toLowerCase(),
        projectedPixels: pixels,
        projectedAreaPx,
        visibilityReviewed: true,
        uvOrigin: "bottom-left",
      },
    };
  });

  const blockers = [];
  if (rejectedFaces.length) blockers.push("one-or-more-faces-failed-calibrated-uv-projection");
  if (projectedFaceCount === 0 && candidate.faces.length > 0) blockers.push("no-faces-could-be-projected-to-texture-uvs");
  return {
    schemaVersion: "1.0.0",
    status: rejectedFaces.length ? "review-required" : "uv-projection-complete-requires-human-review",
    faceCount: candidate.faces.length,
    projectedFaceCount,
    rejectedFaces,
    faces,
    blockers,
    policy: {
      computesUvsFromCalibratedProjection: true,
      usesSuppliedUvs: false,
      automaticallyChoosesSourceView: false,
      automaticallyChecksOcclusion: false,
      requiresPerFaceVisibilityAttestation: true,
      fabricatesMissingTexturePixels: false,
      maxReprojectionErrorPx,
      minProjectedTriangleAreaPx,
    },
    limitations: [
      "The source image and calibrated camera are assigned explicitly per face; the worker does not automatically choose the best view.",
      "Visibility and occlusion are not inferred. visibilityReviewed=true must be attested after checking that the selected view actually sees this face.",
      "Camera projection matrices must be calibrated in source-image pixel coordinates, share the mesh coordinate frame, and use positive camera depth.",
      "This computes texture UV coordinates; it does not correct lens distortion, relight images, blend seams, or prove architectural/geospatial accuracy.",
    ],
    publicationEligible: false,
  };
}
