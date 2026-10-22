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

function projectWithDepth(camera, point) {
  const p = camera.projection;
  const homogeneous = p.map((row) =>
    row[0] * point[0] + row[1] * point[1] + row[2] * point[2] + row[3]);
  const depth = homogeneous[2];
  if (!finite(depth) || depth <= EPSILON) {
    throw new RangeError("point is behind camera or at projection horizon");
  }
  const pixel = { x: homogeneous[0] / depth, y: homogeneous[1] / depth };
  if (!finite(pixel.x) || !finite(pixel.y)) throw new RangeError("camera projection is non-finite");
  return { ...pixel, depth };
}

function edgeFunction(a, b, x, y) {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

/**
 * Builds a software inverse-depth buffer in source-image pixel space.
 * Maximum reciprocal depth means the closest surface at a raster pixel.
 */
function buildRasterizedDepthBuffer({ camera, image, triangles, vertexById, maxRasterResolution }) {
  const scale = Math.min(1, maxRasterResolution / Math.max(image.width, image.height));
  const width = Math.max(1, Math.ceil(image.width * scale));
  const height = Math.max(1, Math.ceil(image.height * scale));
  const depthBuffer = new Float64Array(width * height);
  let rasterizedTriangleCount = 0;
  let skippedBehindCameraTriangleCount = 0;
  let nearPlaneCrossingTriangleCount = 0;
  let skippedDegenerateTriangleCount = 0;

  for (const triangle of triangles) {
    const ids = Array.isArray(triangle) ? triangle : triangle?.vertices;
    if (!triangleKey(ids) || ids.some((id) => !vertexById.has(id))) continue;
    const points3d = ids.map((id) => vertexById.get(id));
    const cameraDepths = points3d.map((point) => {
      const p = camera.projection;
      return p[2][0] * point[0] + p[2][1] * point[1] + p[2][2] * point[2] + p[2][3];
    });
    const inFront = cameraDepths.map((depth) => finite(depth) && depth > EPSILON);
    if (!inFront.some(Boolean)) {
      skippedBehindCameraTriangleCount += 1;
      continue;
    }
    if (!inFront.every(Boolean)) {
      // Crossing the camera plane requires polygon clipping; never call such coverage visible.
      nearPlaneCrossingTriangleCount += 1;
      continue;
    }

    let projected;
    try {
      projected = points3d.map((point) => {
        const p = projectWithDepth(camera, point);
        return { x: p.x * scale, y: p.y * scale, depth: p.depth };
      });
    } catch {
      skippedDegenerateTriangleCount += 1;
      continue;
    }
    const [a, b, c] = projected;
    const area = edgeFunction(a, b, c.x, c.y);
    if (!finite(area) || Math.abs(area) < 1e-10) {
      skippedDegenerateTriangleCount += 1;
      continue;
    }

    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)) - 1);
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)) - 1);
    if (maxX < minX || maxY < minY) continue;

    const inverseA = 1 / a.depth;
    const inverseB = 1 / b.depth;
    const inverseC = 1 / c.depth;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const wa = edgeFunction(b, c, px, py) / area;
        const wb = edgeFunction(c, a, px, py) / area;
        const wc = 1 - wa - wb;
        if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
        // Reciprocal depth interpolates linearly in projected screen coordinates.
        const inverseDepth = wa * inverseA + wb * inverseB + wc * inverseC;
        if (!finite(inverseDepth) || inverseDepth <= 0) continue;
        const offset = y * width + x;
        if (inverseDepth > depthBuffer[offset]) depthBuffer[offset] = inverseDepth;
      }
    }
    rasterizedTriangleCount += 1;
  }

  return {
    width,
    height,
    scale,
    depthBuffer,
    rasterizedTriangleCount,
    skippedBehindCameraTriangleCount,
    nearPlaneCrossingTriangleCount,
    skippedDegenerateTriangleCount,
    visibilityMethod: "software-rasterized-inverse-depth-buffer",
  };
}

