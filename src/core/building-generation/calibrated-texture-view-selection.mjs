const EPSILON = 1e-9;
const HASH = /^[a-f0-9]{64}$/i;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (v) => Math.hypot(...v);

function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

function cameraCenter(camera) {
  const projection = camera.projection;
  const homogeneous = [];
  for (let removed = 0; removed < 4; removed += 1) {
    const minor = projection.map((row) => row.filter((_, col) => col !== removed));
    homogeneous.push((removed % 2 === 0 ? 1 : -1) * det3(minor));
  }
  const scale = Math.max(...homogeneous.map(Math.abs));
  if (!finite(scale) || scale < EPSILON || Math.abs(homogeneous[3]) < scale * 1e-12) {
    throw new RangeError("camera projection matrix has no finite recoverable camera center");
  }
  return homogeneous.slice(0, 3).map((value) => value / homogeneous[3]);
}

function project(camera, point) {
  const p = camera.projection;
  const h = p.map((row) => row[0] * point[0] + row[1] * point[1] + row[2] * point[2] + row[3]);
  if (!finite(h[2]) || h[2] <= EPSILON) throw new RangeError("point is behind camera or at projection horizon");
  const pixel = { x: h[0] / h[2], y: h[1] / h[2] };
  if (!finite(pixel.x) || !finite(pixel.y)) throw new RangeError("camera projection is non-finite");
  return pixel;
}

function triangleKey(ids) {
  if (!Array.isArray(ids) || ids.length !== 3 ||
      ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== 3) return null;
  return [...ids].sort().join("\u0000");
}

function barycentricPoint(a, b, c, weights) {
  return [
    a[0] * weights[0] + b[0] * weights[1] + c[0] * weights[2],
    a[1] * weights[0] + b[1] * weights[1] + c[1] * weights[2],
    a[2] * weights[0] + b[2] * weights[1] + c[2] * weights[2],
  ];
}

function segmentIntersectsTriangle(origin, target, a, b, c) {
  const direction = sub(target, origin);
  const edge1 = sub(b, a);
  const edge2 = sub(c, a);
  const p = cross(direction, edge2);
  const determinant = dot(edge1, p);
  if (Math.abs(determinant) < 1e-10) return false;
  const inverse = 1 / determinant;
  const offset = sub(origin, a);
  const u = dot(offset, p) * inverse;
  if (u < -1e-8 || u > 1 + 1e-8) return false;
  const q = cross(offset, edge1);
  const v = dot(direction, q) * inverse;
  if (v < -1e-8 || u + v > 1 + 1e-8) return false;
  const t = dot(edge2, q) * inverse;
  // The ray is a finite segment ending on the target face; only earlier hits occlude it.
  return t > 1e-6 && t < 1 - 1e-5;
}

function viewVisibility({ center, points, targetKey, triangles, vertexById }) {
  const [a, b, c] = points;
  const samples = [
    barycentricPoint(a, b, c, [1 / 3, 1 / 3, 1 / 3]),
    barycentricPoint(a, b, c, [0.65, 0.175, 0.175]),
    barycentricPoint(a, b, c, [0.175, 0.65, 0.175]),
    barycentricPoint(a, b, c, [0.175, 0.175, 0.65]),
  ];
  const occludedSamples = [];
  samples.forEach((sample, sampleIndex) => {
    for (const triangle of triangles) {
      const ids = Array.isArray(triangle) ? triangle : triangle?.vertices;
      if (triangleKey(ids) === targetKey) continue;
      if (!triangleKey(ids) || ids.some((id) => !vertexById.has(id))) continue;
      const tri = ids.map((id) => vertexById.get(id));
      if (segmentIntersectsTriangle(center, sample, tri[0], tri[1], tri[2])) {
        occludedSamples.push(sampleIndex);
        break;
      }
    }
  });
  return {
    status: occludedSamples.length ? "occluded" : "visible-by-mesh-ray-test",
    sampleCount: samples.length,
    visibleSampleCount: samples.length - occludedSamples.length,
    occludedSampleIndices: occludedSamples,
  };
}

function validateCandidate({ image, calibration, camera, cameraId, face, vertexById, triangleKeys, triangles, options }) {
  const reasons = [];
  if (!image) reasons.push("source-image-not-found");
  else {
    if (image.verifiedSource !== true) reasons.push("source-image-not-verified");
    if (typeof image.sha256 !== "string" || !HASH.test(image.sha256)) reasons.push("source-image-sha256-missing-or-invalid");
    if (!Number.isInteger(image.width) || image.width < 1 ||
        !Number.isInteger(image.height) || image.height < 1) reasons.push("source-image-dimensions-invalid");
    if (image.cameraId && image.cameraId !== cameraId) reasons.push("source-image-camera-does-not-match-calibration");
  }
  if (!calibration) reasons.push("camera-calibration-not-found");
  else {
    if (calibration.status !== "verified") reasons.push("camera-calibration-not-verified");
    if (!finite(calibration.reprojectionErrorPx)) reasons.push("calibration-reprojection-error-missing");
    else if (calibration.reprojectionErrorPx > options.maxReprojectionErrorPx) reasons.push("calibration-reprojection-error-exceeds-threshold");
  }
  if (!camera) reasons.push("calibrated-camera-matrix-not-found");
  if (!triangleKey(face?.vertices)) reasons.push("face-must-reference-three-distinct-vertex-ids");
  const ids = face?.vertices;
  if (triangleKey(ids) && ids.some((id) => !vertexById.has(id))) reasons.push("face-references-unknown-mesh-vertex");
  const targetKey = triangleKey(ids);
  if (targetKey && !triangleKeys.has(targetKey)) reasons.push("face-not-found-in-reviewed-mesh-triangles");
  if (reasons.length) return { reasons: [...new Set(reasons)] };

  const points = ids.map((id) => vertexById.get(id));
  const normal = cross(sub(points[1], points[0]), sub(points[2], points[0]));
  const normalLength = length(normal);
  if (normalLength < EPSILON) return { reasons: ["degenerate-mesh-face"] };

  try {
    const pixels = points.map((point) => project(camera, point));
    if (!pixels.every((point) => point.x >= 0 && point.y >= 0 && point.x < image.width && point.y < image.height)) {
      return { reasons: ["projected-face-corners-outside-source-image"], pixels };
    }
    const [pa, pb, pc] = pixels;
    const projectedAreaPx = Math.abs((pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x)) / 2;
    if (!finite(projectedAreaPx) || projectedAreaPx < options.minProjectedTriangleAreaPx) {
      return { reasons: ["projected-face-is-degenerate-or-too-small"], pixels, projectedAreaPx };
    }
    const center = cameraCenter(camera);
    const faceCenter = [
      (points[0][0] + points[1][0] + points[2][0]) / 3,
      (points[0][1] + points[1][1] + points[2][1]) / 3,
      (points[0][2] + points[1][2] + points[2][2]) / 3,
    ];
    const toCamera = sub(center, faceCenter);
    const toCameraLength = length(toCamera);
    if (toCameraLength < EPSILON) return { reasons: ["camera-center-coincides-with-face"] };
    const facingCosine = Math.abs(dot(normal, toCamera) / (normalLength * toCameraLength));
    if (facingCosine < options.minFacingCosine) {
      return { reasons: ["face-is-too-grazing-for-texture-projection"], pixels, projectedAreaPx, facingCosine };
    }
    const visibility = viewVisibility({ center, points, targetKey, triangles, vertexById });
    if (visibility.status !== "visible-by-mesh-ray-test") {
      return { reasons: ["source-view-occludes-or-partially-occludes-face"], pixels, projectedAreaPx, facingCosine, visibility };
    }
    return {
      reasons: [],
      pixels,
      projectedAreaPx,
      facingCosine,
      cameraCenter: center,
      visibility,
      score: projectedAreaPx * Math.max(facingCosine, 0.01),
    };
  } catch (error) {
    return {
      reasons: [error instanceof Error && /camera center/i.test(error.message)
        ? "camera-center-not-recoverable-from-projection-matrix"
        : error instanceof Error && /behind camera|projection horizon/i.test(error.message)
          ? "vertex-behind-camera-or-at-projection-horizon"
          : "camera-projection-produced-invalid-coordinates"],
    };
  }
}