function rasterizedViewVisibility({ context, camera, points, options }) {
  const [a, b, c] = points;
  const samples = [
    barycentricPoint(a, b, c, [1 / 3, 1 / 3, 1 / 3]),
    barycentricPoint(a, b, c, [0.65, 0.175, 0.175]),
    barycentricPoint(a, b, c, [0.175, 0.65, 0.175]),
    barycentricPoint(a, b, c, [0.175, 0.175, 0.65]),
  ];
  const occludedSamples = [];
  const unclassifiedSamples = [];
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    let sample;
    try {
      sample = projectWithDepth(camera, samples[sampleIndex]);
    } catch {
      unclassifiedSamples.push(sampleIndex);
      continue;
    }
    const x = Math.floor(sample.x * context.scale);
    const y = Math.floor(sample.y * context.scale);
    if (x < 0 || y < 0 || x >= context.width || y >= context.height ||
        context.nearPlaneCrossingTriangleCount > 0) {
      unclassifiedSamples.push(sampleIndex);
      continue;
    }
    const nearestInverseDepth = context.depthBuffer[y * context.width + x];
    const targetInverseDepth = 1 / sample.depth;
    if (!finite(nearestInverseDepth) || nearestInverseDepth <= 0) {
      unclassifiedSamples.push(sampleIndex);
      continue;
    }
    const tolerance = Math.max(1e-8, targetInverseDepth * options.depthToleranceRatio);
    if (nearestInverseDepth > targetInverseDepth + tolerance) occludedSamples.push(sampleIndex);
    else if (nearestInverseDepth + tolerance < targetInverseDepth) unclassifiedSamples.push(sampleIndex);
  }

  let status = "visible-by-rasterized-depth-buffer";
  if (occludedSamples.length) status = "occluded";
  else if (unclassifiedSamples.length) status = "indeterminate";
  return {
    status,
    sampleCount: samples.length,
    visibleSampleCount: samples.length - occludedSamples.length - unclassifiedSamples.length,
    occludedSampleIndices: occludedSamples,
    unclassifiedSampleIndices: unclassifiedSamples,
    visibilityMethod: context.visibilityMethod,
    rasterWidth: context.width,
    rasterHeight: context.height,
    rasterizedTriangleCount: context.rasterizedTriangleCount,
    skippedBehindCameraTriangleCount: context.skippedBehindCameraTriangleCount,
    nearPlaneCrossingTriangleCount: context.nearPlaneCrossingTriangleCount,
    skippedDegenerateTriangleCount: context.skippedDegenerateTriangleCount,
  };
}

function validateCandidate({ image, calibration, camera, cameraId, face, vertexById, triangleKeys, triangles, visibilityCache, options }) {
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
    const visibilityKey = cameraId + "\u0000" + image.width + "x" + image.height + "\u0000" + options.maxRasterResolution;
    let visibilityContext = visibilityCache.get(visibilityKey);
    if (!visibilityContext) {
      visibilityContext = buildRasterizedDepthBuffer({
        camera,
        image,
        triangles,
        vertexById,
        maxRasterResolution: options.maxRasterResolution,
      });
      visibilityCache.set(visibilityKey, visibilityContext);
    }
    const visibility = rasterizedViewVisibility({ context: visibilityContext, camera, points, options });
    if (visibility.status !== "visible-by-rasterized-depth-buffer") {
      const reason = visibility.status === "occluded"
        ? "source-view-occludes-or-partially-occludes-face"
        : "rasterized-visibility-check-indeterminate";
      return { reasons: [reason], pixels, projectedAreaPx, facingCosine, visibility };
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
 * per face. Automatic choice requires cameraId on every candidate image; software
 * inverse-depth rasterization checks occlusion against the reviewed mesh.
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
    maxRasterResolution: options.maxRasterResolution ?? 512,
    depthToleranceRatio: options.depthToleranceRatio ?? 1e-4,
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
  if (!Number.isInteger(resolvedOptions.maxRasterResolution) ||
      resolvedOptions.maxRasterResolution < 64 || resolvedOptions.maxRasterResolution > 1024) {
    throw new RangeError("maxRasterResolution must be an integer between 64 and 1024");
  }
  if (!finite(resolvedOptions.depthToleranceRatio) ||
      resolvedOptions.depthToleranceRatio < 0 || resolvedOptions.depthToleranceRatio > 0.01) {
    throw new RangeError("depthToleranceRatio must be between zero and 0.01");
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

  const visibilityCache = new Map();
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
        visibilityCache,
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
        status: "visible-by-rasterized-depth-buffer",
        cameraId: chosen.cameraId,
        sourceImageId: chosen.image.id,
        sampleCount: chosen.visibility.sampleCount,
        visibleSampleCount: chosen.visibility.visibleSampleCount,
        occludedSampleIndices: chosen.visibility.occludedSampleIndices,
        cameraCenter: chosen.cameraCenter,
        projectedAreaPx: chosen.projectedAreaPx,
        facingCosine: chosen.facingCosine,
        selectionScore: chosen.score,
        method: "software-rasterized-inverse-depth-buffer",
      },
      selectionEvidence: {
        status: autoSelect ? "best-visible-calibrated-view-selected" : "explicit-view-geometry-checked",
        cameraId: chosen.cameraId,
        sourceImageId: chosen.image.id,
        candidateCount: evaluated.length,
        eligibleCandidateCount: eligible.length,
        visibilityMethod: "software-rasterized-inverse-depth-buffer",
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
      usesSoftwareRasterizedDepthBuffer: true,
      fabricatesMissingTexturePixels: false,
    },
    limitations: [
      "Automatic source selection requires source images with explicit cameraId assignments and verified calibrated camera matrices.",
      "Visibility is sampled at the face centroid and three inset points against a software rasterized inverse-depth buffer; low raster resolution and camera-plane-crossing triangles produce indeterminate results rather than false visibility passes.",
      "The camera center is recovered from the calibrated 3x4 projection matrix; calibration must be full-rank, finite, and expressed in the same mesh coordinate frame.",
      "Human review, correct feature correspondences, image rights, architectural dimensions and geospatial control remain necessary.",
    ],
    publicationEligible: false,
  };
}