/**
 * Validates explicit source-view assignments or chooses a suitable calibrated image
 * per face. Automatic choice requires a cameraId on every candidate image and a
 * reviewed mesh so finite camera-to-face rays can be checked against other triangles.
 */
export function selectCalibratedTextureViews({ cameras, vertices, triangles, candidate, options = {} }) {
  if (!Array.isArray(cameras) || cameras.length < 1) throw new TypeError("at least one calibrated camera is required");
  if (!Array.isArray(vertices) || vertices.length < 3) throw new TypeError("at least three reviewed mesh vertices are required");
  if (!Array.isArray(triangles) || triangles.length < 1) throw new TypeError("reviewed mesh triangles are required for visibility selection");
  if (!candidate || !Array.isArray(candidate.images) ||
      !Array.isArray(candidate.cameraCalibrations) || !Array.isArray(candidate.faces)) {
    throw new TypeError("candidate must contain images, cameraCalibrations and faces arrays");
  }
  const resolvedOptions = {
    maxReprojectionErrorPx: options.maxReprojectionErrorPx ?? 2,
    minProjectedTriangleAreaPx: options.minProjectedTriangleAreaPx ?? 0.5,
    minFacingCosine: options.minFacingCosine ?? 0.02,
    autoSelectSourceView: options.autoSelectSourceView === true,
  };
  if (!finite(resolvedOptions.maxReprojectionErrorPx) || resolvedOptions.maxReprojectionErrorPx < 0) {
    throw new RangeError("maxReprojectionErrorPx must be a non-negative finite number");
  }
  if (!finite(resolvedOptions.minProjectedTriangleAreaPx) || resolvedOptions.minProjectedTriangleAreaPx <= 0) {
    throw new RangeError("minProjectedTriangleAreaPx must be a positive finite number");
  }
  if (!finite(resolvedOptions.minFacingCosine) ||
      resolvedOptions.minFacingCosine < 0 || resolvedOptions.minFacingCosine > 1) {
    throw new RangeError("minFacingCosine must be between zero and one");
  }
  const cameraById = new Map();
  for (const camera of cameras) {
    if (!camera || typeof camera.id !== "string" || !camera.id ||
        !Array.isArray(camera.projection) || camera.projection.length !== 3 ||
        camera.projection.some((row) => !Array.isArray(row) || row.length !== 4 || row.some((value) => !finite(value)))) {
      throw new TypeError("cameras need unique IDs and finite calibrated 3x4 projection matrices");
    }
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
  const triangleKeys = new Set(triangles.map((triangle) =>
    triangleKey(Array.isArray(triangle) ? triangle : triangle?.vertices)).filter(Boolean));
  const imageById = new Map();
  const duplicateImageIds = new Set();
  for (const image of candidate.images) {
    if (!image || typeof image.id !== "string" || !image.id) continue;
    if (imageById.has(image.id)) duplicateImageIds.add(image.id);
    else imageById.set(image.id, image);
  }
  const calibrationById = new Map();
  const duplicateCalibrationIds = new Set();
  for (const calibration of candidate.cameraCalibrations) {
    if (!calibration || typeof calibration.id !== "string" || !calibration.id) continue;
    if (calibrationById.has(calibration.id)) duplicateCalibrationIds.add(calibration.id);
    else calibrationById.set(calibration.id, calibration);
  }

  const rejectedFaces = [];
  let autoSelectedFaceCount = 0;
  let visibilityCheckedFaceCount = 0;
  const faces = candidate.faces.map((face, index) => {
    const original = Object.fromEntries(Object.entries(face ?? {}).filter(([key]) =>
      key !== "uv" && key !== "projectionEvidence" && key !== "visibilityEvidence" && key !== "selectionEvidence"));
    const hasImageAssignment = typeof face?.sourceImageId === "string" && face.sourceImageId.length > 0;
    const hasCalibrationAssignment = typeof face?.cameraCalibrationId === "string" && face.cameraCalibrationId.length > 0;
    if (hasImageAssignment !== hasCalibrationAssignment && !resolvedOptions.autoSelectSourceView) {
      const reasons = ["source-image-and-camera-calibration-must-be-assigned-together"];
      rejectedFaces.push({ index, vertices: face?.vertices ?? null, reasons });
      return { ...original, selectionEvidence: { status: "rejected", reasons } };
    }
    const autoSelect = resolvedOptions.autoSelectSourceView || (!hasImageAssignment && !hasCalibrationAssignment);
    if (!autoSelect && face?.visibilityReviewed === true) {
      const image = imageById.get(face.sourceImageId);
      const calibration = calibrationById.get(face.cameraCalibrationId);
      const cameraId = calibration?.cameraId ?? calibration?.id;
      const camera = cameraById.get(cameraId);
      if (duplicateImageIds.has(face.sourceImageId) || !image) {
        const reasons = ["source-image-not-found-or-duplicated"];
        rejectedFaces.push({ index, vertices: face.vertices ?? null, reasons });
        return { ...original, selectionEvidence: { status: "rejected", reasons } };
      }
      if (duplicateCalibrationIds.has(face.cameraCalibrationId) || !calibration) {
        const reasons = ["camera-calibration-not-found-or-duplicated"];
        rejectedFaces.push({ index, vertices: face.vertices ?? null, reasons });
        return { ...original, selectionEvidence: { status: "rejected", reasons } };
      }
      if (image.cameraId && image.cameraId !== cameraId) {
        const reasons = ["source-image-camera-does-not-match-calibration"];
        rejectedFaces.push({ index, vertices: face.vertices ?? null, reasons });
        return { ...original, selectionEvidence: { status: "rejected", reasons } };
      }
      return {
        ...original,
        selectionEvidence: {
          status: "explicit-assignment-human-attested",
          cameraId,
          sourceImageId: image.id,
          visibilityMethod: "operator-attestation",
        },
      };
    }

    let pairs = [];
    if (!autoSelect) {
      const image = imageById.get(face.sourceImageId);
      const calibration = calibrationById.get(face.cameraCalibrationId);
      pairs = [{ image, calibration, cameraId: calibration?.cameraId ?? calibration?.id }];
    } else {
      for (const image of candidate.images) {
        const imageCameraId = image?.cameraId;
        if (typeof imageCameraId !== "string" || !imageCameraId) continue;
        for (const calibration of candidate.cameraCalibrations) {
          const calibrationCameraId = calibration?.cameraId ?? calibration?.id;
          if (calibrationCameraId !== imageCameraId) continue;
          if (image.cameraCalibrationId && image.cameraCalibrationId !== calibration.id) continue;
          if (resolvedOptions.autoSelectSourceView ||
              (!hasImageAssignment && !hasCalibrationAssignment)) {
            pairs.push({ image, calibration, cameraId: imageCameraId });
          }
        }
      }
    }

    const evaluated = [];
    for (const pair of pairs) {
      const imageId = pair.image?.id;
      const calibrationId = pair.calibration?.id;
      if (duplicateImageIds.has(imageId) || duplicateCalibrationIds.has(calibrationId)) {
        evaluated.push({ imageId, cameraId: pair.cameraId, reasons: ["duplicate-image-or-calibration-id"] });
        continue;
      }
      const result = validateCandidate({
        ...pair,
        camera: cameraById.get(pair.cameraId),
        face,
        vertexById,
        triangleKeys,
        triangles,
        options: resolvedOptions,
      });
      evaluated.push({ ...pair, ...result, imageId, cameraId: pair.cameraId });
    }
    const eligible = evaluated.filter((item) => item.reasons.length === 0)
      .sort((a, b) => b.score - a.score ||
        String(a.cameraId).localeCompare(String(b.cameraId)) ||
        String(a.imageId).localeCompare(String(b.imageId)));
    if (!eligible.length) {
      const reasons = [...new Set(evaluated.flatMap((item) => item.reasons))];
      if (!reasons.length) reasons.push("no-calibrated-source-image-assignment-available");
      rejectedFaces.push({
        index,
        vertices: face?.vertices ?? null,
        reasons,
        candidateFailures: evaluated.map((item) => ({
          cameraId: item.cameraId ?? null,
          imageId: item.imageId ?? null,
          reasons: item.reasons,
        })),
      });
      return {
        ...original,
        selectionEvidence: {
          status: "rejected",
          candidateFailures: evaluated.map((item) => ({
            cameraId: item.cameraId ?? null,
            imageId: item.imageId ?? null,
            reasons: item.reasons,
          })),
          reasons,
        },
      };
    }
    const chosen = eligible[0];
    visibilityCheckedFaceCount += 1;
    if (autoSelect) autoSelectedFaceCount += 1;
    return {
      ...original,
      sourceImageId: chosen.image.id,
      cameraCalibrationId: chosen.calibration.id,
      visibilityEvidence: {
        status: "visible-by-mesh-ray-test",
        cameraId: chosen.cameraId,
        sourceImageId: chosen.image.id,
        sampleCount: chosen.visibility.sampleCount,
        visibleSampleCount: chosen.visibility.visibleSampleCount,
        occludedSampleIndices: chosen.visibility.occludedSampleIndices,
        cameraCenter: chosen.cameraCenter,
        projectedAreaPx: chosen.projectedAreaPx,
        facingCosine: chosen.facingCosine,
        selectionScore: chosen.score,
        method: "finite-camera-ray-vs-reviewed-triangle-mesh",
      },
      selectionEvidence: {
        status: autoSelect ? "best-visible-calibrated-view-selected" : "explicit-view-geometry-checked",
        cameraId: chosen.cameraId,
        sourceImageId: chosen.image.id,
        candidateCount: evaluated.length,
        eligibleCandidateCount: eligible.length,
        visibilityMethod: "finite-camera-ray-vs-reviewed-triangle-mesh",
      },
    };
  });

  const blockers = [];
  if (rejectedFaces.length) blockers.push("one-or-more-faces-have-no-eligible-visible-texture-source");
  if (candidate.faces.length > 0 && faces.every((face) => face.selectionEvidence?.status === "rejected")) {
    blockers.push("no-texture-faces-could-be-assigned-to-visible-calibrated-views");
  }
  return {
    schemaVersion: "1.0.0",
    status: blockers.length ? "review-required" : "texture-views-selected-requires-human-review",
    faceCount: candidate.faces.length,
    autoSelectedFaceCount,
    visibilityCheckedFaceCount,
    rejectedFaces,
    faces,
    blockers,
    policy: {
      automaticallyChoosesSourceView: autoSelectedFaceCount > 0,
      automaticallyChecksOcclusion: visibilityCheckedFaceCount > 0,
      usesCalibratedCameraMatrices: true,
      requiresVerifiedImageAndCalibration: true,
      requiresExplicitViewVisibilityAttestation: visibilityCheckedFaceCount === 0,
      testsCentroidAndInsetFaceRays: true,
      fabricatesMissingTexturePixels: false,
    },
    limitations: [
      "Automatic source selection requires source images with explicit cameraId assignments and verified calibrated camera matrices.",
      "Occlusion is approximated by ray tests at the face centroid and three inset samples against the reviewed triangle mesh; small occluders between samples can be missed.",
      "The camera center is recovered from the calibrated 3x4 projection matrix; calibration must be full-rank, finite, and expressed in the same mesh coordinate frame.",
      "Human review, correct feature correspondences, image rights, architectural dimensions and geospatial control remain necessary.",
    ],
    publicationEligible: false,
  };
}
